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
  const downloadResult = await withRetry(
    () => _downloadVideo(sourceUrl, videoDir),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'downloadVideo' }
  );

  if (!downloadResult.success) {
    // Mark source as failed
    const { updateSourceVideo } = require('../../utils/db');
    try {
      insertSourceVideo({
        id: sourceVideoId,
        correlation_id: correlationId,
        source_url: sourceUrl,
        source_video_path: null,
        source_duration: null,
        channel_title: null,
        video_title: null,
        description: null,
        permission_status: 'unknown',
        allowed_to_clip: 0,
        risk_level: 'manual_review',
        risk_notes: 'Download failed',
        status: 'failed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      // Ignore if already exists
    }
    throw new Error(`Download gagal: ${downloadResult.error}`);
  }

  const videoPath = downloadResult.videoPath;
  const metadata = downloadResult.metadata;

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

function _downloadVideo(url, videoDir) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(videoDir, 'source.%(ext)s');
    const finalPath = path.join(videoDir, 'source.mp4');

    const args = [
      url,
      '-f', config.ytdlp.format,
      '-o', outputTemplate,
      '--no-playlist',
      '--write-info-json',
      '--print-json',
    ];

    // Add cookies if configured
    if (config.ytdlp.cookiesFromBrowser) {
      args.push('--cookies-from-browser', config.ytdlp.cookiesFromBrowser);
    }

    logger.info('Running yt-dlp', { agent: AGENT, command: `yt-dlp ${args.join(' ')}` });

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      logger.info('yt-dlp finished', { agent: AGENT, exitCode: code });

      if (code !== 0) {
        logger.error('yt-dlp failed', { 
          agent: AGENT, 
          exitCode: code, 
          stderr: stderr.slice(-500),
          stdout: stdout.slice(-500),
        });
        return resolve({
          success: false,
          error: `yt-dlp exit code ${code}: ${stderr.slice(-300)}`,
        });
      }

      // Parse metadata from JSON output
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '{}';
      
      let metadata;
      try {
        metadata = JSON.parse(lastLine);
      } catch (e) {
        // Fallback: read .info.json file
        const files = fs.readdirSync(videoDir);
        const infoFile = files.find(f => f.endsWith('.info.json'));
        if (infoFile) {
          const infoPath = path.join(videoDir, infoFile);
          metadata = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
          fs.unlinkSync(infoPath); // cleanup
        } else {
          logger.error('Failed to parse yt-dlp metadata', { agent: AGENT, error: e.message });
          return resolve({
            success: false,
            error: 'Failed to parse yt-dlp metadata',
          });
        }
      }

      // Locate downloaded file (ignore .part, .ytdl, .json, .txt)
      const files = fs.readdirSync(videoDir);
      const videoExts = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv'];
      const downloadedFile = files.find(f => {
        const ext = path.extname(f).toLowerCase();
        return videoExts.includes(ext) && 
               !f.includes('.part') && 
               !f.includes('.ytdl') &&
               f.startsWith('source.');
      });

      if (!downloadedFile) {
        logger.error('No video file found after download', { 
          agent: AGENT, 
          videoDir, 
          files: files.join(', '),
        });
        return resolve({
          success: false,
          error: 'No video file found after download',
        });
      }

      const downloadedPath = path.join(videoDir, downloadedFile);
      const stats = fs.statSync(downloadedPath);
      
      logger.info('Downloaded file found', { 
        agent: AGENT, 
        file: downloadedFile, 
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
      });

      // Validate file size (must be > 100KB)
      if (stats.size < 100 * 1024) {
        logger.error('Downloaded file too small', { 
          agent: AGENT, 
          file: downloadedFile, 
          size: stats.size,
        });
        return resolve({
          success: false,
          error: `Downloaded file too small: ${stats.size} bytes`,
        });
      }

      // Validate with ffprobe
      const probeResult = await _ffprobeVideo(downloadedPath);
      if (!probeResult.success) {
        logger.error('ffprobe validation failed', { 
          agent: AGENT, 
          file: downloadedFile, 
          error: probeResult.error,
        });
        return resolve({
          success: false,
          error: `ffprobe failed: ${probeResult.error}`,
        });
      }

      if (probeResult.duration < 1) {
        logger.error('Video duration too short', { 
          agent: AGENT, 
          duration: probeResult.duration,
        });
        return resolve({
          success: false,
          error: `Video duration too short: ${probeResult.duration}s`,
        });
      }

      logger.info('Downloaded file validated', { 
        agent: AGENT, 
        duration: probeResult.duration,
        format: probeResult.format,
      });

      // If not source.mp4, remux/convert
      if (downloadedFile !== 'source.mp4') {
        logger.info('Converting to source.mp4', { agent: AGENT, from: downloadedFile });
        
        const convertResult = await _convertToMp4(downloadedPath, finalPath);
        if (!convertResult.success) {
          logger.error('Conversion failed', { agent: AGENT, error: convertResult.error });
          return resolve({
            success: false,
            error: `Conversion failed: ${convertResult.error}`,
          });
        }

        // Cleanup original file
        try {
          fs.unlinkSync(downloadedPath);
        } catch (e) {
          logger.warn('Failed to cleanup original file', { agent: AGENT, error: e.message });
        }
      } else {
        // Already source.mp4, no conversion needed
        logger.info('File already source.mp4, no conversion needed', { agent: AGENT });
      }

      // Final validation of source.mp4
      const finalProbe = await _ffprobeVideo(finalPath);
      if (!finalProbe.success) {
        logger.error('Final source.mp4 validation failed', { 
          agent: AGENT, 
          error: finalProbe.error,
        });
        return resolve({
          success: false,
          error: `Final validation failed: ${finalProbe.error}`,
        });
      }

      logger.info('Final source.mp4 validated', { 
        agent: AGENT, 
        path: finalPath,
        duration: finalProbe.duration,
        size: fs.statSync(finalPath).size,
      });

      resolve({
        success: true,
        videoPath: finalPath,
        metadata: {
          duration: finalProbe.duration,
          title: metadata.title || 'Unknown',
          channel: metadata.uploader || metadata.channel || 'Unknown',
          description: (metadata.description || '').slice(0, 500),
        },
      });
    });

    proc.on('error', (err) => {
      logger.error('Failed to spawn yt-dlp', { agent: AGENT, error: err.message });
      resolve({
        success: false,
        error: `Failed to spawn yt-dlp: ${err.message}`,
      });
    });
  });
}

// ─── Validate video with ffprobe ─────────────────────────────────────────────

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
        return resolve({
          success: false,
          error: stderr.slice(-300) || 'ffprobe failed',
        });
      }

      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format?.duration || 0);
        const format = data.format?.format_name || 'unknown';

        resolve({
          success: true,
          duration,
          format,
        });
      } catch (e) {
        resolve({
          success: false,
          error: `Failed to parse ffprobe output: ${e.message}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: `Failed to spawn ffprobe: ${err.message}`,
      });
    });
  });
}

// ─── Convert video to MP4 ────────────────────────────────────────────────────

function _convertToMp4(inputPath, outputPath) {
  return new Promise((resolve) => {
    // Try copy codec first (fast)
    logger.info('Attempting fast remux with -c copy', { agent: AGENT });
    
    const procCopy = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    procCopy.stderr.on('data', (d) => { stderr += d.toString(); });

    procCopy.on('close', (code) => {
      if (code === 0) {
        logger.info('Fast remux successful', { agent: AGENT });
        return resolve({ success: true });
      }

      // Copy failed, try re-encode
      logger.warn('Fast remux failed, trying re-encode', { agent: AGENT, error: stderr.slice(-300) });
      
      const procEncode = spawn('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderrEncode = '';
      procEncode.stderr.on('data', (d) => { stderrEncode += d.toString(); });

      procEncode.on('close', (codeEncode) => {
        if (codeEncode === 0) {
          logger.info('Re-encode successful', { agent: AGENT });
          return resolve({ success: true });
        }

        logger.error('Re-encode failed', { agent: AGENT, error: stderrEncode.slice(-300) });
        resolve({
          success: false,
          error: stderrEncode.slice(-300) || 'ffmpeg re-encode failed',
        });
      });

      procEncode.on('error', (err) => {
        resolve({
          success: false,
          error: `Failed to spawn ffmpeg for re-encode: ${err.message}`,
        });
      });
    });

    procCopy.on('error', (err) => {
      resolve({
        success: false,
        error: `Failed to spawn ffmpeg for copy: ${err.message}`,
      });
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
