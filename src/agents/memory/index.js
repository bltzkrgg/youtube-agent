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

// ─── Main entry (analytics-driven) ──────────────────────────────────────────

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

// ─── Main entry (rejection penalty) ─────────────────────────────────────────

async function runMemoryPenaltyAgent() {
  const job = popJob('memory_penalty');
  if (!job) return;

  logger.info('Memulai Memory Penalty Agent', { agent: AGENT, jobId: job.id });

  try {
    await _applyRejectionPenalty(job.payload);
    ackJob(job.id);
  } catch (err) {
    logger.error('Memory Penalty Agent gagal', {
      agent: AGENT, step: 'runMemoryPenaltyAgent',
      error_message: err.message, stack: err.stack,
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

// ─── Rejection penalty ────────────────────────────────────────────────────────
//
// Penalty matrix (applied multiplicatively on top of current weight):
//   penalty_type=topic   → weight *= 0.3  (strong: avoid repeating boring topic)
//   penalty_type=visual  → weight *= 0.4  (moderate: topic might be fine, execution was bad)
// Floor: MIN_WEIGHT (0.1) so the topic can still recover via future analytics.

async function _applyRejectionPenalty(payload) {
  const { topic, penalty_type, penalty_factor, reason_label, video_id } = payload || {};
  if (!topic) throw new Error('memory_penalty: topic wajib diisi');

  const db      = getDb();
  const factor  = typeof penalty_factor === 'number' ? penalty_factor : 0.4;
  const now     = new Date().toISOString();

  // Check if topic already exists in memory
  const existing = db.prepare('SELECT * FROM memory WHERE topic = ?').get(topic);

  if (existing) {
    const newWeight = Math.max(MIN_WEIGHT, existing.weight * factor);
    db.prepare(`
      UPDATE memory
      SET weight = ?, last_updated = ?, reject_count = COALESCE(reject_count, 0) + 1
      WHERE topic = ?
    `).run(newWeight, now, topic);

    logger.info('Penalti weight diterapkan', {
      agent: AGENT, topic,
      reason: reason_label,
      penalty_type,
      before: existing.weight.toFixed(3),
      after: newWeight.toFixed(3),
    });
  } else {
    // Topic not yet in memory — insert with low initial weight
    const initWeight = Math.max(MIN_WEIGHT, factor); // e.g. 0.3 or 0.4
    db.prepare(`
      INSERT OR IGNORE INTO memory
        (topic, weight, views_avg, engagement, video_count, last_updated, created_at, reject_count)
      VALUES (?, ?, 0, 0, 0, ?, ?, 1)
    `).run(topic, initWeight, now, now);

    logger.info('Topik baru dimasukkan dengan penalti weight', {
      agent: AGENT, topic, initWeight, reason: reason_label,
    });
  }

  // Also mark the visual_keyword cluster if penalty is visual-only
  // (Research agent uses this to skip similar visual styles in future)
  if (penalty_type === 'visual' && video_id) {
    const scriptKeywords = _getScriptVisualKeywords(video_id);
    if (scriptKeywords.length > 0) {
      logger.debug('Visual keywords dari video yang ditolak dicatat', {
        agent: AGENT, video_id, keywords: scriptKeywords,
      });
      // Store as low-weight separate entries so Research knows to vary visuals
      for (const kw of scriptKeywords) {
        const kwTopic = `[visual] ${kw}`;
        const kwExisting = db.prepare('SELECT weight FROM memory WHERE topic = ?').get(kwTopic);
        const kwWeight = kwExisting ? Math.max(MIN_WEIGHT, kwExisting.weight * 0.5) : MIN_WEIGHT;
        db.prepare(`
          INSERT INTO memory (topic, weight, views_avg, engagement, video_count, last_updated, created_at, reject_count)
          VALUES (?, ?, 0, 0, 0, ?, ?, 1)
          ON CONFLICT(topic) DO UPDATE SET weight = excluded.weight, last_updated = excluded.last_updated,
            reject_count = COALESCE(reject_count, 0) + 1
        `).run(kwTopic, kwWeight, now, now);
      }
    }
  }
}

function _getScriptVisualKeywords(videoId) {
  try {
    const { readVideoJson } = require('../../utils/storage');
    const script = readVideoJson(videoId, 'script.json');
    return (script?.segments || []).map((s) => s.visual_keyword).filter(Boolean).slice(0, 5);
  } catch {
    return [];
  }
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
          model: config.openrouter.models.research, // ← from config, not hardcoded
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
  const db = getDb();
  // Exclude penalty-only records ([visual] prefixed) and floor-weight topics from recommendations
  const rows = db.prepare(`
    SELECT topic FROM memory
    WHERE topic NOT LIKE '[visual]%'
      AND weight > 0.2
    ORDER BY weight DESC
    LIMIT ?
  `).all(limit);
  return rows.map((r) => r.topic);
}

// Also expose low-weight (penalised) topics so Research prompt can explicitly avoid them
function getAvoidTopics(limit = 10) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT topic FROM memory
    WHERE weight <= 0.2 AND topic NOT LIKE '[visual]%'
    ORDER BY weight ASC
    LIMIT ?
  `).all(limit);
  return rows.map((r) => r.topic);
}

module.exports = { runMemoryAgent, runMemoryPenaltyAgent, getTopTopics, getAvoidTopics };
