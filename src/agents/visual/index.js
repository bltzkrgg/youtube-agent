'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { validate, VisualOutput } = require('../../schemas');

const AGENT = 'VisualAgent';

const KLING_BASE_URL   = 'https://api.klingai.com';
const POLL_INTERVAL_MS = 10_000; // 10s between polls
const POLL_MAX_ATTEMPTS = 120;   // max 20 minutes per clip

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runVisualAgent() {
  const job = popJob('visual');
  if (!job) {
    logger.info('Tidak ada job visual di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Visual Agent (KlingAI + Prompt Engineer)', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processVisual(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Visual Agent selesai', { agent: AGENT, videoId: video_id });

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
  const script    = readVideoJson(videoId, 'script.json');
  const voiceover = readVideoJson(videoId, 'voiceover.json');

  if (!script)    throw new Error(`script.json tidak ditemukan untuk video ${videoId}`);
  if (!voiceover) throw new Error(`voiceover.json tidak ditemukan untuk video ${videoId}`);

  const footageDir = getVideoDir(videoId, 'footage');

  if (config.dryRun) return _mockVisual(videoId, correlationId, script, footageDir);

  // ── Step 1: Prompt Engineer — enrich all raw prompts in one LLM call ────────
  const rawPrompts = script.segments.flatMap((seg) =>
    (seg.visual_prompts?.length ? seg.visual_prompts : [seg.visual_keyword])
      .map((p, clipIdx) => ({ segIndex: seg.index, clipIdx, raw: p }))
  );

  logger.info(`Prompt Engineer: enriching ${rawPrompts.length} prompts via LLM`, { agent: AGENT });

  const enrichedMap = await withRetry(
    () => rateLimited('openrouter', () => _enrichPrompts(rawPrompts), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'promptEngineer' }
  );

  // ── Step 2: Generate each clip with KlingAI — sequential per-segment ────────
  const visualSegments = [];

  for (const seg of script.segments) {
    const voiceSeg  = voiceover.segments.find((v) => v.index === seg.index);
    const segDuration = voiceSeg?.duration_seconds || seg.duration_hint_sec;

    const rawList = seg.visual_prompts?.length
      ? seg.visual_prompts
      : [seg.visual_keyword];

    const footagePaths = [];

    for (let clipIdx = 0; clipIdx < rawList.length; clipIdx++) {
      const key             = `${seg.index}_${clipIdx}`;
      const cinematicPrompt = enrichedMap[key] || rawList[clipIdx];
      const outputPath      = path.join(footageDir, `seg_${seg.index}_clip_${clipIdx}.mp4`);

      logger.info(
        `KlingAI generate: seg ${seg.index} clip ${clipIdx + 1}/${rawList.length}`,
        { agent: AGENT, prompt: cinematicPrompt.slice(0, 80) }
      );

      await withRetry(
        () => _generateAndDownload(cinematicPrompt, outputPath),
        { maxRetry: config.maxRetry, agent: AGENT, step: `kling_seg${seg.index}_clip${clipIdx}` }
      );

      footagePaths.push(outputPath);
    }

    visualSegments.push({
      index:            seg.index,
      keyword:          seg.visual_keyword,
      footage_paths:    footagePaths,    // ← array, one path per clip
      duration_seconds: segDuration,
    });
  }

  // ── Step 3: Validate & persist ──────────────────────────────────────────────
  const output = {
    video_id:       videoId,
    correlation_id: correlationId,
    segments:       visualSegments,
    version:        '1.0',
    created_at:     new Date().toISOString(),
  };

  const { success, data, error } = validate(VisualOutput, output, AGENT);
  if (!success) throw new Error(`Validasi VisualOutput gagal: ${error}`);

  writeVideoJson(videoId, 'visual.json', data);
  return data;
}

// ─── Prompt Engineer (internal LLM) ─────────────────────────────────────────
//
// Receives a flat list of {segIndex, clipIdx, raw} objects and returns a map
// keyed by "${segIndex}_${clipIdx}" → enriched cinematic prompt string.
// Batching in one call keeps API cost minimal.

async function _enrichPrompts(rawPrompts) {
  const model = config.openrouter.models.visualPrompt; // ← from config, never hardcoded

  const listText = rawPrompts
    .map((p, i) => `${i}. [key:${p.segIndex}_${p.clipIdx}] ${p.raw}`)
    .join('\n');

  const prompt = `You are a cinematic AI video prompt engineer.
Transform each short description below into a rich, detailed AI video generation prompt.

Requirements for every prompt:
- Style: cinematic, dramatic, photorealistic
- Resolution hint: 4K, ultra-detailed
- Lighting: specify (e.g. rim light, volumetric light, dramatic shadows, golden hour)
- Mood: moody, atmospheric, emotionally charged
- Camera: specify angle and movement (e.g. slow push-in, low angle, bird's eye, rack focus)
- Subject: describe clearly with texture and color details
- Negative elements to avoid: no text, no watermark, no cartoon, no blurry
- Keep it under 120 words per prompt

Input prompts:
${listText}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "prompts": {
    "segIndex_clipIdx": "enriched cinematic prompt here",
    ...
  }
}`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
    },
    {
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://youtube-agent.local',
        'X-Title': 'YouTube Shorts Agent',
      },
      timeout: 45000,
    }
  );

  logger.debug('Prompt Engineer model digunakan', { agent: AGENT, model });

  const raw    = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, `${AGENT}:enrichPrompts`);
  if (!parsed?.prompts) {
    logger.warn('Prompt Engineer gagal parse — pakai raw prompts sebagai fallback', { agent: AGENT });
    // Return identity map so downstream still works
    return Object.fromEntries(rawPrompts.map((p) => [`${p.segIndex}_${p.clipIdx}`, p.raw]));
  }

  return parsed.prompts;
}

// ─── KlingAI: generate → poll → download ─────────────────────────────────────

async function _generateAndDownload(cinematicPrompt, outputPath) {
  const taskId = await _submitKlingTask(cinematicPrompt);
  logger.debug(`KlingAI task submitted: ${taskId}`, { agent: AGENT });

  const videoUrl = await _pollKlingTask(taskId);
  await _downloadVideo(videoUrl, outputPath);

  logger.info(`KlingAI clip saved → ${path.basename(outputPath)}`, { agent: AGENT });
}

async function _submitKlingTask(cinematicPrompt) {
  const res = await axios.post(
    `${KLING_BASE_URL}/v1/videos/text2video`,
    {
      model:           config.kling.model,
      prompt:          cinematicPrompt,
      negative_prompt: 'text, subtitles, watermark, logo, blurry, low quality, cartoon, animation, nsfw',
      cfg_scale:       0.5,
      mode:            config.kling.mode,
      aspect_ratio:    '9:16',
      duration:        config.kling.duration,
    },
    {
      headers: {
        Authorization:  `Bearer ${_generateToken()}`,
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

async function _pollKlingTask(taskId) {
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
    const status   = taskData?.task_status;

    logger.debug(`KlingAI poll [${taskId}] attempt ${attempt + 1}: ${status}`, { agent: AGENT });

    if (status === 'succeed') {
      const videoUrl = taskData?.task_result?.videos?.[0]?.url;
      if (!videoUrl) throw new Error('KlingAI succeed tapi tidak ada video URL');
      return videoUrl;
    }

    if (status === 'failed') {
      throw new Error(`KlingAI task gagal: ${taskData?.task_status_msg || 'unknown'}`);
    }
    // 'submitted' | 'processing' → keep polling
  }

  throw new Error(`KlingAI task ${taskId} timeout setelah ${POLL_MAX_ATTEMPTS} polls`);
}

async function _downloadVideo(url, outputPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
}

// ─── KlingAI JWT (HS256) ─────────────────────────────────────────────────────

function _generateToken() {
  const now     = Math.floor(Date.now() / 1000);
  const header  = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = _b64url(JSON.stringify({ iss: config.kling.accessKey, exp: now + 1800, nbf: now - 5 }));
  const sig     = crypto
    .createHmac('sha256', config.kling.secretKey)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function _b64url(str) { return Buffer.from(str).toString('base64url'); }
function _sleep(ms)   { return new Promise((r) => setTimeout(r, ms)); }

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockVisual(videoId, correlationId, script, footageDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Visual', { agent: AGENT });

  const segments = script.segments.map((seg) => {
    const clipCount   = seg.visual_prompts?.length || 1;
    const footagePaths = Array.from({ length: clipCount }, (_, i) => {
      const p = path.join(footageDir, `seg_${seg.index}_clip_${i}.mp4`);
      fs.writeFileSync(p, ''); // placeholder file
      return p;
    });

    return {
      index:            seg.index,
      keyword:          seg.visual_keyword,
      footage_paths:    footagePaths,
      duration_seconds: seg.duration_hint_sec,
    };
  });

  const output = {
    video_id:       videoId,
    correlation_id: correlationId,
    segments,
    version:        '1.0',
    created_at:     new Date().toISOString(),
  };

  writeVideoJson(videoId, 'visual.json', output);
  return output;
}

module.exports = { runVisualAgent };
