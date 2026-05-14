'use strict';

const { spawn } = require('child_process');
const path = require('path');

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
  } catch (err) {
    logger.error('Transcript Agent gagal', {
      agent: AGENT, step: 'runTranscriptAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processTranscript(sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);

  const videoPath = sourceIngest.source_video_path;

  if (config.dryRun) return _mockTranscript(sourceVideoId, correlationId);

  logger.info('Melakukan transkripsi dengan Whisper', { agent: AGENT, videoPath });

  const transcriptData = await withRetry(
    () => _runWhisper(videoPath, sourceVideoId),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'whisperTranscribe' }
  );

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

module.exports = { runTranscriptAgent };
