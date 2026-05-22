'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

let db;

function getDb() {
  if (!db) {
    db = new Database(config.paths.db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

function runMigrations(db) {
  db.exec(`
    -- Queue jobs
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      priority    INTEGER NOT NULL DEFAULT 5,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retry   INTEGER NOT NULL DEFAULT 3,
      payload     TEXT NOT NULL DEFAULT '{}',
      version     TEXT NOT NULL DEFAULT '1.0',
      error       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      locked_at   TEXT,
      timeout_at  TEXT
    );

    -- Dead letter queue
    CREATE TABLE IF NOT EXISTS dead_letter (
      id             TEXT PRIMARY KEY,
      original_job_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      type           TEXT NOT NULL,
      payload        TEXT NOT NULL DEFAULT '{}',
      error          TEXT,
      failed_at      TEXT NOT NULL
    );

    -- Source videos (YouTube videos to clip from)
    CREATE TABLE IF NOT EXISTS source_videos (
      id                  TEXT PRIMARY KEY,
      correlation_id      TEXT NOT NULL,
      source_url          TEXT NOT NULL,
      source_video_path   TEXT,
      source_duration     REAL,
      channel_title       TEXT,
      video_title         TEXT,
      description         TEXT,
      permission_status   TEXT NOT NULL DEFAULT 'unknown',
      allowed_to_clip     INTEGER NOT NULL DEFAULT 0,
      risk_level          TEXT NOT NULL DEFAULT 'unknown',
      risk_notes          TEXT,
      status              TEXT NOT NULL DEFAULT 'processing',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    -- Clips generated from source videos
    CREATE TABLE IF NOT EXISTS clips (
      id                  TEXT PRIMARY KEY,
      source_video_id     TEXT NOT NULL,
      correlation_id      TEXT NOT NULL,
      start_sec           REAL NOT NULL,
      end_sec             REAL NOT NULL,
      duration_sec        REAL NOT NULL,
      score               REAL NOT NULL DEFAULT 0,
      hook_type           TEXT,
      caption_plan        TEXT,
      reframe_strategy    TEXT,
      risk_notes          TEXT,
      title               TEXT,
      description         TEXT,
      hashtags            TEXT,
      source_url          TEXT,
      source_channel      TEXT,
      attribution         TEXT,
      final_video_path    TEXT,
      thumbnail_path      TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      approved_at         TEXT,
      rejected_at         TEXT,
      reject_reason       TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      FOREIGN KEY (source_video_id) REFERENCES source_videos(id)
    );

    -- Analytics (now tracks clips instead of generated videos)
    CREATE TABLE IF NOT EXISTS analytics (
      id              TEXT PRIMARY KEY,
      clip_id         TEXT,
      views           INTEGER DEFAULT 0,
      likes           INTEGER DEFAULT 0,
      comments        INTEGER DEFAULT 0,
      ctr             REAL DEFAULT 0,
      avg_view_pct    REAL DEFAULT 0,
      recorded_at     TEXT NOT NULL,
      FOREIGN KEY (clip_id) REFERENCES clips(id)
    );

    -- Memory / learning weights (now tracks clip patterns)
    CREATE TABLE IF NOT EXISTS memory (
      id              TEXT PRIMARY KEY,
      pattern_type    TEXT NOT NULL,
      pattern_value   TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      views_avg       REAL NOT NULL DEFAULT 0,
      engagement      REAL NOT NULL DEFAULT 0,
      clip_count      INTEGER NOT NULL DEFAULT 0,
      last_updated    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      UNIQUE(pattern_type, pattern_value)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status           ON jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_type             ON jobs(type, status);
    CREATE INDEX IF NOT EXISTS idx_source_videos_status  ON source_videos(status);
    
    -- Drop old non-unique index if exists, then create unique index
    DROP INDEX IF EXISTS idx_source_videos_url;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_videos_url_unique ON source_videos(source_url);
    
    CREATE INDEX IF NOT EXISTS idx_clips_source          ON clips(source_video_id);
    CREATE INDEX IF NOT EXISTS idx_clips_status          ON clips(status);
    CREATE INDEX IF NOT EXISTS idx_clips_unique          ON clips(source_video_id, start_sec, end_sec);
    CREATE INDEX IF NOT EXISTS idx_memory_pattern        ON memory(pattern_type, pattern_value);
  `);

  logger.info('Migrasi database selesai');
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

function insertJob(job) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (id, correlation_id, type, status, priority, retry_count, max_retry,
                      payload, version, created_at, updated_at, timeout_at)
    VALUES (@id, @correlation_id, @type, @status, @priority, @retry_count, @max_retry,
            @payload, @version, @created_at, @updated_at, @timeout_at)
  `);
  stmt.run(job);
}

function getNextPendingJob(type) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM jobs
    WHERE type = ? AND status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `).get(type);
}

function claimNextPendingJob(type, now) {
  const db = getDb();
  const nowIso = now || new Date().toISOString();

  const row = db.prepare(`
    UPDATE jobs
    SET status = 'processing', locked_at = ?, updated_at = ?
    WHERE id = (
      SELECT id
      FROM jobs
      WHERE type = ?
        AND status = 'pending'
        AND (timeout_at IS NULL OR timeout_at >= ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    )
      AND status = 'pending'
    RETURNING *
  `).get(nowIso, nowIso, type, nowIso);

  return row || null;
}

function lockJob(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE jobs SET status = 'processing', locked_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, now, id);
}

function completeJob(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(now, id);
}

function failJob(id, errorMsg, retryCount) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, retry_count = ?, updated_at = ?
    WHERE id = ?
  `).run(errorMsg, retryCount, now, id);
}

function requeueJob(id, retryCount, timeoutMs) {
  const db = getDb();
  const now = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + (timeoutMs || 1800000)).toISOString();
  db.prepare(`
    UPDATE jobs SET status = 'pending', retry_count = ?, locked_at = NULL,
                    updated_at = ?, timeout_at = ?
    WHERE id = ?
  `).run(retryCount, now, timeoutAt, id);
}

function getTimedOutPendingJobs(type, now) {
  const db = getDb();
  const nowIso = now || new Date().toISOString();
  return db.prepare(`
    SELECT *
    FROM jobs
    WHERE status = 'pending'
      AND type = ?
      AND timeout_at IS NOT NULL
      AND timeout_at < ?
    ORDER BY created_at ASC
  `).all(type, nowIso);
}

function getTimedOutProcessingJobs(type, now) {
  const db = getDb();
  const nowIso = now || new Date().toISOString();
  return db.prepare(`
    SELECT *
    FROM jobs
    WHERE status = 'processing'
      AND type = ?
      AND timeout_at IS NOT NULL
      AND timeout_at < ?
    ORDER BY locked_at ASC, created_at ASC
  `).all(type, nowIso);
}

function moveToDeadLetter(job, errorMsg) {
  const db = getDb();
  const now = new Date().toISOString();
  const payload = typeof job.payload === 'string'
    ? job.payload
    : JSON.stringify(job.payload || {});
  db.prepare(`
    INSERT INTO dead_letter (id, original_job_id, correlation_id, type, payload, error, failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    job.id,
    job.correlation_id,
    job.type,
    payload,
    errorMsg,
    now
  );
  completeJob(job.id); // Mark original as done so it's not retried
}

function hardResetDatabase() {
  const db = getDb();
  // New clipper tables
  try { db.prepare('DELETE FROM jobs').run(); } catch(e) {}
  try { db.prepare('DELETE FROM dead_letter').run(); } catch(e) {}
  try { db.prepare('DELETE FROM analytics').run(); } catch(e) {}
  try { db.prepare('DELETE FROM memory').run(); } catch(e) {}
  try { db.prepare('DELETE FROM clips').run(); } catch(e) {}
  try { db.prepare('DELETE FROM source_videos').run(); } catch(e) {}
  // Legacy tables (safe with try/catch)
  try { db.prepare('DELETE FROM videos').run(); } catch(e) {}
  try { db.prepare('DELETE FROM metadata').run(); } catch(e) {}
  try { db.prepare('DELETE FROM scripts').run(); } catch(e) {}
  try { db.prepare('VACUUM').run(); } catch(e) {}
}

function deleteJob(id) {
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function updateJobStatus(id, status) {
  const now = new Date().toISOString();
  getDb().prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

// ─── Source Videos ───────────────────────────────────────────────────────────

function insertSourceVideo(video) {
  const db = getDb();
  db.prepare(`
    INSERT INTO source_videos (id, correlation_id, source_url, source_video_path, source_duration,
                               channel_title, video_title, description, 
                               permission_status, allowed_to_clip, risk_level, risk_notes,
                               status, created_at, updated_at)
    VALUES (@id, @correlation_id, @source_url, @source_video_path, @source_duration,
            @channel_title, @video_title, @description,
            @permission_status, @allowed_to_clip, @risk_level, @risk_notes,
            @status, @created_at, @updated_at)
  `).run(video);
}

function updateSourceVideo(id, fields) {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE source_videos SET ${sets}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, updated_at: now, id });
}

function getSourceVideo(id) {
  return getDb().prepare('SELECT * FROM source_videos WHERE id = ?').get(id);
}

function getSourceVideoByCorrelation(correlationId) {
  return getDb().prepare('SELECT * FROM source_videos WHERE correlation_id = ?').get(correlationId);
}

// ─── Clips ───────────────────────────────────────────────────────────────────

function insertClip(clip) {
  const db = getDb();
  db.prepare(`
    INSERT INTO clips (id, source_video_id, correlation_id, start_sec, end_sec, duration_sec,
                       score, hook_type, caption_plan, reframe_strategy, risk_notes,
                       title, description, hashtags, source_url, source_channel, attribution,
                       final_video_path, thumbnail_path, status, created_at, updated_at)
    VALUES (@id, @source_video_id, @correlation_id, @start_sec, @end_sec, @duration_sec,
            @score, @hook_type, @caption_plan, @reframe_strategy, @risk_notes,
            @title, @description, @hashtags, @source_url, @source_channel, @attribution,
            @final_video_path, @thumbnail_path, @status, @created_at, @updated_at)
  `).run(clip);
}

function updateClip(id, fields) {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE clips SET ${sets}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, updated_at: now, id });
}

function getClip(id) {
  return getDb().prepare('SELECT * FROM clips WHERE id = ?').get(id);
}

function getClipsBySourceVideo(sourceVideoId) {
  return getDb().prepare('SELECT * FROM clips WHERE source_video_id = ? ORDER BY score DESC').all(sourceVideoId);
}

function getExistingClip(sourceVideoId, startSec, endSec) {
  return getDb().prepare(`
    SELECT * FROM clips 
    WHERE source_video_id = ? 
      AND ABS(start_sec - ?) < 0.5 
      AND ABS(end_sec - ?) < 0.5
    LIMIT 1
  `).get(sourceVideoId, startSec, endSec);
}

// ─── Videos (legacy - keep for backward compatibility) ──────────────────────

function insertVideo(video) {
  const db = getDb();
  db.prepare(`
    INSERT INTO videos (id, correlation_id, topic, title, description, hashtags, status, created_at, updated_at)
    VALUES (@id, @correlation_id, @topic, @title, @description, @hashtags, @status, @created_at, @updated_at)
  `).run(video);
}

function updateVideo(id, fields) {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE videos SET ${sets}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, updated_at: now, id });
}

function getVideo(id) {
  return getDb().prepare('SELECT * FROM videos WHERE id = ?').get(id);
}

function getVideoByCorrelation(correlationId) {
  return getDb().prepare('SELECT * FROM videos WHERE correlation_id = ?').get(correlationId);
}

// ─── Memory ──────────────────────────────────────────────────────────────────

function upsertMemory(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO memory (id, pattern_type, pattern_value, weight, views_avg, engagement, clip_count, last_updated, created_at)
    VALUES (@id, @pattern_type, @pattern_value, @weight, @views_avg, @engagement, @clip_count, @last_updated, @created_at)
    ON CONFLICT(pattern_type, pattern_value) DO UPDATE SET
      weight       = excluded.weight,
      views_avg    = excluded.views_avg,
      engagement   = excluded.engagement,
      clip_count   = excluded.clip_count,
      last_updated = excluded.last_updated
  `).run(record);
}

function getAllMemory() {
  return getDb().prepare('SELECT * FROM memory ORDER BY weight DESC').all();
}

function getTopPatterns(patternType, limit = 10) {
  return getDb().prepare(`
    SELECT * FROM memory 
    WHERE pattern_type = ? AND weight > 0.2
    ORDER BY weight DESC 
    LIMIT ?
  `).all(patternType, limit);
}

function getAvoidPatterns(patternType) {
  return getDb().prepare(`
    SELECT * FROM memory 
    WHERE pattern_type = ? AND weight < 0.2
    ORDER BY weight ASC
  `).all(patternType);
}

// ─── Analytics ───────────────────────────────────────────────────────────────

function insertAnalytics(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO analytics (id, clip_id, views, likes, comments, ctr, avg_view_pct, recorded_at)
    VALUES (@id, @clip_id, @views, @likes, @comments, @ctr, @avg_view_pct, @recorded_at)
  `).run(record);
}

function getAnalyticsByClip(clipId) {
  return getDb().prepare('SELECT * FROM analytics WHERE clip_id = ? ORDER BY recorded_at DESC').all(clipId);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Admin Operations ────────────────────────────────────────────────────────

function countRows(table) {
  const db = getDb();
  try {
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
    return result.count;
  } catch (e) {
    return 0;
  }
}

function clearJobs() {
  const db = getDb();
  const result = db.prepare('DELETE FROM jobs WHERE status IN (?, ?, ?)').run('pending', 'processing', 'failed');
  return result.changes;
}

function clearDeadLetters() {
  const db = getDb();
  const result = db.prepare('DELETE FROM dead_letter').run();
  return result.changes;
}

function clearMemory() {
  const db = getDb();
  const result = db.prepare('DELETE FROM memory').run();
  return result.changes;
}

function clearAllTestState() {
  const db = getDb();
  const counts = {
    jobs: countRows('jobs'),
    dead_letter: countRows('dead_letter'),
    source_videos: countRows('source_videos'),
    clips: countRows('clips'),
    analytics: countRows('analytics'),
    memory: countRows('memory'),
  };
  
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM dead_letter').run();
  db.prepare('DELETE FROM analytics').run();
  db.prepare('DELETE FROM memory').run();
  db.prepare('DELETE FROM clips').run();
  db.prepare('DELETE FROM source_videos').run();
  
  return counts;
}

function getDetailedJobStats() {
  const db = getDb();
  
  const byTypeStatus = db.prepare(`
    SELECT type, status, COUNT(*) as count 
    FROM jobs 
    GROUP BY type, status 
    ORDER BY type, status
  `).all();
  
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count 
    FROM jobs 
    GROUP BY status
  `).all();
  
  const retryStats = db.prepare(`
    SELECT 
      AVG(retry_count) as avg_retry,
      MAX(retry_count) as max_retry,
      SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried_count
    FROM jobs
  `).get();
  
  const oldestPending = db.prepare(`
    SELECT type, created_at 
    FROM jobs 
    WHERE status = 'pending' 
    ORDER BY created_at ASC 
    LIMIT 1
  `).get();
  
  const oldestProcessing = db.prepare(`
    SELECT type, locked_at 
    FROM jobs 
    WHERE status = 'processing' 
    ORDER BY locked_at ASC 
    LIMIT 1
  `).get();
  
  return {
    byTypeStatus,
    byStatus,
    retryStats,
    oldestPending,
    oldestProcessing,
  };
}

function getDeadLetterSummary() {
  const db = getDb();
  
  const total = countRows('dead_letter');
  
  const byType = db.prepare(`
    SELECT type, COUNT(*) as count 
    FROM dead_letter 
    GROUP BY type 
    ORDER BY count DESC
  `).all();
  
  const recent = db.prepare(`
    SELECT type, error, failed_at 
    FROM dead_letter 
    ORDER BY failed_at DESC 
    LIMIT 5
  `).all();
  
  return { total, byType, recent };
}

function deleteJobsByIds(jobIds) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return 0;
  
  const db = getDb();
  const placeholders = jobIds.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`);
  const result = stmt.run(...jobIds);
  return result.changes;
}

function findOrphanJobs() {
  const db = getDb();
  const fs = require('fs');
  const path = require('path');
  const { safeParseJson } = require('./safeJson');
  
  const allJobs = db.prepare('SELECT * FROM jobs').all();
  const orphans = [];
  
  for (const job of allJobs) {
    let payload;
    try {
      payload = safeParseJson(job.payload, 'findOrphanJobs');
    } catch (e) {
      // Invalid payload = orphan
      orphans.push({ job, reason: 'invalid_payload' });
      continue;
    }
    
    if (!payload) {
      orphans.push({ job, reason: 'null_payload' });
      continue;
    }
    
    // Check transcript/scene_detect/clip_planner jobs
    if (['transcript', 'scene_detect', 'clip_planner'].includes(job.type)) {
      const sourceVideoId = payload.source_video_id;
      
      if (!sourceVideoId) {
        orphans.push({ job, reason: 'missing_source_video_id' });
        continue;
      }
      
      // Check if source_video exists in DB
      const sourceVideo = db.prepare('SELECT id FROM source_videos WHERE id = ?').get(sourceVideoId);
      if (!sourceVideo) {
        orphans.push({ job, reason: 'source_video_not_found' });
        continue;
      }
      
      // Check if source_ingest.json exists
      const sourceIngestPath = path.join(config.paths.output, sourceVideoId, 'source_ingest.json');
      if (!fs.existsSync(sourceIngestPath)) {
        orphans.push({ job, reason: 'source_ingest_json_missing' });
        continue;
      }
    }
    
    // Check clip_render/telegram_clip jobs
    if (['clip_render', 'telegram_clip'].includes(job.type)) {
      const clipId = payload.clip_id;
      
      if (!clipId) {
        orphans.push({ job, reason: 'missing_clip_id' });
        continue;
      }
      
      // Check if clip exists in DB
      const clip = db.prepare('SELECT id, status FROM clips WHERE id = ?').get(clipId);
      if (!clip) {
        orphans.push({ job, reason: 'clip_not_found' });
        continue;
      }
      
      // telegram_clip should not be sent for already reviewed clips
      if (job.type === 'telegram_clip') {
        if (['pending_review', 'approved', 'rejected', 'uploaded'].includes(clip.status)) {
          orphans.push({ job, reason: 'clip_already_reviewed' });
          continue;
        }
      }
    }
  }
  
  return orphans;
}

module.exports = {
  getDb,
  // Jobs
  insertJob, getNextPendingJob, claimNextPendingJob, lockJob, completeJob, failJob, requeueJob,
  getTimedOutPendingJobs, getTimedOutProcessingJobs, moveToDeadLetter, hardResetDatabase, deleteJob, updateJobStatus,
  // Source Videos
  insertSourceVideo, updateSourceVideo, getSourceVideo, getSourceVideoByCorrelation,
  // Clips
  insertClip, updateClip, getClip, getClipsBySourceVideo, getExistingClip,
  // Videos (legacy)
  insertVideo, updateVideo, getVideo, getVideoByCorrelation,
  // Memory
  upsertMemory, getAllMemory, getTopPatterns, getAvoidPatterns,
  // Analytics
  insertAnalytics, getAnalyticsByClip,
  // Admin Operations
  countRows, clearJobs, clearDeadLetters, clearMemory, clearAllTestState,
  getDetailedJobStats, getDeadLetterSummary, deleteJobsByIds, findOrphanJobs,
  // Lifecycle
  closeDb,
};
