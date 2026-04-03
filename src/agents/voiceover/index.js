'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { validate, VoiceoverOutput } = require('../../schemas');

const AGENT = 'VoiceoverAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runVoiceoverAgent() {
  const job = popJob('voiceover');
  if (!job) {
    logger.info('Tidak ada job voiceover di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Voiceover Agent', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processVoiceover(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Voiceover Agent selesai', { agent: AGENT, videoId: video_id });

    // Next: Visual Agent
    pushJob('visual', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
    });
  } catch (err) {
    logger.error('Voiceover Agent gagal', {
      agent: AGENT, step: 'runVoiceoverAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processVoiceover(videoId, correlationId) {
  const script = readVideoJson(videoId, 'script.json');
  if (!script) throw new Error(`script.json tidak ditemukan untuk video ${videoId}`);

  const audioDir = getVideoDir(videoId, 'audio');

  if (config.dryRun) return _mockVoiceover(videoId, correlationId, script, audioDir);

  logger.info(`Generating TTS untuk ${script.segments.length} segmen`, { agent: AGENT });

  const voiceoverSegments = [];

  for (const seg of script.segments) {
    const audioPath = path.join(audioDir, `seg_${seg.index}.mp3`);

    // Generate TTS for this segment
    await withRetry(
      () => rateLimited('openai_tts', () => _generateTTS(seg.text, audioPath), 500),
      { maxRetry: config.maxRetry, agent: AGENT, step: `tts_seg_${seg.index}` }
    );

    // Get exact duration via ffprobe
    const duration = _getAudioDuration(audioPath);

    voiceoverSegments.push({
      index: seg.index,
      text: seg.text,
      audio_path: audioPath,
      duration_seconds: duration,
    });

    logger.debug(`Segmen ${seg.index} TTS selesai (${duration.toFixed(1)}s)`, { agent: AGENT });
  }

  // Concatenate all segments into one full audio file
  const fullAudioPath = path.join(audioDir, 'full_voiceover.mp3');
  await _concatenateAudio(voiceoverSegments.map((s) => s.audio_path), fullAudioPath);

  const totalDuration = voiceoverSegments.reduce((sum, s) => sum + s.duration_seconds, 0);

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    segments: voiceoverSegments,
    full_audio_path: fullAudioPath,
    total_duration_seconds: parseFloat(totalDuration.toFixed(2)),
    voice: config.openai.ttsVoice,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(VoiceoverOutput, output, AGENT);
  if (!success) throw new Error(`Validasi VoiceoverOutput gagal: ${error}`);

  writeVideoJson(videoId, 'voiceover.json', data);
  return data;
}

// ─── OpenAI TTS API call ──────────────────────────────────────────────────────

async function _generateTTS(text, outputPath) {
  const res = await axios.post(
    `${config.openai.baseUrl}/audio/speech`,
    {
      model: config.openai.ttsModel,
      input: text,
      voice: config.openai.ttsVoice,
      speed: config.openai.ttsSpeed,
      response_format: 'mp3',
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(res.data));
  logger.debug(`TTS audio disimpan: ${path.basename(outputPath)}`, { agent: AGENT });
}

// ─── Get audio duration via ffprobe ──────────────────────────────────────────

function _getAudioDuration(audioPath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
    ).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

// ─── Concatenate audio files via FFmpeg ──────────────────────────────────────

async function _concatenateAudio(audioPaths, outputPath) {
  // Build FFmpeg concat filter
  const inputs = audioPaths.map((p) => `-i "${p}"`).join(' ');
  const filterComplex = audioPaths.map((_, i) => `[${i}:a]`).join('') +
    `concat=n=${audioPaths.length}:v=0:a=1[out]`;

  const cmd = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[out]" "${outputPath}" -loglevel error`;

  try {
    execSync(cmd, { stdio: 'pipe' });
    logger.debug('Audio segmen digabungkan', { agent: AGENT, output: path.basename(outputPath) });
  } catch (err) {
    throw new Error(`Gagal concatenate audio: ${err.message}`);
  }
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockVoiceover(videoId, correlationId, script, audioDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Voiceover', { agent: AGENT });

  // Create empty placeholder audio files
  const segments = script.segments.map((seg) => {
    const audioPath = path.join(audioDir, `seg_${seg.index}.mp3`);
    fs.writeFileSync(audioPath, '');
    return {
      index: seg.index,
      text: seg.text,
      audio_path: audioPath,
      duration_seconds: seg.duration_hint_sec,
    };
  });

  const fullAudioPath = path.join(audioDir, 'full_voiceover.mp3');
  fs.writeFileSync(fullAudioPath, '');

  const totalDuration = segments.reduce((s, seg) => s + seg.duration_seconds, 0);

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    segments,
    full_audio_path: fullAudioPath,
    total_duration_seconds: totalDuration,
    voice: config.openai.ttsVoice,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'voiceover.json', output);
  return output;
}

module.exports = { runVoiceoverAgent };
