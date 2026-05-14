'use strict';

const { spawn } = require('child_process');
const path = require('path');

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

    // Check if transcript is also done, then trigger clip_planner
    const transcript = readVideoJson(source_video_id, 'transcript.json');
    if (transcript) {
      logger.info('Transcript dan scene detect selesai, memulai clip planner', { agent: AGENT });
      pushJob('clip_planner', { source_video_id, correlation_id }, {
        correlationId: correlation_id,
        priority: 'normal',
      });
    }
  } catch (err) {
    logger.error('Scene Detect Agent gagal', {
      agent: AGENT, step: 'runSceneDetectAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processSceneDetect(sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);

  const videoPath = sourceIngest.source_video_path;

  if (config.dryRun) return _mockSceneDetect(sourceVideoId, correlationId);

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

module.exports = { runSceneDetectAgent };
