'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { safeParseJson } = require('./safeJson');

/**
 * Get the output directory for a specific video.
 * Auto-creates subdirs on first call.
 */
function getVideoDir(videoId, sub = '') {
  const base = path.join(config.paths.output, videoId, sub);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/**
 * Write JSON data to a file inside the video's output directory.
 */
function writeVideoJson(videoId, filename, data) {
  const dir = getVideoDir(videoId);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.debug('File JSON ditulis', { videoId, filename });
  return filePath;
}

/**
 * Read JSON from a file inside the video's output directory.
 * Returns null if not found.
 */
function readVideoJson(videoId, filename) {
  const filePath = path.join(config.paths.output, videoId, filename);
  if (!fs.existsSync(filePath)) return null;
  return safeParseJson(fs.readFileSync(filePath, 'utf-8'), `storage:readVideoJson:${filename}`);
}

/**
 * Check if a file exists in the video's output directory.
 */
function videoFileExists(videoId, filename) {
  return fs.existsSync(path.join(config.paths.output, videoId, filename));
}

/**
 * Delete an entire video directory (used for cleanup).
 */
function deleteVideoDir(videoId) {
  const dir = path.join(config.paths.output, videoId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info('Direktori video dihapus', { videoId });
  }
}

/**
 * List all video IDs in the output directory.
 */
function listVideoIds() {
  if (!fs.existsSync(config.paths.output)) return [];
  return fs.readdirSync(config.paths.output, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Delete rejected videos older than TTL days.
 */
function cleanupRejectedVideos(db) {
  const ttlMs = config.rejectedVideoTtlDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - ttlMs).toISOString();

  const rejected = db.prepare(
    "SELECT id FROM videos WHERE status = 'rejected' AND rejected_at < ?"
  ).all(cutoff);

  for (const { id } of rejected) {
    deleteVideoDir(id);
    db.prepare('DELETE FROM videos WHERE id = ?').run(id);
    logger.info('Video rejected dihapus (cleanup)', { videoId: id });
  }
}

/**
 * Ensure all required base directories exist.
 */
function ensureDirectories() {
  for (const dir of Object.values(config.paths)) {
    if (dir.endsWith('.db')) continue; // skip file paths
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  getVideoDir,
  writeVideoJson,
  readVideoJson,
  videoFileExists,
  deleteVideoDir,
  listVideoIds,
  cleanupRejectedVideos,
  ensureDirectories,
};
