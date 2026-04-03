'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const logger = require('../../utils/logger');
const { safeParseJson } = require('../../utils/safeJson');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { updateVideo } = require('../../utils/db');
const { validate, ClipOutput } = require('../../schemas');

const AGENT = 'ClipAgent';

// Semaphore: limit FFmpeg to 1 concurrent job (rule 23)
let _isProcessing = false;

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runClipAgent() {
  if (_isProcessing) {
    logger.info('Clip Agent sedang memproses job lain, skip', { agent: AGENT });
    return;
  }

  const job = popJob('clip');
  if (!job) {
    logger.info('Tidak ada job clip di queue', { agent: AGENT });
    return;
  }

  _isProcessing = true;
  logger.info('Memulai Clip Agent', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processClip(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Clip Agent selesai', { agent: AGENT, videoId: video_id });

    // Next: Telegram review
    pushJob('telegram', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'high',
    });
  } catch (err) {
    logger.error('Clip Agent gagal', {
      agent: AGENT, step: 'runClipAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  } finally {
    _isProcessing = false;
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processClip(videoId, correlationId) {
  const script    = readVideoJson(videoId, 'script.json');
  const metadata  = readVideoJson(videoId, 'metadata.json');
  const voiceover = readVideoJson(videoId, 'voiceover.json');
  const visual    = readVideoJson(videoId, 'visual.json');

  if (!script)    throw new Error(`script.json tidak ditemukan untuk video ${videoId}`);
  if (!voiceover) throw new Error(`voiceover.json tidak ditemukan untuk video ${videoId}`);
  if (!visual)    throw new Error(`visual.json tidak ditemukan untuk video ${videoId}`);

  const videoDir = getVideoDir(videoId);

  if (config.dryRun) return _mockClip(videoId, correlationId, videoDir);

  // Build Python clip config
  const clipConfig = {
    video_id: videoId,
    segments:  script.segments,
    voiceover: voiceover.segments,
    footage:   visual.segments,
    title:     metadata?.title || script.topic,
    width:     config.video.width,
    height:    config.video.height,
    fps:       config.video.fps,
    full_audio_path: voiceover.full_audio_path,
    output_video:     path.join(videoDir, 'final.mp4'),
    output_thumbnail: path.join(videoDir, 'thumbnail.jpg'),
  };

  const clipConfigPath = path.join(videoDir, 'clip_config.json');
  fs.writeFileSync(clipConfigPath, JSON.stringify(clipConfig, null, 2));

  logger.info('Merender video final via Python', { agent: AGENT, step: 'render' });

  const clipResult = await _runPython('clip_agent.py', [clipConfigPath, videoDir]);

  if (!clipResult.success) {
    throw new Error(`clip_agent.py gagal: ${clipResult.error || 'unknown error'}`);
  }

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    final_video_path: clipResult.final_video_path,
    thumbnail_path: clipResult.thumbnail_path,
    duration_seconds: clipResult.duration_seconds,
    width:  config.video.width,
    height: config.video.height,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ClipOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ClipOutput gagal: ${error}`);

  writeVideoJson(videoId, 'clip.json', data);
  updateVideo(videoId, { status: 'pending_review' });

  return data;
}

// ─── Run Python script ────────────────────────────────────────────────────────

function _runPython(scriptName, args) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.paths.python, scriptName);
    const proc = spawn('python3', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '{}';
      const result = safeParseJson(lastLine, `python:${scriptName}`) || {};

      if (code !== 0) {
        logger.warn(`Python script gagal: ${scriptName}`, {
          agent: AGENT,
          error: result.error || stderr.slice(-300),
        });
      }
      resolve({ ...result, _exitCode: code });
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal spawn python3: ${err.message}`));
    });
  });
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockClip(videoId, correlationId, videoDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Clip', { agent: AGENT });

  const finalPath = path.join(videoDir, 'final.mp4');
  const thumbPath = path.join(videoDir, 'thumbnail.jpg');

  fs.writeFileSync(finalPath, 'mock-video');
  fs.writeFileSync(thumbPath, 'mock-thumbnail');

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    final_video_path: finalPath,
    thumbnail_path: thumbPath,
    duration_seconds: 45,
    width:  config.video.width,
    height: config.video.height,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'clip.json', output);
  updateVideo(videoId, { status: 'pending_review' });

  return output;
}

module.exports = { runClipAgent };
