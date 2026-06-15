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

const AGENT = 'MemoryAgent';

const WEIGHT_DECAY = 0.95;   // Multiply weight by this each cycle if no new data
const MAX_RECORDS = 1000;    // Max 1000 memory records
const MIN_WEIGHT = 0.1;      // Floor weight to prevent patterns from disappearing

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
  // Step 1: Aggregate analytics into clip pattern performance
  const patternStats = _aggregateClipPatternStats();
  logger.info(`${patternStats.length} clip patterns ditemukan dari analytics`, { agent: AGENT });

  // Step 2: Apply weight decay to all existing memory records
  _applyWeightDecay();

  // Step 3: Update weights based on new analytics data
  for (const stat of patternStats) {
    await _updatePatternWeight(stat);
  }

  // Step 4: Enforce max 1000 records (keep top by weight)
  _enforceMaxRecords();

  // Step 5: (Optional) AI insights for pattern recommendations
  if (!config.dryRun && patternStats.length > 0) {
    await _aiPatternInsights(patternStats).catch((e) => {
      logger.warn('AI pattern insights gagal (non-fatal)', { agent: AGENT, error_message: e.message });
    });
  }

  const all = getAllMemory();
  logger.info(`Memory Agent selesai. Total ${all.length} patterns dalam memori`, { agent: AGENT });
}

// ─── Aggregate clip pattern stats from analytics ────────────────────────────

function _aggregateClipPatternStats() {
  const db = getDb();

  // Aggregate by different pattern types
  const patterns = [];

  // 1. Hook type patterns
  const hookTypes = db.prepare(`
    SELECT
      'hook_type' AS pattern_type,
      c.hook_type AS pattern_value,
      COUNT(DISTINCT c.id) AS clip_count,
      AVG(a.views) AS avg_views,
      AVG(a.ctr) AS avg_ctr,
      AVG(a.avg_view_pct) AS avg_view_pct,
      AVG(a.likes * 1.0 / NULLIF(a.views, 0) * 100) AS engagement_rate
    FROM clips c
    LEFT JOIN analytics a ON a.clip_id = c.id
    WHERE c.hook_type IS NOT NULL AND c.status IN ('uploaded', 'approved')
    GROUP BY c.hook_type
    HAVING clip_count > 0
  `).all();
  patterns.push(...hookTypes);

  // 2. Duration range patterns
  const durationRanges = db.prepare(`
    SELECT
      'duration_range' AS pattern_type,
      CASE
        WHEN c.duration_sec < 20 THEN '0-20s'
        WHEN c.duration_sec < 30 THEN '20-30s'
        WHEN c.duration_sec < 45 THEN '30-45s'
        ELSE '45-60s'
      END AS pattern_value,
      COUNT(DISTINCT c.id) AS clip_count,
      AVG(a.views) AS avg_views,
      AVG(a.ctr) AS avg_ctr,
      AVG(a.avg_view_pct) AS avg_view_pct,
      AVG(a.likes * 1.0 / NULLIF(a.views, 0) * 100) AS engagement_rate
    FROM clips c
    LEFT JOIN analytics a ON a.clip_id = c.id
    WHERE c.status IN ('uploaded', 'approved')
    GROUP BY pattern_value
    HAVING clip_count > 0
  `).all();
  patterns.push(...durationRanges);

  // 3. Reframe strategy patterns
  const reframeStrategies = db.prepare(`
    SELECT
      'reframe_strategy' AS pattern_type,
      c.reframe_strategy AS pattern_value,
      COUNT(DISTINCT c.id) AS clip_count,
      AVG(a.views) AS avg_views,
      AVG(a.ctr) AS avg_ctr,
      AVG(a.avg_view_pct) AS avg_view_pct,
      AVG(a.likes * 1.0 / NULLIF(a.views, 0) * 100) AS engagement_rate
    FROM clips c
    LEFT JOIN analytics a ON a.clip_id = c.id
    WHERE c.reframe_strategy IS NOT NULL AND c.status IN ('uploaded', 'approved')
    GROUP BY c.reframe_strategy
    HAVING clip_count > 0
  `).all();
  patterns.push(...reframeStrategies);

  // 4. Source channel patterns (which channels produce best clips)
  const sourceChannels = db.prepare(`
    SELECT
      'source_channel' AS pattern_type,
      sv.channel_title AS pattern_value,
      COUNT(DISTINCT c.id) AS clip_count,
      AVG(a.views) AS avg_views,
      AVG(a.ctr) AS avg_ctr,
      AVG(a.avg_view_pct) AS avg_view_pct,
      AVG(a.likes * 1.0 / NULLIF(a.views, 0) * 100) AS engagement_rate
    FROM clips c
    JOIN source_videos sv ON sv.id = c.source_video_id
    LEFT JOIN analytics a ON a.clip_id = c.id
    WHERE sv.channel_title IS NOT NULL AND c.status IN ('uploaded', 'approved')
    GROUP BY sv.channel_title
    HAVING clip_count > 0
  `).all();
  patterns.push(...sourceChannels);

  return patterns;
}

// ─── Weight decay ─────────────────────────────────────────────────────────────

function _applyWeightDecay() {
  const db = getDb();
  const now = new Date().toISOString();

  // Only decay patterns not updated in the last 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE memory
    SET weight = MAX(?, weight * ?), last_updated = ?
    WHERE last_updated < ?
  `).run(MIN_WEIGHT, WEIGHT_DECAY, now, cutoff);

  logger.debug('Weight decay diterapkan ke patterns lama', { agent: AGENT });
}

// ─── Update pattern weight based on analytics ────────────────────────────────

async function _updatePatternWeight(stat) {
  if (!stat.pattern_type || !stat.pattern_value) return;

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
    pattern_type: stat.pattern_type,
    pattern_value: stat.pattern_value,
    weight: newWeight,
    views_avg: stat.avg_views || 0,
    engagement: stat.engagement_rate || 0,
    clip_count: stat.clip_count || 0,
    last_updated: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  upsertMemory(record);
  logger.debug(`Memori diupdate untuk pattern: ${stat.pattern_type}=${stat.pattern_value} (weight: ${newWeight.toFixed(2)})`,
    { agent: AGENT });
}

// ─── Rejection penalty ────────────────────────────────────────────────────────

async function _applyRejectionPenalty(payload) {
  const { clip_id, penalty_type, penalty_factor, reason_label } = payload || {};
  if (!clip_id) throw new Error('memory_penalty: clip_id wajib diisi');

  const db = getDb();
  const factor = typeof penalty_factor === 'number' ? penalty_factor : 0.4;
  const now = new Date().toISOString();

  // Get clip data
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(clip_id);
  if (!clip) {
    logger.warn('Clip tidak ditemukan untuk penalty', { agent: AGENT, clip_id });
    return;
  }

  // Apply penalty to relevant patterns
  const patternsTopenalize = [];

  if (penalty_type === 'topic' || penalty_type === 'general') {
    // Penalize hook_type
    if (clip.hook_type) {
      patternsTopenalize.push({ type: 'hook_type', value: clip.hook_type });
    }
    // Penalize duration range
    const durationRange = clip.duration_sec < 20 ? '0-20s' :
                          clip.duration_sec < 30 ? '20-30s' :
                          clip.duration_sec < 45 ? '30-45s' : '45-60s';
    patternsTopenalize.push({ type: 'duration_range', value: durationRange });
  }

  if (penalty_type === 'visual' || penalty_type === 'general') {
    // Penalize reframe_strategy
    if (clip.reframe_strategy) {
      patternsTopenalize.push({ type: 'reframe_strategy', value: clip.reframe_strategy });
    }
  }

  // Apply penalties
  for (const pattern of patternsTopenalize) {
    const existing = db.prepare(
      'SELECT * FROM memory WHERE pattern_type = ? AND pattern_value = ?'
    ).get(pattern.type, pattern.value);

    if (existing) {
      const newWeight = Math.max(MIN_WEIGHT, existing.weight * factor);
      db.prepare(`
        UPDATE memory
        SET weight = ?, last_updated = ?
        WHERE pattern_type = ? AND pattern_value = ?
      `).run(newWeight, now, pattern.type, pattern.value);

      logger.info('Penalti weight diterapkan', {
        agent: AGENT,
        pattern: `${pattern.type}=${pattern.value}`,
        reason: reason_label,
        before: existing.weight.toFixed(3),
        after: newWeight.toFixed(3),
      });
    } else {
      // Pattern not yet in memory — insert with low initial weight
      const initWeight = Math.max(MIN_WEIGHT, factor);
      db.prepare(`
        INSERT INTO memory (id, pattern_type, pattern_value, weight, views_avg, engagement, clip_count, last_updated, created_at)
        VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
      `).run(uuidv4(), pattern.type, pattern.value, initWeight, now, now);

      logger.info('Pattern baru dimasukkan dengan penalti weight', {
        agent: AGENT,
        pattern: `${pattern.type}=${pattern.value}`,
        initWeight,
        reason: reason_label,
      });
    }
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
      DELETE FROM memory WHERE id IN (
        SELECT id FROM memory ORDER BY weight ASC LIMIT ?
      )
    `).run(excess);
    logger.info(`${excess} record memori terlama dihapus (limit ${MAX_RECORDS})`, { agent: AGENT });
  }
}

// ─── AI pattern insights ─────────────────────────────────────────────────────

async function _aiPatternInsights(patternStats) {
  const topPatterns = patternStats
    .sort((a, b) => (b.avg_views || 0) - (a.avg_views || 0))
    .slice(0, 15)
    .map((p) => `${p.pattern_type}=${p.pattern_value}: ${Math.round(p.avg_views || 0)} views avg, ${p.clip_count} clips`);

  const prompt = `Kamu adalah analis performa clip YouTube Shorts.

Berikut adalah pattern clip yang sudah dipublikasikan beserta performa:
${topPatterns.join('\n')}

Berikan analisis singkat dalam JSON:
{
  "insights": "Analisis 2-3 kalimat tentang pattern yang berhasil",
  "recommended_patterns": {
    "hook_type": ["type1", "type2"],
    "duration_range": ["range"],
    "reframe_strategy": ["strategy"]
  },
  "avoid_patterns": ["pattern yang performanya buruk"]
}`;

  const res = await withRetry(
    () => rateLimited('openrouter', async () => {
      return axios.post(
        `${config.openrouter.baseUrl}/chat/completions`,
        {
          model: config.openrouter.models.clipPlanner,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
          max_tokens: 600,
          response_format: { type: 'json_object' },
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
    logger.info('AI insights untuk patterns', { agent: AGENT, insights: insights.insights });
  }
}

// ─── Get pattern recommendations ─────────────────────────────────────────────

function getTopPatterns(patternType, limit = 5) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pattern_value, weight FROM memory
    WHERE pattern_type = ? AND weight > 0.2
    ORDER BY weight DESC
    LIMIT ?
  `).all(patternType, limit);
  return rows.map((r) => ({ value: r.pattern_value, weight: r.weight }));
}

function getAvoidPatterns(patternType, limit = 5) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pattern_value, weight FROM memory
    WHERE pattern_type = ? AND weight <= 0.2
    ORDER BY weight ASC
    LIMIT ?
  `).all(patternType, limit);
  return rows.map((r) => ({ value: r.pattern_value, weight: r.weight }));
}

// Legacy exports for backward compatibility
function getTopTopics(limit = 5) {
  return getTopPatterns('hook_type', limit).map(p => p.value);
}

function getAvoidTopics(limit = 5) {
  return getAvoidPatterns('hook_type', limit).map(p => p.value);
}

module.exports = {
  runMemoryAgent,
  runMemoryPenaltyAgent,
  getTopPatterns,
  getAvoidPatterns,
  // Legacy exports
  getTopTopics,
  getAvoidTopics,
};
