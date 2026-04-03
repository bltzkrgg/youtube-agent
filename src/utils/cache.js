'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');
const { safeParseJson, safeStringifyJson } = require('./safeJson');

// Ensure cache directory exists
fs.mkdirSync(config.paths.cache, { recursive: true });

/**
 * File-based cache with TTL.
 * Each entry is stored as a single JSON file: cache/{hash}.json
 */

function getCacheKey(key) {
  return crypto.createHash('md5').update(key).digest('hex');
}

function getCachePath(key) {
  return path.join(config.paths.cache, `${getCacheKey(key)}.json`);
}

/**
 * Get a cached value. Returns null if not found or expired.
 */
function cacheGet(key) {
  const filePath = getCachePath(key);
  try {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry = safeParseJson(raw, `cache:get:${key}`);
    if (!entry) return null;

    const now = Date.now();
    if (entry.expiresAt && now > entry.expiresAt) {
      fs.unlinkSync(filePath);
      logger.debug('Cache expired, dihapus', { key });
      return null;
    }

    logger.debug('Cache hit', { key });
    return entry.value;
  } catch (err) {
    logger.warn('Cache get error', { key, error_message: err.message });
    return null;
  }
}

/**
 * Set a cached value.
 * @param {string} key
 * @param {*}      value
 * @param {number} ttlHours - TTL in hours (default from config)
 */
function cacheSet(key, value, ttlHours = config.cacheTtlHours) {
  const filePath = getCachePath(key);
  try {
    const entry = {
      key,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
    };
    fs.writeFileSync(filePath, safeStringifyJson(entry), 'utf-8');
    logger.debug('Cache set', { key, ttlHours });
  } catch (err) {
    logger.warn('Cache set error', { key, error_message: err.message });
  }
}

/**
 * Delete a cache entry.
 */
function cacheDel(key) {
  const filePath = getCachePath(key);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn('Cache del error', { key, error_message: err.message });
  }
}

/**
 * Wrap an async function with caching.
 */
async function withCache(key, fn, ttlHours = config.cacheTtlHours) {
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const result = await fn();
  if (result !== null && result !== undefined) {
    cacheSet(key, result, ttlHours);
  }
  return result;
}

module.exports = { cacheGet, cacheSet, cacheDel, withCache };
