'use strict';

const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { writeVideoJson, getVideoDir } = require('../../utils/storage');
const { insertSourceVideo } = require('../../utils/db');
const { validate, SourceIngestOutput } = require('../../schemas');

const AGENT = 'SourceIngestAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runSourceIngestAgent() {
  const job = popJob('source_ingest');
  if (!job) {
    logger.info('Tidak ada job source_ingest di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Source Ingest Agent', { agent: AGENT, jobId: job.id });

  try {
    const result = await _processSourceIngest(job);
    ackJob(job.id);
    logger.info('Source Ingest Agent selesai', { agent: AGENT, sourceVideoId: result.source_video_id });

    // Next: Transcript + SceneDetect (parallel)
    for (const type of ['transcript', 'scene_detect']) {
      pushJob(type, { source_video_id: result.source_video_id, correlation_id: result.correlation_id }, {
        correlationId: result.correlation_id,
        priority: 'normal',
      });
    }
  } catch (err) {
    logger.error('Source Ingest Agent gagal', {
      agent: AGENT, step: 'runSourceIngestAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processSourceIngest(job) {
  const correlationId = job.payload?.correlation_id || job.correlation_id;
  const sourceUrl = job.payload?.source_url;

  if (!sourceUrl) throw new Error('source_url tidak ada di payload');

  // IDEMPOTENCY: Check if source URL already processed
  const { getDb } = require('../../utils/db');
  const existing = getDb().prepare(`
    SELECT id, status FROM source_videos 
    WHERE source_url = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get(sourceUrl);

  if (existing) {
    if (existing.status === 'processing' || existing.status === 'completed') {
      logger.info('Source URL sudah diproses, skip', { 
        agent: AGENT, 
        sourceUrl, 
        existingId: existing.id,
        status: existing.status 
      });
      return {
        source_video_id: existing.id,
        correlation_id: correlationId,
        skipped: true,
      };
    }
    // If failed, allow retry with new ID
    logger.info('Source URL pernah gagal, retry dengan ID baru', { 
      agent: AGENT, 
      sourceUrl, 
      previousId: existing.id 
    });
  }

  const sourceVideoId = uuidv4();
  const videoDir = getVideoDir(sourceVideoId);

  if (config.dryRun) return _mockSourceIngest(sourceVideoId, correlationId, sourceUrl, videoDir);

  logger.info('Mengunduh video dari YouTube', { agent: AGENT, sourceUrl });

  // Download video using yt-dlp
  const videoPath = path.join(videoDir, 'source.mp4');
  const metadata = await withRetry(
    () => _downloadVideo(sourceUrl, videoPath),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'downloadVideo' }
  );

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    source_url: sourceUrl,
    source_video_path: videoPath,
    source_duration: metadata.duration,
    channel_title: metadata.channel,
    video_title: metadata.title,
    description: metadata.description,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(SourceIngestOutput, output, AGENT);
  if (!success) throw new Error(`Validasi SourceIngestOutput gagal: ${error}`);

  writeVideoJson(sourceVideoId, 'source_ingest.json', data);
  
  // Default permission/risk settings
  const defaultPermission = {
    permission_status: 'unknown',
    allowed_to_clip: 0,
    risk_level: 'manual_review',
    risk_notes: 'Source permission not verified',
  };
  
  // Insert with UNIQUE constraint handling
  try {
    insertSourceVideo({
      id: sourceVideoId,
      correlation_id: correlationId,
      source_url: sourceUrl,
      source_video_path: videoPath,
      source_duration: metadata.duration,
      channel_title: metadata.channel,
      video_title: metadata.title,
      description: metadata.description,
      ...defaultPermission,
      status: 'processing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (insertErr) {
    // Handle UNIQUE constraint violation (concurrent insert)
    if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
      logger.warn('Concurrent insert detected, using existing source_video', {
        agent: AGENT,
        sourceUrl,
        error: insertErr.message,
      });
      // Re-check for existing source_video
      const { getDb } = require('../../utils/db');
      const existing = getDb().prepare(`
        SELECT id FROM source_videos WHERE source_url = ? LIMIT 1
      `).get(sourceUrl);
      if (existing) {
        return {
          source_video_id: existing.id,
          correlation_id: correlationId,
          skipped: true,
          reason: 'concurrent_insert',
        };
      }
    }
    throw insertErr;
  }

  return data;
}

// ─── Download video with yt-dlp ──────────────────────────────────────────────

function _downloadVideo(url, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', outputPath,
      '--no-playlist',
      '--write-info-json',
      '--print-json',
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp gagal (exit ${code}): ${stderr.slice(-300)}`));
      }

      // Parse JSON output from yt-dlp
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '{}';
      
      let metadata;
      try {
        metadata = JSON.parse(lastLine);
      } catch (e) {
        // Fallback: read .info.json file
        const infoPath = outputPath.replace('.mp4', '.info.json');
        if (fs.existsSync(infoPath)) {
          metadata = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
          fs.unlinkSync(infoPath); // cleanup
        } else {
          return reject(new Error('Gagal parse metadata dari yt-dlp'));
        }
      }

      resolve({
        duration: metadata.duration || 0,
        title: metadata.title || 'Unknown',
        channel: metadata.uploader || metadata.channel || 'Unknown',
        description: (metadata.description || '').slice(0, 500),
      });
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal spawn yt-dlp: ${err.message}`));
    });
  });
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockSourceIngest(sourceVideoId, correlationId, sourceUrl, videoDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Source Ingest', { agent: AGENT });

  const videoPath = path.join(videoDir, 'source.mp4');
  fs.writeFileSync(videoPath, 'mock-source-video');

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    source_url: sourceUrl,
    source_video_path: videoPath,
    source_duration: 180.5,
    channel_title: 'Mock Channel',
    video_title: 'Mock Video Title - Fakta Unik Indonesia',
    description: 'Mock description for testing',
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(sourceVideoId, 'source_ingest.json', output);
  
  // Default permission/risk settings (same as real mode)
  const defaultPermission = {
    permission_status: 'unknown',
    allowed_to_clip: 0,
    risk_level: 'manual_review',
    risk_notes: 'Source permission not verified',
  };
  
  // Insert with UNIQUE constraint handling
  try {
    insertSourceVideo({
      id: sourceVideoId,
      correlation_id: correlationId,
      source_url: sourceUrl,
      source_video_path: videoPath,
      source_duration: 180.5,
      channel_title: 'Mock Channel',
      video_title: 'Mock Video Title',
      description: 'Mock description',
      ...defaultPermission,
      status: 'processing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (insertErr) {
    // Handle UNIQUE constraint violation (concurrent insert)
    if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
      logger.warn('[DRY_RUN] Concurrent insert detected, using existing source_video', {
        agent: AGENT,
        sourceUrl,
      });
      const { getDb } = require('../../utils/db');
      const existing = getDb().prepare(`
        SELECT id FROM source_videos WHERE source_url = ? LIMIT 1
      `).get(sourceUrl);
      if (existing) {
        return {
          source_video_id: existing.id,
          correlation_id: correlationId,
          skipped: true,
          reason: 'concurrent_insert',
        };
      }
    }
    throw insertErr;
  }

  return output;
}

// ─── Manual trigger ───────────────────────────────────────────────────────────

async function triggerSourceIngest(sourceUrl) {
  const correlationId = uuidv4();
  pushJob('source_ingest', { source_url: sourceUrl, correlation_id: correlationId }, {
    correlationId,
    priority: 'high',
    timeoutMs: config.timeouts.default,
  });
  logger.info('Source ingest job ditambahkan manual', { agent: AGENT, correlationId, sourceUrl });
  await runSourceIngestAgent();
}

module.exports = { runSourceIngestAgent, triggerSourceIngest };
