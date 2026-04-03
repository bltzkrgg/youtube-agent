'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');
const { withCache } = require('../../utils/cache');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { validate, VisualOutput } = require('../../schemas');

const AGENT = 'VisualAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runVisualAgent() {
  const job = popJob('visual');
  if (!job) {
    logger.info('Tidak ada job visual di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Visual Agent (Pexels)', { agent: AGENT, jobId: job.id });

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

    logger.info(`Mencari footage: "${seg.visual_keyword}" (seg ${seg.index})`, { agent: AGENT });

    const footagePath = await withRetry(
      () => rateLimited('pexels', () => _fetchAndDownloadFootage(
        seg.visual_keyword,
        footageDir,
        seg.index,
        segDuration
      ), 1200),
      { maxRetry: config.maxRetry, agent: AGENT, step: `visual_seg_${seg.index}` }
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

// ─── Pexels: search + download ────────────────────────────────────────────────

async function _fetchAndDownloadFootage(keyword, footageDir, segIndex, durationSec) {
  const cacheKey = `pexels_${keyword.toLowerCase().replace(/\s+/g, '_')}`;

  // Cache Pexels search results (same keyword → same video ID)
  const videoMeta = await withCache(cacheKey, async () => {
    return _searchPexels(keyword);
  }, config.cacheTtlHours);

  if (!videoMeta) throw new Error(`Tidak ada footage untuk keyword: ${keyword}`);

  const outputPath = path.join(footageDir, `seg_${segIndex}.mp4`);

  // Re-download if file doesn't exist (cache stores metadata only)
  if (!fs.existsSync(outputPath)) {
    await _downloadFile(videoMeta.download_url, outputPath);
  }

  return outputPath;
}

async function _searchPexels(keyword) {
  // Try portrait first, fallback to landscape
  for (const orientation of ['portrait', 'landscape']) {
    const res = await axios.get(`${config.pexels.baseUrl}/search`, {
      headers: { Authorization: config.pexels.apiKey },
      params: {
        query: keyword,
        per_page: 10,
        orientation,
        size: 'large',
      },
      timeout: 15000,
    });

    const videos = res.data?.videos || [];
    if (videos.length === 0) continue;

    // Pick the first video with a usable file
    for (const video of videos) {
      const file = _pickBestVideoFile(video.video_files, orientation);
      if (file) {
        logger.debug(`Pexels hit: "${keyword}" → video ${video.id} (${orientation})`, { agent: AGENT });
        return {
          pexels_id: video.id,
          download_url: file.link,
          width: file.width,
          height: file.height,
        };
      }
    }
  }

  return null;
}

function _pickBestVideoFile(files, preferredOrientation) {
  if (!files || files.length === 0) return null;

  // Filter: prefer portrait (height > width) for Shorts
  const isPortrait = (f) => f.height > f.width;
  const isLandscape = (f) => f.width >= f.height;

  const preferred = preferredOrientation === 'portrait'
    ? files.filter(isPortrait)
    : files.filter(isLandscape);

  const pool = preferred.length > 0 ? preferred : files;

  // Pick highest quality under 1080p
  const sorted = pool
    .filter((f) => f.file_type === 'video/mp4')
    .filter((f) => Math.max(f.width, f.height) <= 1920)
    .sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height));

  return sorted[0] || null;
}

async function _downloadFile(url, outputPath) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { Authorization: config.pexels.apiKey },
  });

  fs.writeFileSync(outputPath, Buffer.from(res.data));
  logger.debug(`Footage didownload: ${path.basename(outputPath)} (${_fmtBytes(res.data.byteLength)})`,
    { agent: AGENT });
}

function _fmtBytes(b) {
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
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
