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

// Lazy-loaded to avoid issues on first run when memory is empty
const getTopTopics = () => {
  try { return require('../memory').getTopTopics(5); } catch { return []; }
};

const AGENT = 'ResearchAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runResearchAgent() {
  const job = popJob('research');
  if (!job) {
    logger.info('Tidak ada job research di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Research Agent', { agent: AGENT, jobId: job.id });

  try {
    const result = await _processResearch(job);
    ackJob(job.id);
    logger.info('Research Agent selesai', { agent: AGENT, videoId: result.video_id });

    // Next: Script Agent
    pushJob('script', { video_id: result.video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
    });
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

  getVideoDir(videoId); // ensure output dir exists

  if (config.dryRun) return _mockResearch(videoId, correlationId);

  logger.info('Mengambil topik trending dari OpenRouter', { agent: AGENT, step: 'getTrending' });

  const topics = await withRetry(
    () => rateLimited('openrouter', () => _getTrendingTopics(), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'getTrending' }
  );

  if (!topics || topics.length === 0) throw new Error('Tidak ada topik trending ditemukan');

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

// ─── OpenRouter: trending topics ─────────────────────────────────────────────

async function _getTrendingTopics() {
  const cacheKey = `trending_topics_${new Date().toISOString().slice(0, 10)}`;

  return withCache(cacheKey, async () => {
    // Bias dengan top-performing topics dari Memory Agent
    let memoryContext = '';
    const topTopics = getTopTopics();
    if (topTopics.length > 0) {
      memoryContext = `\nTopik yang sudah terbukti viral di channel ini (buat yang sejenis):\n${topTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    }

    const prompt = `Kamu adalah analis konten viral YouTube Indonesia.
Identifikasi 5 topik "fakta unik" yang sedang trending di Indonesia hari ini.
${memoryContext}
Pilih topik yang:
- Mengejutkan, kontroversi ringan, atau sulit dipercaya
- Relevan untuk penonton Indonesia usia 18-35
- Belum terlalu mainstream tapi sedang naik daun

Format JSON persis:
{
  "topics": [
    {
      "title": "Judul topik singkat",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "trending_reason": "Kenapa topik ini menarik sekarang"
    }
  ]
}

Hanya JSON, tanpa teks lain.`;

    const res = await axios.post(
      `${config.openrouter.baseUrl}/chat/completions`,
      {
        model: config.openrouter.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 1000,
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
    const parsed = extractJson(raw, 'ResearchAgent:getTrendingTopics');
    if (!parsed) throw new Error('Gagal parse respons OpenRouter untuk topik');

    const { success, data, error } = validate(OpenRouterTopicsResponse, parsed, AGENT);
    if (!success) throw new Error(`Validasi topik dari OpenRouter gagal: ${error}`);

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
    trending_reason: 'Konten kesehatan & sains sedang trending di Indonesia karena awareness kesehatan meningkat post-pandemi',
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
