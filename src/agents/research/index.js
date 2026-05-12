'use strict';

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { withCache } = require('../../utils/cache');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { writeVideoJson, getVideoDir } = require('../../utils/storage');
const { insertVideo } = require('../../utils/db');
const { validate, OpenRouterTopicsResponse, ResearchOutput } = require('../../schemas');

// Lazy-loaded — Memory Agent might not exist yet on first run
const getTopTopics = () => {
  try { return require('../memory').getTopTopics(5); } catch { return []; }
};

const AGENT = 'ResearchAgent';
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_YT_RESULTS = 25; // per query, stays within free quota

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runResearchAgent() {
  const job = popJob('research');
  if (!job) {
    logger.info('Tidak ada job research di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Research Agent', { agent: AGENT, jobId: job.id });

  try {
    const db = require('../../utils/db').getDb();
    const today = new Date().toISOString().split('T')[0];
    const countObj = db.prepare(`SELECT COUNT(*) as c FROM videos WHERE date(created_at) = ?`).get(today);
    const dailyCount = countObj ? countObj.c : 0;
    
    if (dailyCount >= (config.maxProductionSlots || 3)) {
      throw new Error('Slot produksi harian (MAX_PRODUCTION_SLOTS) sudah penuh');
    }

    const result = await _processResearch(job);
    ackJob(job.id);
    logger.info('Research Agent selesai', { agent: AGENT, videoId: result.video_id });

    const jobId = pushJob('script', { video_id: result.video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
      status: 'WAITING_CONFIRMATION',
    });

    const { sendResearchBriefing } = require('../../bot/telegram');
    await sendResearchBriefing(result.video_id, jobId);
  } catch (err) {
    logger.error('Research Agent gagal', {
      agent: AGENT, step: 'runResearchAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processResearch(job) {
  const correlationId = job.payload?.correlation_id || job.correlation_id;
  const videoId = uuidv4();

  getVideoDir(videoId);

  if (config.dryRun) return _mockResearch(videoId, correlationId);

  logger.info('Mengambil sinyal trending dari YouTube Data API', { agent: AGENT });

  // Step 1 — Gather raw signals from YouTube
  const [trendingVideos, nicheVideos] = await Promise.all([
    withRetry(() => rateLimited('youtube', () => _fetchTrending(), 1000), {
      maxRetry: config.maxRetry, agent: AGENT, step: 'fetchTrending',
    }),
    withRetry(() => rateLimited('youtube', () => _fetchNicheSearch(), 1000), {
      maxRetry: config.maxRetry, agent: AGENT, step: 'fetchNicheSearch',
    }),
  ]);

  // Step 2 — Fetch channel stats for virality ratio calculation
  const allVideos = [...trendingVideos, ...nicheVideos];
  const channelIds = [...new Set(allVideos.map((v) => v.channelId).filter(Boolean))];
  const channelStats = await withRetry(
    () => rateLimited('youtube', () => _fetchChannelStats(channelIds), 1000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'fetchChannelStats' }
  );

  // Step 3 — Enrich video objects with virality score
  const enriched = _scoreVideos(allVideos, channelStats);
  logger.info(`Berhasil enrich ${enriched.length} video dari YouTube`, { agent: AGENT });

  // Step 4 — LLM analysis: pick best topic
  const topics = await withRetry(
    () => rateLimited('openrouter', () => _analyzeWithLLM(enriched), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'llmAnalysis' }
  );

  if (!topics || topics.length === 0) throw new Error('LLM tidak menghasilkan topik valid');

  const topic = topics[0];
  logger.info('Topik terpilih', { agent: AGENT, topic: topic.title });

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: topic.title,
    keywords: topic.keywords,
    trending_reason: topic.trending_reason,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ResearchOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ResearchOutput gagal: ${error}`);

  writeVideoJson(videoId, 'research.json', data);
  insertVideo({
    id: videoId,
    correlation_id: correlationId,
    topic: data.topic,
    title: null, description: null, hashtags: null,
    status: 'processing',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return data;
}

// ─── YouTube Data API v3: Trending (Indonesia) ───────────────────────────────

async function _fetchTrending() {
  const cacheKey = `yt_trending_ID_${new Date().toISOString().slice(0, 10)}`;

  return withCache(cacheKey, async () => {
    const res = await axios.get(`${YT_BASE}/videos`, {
      params: {
        part: 'snippet,statistics',
        chart: 'mostPopular',
        regionCode: 'ID',
        // videoCategoryId: '27', // Education — dinonaktifkan: sering 404 di region ID
        maxResults: MAX_YT_RESULTS,
        key: config.youtube.apiKey,
      },
      timeout: 15000,
    });

    return _normalizeVideoItems(res.data?.items || []);
  }, config.cacheTtlHours);
}

// ─── YouTube Data API v3: Niche Search ───────────────────────────────────────

async function _fetchNicheSearch() {
  const cacheKey = `yt_niche_search_${new Date().toISOString().slice(0, 10)}`;

  return withCache(cacheKey, async () => {
    // Search: published within last 30 days, sorted by viewCount, region = ID
    const publishedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const searchRes = await axios.get(`${YT_BASE}/search`, {
      params: {
        part: 'snippet',
        q: config.content.niche,       // "fakta unik indonesia" from config
        type: 'video',
        order: 'viewCount',
        regionCode: 'ID',
        relevanceLanguage: config.content.language, // "id"
        publishedAfter,
        maxResults: MAX_YT_RESULTS,
        key: config.youtube.apiKey,
      },
      timeout: 15000,
    });

    const videoIds = (searchRes.data?.items || [])
      .map((i) => i.id?.videoId)
      .filter(Boolean)
      .join(',');

    if (!videoIds) return [];

    // Enrich with statistics (search endpoint doesn't return stats)
    const statsRes = await axios.get(`${YT_BASE}/videos`, {
      params: {
        part: 'snippet,statistics',
        id: videoIds,
        key: config.youtube.apiKey,
      },
      timeout: 15000,
    });

    return _normalizeVideoItems(statsRes.data?.items || []);
  }, config.cacheTtlHours);
}

// ─── YouTube Data API v3: Channel Stats ──────────────────────────────────────

async function _fetchChannelStats(channelIds) {
  if (!channelIds.length) return {};

  // YouTube API allows up to 50 IDs per request
  const chunks = [];
  for (let i = 0; i < channelIds.length; i += 50) {
    chunks.push(channelIds.slice(i, i + 50));
  }

  const statsMap = {};
  for (const chunk of chunks) {
    const res = await axios.get(`${YT_BASE}/channels`, {
      params: {
        part: 'statistics',
        id: chunk.join(','),
        key: config.youtube.apiKey,
      },
      timeout: 15000,
    });
    for (const item of res.data?.items || []) {
      statsMap[item.id] = {
        subscriberCount: parseInt(item.statistics?.subscriberCount || '0', 10),
      };
    }
  }
  return statsMap;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _normalizeVideoItems(items) {
  return items.map((item) => ({
    videoId: item.id?.videoId || item.id,
    channelId: item.snippet?.channelId,
    title: item.snippet?.title || '',
    description: (item.snippet?.description || '').slice(0, 300),
    publishedAt: item.snippet?.publishedAt,
    viewCount: parseInt(item.statistics?.viewCount || '0', 10),
    likeCount: parseInt(item.statistics?.likeCount || '0', 10),
    commentCount: parseInt(item.statistics?.commentCount || '0', 10),
  }));
}

/**
 * Compute virality score = viewCount / max(subscriberCount, 1000)
 * High ratio → small channel blowing up → high virality signal.
 */
function _scoreVideos(videos, channelStats) {
  return videos
    .map((v) => {
      const subs = channelStats[v.channelId]?.subscriberCount || 1000;
      const viralityScore = v.viewCount / Math.max(subs, 1000);
      return { ...v, subscriberCount: subs, viralityScore };
    })
    .sort((a, b) => b.viralityScore - a.viralityScore)
    .slice(0, 15); // top 15 for LLM context — keep prompt compact
}

// ─── LLM Analysis ────────────────────────────────────────────────────────────

async function _analyzeWithLLM(videos) {
  const cacheKey = `llm_topics_${new Date().toISOString().slice(0, 10)}`;

  return withCache(cacheKey, async () => {
    let memoryContext = '';
    const topTopics = getTopTopics();
    if (topTopics.length > 0) {
      memoryContext = `\nTopik yang sudah terbukti viral di channel ini (buat yang sejenis):\n${topTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    }

    const videoSummary = videos.map((v, i) =>
      `${i + 1}. "${v.title}" | views: ${v.viewCount.toLocaleString()} | subs: ${v.subscriberCount.toLocaleString()} | virality: ${v.viralityScore.toFixed(2)}`
    ).join('\n');

    const prompt = `Kamu adalah analis konten viral YouTube Indonesia.

Berikut ${videos.length} video trending di Indonesia hari ini, diurutkan berdasarkan rasio views/subscribers (virality score):
${videoSummary}
${memoryContext}
Berdasarkan data di atas, identifikasi 5 topik "fakta unik" ORIGINAL yang bisa dibuat video Shorts berdurasi <60 detik.

Pilih topik yang:
- Memiliki virality score tinggi (sinyal bahwa konten tersebut meledak di channel kecil)
- Mengejutkan, kontroversi ringan, atau sulit dipercaya
- Relevan untuk penonton Indonesia usia 18-35
- Belum pernah dibuat persis sama (buat angle baru)

Format JSON persis:
{
  "topics": [
    {
      "title": "Judul topik singkat (max 10 kata)",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "trending_reason": "Kenapa topik ini akan viral sekarang (1 kalimat)"
    }
  ]
}

Hanya JSON, tanpa teks lain.`;

    const res = await axios.post(
      `${config.openrouter.baseUrl}/chat/completions`,
      {
        model: config.openrouter.models.research, // ← reads from config, never hardcoded
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85,
        max_tokens: 2000,
        response_format: { type: 'json_object' }, // paksa output JSON murni
      },
      {
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://youtube-agent.local',
          'X-Title': 'YouTube Shorts Agent',
        },
        timeout: 30000,
      }
    );

    const raw = res.data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(raw, `${AGENT}:analyzeWithLLM`);
    if (!parsed) throw new Error('Gagal parse respons LLM untuk topik');

    const { success, data, error } = validate(OpenRouterTopicsResponse, parsed, AGENT);
    if (!success) throw new Error(`Validasi topik dari LLM gagal: ${error}`);

    return data.topics;
  }, config.cacheTtlHours);
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockResearch(videoId, correlationId) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Research', { agent: AGENT });

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    topic: 'Fakta Gelap Tentang Tidur Yang Jarang Diketahui',
    keywords: ['tidur', 'fakta unik', 'kesehatan', 'otak', 'indonesia'],
    trending_reason: 'Konten kesehatan & sains sedang trending di Indonesia (virality score tinggi di channel kecil)',
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'research.json', output);
  insertVideo({
    id: videoId,
    correlation_id: correlationId,
    topic: output.topic,
    title: null, description: null, hashtags: null,
    status: 'processing',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return output;
}

// ─── Manual trigger ───────────────────────────────────────────────────────────

async function triggerResearch() {
  const correlationId = uuidv4();
  pushJob('research', { correlation_id: correlationId }, {
    correlationId,
    priority: 'high',
    timeoutMs: config.timeouts.research,
  });
  logger.info('Research job ditambahkan manual', { agent: AGENT, correlationId });
  await runResearchAgent();
}

module.exports = { runResearchAgent, triggerResearch };
