'use strict';

const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { validate, OpenRouterScriptResponse, ScriptOutput } = require('../../schemas');

const AGENT = 'ScriptAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runScriptAgent() {
  const job = popJob('script');
  if (!job) {
    logger.info('Tidak ada job script di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Script Agent', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processScript(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Script Agent selesai', { agent: AGENT, videoId: video_id });

    // Next: Metadata Agent (bisa gunakan script untuk context)
    pushJob('metadata', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
    });
  } catch (err) {
    logger.error('Script Agent gagal', {
      agent: AGENT, step: 'runScriptAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processScript(videoId, correlationId) {
  const research = readVideoJson(videoId, 'research.json');
  if (!research) throw new Error(`research.json tidak ditemukan untuk video ${videoId}`);

  if (config.dryRun) return _mockScript(videoId, correlationId, research);

  logger.info('Membuat viral script via OpenRouter', { agent: AGENT, step: 'generateScript' });

  const scriptData = await withRetry(
    () => rateLimited('openrouter', () => _callOpenRouter(research), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'generateScript' }
  );

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: research.topic,
    ...scriptData,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ScriptOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ScriptOutput gagal: ${error}`);

  writeVideoJson(videoId, 'script.json', data);
  return data;
}

// ─── OpenRouter: viral script generation ─────────────────────────────────────

async function _callOpenRouter(research) {
  // Viral prompt template (user-defined)
  const prompt = `You are a professional viral video scriptwriter and cinematic editor for Indonesian social media.

TOPIC: "${research.topic}"
TRENDING REASON: "${research.trending_reason}"
KEYWORDS: ${research.keywords.join(', ')}

Create a complete SHORT-FORM viral video script (45–55 seconds total) optimized for YouTube Shorts & Instagram Reels.

STRUCTURE REQUIRED (use these exact type values in JSON):
- "hook" (0–3s): Shock or extreme curiosity. Max 12 words. Makes them FREEZE mid-scroll.
- "buildup" (3–20s): Increase tension. Drop facts that feel unbelievable.
- "climax" (20–40s): The revealing moment. Highest emotional peak.
- "cliffhanger" (40–55s): End with a question or incomplete thought that forces them to comment.

RULES:
- Use punchy, dramatic Bahasa Indonesia (Gen-Z tone + sedikit formal)
- Every sentence must increase tension or curiosity — NO flat explanations
- Make audience feel they are missing CRITICAL information if they skip
- Add pattern interrupt every 3–5 seconds (zoom hint, glitch, sound hit, silence)
- Slightly controversial, conspiracy-like tension without being fake news

For each segment, provide a visual_keyword (English, for stock footage search).
SFX options: whoosh, hit, glitch, heartbeat, silence_drop, tension_riser, none

Respond ONLY with this exact JSON structure:
{
  "hook_line": "opening hook sentence max 12 words",
  "segments": [
    {
      "index": 0,
      "type": "hook|buildup|climax|cliffhanger",
      "text": "narasi yang dibacakan",
      "visual_keyword": "english keyword for stock footage",
      "sfx": "sound effect type",
      "duration_hint_sec": 3
    }
  ],
  "full_voiceover_text": "gabungan semua narasi dari awal sampai akhir",
  "music_mood": "tense cinematic dark / upbeat energetic / mysterious ambient",
  "total_duration_sec": 50,
  "cliffhanger": "kalimat cliffhanger terakhir"
}`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model: config.openrouter.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,
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

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, 'ScriptAgent:callOpenRouter');
  if (!parsed) throw new Error('Gagal parse respons OpenRouter untuk script');

  const { success, data, error } = validate(OpenRouterScriptResponse, parsed, AGENT);
  if (!success) throw new Error(`Validasi respons script dari OpenRouter gagal: ${error}`);

  return data;
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockScript(videoId, correlationId, research) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Script', { agent: AGENT });

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: research.topic,
    hook_line: 'Kamu tidak akan bisa tidur nyenyak setelah tahu ini...',
    segments: [
      {
        index: 0, type: 'hook',
        text: 'Kamu tidak akan bisa tidur nyenyak setelah tahu ini...',
        visual_keyword: 'person lying awake dark room',
        sfx: 'silence_drop',
        duration_hint_sec: 3,
      },
      {
        index: 1, type: 'buildup',
        text: 'Setiap malam, otakmu melakukan sesuatu yang belum pernah diceritakan oleh siapapun kepadamu.',
        visual_keyword: 'brain neuron activity night',
        sfx: 'tension_riser',
        duration_hint_sec: 7,
      },
      {
        index: 2, type: 'buildup',
        text: 'Selama 90 menit pertama tidurmu, tubuhmu secara teknis sudah mati. Detak jantung melambat. Suhu tubuh turun. Dan otakmu... mulai menghapus memori yang dia anggap tidak penting.',
        visual_keyword: 'sleeping person dark eerie slow motion',
        sfx: 'heartbeat',
        duration_hint_sec: 15,
      },
      {
        index: 3, type: 'climax',
        text: 'Yang mengerikan? Kamu tidak bisa mengontrol memori mana yang dihapus. Bisa jadi wajah seseorang yang penting. Bisa jadi skill yang sudah kamu pelajari bertahun-tahun.',
        visual_keyword: 'memory fading dark dramatic',
        sfx: 'hit',
        duration_hint_sec: 12,
      },
      {
        index: 4, type: 'cliffhanger',
        text: 'Dan ada satu fase tidur yang kalau kamu lewatkan... tidak bisa dikembalikan. Kamu tau fase apa itu?',
        visual_keyword: 'question mark mystery dark',
        sfx: 'whoosh',
        duration_hint_sec: 8,
      },
    ],
    full_voiceover_text: 'Kamu tidak akan bisa tidur nyenyak setelah tahu ini... Setiap malam, otakmu melakukan sesuatu yang belum pernah diceritakan oleh siapapun kepadamu. Selama 90 menit pertama tidurmu, tubuhmu secara teknis sudah mati. Detak jantung melambat. Suhu tubuh turun. Dan otakmu... mulai menghapus memori yang dia anggap tidak penting. Yang mengerikan? Kamu tidak bisa mengontrol memori mana yang dihapus. Bisa jadi wajah seseorang yang penting. Bisa jadi skill yang sudah kamu pelajari bertahun-tahun. Dan ada satu fase tidur yang kalau kamu lewatkan... tidak bisa dikembalikan. Kamu tau fase apa itu?',
    music_mood: 'tense cinematic dark',
    total_duration_sec: 45,
    cliffhanger: 'Kamu tau fase apa itu?',
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'script.json', output);
  return output;
}

module.exports = { runScriptAgent };
