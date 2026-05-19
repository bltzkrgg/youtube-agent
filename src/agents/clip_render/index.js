'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const logger = require('../../utils/logger');
const { safeParseJson } = require('../../utils/safeJson');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, getVideoDir } = require('../../utils/storage');
const { getClip, updateClip } = require('../../utils/db');
const { validate, ClipRenderOutput } = require('../../schemas');

const AGENT = 'ClipRenderAgent';

// Semaphore: limit FFmpeg to 1 concurrent job
let _isProcessing = false;

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runClipRenderAgent() {
  if (_isProcessing) {
    logger.info('Clip Render Agent sedang memproses job lain, skip', { agent: AGENT });
    return;
  }

  const job = popJob('clip_render');
  if (!job) {
    logger.info('Tidak ada job clip_render di queue', { agent: AGENT });
    return;
  }

  _isProcessing = true;
  logger.info('Memulai Clip Render Agent', { agent: AGENT, jobId: job.id });

  try {
    const { clip_id, source_video_id, correlation_id } = job.payload;
    if (!clip_id) throw new Error('clip_id tidak ada di payload');
    if (!source_video_id) throw new Error('source_video_id tidak ada di payload');

    const result = await _processClipRender(clip_id, source_video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Clip Render Agent selesai', { agent: AGENT, clipId: clip_id });

    // Next: Telegram review ONLY if render succeeded (not blocked/skipped)
    if (!result.blocked && !result.skipped) {
      pushJob('telegram_clip', { clip_id, source_video_id, correlation_id: result.correlation_id }, {
        correlationId: result.correlation_id,
        priority: 'high',
      });
      logger.info('Pushed telegram_clip job for review', { agent: AGENT, clipId: clip_id });
    } else {
      logger.info('Skipped telegram_clip job (render blocked or skipped)', { 
        agent: AGENT, 
        clipId: clip_id,
        blocked: result.blocked,
        skipped: result.skipped,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger.error('Clip Render Agent gagal', {
      agent: AGENT, step: 'runClipRenderAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  } finally {
    _isProcessing = false;
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processClipRender(clipId, sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  const clipDb = getClip(clipId);

  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);
  if (!clipDb) throw new Error(`Clip ${clipId} tidak ditemukan di database`);

  // IDEMPOTENCY: Skip if already rendered or in review/approved
  if (clipDb.status === 'pending_review' || clipDb.status === 'approved' || clipDb.status === 'uploaded') {
    logger.info('Clip sudah dirender, skip', { 
      agent: AGENT, 
      clipId, 
      status: clipDb.status,
      finalVideoPath: clipDb.final_video_path 
    });
    return {
      clip_id: clipId,
      source_video_id: sourceVideoId,
      correlation_id: correlationId,
      final_video_path: clipDb.final_video_path,
      thumbnail_path: clipDb.thumbnail_path,
      status: clipDb.status,
      skipped: true,
    };
  }

  // PERMISSION GATE: Check if source video allowed to clip
  const { getSourceVideo } = require('../../utils/db');
  const sourceVideo = getSourceVideo(sourceVideoId);
  
  if (!sourceVideo) {
    throw new Error(`Source video ${sourceVideoId} tidak ditemukan di database`);
  }

  if (!sourceVideo.allowed_to_clip || sourceVideo.allowed_to_clip === 0) {
    logger.warn('Source video tidak diizinkan untuk di-clip (permission gate)', {
      agent: AGENT,
      sourceVideoId,
      clipId,
      permissionStatus: sourceVideo.permission_status,
      riskLevel: sourceVideo.risk_level,
      riskNotes: sourceVideo.risk_notes,
    });

    // Update clip status to manual_review
    updateClip(clipId, {
      status: 'manual_review',
      risk_notes: `Permission gate: ${sourceVideo.risk_notes || 'Source not allowed to clip'}`,
    });

    // Send notification to Telegram if available (skip in DRY_RUN)
    if (!config.dryRun) {
      try {
        const { notify } = require('../../bot/telegram');
        await notify(
          `⚠️ Clip ${clipId} memerlukan manual review\n\n` +
          `Source: ${sourceVideo.video_title}\n` +
          `Channel: ${sourceVideo.channel_title}\n` +
          `Permission: ${sourceVideo.permission_status}\n` +
          `Risk: ${sourceVideo.risk_level}\n\n` +
          `${sourceVideo.risk_notes}\n\n` +
          `Gunakan /approve_source ${sourceVideoId} untuk mengizinkan.`
        );
      } catch (notifyErr) {
        logger.warn('Gagal kirim notifikasi Telegram', { agent: AGENT, error: notifyErr.message });
      }
    }

    return {
      clip_id: clipId,
      source_video_id: sourceVideoId,
      correlation_id: correlationId,
      status: 'manual_review',
      blocked: true,
      reason: 'Permission gate: source not allowed to clip',
    };
  }

  const videoDir = getVideoDir(sourceVideoId);
  const clipDir = path.join(videoDir, 'clips', clipId);
  fs.mkdirSync(clipDir, { recursive: true });

  if (config.dryRun) return _mockClipRender(clipId, sourceVideoId, correlationId, clipDir);

  // Build Python clip config
  const clipConfig = {
    source_video_path: sourceIngest.source_video_path,
    start_sec: clipDb.start_sec,
    end_sec: clipDb.end_sec,
    caption_plan: clipDb.caption_plan,
    reframe_strategy: clipDb.reframe_strategy,
    width: config.video.width,
    height: config.video.height,
    fps: config.video.fps,
    output_video: path.join(clipDir, 'final.mp4'),
    output_thumbnail: path.join(clipDir, 'thumbnail.jpg'),
    work_dir: clipDir,
  };

  // Add advanced data if available (from Phase 2 agents)
  const clipPlannerData = readVideoJson(sourceVideoId, 'clip_planner.json');
  if (clipPlannerData) {
    const clipPlan = clipPlannerData.clips.find(c => c.clip_id === clipId);
    if (clipPlan) {
      if (clipPlan.captions) {
        clipConfig.captions = clipPlan.captions;
      }
      if (clipPlan.reframe_details) {
        clipConfig.reframe_details = clipPlan.reframe_details;
      }
    }
  }

  const clipConfigPath = path.join(clipDir, 'clip_config.json');
  fs.writeFileSync(clipConfigPath, JSON.stringify(clipConfig, null, 2));

  logger.info('Merender clip via Python', { agent: AGENT, clipId, step: 'render' });

  const clipResult = await _runPython('clip_render.py', [clipConfigPath]);

  if (!clipResult.success) {
    throw new Error(`clip_render.py gagal: ${clipResult.error || 'unknown error'}`);
  }

  const output = {
    clip_id: clipId,
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    final_video_path: clipResult.final_video_path,
    thumbnail_path: clipResult.thumbnail_path,
    start_sec: clipDb.start_sec,
    end_sec: clipDb.end_sec,
    duration_sec: clipResult.duration_sec,
    width: config.video.width,
    height: config.video.height,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ClipRenderOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ClipRenderOutput gagal: ${error}`);

  // Update clip in database
  updateClip(clipId, {
    final_video_path: data.final_video_path,
    thumbnail_path: data.thumbnail_path,
    status: 'pending_review',
  });

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

function _mockClipRender(clipId, sourceVideoId, correlationId, clipDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Clip Render', { agent: AGENT });

  const finalPath = path.join(clipDir, 'final.mp4');
  const thumbPath = path.join(clipDir, 'thumbnail.jpg');

  fs.writeFileSync(finalPath, 'mock-clip-video');
  fs.writeFileSync(thumbPath, 'mock-clip-thumbnail');

  const clipDb = getClip(clipId);

  const output = {
    clip_id: clipId,
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    final_video_path: finalPath,
    thumbnail_path: thumbPath,
    start_sec: clipDb.start_sec,
    end_sec: clipDb.end_sec,
    duration_sec: clipDb.end_sec - clipDb.start_sec,
    width: config.video.width,
    height: config.video.height,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  updateClip(clipId, {
    final_video_path: finalPath,
    thumbnail_path: thumbPath,
    status: 'pending_review',
  });

  return output;
}

module.exports = { runClipRenderAgent };
