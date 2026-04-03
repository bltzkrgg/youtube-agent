'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('./logger');
const db = require('./db');
const { safeStringifyJson, safeParseJson } = require('./safeJson');

// Priority map
const PRIORITY = { high: 10, normal: 5, low: 1 };

/**
 * Push a new job into the queue.
 *
 * @param {string} type           - job type (research|metadata|affiliate|clip|telegram|analytics|memory)
 * @param {Object} payload        - job data
 * @param {Object} opts
 * @param {string} opts.correlationId  - trace ID (generated if not provided)
 * @param {string} opts.priority       - 'high'|'normal'|'low'
 * @param {number} opts.maxRetry
 * @param {number} opts.timeoutMs      - execution timeout in ms
 */
function pushJob(type, payload, opts = {}) {
  const now = new Date().toISOString();
  const correlationId = opts.correlationId || uuidv4();
  const priority = PRIORITY[opts.priority || 'normal'] ?? 5;
  const maxRetry = opts.maxRetry ?? config.maxRetry;
  const timeoutMs = opts.timeoutMs ?? config.timeouts.default;
  const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();

  const job = {
    id: uuidv4(),
    correlation_id: correlationId,
    type,
    status: 'pending',
    priority,
    retry_count: 0,
    max_retry: maxRetry,
    payload: safeStringifyJson(payload),
    version: '1.0',
    error: null,
    created_at: now,
    updated_at: now,
    locked_at: null,
    timeout_at: timeoutAt,
  };

  // Idempotency check: prevent duplicate jobs of same type+correlationId
  const existing = db.getDb().prepare(
    "SELECT id FROM jobs WHERE correlation_id = ? AND type = ? AND status NOT IN ('done','failed')"
  ).get(correlationId, type);

  if (existing) {
    logger.warn('Job duplikat dicegah (idempotency)', { type, correlationId });
    return existing.id;
  }

  db.insertJob(job);
  logger.info(`Job ditambahkan ke queue`, { type, jobId: job.id, correlationId, priority });
  return job.id;
}

/**
 * Pop and lock the next pending job of a given type.
 * Returns null if queue is empty.
 */
function popJob(type) {
  const job = db.getNextPendingJob(type);
  if (!job) return null;

  // Check if job has timed out before locking
  if (job.timeout_at && new Date(job.timeout_at) < new Date()) {
    logger.warn('Job timeout sebelum diproses', { jobId: job.id, type });
    db.failJob(job.id, 'Job timeout sebelum diproses', job.retry_count);
    _handleRetryOrDead(job, 'Job timeout sebelum diproses');
    return null;
  }

  db.lockJob(job.id);
  logger.info(`Job dikunci untuk diproses`, { type, jobId: job.id });

  return {
    ...job,
    payload: safeParseJson(job.payload, `queue:pop:${type}`) || {},
  };
}

/**
 * Mark a job as successfully completed.
 */
function ackJob(jobId) {
  db.completeJob(jobId);
  logger.info('Job selesai', { jobId });
}

/**
 * Mark a job as failed. Retry or move to dead-letter based on retry_count.
 */
function nackJob(job, errorMsg) {
  const newRetryCount = (job.retry_count || 0) + 1;
  db.failJob(job.id, errorMsg, newRetryCount);
  _handleRetryOrDead({ ...job, retry_count: newRetryCount }, errorMsg);
}

function _handleRetryOrDead(job, errorMsg) {
  if (job.retry_count < job.max_retry) {
    db.requeueJob(job.id, job.retry_count);
    logger.warn('Job direqueue untuk retry', {
      jobId: job.id,
      retry: job.retry_count,
      max: job.max_retry,
    });
  } else {
    db.moveToDeadLetter(job, errorMsg);
    logger.error('Job dipindah ke dead-letter queue', {
      jobId: job.id,
      type: job.type,
      error_message: errorMsg,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get queue stats (pending count per type).
 */
function getQueueStats() {
  const rows = db.getDb().prepare(`
    SELECT type, status, COUNT(*) as count
    FROM jobs
    GROUP BY type, status
  `).all();
  return rows;
}

module.exports = { pushJob, popJob, ackJob, nackJob, getQueueStats, PRIORITY };
