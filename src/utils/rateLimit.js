'use strict';

const logger = require('./logger');
const { sleep } = require('./retry');

/**
 * Simple per-key rate limiter using in-memory timestamps.
 * Controls minimum delay between calls to the same API.
 */
const lastCallTime = new Map();

/**
 * Throttle calls by key — wait until minDelayMs has passed since the last call.
 *
 * @param {string} key         - identifier (e.g. 'openrouter', 'ytdlp')
 * @param {number} minDelayMs  - minimum ms between calls (default 1000)
 */
async function throttle(key, minDelayMs = 1000) {
  const now = Date.now();
  const last = lastCallTime.get(key) || 0;
  const elapsed = now - last;

  if (elapsed < minDelayMs) {
    const wait = minDelayMs - elapsed;
    logger.debug(`Rate limit: menunggu ${wait}ms untuk ${key}`);
    await sleep(wait);
  }

  lastCallTime.set(key, Date.now());
}

/**
 * Rate-limited API call wrapper.
 * Ensures minDelayMs between successive calls for the same key.
 *
 * @param {string}   key
 * @param {Function} fn
 * @param {number}   minDelayMs
 */
async function rateLimited(key, fn, minDelayMs = 1000) {
  await throttle(key, minDelayMs);
  return fn();
}

module.exports = { throttle, rateLimited };
