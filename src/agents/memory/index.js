'use strict';

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob } = require('../../utils/queue');
const { upsertMemory, getAllMemory, getDb } = require('../../utils/db');
const { validate, MemoryRecord } = require('../../schemas');

const AGENT = 'MemoryAgent';

const WEIGHT_DECAY = 0.95;   // Multiply weight by this each cycle if no new data
const MAX_RECORDS = 1000;    // Rule 42: max 1000 memory records
const MIN_WEIGHT = 0.1;      // Floor weight to prevent topics from disappearing

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runMemoryAgent() {
  const job = popJob('memory');
  if (!job) {
    logger.info('Tidak ada job memory di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Memory Agent', { agent: AGENT, jobId: job.id });

  try {
    await _processMemory(job.correlation_id);
    ackJob(job.id);
    logger.info('Memory Agent selesai', { agent: AGENT });
  } catch (err) {
    logger.error('Memory Agent gagal', {
      agent: AGENT,
      step: 'runMemoryAgent',
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processMemory(correlationId) {
  // Step 1: Aggregate analytics into topic performance
  const topicStats = _aggregateTopicStats();
  logger.info(`${topicStats.length} topik ditemukan dari analytics`, { agent: AGENT });

  // Step 2: Apply weight decay to all existing memory records
  _applyWeightDecay();

  // Step 3: Update weights based on new analytics data
  for (const stat of topicStats) {
    await _updateTopicWeight(stat);
  }

  // Step 4: Enforce max 1000 records (keep top by weight)
  _enforceMaxRecords();

  // Step 5: (Optional in production) Use OpenRouter to suggest new topic directions
  if (!config.dryRun && topicStats.length > 0) {
    await _aiTopicInsights(topicStats).catch((e) => {
      logger.warn('AI topic insights gagal (non-fatal)', { agent: AGENT, error_message: e.message });
    });
  }

  const all = getAllMemory();
  logger.info(`Memory Agent selesai. Total ${all.length} topik dalam memori`, { agent: AGENT });
}

// ─── Aggregate topic stats from analytics ────────────────────────────────────

function _aggregateTopicStats() {
  const db = getDb();

  // Join videos with analytics to get per-topic performance
  const rows = db.prepare(`
    SELECT
      v.topic,
      COUNT(DISTINCT v.id)       AS video_count,
      AVG(a.views)               AS avg_views,
      AVG(a.ctr)                 AS avg_ctr,
      AVG(a.avg_view_pct)        AS avg_view_pct,
      AVG(a.likes * 1.0 / NULLIF(a.views, 0) * 100) AS engagement_rate
    FROM videos v
    LEFT JOIN analytics a ON a.video_id = v.id
    WHERE v.topic IS NOT NULL AND v.status IN ('uploaded', 'approved')
    GROUP BY v.topic
    HAVING video_count > 0
  `).all();

  return rows;
}

// ─── Weight decay ─────────────────────────────────────────────────────────────

function _applyWeightDecay() {
  const db = getDb();
  const now = new Date().toISOString();

  // Only decay topics not updated in the last 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE memory
    SET weight = MAX(?, weight * ?), last_updated = ?
    WHERE last_updated < ?
  `).run(MIN_WEIGHT, WEIGHT_DECAY, now, cutoff);

  logger.debug('Weight decay diterapkan ke topik lama', { agent: AGENT });
}

// ─── Update topic weight based on analytics ───────────────────────────────────

async function _updateTopicWeight(stat) {
  if (!stat.topic) return;

  // Scoring formula:
  // - avg_views normalized (higher = better)
  // - engagement_rate (likes/views * 100)
  // - avg_view_pct (retention percentage)
  const viewScore = Math.log10(Math.max(stat.avg_views || 1, 1)) / 5;  // Normalize log scale
  const engScore = (stat.engagement_rate || 0) / 100;
  const retentionScore = (stat.avg_view_pct || 0) / 100;

  const newWeight = Math.min(10, Math.max(MIN_WEIGHT,
    (viewScore * 0.4 + engScore * 0.35 + retentionScore * 0.25) * 10
  ));

  const record = {
    id: uuidv4(),
    topic: stat.topic,
    weight: newWeight,
    views_avg: stat.avg_views || 0,
    engagement: stat.engagement_rate || 0,
    video_count: stat.video_count || 0,
    last_updated: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(MemoryRecord, record, AGENT);
  if (!success) {
    logger.warn('Record memory tidak valid', { agent: AGENT, error, topic: stat.topic });
    return;
  }

  upsertMemory(record);
  logger.debug(`Memori diupdate untuk topik: ${stat.topic} (weight: ${newWeight.toFixed(2)})`,
    { agent: AGENT });
}

// ─── Enforce max 1000 records ─────────────────────────────────────────────────

function _enforceMaxRecords() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM memory').get().c;

  if (count > MAX_RECORDS) {
    const excess = count - MAX_RECORDS;
    // Delete lowest-weight records
    db.prepare(`
      DELETE FROM memory WHERE topic IN (
        SELECT topic FROM memory ORDER BY weight ASC LIMIT ?
      )
    `).run(excess);
    logger.info(`${excess} record memori terlama dihapus (limit ${MAX_RECORDS})`, { agent: AGENT });
  }
}

// ─── AI topic insights (production only) ─────────────────────────────────────

async function _aiTopicInsights(topicStats) {
  const topTopics = topicStats
    .sort((a, b) => (b.avg_views || 0) - (a.avg_views || 0))
    .slice(0, 10)
    .map((t) => `${t.topic}: ${Math.round(t.avg_views || 0)} views rata-rata`);

  const prompt = `Kamu adalah analis konten YouTube Indonesia.

Berikut adalah topik "fakta unik" yang sudah dipublikasikan beserta performa rata-rata views:
${topTopics.join('\n')}

Berikan analisis singkat dalam JSON:
{
  "insights": "Analisis 2-3 kalimat tentang tren",
  "recommended_topics": ["topik1", "topik2", "topik3"],
  "avoid_topics": ["topik yang performanya buruk"]
}`;

  const res = await withRetry(
    () => rateLimited('openrouter', async () => {
      return axios.post(
        `${config.openrouter.baseUrl}/chat/completions`,
        {
          model: config.openrouter.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
          max_tokens: 500,
        },
        {
          headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
    }, 3000),
    { maxRetry: 2, agent: AGENT, step: 'aiInsights' }
  );

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const insights = extractJson(raw, 'MemoryAgent');
  if (insights) {
    logger.info('AI insights untuk topik', { agent: AGENT, insights: insights.insights });
  }
}

// ─── Get top topics for Research Agent ───────────────────────────────────────

function getTopTopics(limit = 5) {
  const all = getAllMemory();
  return all.slice(0, limit).map((m) => m.topic);
}

module.exports = { runMemoryAgent, getTopTopics };
