'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const { GoogleGenAI } = require('@google/genai');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson, getVideoDir } = require('../../utils/storage');
const { validate, VisualOutput } = require('../../schemas');

const AGENT = 'VisualAgent';

const POLL_INTERVAL_MS  = 15_000; // 15s between polls (Veo is slower than text models)
const POLL_MAX_ATTEMPTS = 240;    // max 60 minutes per clip

// Lazy-initialised Google AI client (created once, reused across calls)
let _ai = null;
function _getAI() {
  if (!_ai) {
    _ai = new GoogleGenAI({ apiKey: config.google.apiKey });
  }
  return _ai;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

async function runVisualAgent() {
  const job = popJob('visual');
  if (!job) {
    logger.info('Tidak ada job visual di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Visual Agent (Google Veo + Prompt Engineer)', { agent: AGENT, jobId: job.id });

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

// ─── Core processing ──────────────────────────────────────────────────────────

async function _processVisual(videoId, correlationId) {
  const script    = readVideoJson(videoId, 'script.json');
  const voiceover = readVideoJson(videoId, 'voiceover.json');

  if (!script)    throw new Error(`script.json tidak ditemukan untuk video ${videoId}`);
  if (!voiceover) throw new Error(`voiceover.json tidak ditemukan untuk video ${videoId}`);

  const footageDir = getVideoDir(videoId, 'footage');

  if (config.dryRun) return _mockVisual(videoId, correlationId, script, footageDir);

  // ── Step 1: Prompt Engineer — enrich all raw prompts in one LLM call ─────────
  const rawPrompts = script.segments.flatMap((seg) =>
    (seg.visual_prompts?.length ? seg.visual_prompts : [seg.visual_keyword])
      .map((p, clipIdx) => ({ segIndex: seg.index, clipIdx, raw: p }))
  );

  logger.info(`Prompt Engineer: enriching ${rawPrompts.length} prompts via LLM`, { agent: AGENT });

  const enrichedMap = await withRetry(
    () => rateLimited('openrouter', () => _enrichPrompts(rawPrompts), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'promptEngineer' }
  );

  // ── Step 2: Generate each clip with Google Veo — sequential per-segment ──────
  const visualSegments = [];

  for (const seg of script.segments) {
    const voiceSeg    = voiceover.segments.find((v) => v.index === seg.index);
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
        `Veo generate: seg ${seg.index} clip ${clipIdx + 1}/${rawList.length}`,
        { agent: AGENT, prompt: cinematicPrompt.slice(0, 80) }
      );

      await withRetry(
        () => _generateAndDownloadVeo(cinematicPrompt, outputPath),
        { maxRetry: config.maxRetry, agent: AGENT, step: `veo_seg${seg.index}_clip${clipIdx}` }
      );

      footagePaths.push(outputPath);
    }

    visualSegments.push({
      index:            seg.index,
      keyword:          seg.visual_keyword,
      footage_paths:    footagePaths,   // ← array, one path per clip
      duration_seconds: segDuration,
    });
  }

  // ── Step 3: Validate & persist ───────────────────────────────────────────────
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

// ─── Prompt Engineer (internal LLM via OpenRouter) ───────────────────────────
//
// Receives a flat list of {segIndex, clipIdx, raw} objects and returns a map
// keyed by "${segIndex}_${clipIdx}" → enriched prompt string optimised for Veo.
// Uses system+user message split for better instruction-following.
// Batching in one call keeps API cost minimal.

async function _enrichPrompts(rawPrompts) {
  await _sleep(5000); // jeda cooldown 5 detik untuk meminimalisir error 429
  const model = config.openrouter.models.visualPrompt; // text LLM via OpenRouter

  const listText = rawPrompts
    .map((p) => `[key:${p.segIndex}_${p.clipIdx}] ${p.raw}`)
    .join('\n');

  // ── System: persona & hard rules ──────────────────────────────────────────
  const systemMessage = `You are an expert prompt engineer specialising in Google Veo text-to-video generation.
Your job is to transform short scene descriptions into highly effective Veo prompts.

Veo prompt best-practices you MUST follow:
1. Structure every prompt as: [Subject + action] → [Environment/background] → [Camera motion] → [Lighting] → [Style/mood]
2. Camera motion MUST be explicit — Veo responds well to: "slow push-in", "smooth tracking shot", "static wide shot", "low-angle upward tilt", "aerial descent", "rack focus from foreground to background".
3. Frame for VERTICAL 9:16 (YouTube Shorts). Prefer close-ups, portrait compositions, tall subject framing.
4. Lighting must be concrete: "golden hour backlight", "dramatic single-source rim light", "overcast diffused light", "neon-lit night scene", "harsh midday sun casting long shadows".
5. Keep each prompt ≤ 100 words. Veo performs best with dense but concise descriptions — avoid filler words.
6. Temporal motion: describe what MOVES and HOW (e.g. "leaves swirl in slow-motion", "crowd surges forward", "lava flows downward").
7. Never include: text, subtitles, watermarks, logos, UI, animated/cartoon elements, blurry footage.
8. Style anchor: "photorealistic, cinematic 4K, shallow depth of field" unless the scene requires otherwise.

Output format — respond ONLY with valid JSON, no markdown fences, no extra keys:
{
  "prompts": {
    "segIndex_clipIdx": "enriched Veo prompt",
    ...
  }
}`;

  // ── User: the actual batch to enrich ──────────────────────────────────────
  const userMessage = `Enrich the following ${rawPrompts.length} scene description(s) into Veo-optimised prompts following your system instructions exactly.

Input:
${listText}

Return only the JSON object.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user',   content: userMessage   },
      ],
      temperature:      0.65, // slightly lower for more deterministic structured JSON
      max_tokens:       2048,
      response_format:  { type: 'json_object' }, // enforce JSON output where supported
    },
    {
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://youtube-agent.local',
        'X-Title': 'YouTube Shorts Agent',
      },
      timeout: 60000, // give more room for larger batches
    }
  );

  logger.debug('Prompt Engineer model digunakan', { agent: AGENT, model });

  const raw    = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, `${AGENT}:enrichPrompts`);
  if (!parsed?.prompts) {
    logger.warn('Prompt Engineer gagal parse — pakai raw prompts sebagai fallback', { agent: AGENT });
    return Object.fromEntries(rawPrompts.map((p) => [`${p.segIndex}_${p.clipIdx}`, p.raw]));
  }

  // Validate all expected keys are present; fill missing ones from raw
  const result = {};
  for (const p of rawPrompts) {
    const key = `${p.segIndex}_${p.clipIdx}`;
    result[key] = parsed.prompts[key] || p.raw;
  }
  return result;
}

// ─── Google Veo: generate → poll → download ───────────────────────────────────

async function _generateAndDownloadVeo(cinematicPrompt, outputPath) {
  const ai    = _getAI();
  let model = config.google.model; // e.g. 'veo-1.0'

  if (!model.startsWith('models/')) {
    model = `models/${model}`;
  }

  logger.debug(`Veo submit: model=${model}`, { agent: AGENT });

  // 1. Submit long-running video generation operation
  let operation;
  try {
    operation = await ai.models.generateVideos({
      model,
      prompt: cinematicPrompt,
      config: {
        aspectRatio:    '9:16',   // Vertical — YouTube Shorts
        numberOfVideos: 1,
      },
    });
  } catch (err) {
    if (err.status === 404 || (err.message && err.message.includes('404'))) {
      logger.warn(`Model ${model} mengembalikan 404. Fallback ke models/veo-0.9...`, { agent: AGENT });
      model = 'models/veo-0.9';
      operation = await ai.models.generateVideos({
        model,
        prompt: cinematicPrompt,
        config: {
          aspectRatio:    '9:16',
          numberOfVideos: 1,
        },
      });
    } else {
      throw err;
    }
  }

  logger.debug(`Veo operation started: ${operation.name}`, { agent: AGENT });

  // 2. Poll until done
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);
    operation = await ai.operations.getVideosOperation({ operation });

    logger.debug(
      `Veo poll [${operation.name}] attempt ${attempt + 1}: done=${operation.done}`,
      { agent: AGENT }
    );

    if (operation.done) break;
  }

  if (!operation.done) {
    throw new Error(`Veo operation timeout setelah ${POLL_MAX_ATTEMPTS} polls`);
  }

  if (operation.error) {
    throw new Error(`Veo operation gagal: ${JSON.stringify(operation.error)}`);
  }

  // 3. Download the generated video
  const generatedVideos = operation.response?.generatedVideos;
  if (!generatedVideos?.length) {
    throw new Error('Veo selesai tapi tidak ada video yang dihasilkan');
  }

  const videoUri = generatedVideos[0].video?.uri;
  if (!videoUri) throw new Error('Veo tidak mengembalikan video URI');

  await _downloadVideo(videoUri, outputPath);
  logger.info(`Veo clip saved → ${path.basename(outputPath)}`, { agent: AGENT });
}

async function _downloadVideo(url, outputPath) {
  // Append API key to authenticated Google storage URIs
  const downloadUrl = url.includes('?')
    ? `${url}&key=${config.google.apiKey}`
    : `${url}?key=${config.google.apiKey}`;

  const res = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Mock (DRY_RUN) ───────────────────────────────────────────────────────────

function _mockVisual(videoId, correlationId, script, footageDir) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Visual', { agent: AGENT });

  const segments = script.segments.map((seg) => {
    const clipCount    = seg.visual_prompts?.length || 1;
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
