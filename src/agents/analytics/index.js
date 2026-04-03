'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../../config');
const logger = require('../../utils/logger');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { insertAnalytics, updateVideo, getDb } = require('../../utils/db');
const { validate, AnalyticsRow } = require('../../schemas');

const AGENT = 'AnalyticsAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runAnalyticsAgent() {
  const job = popJob('analytics');
  if (!job) {
    logger.info('Tidak ada job analytics di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Analytics Agent', { agent: AGENT, jobId: job.id });

  try {
    const { csv_path, correlation_id } = job.payload;

    if (config.dryRun && !csv_path) {
      await _processMockAnalytics(job);
    } else if (csv_path) {
      await _processCsv(csv_path, correlation_id || job.correlation_id);
    } else {
      throw new Error('csv_path tidak ada di payload');
    }

    ackJob(job.id);
    logger.info('Analytics Agent selesai', { agent: AGENT });

    // Push memory update
    pushJob('memory', { correlation_id: correlation_id || job.correlation_id }, {
      correlationId: correlation_id || job.correlation_id,
      priority: 'low',
    });
  } catch (err) {
    logger.error('Analytics Agent gagal', {
      agent: AGENT,
      step: 'runAnalyticsAgent',
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── CSV Processing ───────────────────────────────────────────────────────────

async function _processCsv(csvPath, correlationId) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV tidak ditemukan: ${csvPath}`);

  logger.info('Memproses CSV analytics', { agent: AGENT, csvPath });

  const content = fs.readFileSync(csvPath, 'utf-8');
  const rows = _parseCsv(content);

  logger.info(`${rows.length} baris analytics ditemukan`, { agent: AGENT });

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      // Validate row
      const { success, data, error } = validate(AnalyticsRow, row, AGENT);
      if (!success) {
        logger.warn('Baris analytics tidak valid, dilewati', { agent: AGENT, error, row });
        skipped++;
        continue;
      }

      // Try to match video by title or video_id
      const video = _findVideo(data);
      const videoId = video?.id || null;

      insertAnalytics({
        id: uuidv4(),
        video_id: videoId,
        views: data.views,
        likes: data.likes,
        comments: data.comments,
        ctr: data.ctr,
        avg_view_pct: data.avg_view_pct,
        recorded_at: new Date().toISOString(),
      });

      inserted++;
    } catch (err) {
      logger.warn('Error memproses baris analytics', { agent: AGENT, error_message: err.message });
      skipped++;
    }
  }

  // Clean up CSV after processing
  try { fs.unlinkSync(csvPath); } catch {}

  logger.info(`Analytics selesai: ${inserted} disimpan, ${skipped} dilewati`, { agent: AGENT });
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function _parseCsv(content) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Auto-detect separator
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map((h) => h.toLowerCase().trim().replace(/"/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = _splitCsvLine(lines[i], sep);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx]?.replace(/"/g, '').trim() || '';
    });

    // Map common YouTube Studio column names to our schema
    const mapped = {
      video_id: row['video_id'] || row['id'] || '',
      title: row['title'] || row['video title'] || '',
      views: row['views'] || row['impressions'] || row['view count'] || '0',
      likes: row['likes'] || row['like count'] || '0',
      comments: row['comments'] || row['comment count'] || '0',
      ctr: row['ctr'] || row['impressions click-through rate (%)'] || '0',
      avg_view_pct: row['average percentage viewed (%)'] || row['avg view duration %'] || '0',
    };

    rows.push(mapped);
  }

  return rows;
}

function _splitCsvLine(line, sep) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function _findVideo(data) {
  const db = getDb();
  if (data.video_id) {
    const v = db.prepare('SELECT id FROM videos WHERE id = ?').get(data.video_id);
    if (v) return v;
  }
  if (data.title) {
    return db.prepare('SELECT id FROM videos WHERE title LIKE ?').get(`%${data.title.slice(0, 30)}%`);
  }
  return null;
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

async function _processMockAnalytics(job) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Analytics', { agent: AGENT });

  const mockRows = [
    { video_id: null, views: 12500, likes: 890, comments: 45, ctr: 8.5, avg_view_pct: 72 },
    { video_id: null, views: 8300, likes: 650, comments: 28, ctr: 6.2, avg_view_pct: 68 },
  ];

  for (const row of mockRows) {
    insertAnalytics({
      id: uuidv4(),
      ...row,
      recorded_at: new Date().toISOString(),
    });
  }
}

module.exports = { runAnalyticsAgent };
