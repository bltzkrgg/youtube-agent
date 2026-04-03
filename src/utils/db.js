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

    -- Videos tracking
    CREATE TABLE IF NOT EXISTS videos (
      id              TEXT PRIMARY KEY,
      correlation_id  TEXT NOT NULL,
      topic           TEXT,
      title           TEXT,
      description     TEXT,
      hashtags        TEXT,
      status          TEXT NOT NULL DEFAULT 'processing',
      approved_at     TEXT,
      rejected_at     TEXT,
      reject_reason   TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- Analytics
    CREATE TABLE IF NOT EXISTS analytics (
      id              TEXT PRIMARY KEY,
      video_id        TEXT,
      views           INTEGER DEFAULT 0,
      likes           INTEGER DEFAULT 0,
      comments        INTEGER DEFAULT 0,
      ctr             REAL DEFAULT 0,
      avg_view_pct    REAL DEFAULT 0,
      recorded_at     TEXT NOT NULL,
      FOREIGN KEY (video_id) REFERENCES videos(id)
    );

    -- Memory / learning weights
    CREATE TABLE IF NOT EXISTS memory (
      id           TEXT PRIMARY KEY,
      topic        TEXT NOT NULL UNIQUE,
      weight       REAL NOT NULL DEFAULT 1.0,
      views_avg    REAL NOT NULL DEFAULT 0,
      engagement   REAL NOT NULL DEFAULT 0,
      video_count  INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    -- Shopee affiliate links
    CREATE TABLE IF NOT EXISTS shopee_links (
      id          TEXT PRIMARY KEY,
      keyword     TEXT NOT NULL,
      url         TEXT NOT NULL,
      description TEXT,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_type      ON jobs(type, status);
    CREATE INDEX IF NOT EXISTS idx_videos_status  ON videos(status);
    CREATE INDEX IF NOT EXISTS idx_memory_topic   ON memory(topic);
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

function moveToDeadLetter(job, errorMsg) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO dead_letter (id, original_job_id, correlation_id, type, payload, error, failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    job.id,
    job.correlation_id,
    job.type,
    job.payload,
    errorMsg,
    now
  );
  completeJob(job.id); // Mark original as done so it's not retried
}

// ─── Videos ──────────────────────────────────────────────────────────────────

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

// ─── Shopee Links ────────────────────────────────────────────────────────────

function insertShopeeLink(link) {
  const db = getDb();
  db.prepare(`
    INSERT INTO shopee_links (id, keyword, url, description, is_active, created_at)
    VALUES (@id, @keyword, @url, @description, @is_active, @created_at)
  `).run(link);
}

function getShopeeLinks(keyword = null) {
  const db = getDb();
  if (keyword) {
    return db.prepare(
      "SELECT * FROM shopee_links WHERE is_active = 1 AND keyword LIKE ?"
    ).all(`%${keyword}%`);
  }
  return db.prepare('SELECT * FROM shopee_links WHERE is_active = 1').all();
}

// ─── Memory ──────────────────────────────────────────────────────────────────

function upsertMemory(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO memory (id, topic, weight, views_avg, engagement, video_count, last_updated, created_at)
    VALUES (@id, @topic, @weight, @views_avg, @engagement, @video_count, @last_updated, @created_at)
    ON CONFLICT(topic) DO UPDATE SET
      weight       = excluded.weight,
      views_avg    = excluded.views_avg,
      engagement   = excluded.engagement,
      video_count  = excluded.video_count,
      last_updated = excluded.last_updated
  `).run(record);
}

function getAllMemory() {
  return getDb().prepare('SELECT * FROM memory ORDER BY weight DESC').all();
}

// ─── Analytics ───────────────────────────────────────────────────────────────

function insertAnalytics(record) {
  const db = getDb();
  db.prepare(`
    INSERT INTO analytics (id, video_id, views, likes, comments, ctr, avg_view_pct, recorded_at)
    VALUES (@id, @video_id, @views, @likes, @comments, @ctr, @avg_view_pct, @recorded_at)
  `).run(record);
}

function getAnalyticsByVideo(videoId) {
  return getDb().prepare('SELECT * FROM analytics WHERE video_id = ?').all(videoId);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  // Jobs
  insertJob, getNextPendingJob, lockJob, completeJob, failJob, requeueJob, moveToDeadLetter,
  // Videos
  insertVideo, updateVideo, getVideo, getVideoByCorrelation,
  // Shopee
  insertShopeeLink, getShopeeLinks,
  // Memory
  upsertMemory, getAllMemory,
  // Analytics
  insertAnalytics, getAnalyticsByVideo,
  // Lifecycle
  closeDb,
};
