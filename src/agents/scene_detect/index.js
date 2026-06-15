'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const logger = require('../../utils/logger');
const { safeParseJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { validate, SceneDetectOutput } = require('../../schemas');

const AGENT = 'SceneDetectAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runSceneDetectAgent() {
  const job = popJob('scene_detect');
  if (!job) {
    logger.info('Tidak ada job scene_detect di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Scene Detect Agent', { agent: AGENT, jobId: job.id });

  try {
    const { source_video_id, correlation_id } = job.payload;
    if (!source_video_id) throw new Error('source_video_id tidak ada di payload');

    await _processSceneDetect(source_video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Scene Detect Agent selesai', { agent: AGENT, sourceVideoId: source_video_id });

    // Check if transcript is also done, then trigger clip_planner (idempotent)
    const transcript = readVideoJson(source_video_id, 'transcript.json');
    if (transcript) {
      logger.info('Transcript dan scene detect selesai, memulai clip planner', { agent: AGENT });
      _enqueueClipPlannerOnce(source_video_id, correlation_id || job.correlation_id);
    }
  } catch (err) {
    logger.error('Scene Detect Agent gagal', {
      agent: AGENT, step: 'runSceneDetectAgent',
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

async function _processSceneDetect(sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);

  const videoPath = sourceIngest.source_video_path;

  if (config.dryRun) return _mockSceneDetect(sourceVideoId, correlationId);

  // Validate source.mp4 before running SceneDetect — avoid infinite retry on corrupt file
  await _validateSourceVideo(sourceVideoId, videoPath);

  logger.info('Mendeteksi scene boundaries', { agent: AGENT, videoPath });

  const sceneData = await withRetry(
    () => _runSceneDetect(videoPath, sourceVideoId),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'sceneDetect' }
  );

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    scenes: sceneData,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(SceneDetectOutput, output, AGENT);
  if (!success) throw new Error(`Validasi SceneDetectOutput gagal: ${error}`);

  writeVideoJson(sourceVideoId, 'scene_detect.json', data);
  return data;
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

// ─── Run SceneDetect Python script ───────────────────────────────────────────

function _runSceneDetect(videoPath, sourceVideoId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.paths.python, 'scene_detect.py');
    const outputPath = path.join(config.paths.output, sourceVideoId, 'scenes_raw.json');
    const threshold = process.env.SCENE_DETECT_THRESHOLD || '27.0';

    const proc = spawn('python3', [scriptPath, videoPath, outputPath, threshold], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '{}';
      const result = safeParseJson(lastLine, `${AGENT}:sceneDetect`) || {};

      if (code !== 0 || !result.success) {
        return reject(new Error(`SceneDetect gagal: ${result.error || stderr.slice(-300)}`));
      }

      // Read the full scenes JSON
      const fs = require('fs');
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('SceneDetect output file tidak ditemukan'));
      }

      const sceneData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      resolve(sceneData);
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal spawn python3: ${err.message}`));
    });
  });
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockSceneDetect(sourceVideoId, correlationId) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Scene Detect', { agent: AGENT });

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    scenes: [
      { index: 0, start_sec: 0.0, end_sec: 8.5, duration_sec: 8.5 },
      { index: 1, start_sec: 8.5, end_sec: 18.2, duration_sec: 9.7 },
      { index: 2, start_sec: 18.2, end_sec: 32.8, duration_sec: 14.6 },
      { index: 3, start_sec: 32.8, end_sec: 45.0, duration_sec: 12.2 },
      { index: 4, start_sec: 45.0, end_sec: 58.3, duration_sec: 13.3 },
      { index: 5, start_sec: 58.3, end_sec: 75.0, duration_sec: 16.7 },
    ],
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(sourceVideoId, 'scene_detect.json', output);
  return output;
}

// ─── Idempotent clip_planner enqueue ─────────────────────────────────────────

function _enqueueClipPlannerOnce(sourceVideoId, correlationId) {
  const { getDb } = require('../../utils/db');
  
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

module.exports = { runSceneDetectAgent };
