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

// Max seconds of narration per single visual clip.
// Longer segments are auto-split into multiple visual_prompts.
const MAX_SEC_PER_CLIP = 5;

// Approximate Indonesian speech rate (syllables/sec → chars/sec ≈ 14)
const CHARS_PER_SEC = 14;

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

    // Spawn both metadata and voiceover in parallel — they don't depend on each other
    for (const type of ['metadata', 'voiceover']) {
      pushJob(type, { video_id, correlation_id: result.correlation_id }, {
        correlationId: result.correlation_id,
        priority: 'normal',
      });
    }
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

  logger.info('Membuat viral script via OpenRouter', { agent: AGENT, topic: research.topic });

  const scriptData = await withRetry(
    () => rateLimited('openrouter', () => _callLLM(research), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'generateScript' }
  );

  // Post-process: generate visual_prompts array for each segment
  const segments = scriptData.segments.map((seg) => ({
    ...seg,
    visual_prompts: _buildVisualPrompts(seg),
  }));

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: research.topic,
    ...scriptData,
    segments,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ScriptOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ScriptOutput gagal: ${error}`);

  writeVideoJson(videoId, 'script.json', data);
  return data;
}

// ─── Visual prompts builder ───────────────────────────────────────────────────
//
// For long segments (> MAX_SEC_PER_CLIP), create multiple prompts so the
// visual editor can use a fresh clip every ~5 seconds — keeps pacing dynamic.

function _buildVisualPrompts(seg) {
  // If LLM already provided visual_prompts, trust it (it might have done the split itself)
  if (Array.isArray(seg.visual_prompts) && seg.visual_prompts.length > 0) {
    return seg.visual_prompts;
  }

  const duration = seg.duration_hint_sec || Math.ceil(seg.text.length / CHARS_PER_SEC);
  const clipCount = Math.max(1, Math.ceil(duration / MAX_SEC_PER_CLIP));

  if (clipCount === 1) return [seg.visual_keyword];

  // Generate distinct angle variants from the base keyword
  const angleVariants = [
    `${seg.visual_keyword}, wide establishing shot, cinematic`,
    `${seg.visual_keyword}, close-up dramatic, shallow depth of field`,
    `${seg.visual_keyword}, extreme close-up, slow motion, high contrast`,
    `${seg.visual_keyword}, overhead bird's eye view, moody lighting`,
    `${seg.visual_keyword}, low angle dramatic, dark vignette`,
  ];

  return angleVariants.slice(0, clipCount);
}

// ─── LLM: viral script generation ────────────────────────────────────────────

async function _callLLM(research) {
  const model = config.openrouter.models.script; // ← always from config

  const prompt = `Kamu adalah scriptwriter konten viral YouTube Shorts Indonesia.

TOPIK: "${research.topic}"
ALASAN TRENDING: "${research.trending_reason}"
KEYWORDS: ${research.keywords.join(', ')}

Tulis script video Shorts (45–55 detik total) dalam Bahasa Indonesia informal/Gen-Z.
DILARANG KERAS menulis script lebih dari 100 kata. Target durasi suara adalah 45-50 detik agar aman dari batas 60 detik YouTube Shorts.
Fokus utama: CURIOSITY GAP — buat penonton TIDAK BISA stop nonton karena merasa ketinggalan info penting.

═══ STRUKTUR WAJIB ═══
Wajib menghasilkan format JSON murni dengan field visual_keyword di setiap segmen.
DILARANG KERAS menggunakan tipe segmen di luar daftar: hook, buildup, climax, cliffhanger.

1. hook (0–3 detik)
   - Maksimal 10 kata. Mulai dengan fakta mengejutkan atau pertanyaan retoris.
   - Contoh tone: "Gue baru tau ini dan langsung deg-degan...", "Ini yang paling gue takutin dari..."
   - HARUS bikin orang freeze scroll dalam 2 detik pertama.

2. buildup (3–20 detik, boleh 2–3 segmen)
   - Bangun tensi perlahan. Setiap kalimat harus lebih mengejutkan dari sebelumnya.
   - Gunakan jeda dramatis: "Dan yang lebih gila lagi...", "Tapi tunggu dulu..."
   - Drop fakta yang terasa tidak masuk akal tapi nyata.
   - TIPE HARUS "buildup" — BUKAN "buildup_dramatic", "buildup_2", atau varian apapun.

3. climax (20–40 detik)
   - Momen puncak reveal. Tulis seolah-olah rahasia besar baru dibuka.
   - Gunakan kalimat pendek yang berdampak. Boleh ada "..." untuk jeda.

4. cliffhanger (40–55 detik)
   - Akhiri dengan pertanyaan atau pernyataan yang tidak lengkap.
   - Paksa penonton tulis komentar atau nonton ulang.
   - Contoh: "Dan yang paling mengerikan? Itu terjadi setiap malam ke kamu juga. Kamu sadar?"

═══ SFX WAJIB DI MOMEN DRAMATIS ═══
Pilih SFX yang cocok untuk setiap segmen:
- hook → "whoosh" atau "hit" (attention grabber)
- buildup awal → "tension_riser"
- buildup dramatis → "heartbeat"
- climax → "hit" atau "glitch"
- cliffhanger → "whoosh"

═══ VISUAL PROMPTS ═══
Untuk setiap segmen, buat visual_prompts: array string berisi prompt AI video/image.
- Setiap prompt MAKSIMAL untuk klip 5 detik
- Jika duration_hint_sec > 5, buat 2–3 prompt berbeda untuk variasi visual
- Setiap prompt harus spesifik: subjek, aksi, mood, pencahayaan, gaya kamera
- Tulis dalam Bahasa Inggris
- Contoh: ["extreme close-up of sleeping human face, dark dramatic lighting, slow zoom in", "brain neurons firing rapidly, dark background, cinematic blue glow"]

═══ FORMAT JSON (hanya JSON, tanpa teks lain) ═══
ATURAN KRITIS:
- "type" HANYA boleh berisi salah satu dari: "hook", "buildup", "climax", "cliffhanger"
- "visual_keyword" WAJIB ADA di setiap segmen tanpa pengecualian (string bahasa Inggris, fallback untuk stock footage)
- Jangan tambahkan field diluar schema di bawah

{
  "hook_line": "kalimat hook maks 10 kata",
  "segments": [
    {
      "index": 0,
      "type": "hook",
      "text": "narasi yang akan dibacakan TTS",
      "visual_keyword": "WAJIB: english keyword for stock footage (contoh: dark room person shocked)",
      "visual_prompts": ["AI video prompt 1", "AI video prompt 2"],
      "sfx": "whoosh",
      "duration_hint_sec": 3
    }
  ],
  "full_voiceover_text": "seluruh narasi dari hook sampai cliffhanger, sambung semua segmen",
  "music_mood": "tense cinematic dark | mysterious ambient | dark energetic",
  "total_duration_sec": 50,
  "cliffhanger": "kalimat terakhir cliffhanger"
}`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.88,
      max_tokens: 2500,
      response_format: { type: 'json_object' }, // paksa output JSON murni
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

  logger.debug('LLM model digunakan untuk script', { agent: AGENT, model });

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, 'ScriptAgent:callLLM');
  if (!parsed) throw new Error('Gagal parse respons LLM untuk script');

  const { success, data, error } = validate(OpenRouterScriptResponse, parsed, AGENT);
  if (!success) throw new Error(`Validasi script dari LLM gagal: ${error}`);

  return data;
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockScript(videoId, correlationId, research) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Script', { agent: AGENT });

  const segments = [
    {
      index: 0, type: 'hook',
      text: 'Gue baru tau ini dan langsung gak bisa tidur...',
      visual_keyword: 'person lying awake dark room shocked',
      visual_prompts: [
        'close-up of wide open eyes in darkness, dramatic lighting, slow zoom in, cinematic',
      ],
      sfx: 'hit',
      duration_hint_sec: 3,
    },
    {
      index: 1, type: 'buildup',
      text: 'Setiap malam, otakmu melakukan sesuatu yang belum pernah ada yang kasih tau ke kamu.',
      visual_keyword: 'brain neuron activity night glow',
      visual_prompts: [
        'neurons firing in slow motion, dark blue background, cinematic glow',
        'top-down view of sleeping person, eerie dark room, minimal light',
      ],
      sfx: 'tension_riser',
      duration_hint_sec: 7,
    },
    {
      index: 2, type: 'buildup',
      text: 'Selama 90 menit pertama tidur, tubuhmu teknis udah mati. Detak jantung melambat. Suhu turun. Dan otakmu... mulai hapus memori yang dia rasa gak penting.',
      visual_keyword: 'sleeping dark eerie slow heartbeat monitor',
      visual_prompts: [
        'heartbeat monitor flatline slow, dramatic red light, hospital dark setting',
        'close-up of human hand going limp, slow motion, dark cold lighting',
        'brain scan MRI glowing, memories dissolving digital effect, cinematic',
      ],
      sfx: 'heartbeat',
      duration_hint_sec: 15,
    },
    {
      index: 3, type: 'climax',
      text: 'Yang bikin gue merinding? Kamu gak bisa kontrol memori mana yang dihapus. Bisa wajah orang penting. Bisa skill yang udah kamu pelajari bertahun-tahun.',
      visual_keyword: 'memory fading dark dramatic glitch',
      visual_prompts: [
        'photo dissolving into dust particles, dark dramatic, slow motion close-up',
        'glitch effect on human face portrait, digital distortion, dark background',
      ],
      sfx: 'glitch',
      duration_hint_sec: 12,
    },
    {
      index: 4, type: 'cliffhanger',
      text: 'Dan ada satu fase tidur yang kalau kamu lewatin... gak bisa dikembaliin selamanya. Kamu tau fase apa itu?',
      visual_keyword: 'mystery dark question suspense dramatic',
      visual_prompts: [
        'dark corridor with single light at end, slow push-in camera, cinematic suspense',
      ],
      sfx: 'whoosh',
      duration_hint_sec: 8,
    },
  ];

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: research.topic,
    hook_line: 'Gue baru tau ini dan langsung gak bisa tidur...',
    segments,
    full_voiceover_text: segments.map((s) => s.text).join(' '),
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
