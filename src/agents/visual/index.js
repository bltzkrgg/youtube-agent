'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { validate, VisualOutput } = require('../../schemas');

const AGENT = 'VisualAgent';

const KLING_BASE_URL = 'https://api.klingai.com';
const POLL_INTERVAL_MS = 10000;   // 10s between polls
const POLL_MAX_ATTEMPTS = 120;    // max 20 minutes per clip

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runVisualAgent() {
  const job = popJob('visual');
  if (!job) {
    logger.info('Tidak ada job visual di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Visual Agent (KlingAI)', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processVisual(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Visual Agent selesai', { agent: AGENT, videoId: video_id });

    // Next: Clip Agent
    pushJob('clip', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
      timeoutMs: config.timeouts.clip,
    });
  } catch (err) {
    logger.error('Visual Agent gagal', {
      agent: AGENT, step: 'runVisualAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processVisual(videoId, correlationId) {
  const script = readVideoJson(videoId, 'script.json');
  const voiceover = readVideoJson(videoId, 'voiceover.json');

  if (!script) throw new Error(`script.json tidak ditemukan untuk video ${videoId}`);
  if (!voiceover) throw new Error(`voiceover.json tidak ditemukan untuk video ${videoId}`);

  const footageDir = getVideoDir(videoId, 'footage');

  if (config.dryRun) return _mockVisual(videoId, correlationId, script, footageDir);

  const visualSegments = [];

  for (const seg of script.segments) {
    const voiceSeg = voiceover.segments.find((v) => v.index === seg.index);
    const segDuration = voiceSeg?.duration_seconds || seg.duration_hint_sec;

    logger.info(`Generating KlingAI video: "${seg.visual_keyword}" (seg ${seg.index})`, { agent: AGENT });

    const footagePath = path.join(footageDir, `seg_${seg.index}.mp4`);

    await withRetry(
      () => _generateAndDownloadKling(seg, segDuration, footagePath),
      { maxRetry: config.maxRetry, agent: AGENT, step: `kling_seg_${seg.index}` }
    );

    visualSegments.push({
      index: seg.index,
      keyword: seg.visual_keyword,
      footage_path: footagePath,
      duration_seconds: segDuration,
    });
  }

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    segments: visualSegments,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(VisualOutput, output, AGENT);
  if (!success) throw new Error(`Validasi VisualOutput gagal: ${error}`);

  writeVideoJson(videoId, 'visual.json', data);
  return data;
}

// ─── KlingAI: generate + poll + download ─────────────────────────────────────

async function _generateAndDownloadKling(seg, durationSec, outputPath) {
  const taskId = await _submitKlingTask(seg, durationSec);
  logger.debug(`KlingAI task submitted: ${taskId} (seg ${seg.index})`, { agent: AGENT });

  const videoUrl = await _pollKlingTask(taskId, seg.index);
  await _downloadKlingVideo(videoUrl, outputPath);

  logger.info(`KlingAI clip downloaded → ${path.basename(outputPath)}`, { agent: AGENT });
}

async function _submitKlingTask(seg, durationSec) {
  const prompt = _buildPrompt(seg.visual_keyword);
  const clipDuration = config.kling.duration; // '5' or '10'

  const body = {
    model: config.kling.model,
    prompt,
    negative_prompt: 'text, subtitles, watermark, logo, blurry, low quality, cartoon, animation, nsfw',
    cfg_scale: 0.5,
    mode: config.kling.mode,
    aspect_ratio: '9:16',
    duration: clipDuration,
  };

  const res = await axios.post(
    `${KLING_BASE_URL}/v1/videos/text2video`,
    body,
    {
      headers: {
        Authorization: `Bearer ${_generateToken()}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (res.data?.code !== 0) {
    throw new Error(`KlingAI submit error: ${res.data?.message || JSON.stringify(res.data)}`);
  }

  const taskId = res.data?.data?.task_id;
  if (!taskId) throw new Error('KlingAI tidak mengembalikan task_id');

  return taskId;
}

async function _pollKlingTask(taskId, segIndex) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);

    const res = await axios.get(
      `${KLING_BASE_URL}/v1/videos/text2video/${taskId}`,
      {
        headers: { Authorization: `Bearer ${_generateToken()}` },
        timeout: 15000,
      }
    );

    const taskData = res.data?.data;
    const status = taskData?.task_status;

    logger.debug(`KlingAI poll [seg ${segIndex}] attempt ${attempt + 1}: ${status}`, { agent: AGENT });

    if (status === 'succeed') {
      const videoUrl = taskData?.task_result?.videos?.[0]?.url;
      if (!videoUrl) throw new Error('KlingAI succeed tapi tidak ada video URL');
      return videoUrl;
    }

    if (status === 'failed') {
      const msg = taskData?.task_status_msg || 'unknown error';
      throw new Error(`KlingAI task gagal: ${msg}`);
    }

    // status: 'submitted' | 'processing' — continue polling
  }

  throw new Error(`KlingAI task ${taskId} timeout setelah ${POLL_MAX_ATTEMPTS} polls`);
}

async function _downloadKlingVideo(url, outputPath) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
  });

  fs.writeFileSync(outputPath, Buffer.from(res.data));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _buildPrompt(visualKeyword) {
  return `${visualKeyword}. Cinematic, dramatic lighting, high quality, smooth motion, no text, no watermark`;
}

/**
 * Generate KlingAI JWT token (HS256) from access_key + secret_key.
 * Token valid for 30 minutes.
 */
function _generateToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = _b64url(JSON.stringify({
    iss: config.kling.accessKey,
    exp: now + 1800,
    nbf: now - 5,
  }));
  const signature = crypto
    .createHmac('sha256', config.kling.secretKey)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function _b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockVisual(videoId, correlationId, script, footageDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Visual', { agent: AGENT });

  const segments = script.segments.map((seg) => {
    const footagePath = path.join(footageDir, `seg_${seg.index}.mp4`);
    fs.writeFileSync(footagePath, ''); // placeholder
    return {
      index: seg.index,
      keyword: seg.visual_keyword,
      footage_path: footagePath,
      duration_seconds: seg.duration_hint_sec,
    };
  });

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    segments,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'visual.json', output);
  return output;
}

module.exports = { runVisualAgent };
