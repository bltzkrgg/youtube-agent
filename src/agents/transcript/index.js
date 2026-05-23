'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const logger = require('../../utils/logger');
const { safeParseJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { popJob, ackJob, nackJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { validate, TranscriptOutput } = require('../../schemas');

const AGENT = 'TranscriptAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runTranscriptAgent() {
  const job = popJob('transcript');
  if (!job) {
    logger.info('Tidak ada job transcript di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Transcript Agent', { agent: AGENT, jobId: job.id });

  try {
    const { source_video_id, correlation_id } = job.payload;
    if (!source_video_id) throw new Error('source_video_id tidak ada di payload');

    await _processTranscript(source_video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Transcript Agent selesai', { agent: AGENT, sourceVideoId: source_video_id });

    // Check if scene_detect is also done, then trigger clip_planner (idempotent)
    const sceneDetect = readVideoJson(source_video_id, 'scene_detect.json');
    if (sceneDetect) {
      logger.info('Scene detect dan transcript selesai, memulai clip planner', { agent: AGENT });
      _enqueueClipPlannerOnce(source_video_id, correlation_id || job.correlation_id);
    }
  } catch (err) {
    logger.error('Transcript Agent gagal', {
      agent: AGENT, step: 'runTranscriptAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    // Permanent errors (e.g. invalid source.mp4) should not retry
    if (err.permanent) {
      ackJob(job.id);
    } else {
      nackJob(job, err.message);
    }
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processTranscript(sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);

  const videoPath = sourceIngest.source_video_path;

  if (config.dryRun) return _mockTranscript(sourceVideoId, correlationId);

  // Validate source.mp4 before running Whisper — avoid infinite retry on corrupt file
  await _validateSourceVideo(sourceVideoId, videoPath);

  // ── Check transcript cache before invoking Whisper ───────────────────────
  const cachePath = path.join(config.paths.output, sourceVideoId, 'transcript_cache.json');
  const cached = _loadTranscriptCache(cachePath, sourceVideoId);
  let transcriptData;

  if (cached) {
    transcriptData = cached;
    logger.info('Transcript cache loaded, skip Whisper', {
      agent: AGENT, sourceVideoId, cachePath,
    });
  } else {
    // Extract mono 16kHz WAV for Whisper — more stable than feeding raw MP4
    const audioPath = path.join(config.paths.output, sourceVideoId, 'audio_16k.wav');
    const whisperInput = await _extractAudio(videoPath, audioPath, sourceVideoId);

    logger.info('Melakukan transkripsi dengan Whisper', {
      agent: AGENT, audioPath: whisperInput, usingExtractedAudio: whisperInput === audioPath,
    });

    transcriptData = await withRetry(
      () => _runWhisper(whisperInput, sourceVideoId),
      { maxRetry: config.maxRetry, agent: AGENT, step: 'whisperTranscribe' }
    );

    // Persist transcript cache after successful Whisper run
    _writeTranscriptCache(cachePath, transcriptData, sourceVideoId);
  }

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    text: transcriptData.text,
    language: transcriptData.language || 'id',
    segments: transcriptData.segments,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(TranscriptOutput, output, AGENT);
  if (!success) throw new Error(`Validasi TranscriptOutput gagal: ${error}`);

  writeVideoJson(sourceVideoId, 'transcript.json', data);
  return data;
}

// ─── Transcript cache helpers ────────────────────────────────────────────────

const CACHE_VERSION = 1;

/**
 * Read and validate transcript_cache.json.
 * Returns the cached transcript data (text + language + segments) on success,
 * or null if the cache is missing, corrupt, or incompatible.
 * Never throws — cache failures are non-fatal.
 */
function _loadTranscriptCache(cachePath, sourceVideoId) {
  if (!fs.existsSync(cachePath)) return null;

  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(raw);

    // Minimal validity checks
    if (
      cache.version !== CACHE_VERSION ||
      typeof cache.text !== 'string' ||
      !Array.isArray(cache.segments) ||
      cache.segments.length === 0
    ) {
      logger.warn('Transcript cache ignored (invalid structure)', {
        agent: AGENT, sourceVideoId, cachePath,
        hasText: typeof cache.text === 'string',
        segCount: Array.isArray(cache.segments) ? cache.segments.length : -1,
        cacheVersion: cache.version,
      });
      return null;
    }

    return {
      text: cache.text,
      language: cache.language || 'id',
      segments: cache.segments,
      words: Array.isArray(cache.words) ? cache.words : [],
    };
  } catch (e) {
    logger.warn('Transcript cache ignored (parse error)', {
      agent: AGENT, sourceVideoId, cachePath, error: e.message,
    });
    return null;
  }
}

/**
 * Write transcript_cache.json after a successful Whisper run.
 * Non-fatal — if write fails, pipeline continues normally.
 */
function _writeTranscriptCache(cachePath, transcriptData, sourceVideoId) {
  try {
    const cache = {
      version: CACHE_VERSION,
      provider: 'whisper',
      model: process.env.WHISPER_MODEL || 'base',
      text: transcriptData.text,
      language: transcriptData.language || 'id',
      segments: transcriptData.segments,
      words: Array.isArray(transcriptData.words) ? transcriptData.words : [],
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    logger.info('Transcript cache written', {
      agent: AGENT, sourceVideoId, cachePath,
      segCount: cache.segments.length,
      wordCount: cache.words.length,
    });
  } catch (e) {
    logger.warn('Gagal tulis transcript cache (non-fatal)', {
      agent: AGENT, sourceVideoId, cachePath, error: e.message,
    });
  }
}

// ─── Validate source.mp4 before processing ───────────────────────────────────

async function _validateSourceVideo(sourceVideoId, videoPath) {
  // 1. File must exist
  if (!videoPath || !fs.existsSync(videoPath)) {
    const err = new Error(`source.mp4 tidak ditemukan: ${videoPath}`);
    err.permanent = true;
    _markSourceFailed(sourceVideoId, `source.mp4 missing: ${videoPath}`);
    throw err;
  }

  // 2. File size must be > 100KB
  const stats = fs.statSync(videoPath);
  const sizeKB = Math.round(stats.size / 1024);

  if (stats.size < 100 * 1024) {
    const err = new Error(`source.mp4 terlalu kecil: ${sizeKB}KB (minimum 100KB)`);
    err.permanent = true;
    logger.error('source.mp4 terlalu kecil', {
      agent: AGENT, sourceVideoId, videoPath, sizeKB,
    });
    _markSourceFailed(sourceVideoId, `source.mp4 too small: ${sizeKB}KB`);
    throw err;
  }

  // 3. ffprobe must be able to read duration > 0
  const probe = await _ffprobeVideo(videoPath);
  if (!probe.success || probe.duration <= 0) {
    const err = new Error(`source.mp4 invalid/corrupt: ${probe.error || `duration=${probe.duration}`}`);
    err.permanent = true;
    logger.error('source.mp4 gagal validasi ffprobe', {
      agent: AGENT, sourceVideoId, videoPath,
      sizeKB, ffprobeError: probe.error, duration: probe.duration,
    });
    _markSourceFailed(sourceVideoId, `source.mp4 corrupt (ffprobe): ${probe.error || `duration=${probe.duration}`}`);
    throw err;
  }

  logger.info('source.mp4 valid', {
    agent: AGENT, sourceVideoId, videoPath,
    sizeKB, duration: probe.duration,
  });
}

function _markSourceFailed(sourceVideoId, reason) {
  try {
    const { updateSourceVideo } = require('../../utils/db');
    updateSourceVideo(sourceVideoId, {
      status: 'failed',
      risk_notes: reason,
    });
    logger.warn('Source video ditandai failed', { agent: AGENT, sourceVideoId, reason });
  } catch (e) {
    logger.error('Gagal update source status to failed', { agent: AGENT, sourceVideoId, error: e.message });
  }
}

function _ffprobeVideo(videoPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name',
      '-of', 'json',
      videoPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ success: false, duration: 0, error: stderr.slice(-300) || 'ffprobe failed' });
      }
      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format?.duration || 0);
        resolve({ success: true, duration, format: data.format?.format_name || 'unknown' });
      } catch (e) {
        resolve({ success: false, duration: 0, error: `parse ffprobe output: ${e.message}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, duration: 0, error: `spawn ffprobe: ${err.message}` });
    });
  });
}

// ─── Extract audio for Whisper ───────────────────────────────────────────────

/**
 * Extracts mono 16kHz WAV from source video. Returns the audio path on success,
 * or falls back to the original video path if extraction fails (non-fatal).
 */
async function _extractAudio(videoPath, audioPath, sourceVideoId) {
  // If WAV already exists and is non-trivial, reuse it (idempotent)
  if (fs.existsSync(audioPath)) {
    const existingSize = fs.statSync(audioPath).size;
    if (existingSize > 1024) {
      logger.info('audio_16k.wav sudah ada, reuse', {
        agent: AGENT, sourceVideoId, audioPath, sizeKB: Math.round(existingSize / 1024),
      });
      return audioPath;
    }
    // Too small — delete and re-extract
    fs.unlinkSync(audioPath);
  }

  const startMs = Date.now();

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vn',            // drop video stream
      '-ac', '1',       // mono
      '-ar', '16000',   // 16 kHz sample rate (Whisper native)
      '-acodec', 'pcm_s16le',
      audioPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const elapsedMs = Date.now() - startMs;

      if (code !== 0 || !fs.existsSync(audioPath)) {
        logger.warn('Audio extraction gagal, fallback ke source.mp4', {
          agent: AGENT, sourceVideoId, videoPath, audioPath,
          exitCode: code, elapsedMs,
          fallbackReason: code !== 0 ? `ffmpeg exit ${code}: ${stderr.slice(-200)}` : 'output file missing',
        });
        return resolve(videoPath); // fallback
      }

      const sizeKB = Math.round(fs.statSync(audioPath).size / 1024);
      if (sizeKB < 1) {
        logger.warn('audio_16k.wav terlalu kecil, fallback ke source.mp4', {
          agent: AGENT, sourceVideoId, audioPath, sizeKB,
          fallbackReason: 'extracted WAV too small',
        });
        return resolve(videoPath); // fallback
      }

      logger.info('Audio extracted untuk Whisper', {
        agent: AGENT, sourceVideoId, audioPath, sizeKB, elapsedMs,
      });
      resolve(audioPath);
    });

    proc.on('error', (err) => {
      logger.warn('Spawn ffmpeg gagal untuk audio extraction, fallback ke source.mp4', {
        agent: AGENT, sourceVideoId, fallbackReason: err.message,
      });
      resolve(videoPath); // fallback
    });
  });
}

// ─── Run Whisper Python script ───────────────────────────────────────────────

function _runWhisper(videoPath, sourceVideoId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.paths.python, 'whisper_transcribe.py');
    const outputPath = path.join(config.paths.output, sourceVideoId, 'transcript_raw.json');
    const modelSize = process.env.WHISPER_MODEL || 'base';

    const proc = spawn('python3', [scriptPath, videoPath, outputPath, modelSize], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '{}';
      const result = safeParseJson(lastLine, `${AGENT}:whisper`) || {};

      if (code !== 0 || !result.success) {
        return reject(new Error(`Whisper gagal: ${result.error || stderr.slice(-300)}`));
      }

      // Read the full transcript JSON
      const fs = require('fs');
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('Whisper output file tidak ditemukan'));
      }

      const transcriptData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      resolve(transcriptData);
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal spawn python3: ${err.message}`));
    });
  });
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockTranscript(sourceVideoId, correlationId) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Transcript', { agent: AGENT });

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    text: 'Ini adalah transkrip mock untuk testing. Video ini membahas tentang fakta unik Indonesia yang jarang diketahui. Pertama, tahukah kamu bahwa Indonesia memiliki lebih dari 17 ribu pulau? Kedua, bahasa Indonesia adalah salah satu bahasa yang paling mudah dipelajari di dunia.',
    language: 'id',
    segments: [
      { id: 0, start: 0.0, end: 5.2, text: 'Ini adalah transkrip mock untuk testing.' },
      { id: 1, start: 5.2, end: 12.8, text: 'Video ini membahas tentang fakta unik Indonesia yang jarang diketahui.' },
      { id: 2, start: 12.8, end: 20.5, text: 'Pertama, tahukah kamu bahwa Indonesia memiliki lebih dari 17 ribu pulau?' },
      { id: 3, start: 20.5, end: 28.0, text: 'Kedua, bahasa Indonesia adalah salah satu bahasa yang paling mudah dipelajari di dunia.' },
    ],
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(sourceVideoId, 'transcript.json', output);
  return output;
}

// ─── Idempotent clip_planner enqueue ─────────────────────────────────────────

function _enqueueClipPlannerOnce(sourceVideoId, correlationId) {
  const { getDb } = require('../../utils/db');
  const { pushJob } = require('../../utils/queue');
  
  // Check if clip_planner job already exists for this source_video
  const existing = getDb().prepare(`
    SELECT id FROM jobs 
    WHERE type = 'clip_planner' 
      AND json_extract(payload, '$.source_video_id') = ?
      AND status IN ('pending', 'processing')
    LIMIT 1
  `).get(sourceVideoId);

  if (existing) {
    logger.info('Clip planner job sudah ada, skip enqueue', { agent: AGENT, sourceVideoId });
    return;
  }

  pushJob('clip_planner', { source_video_id: sourceVideoId, correlation_id: correlationId }, {
    correlationId,
    priority: 'normal',
  });
  logger.info('Clip planner job dienqueue', { agent: AGENT, sourceVideoId });
}

module.exports = { runTranscriptAgent };
