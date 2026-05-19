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
 * Delete rejected clips older than TTL days.
 */
function cleanupRejectedClips(db) {
  const ttlMs = config.rejectedVideoTtlDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - ttlMs).toISOString();

  const rejected = db.prepare(
    "SELECT id, source_video_id FROM clips WHERE status = 'rejected' AND rejected_at < ?"
  ).all(cutoff);

  for (const { id, source_video_id } of rejected) {
    // Delete clip directory
    const clipDir = path.join(config.paths.output, source_video_id, 'clips', id);
    if (fs.existsSync(clipDir)) {
      fs.rmSync(clipDir, { recursive: true, force: true });
      logger.info('Clip rejected dihapus (cleanup)', { clipId: id, sourceVideoId: source_video_id });
    }
    
    // Delete clip record
    db.prepare('DELETE FROM clips WHERE id = ?').run(id);
    
    // Check if source video has any remaining clips
    const remainingClips = db.prepare('SELECT COUNT(*) as c FROM clips WHERE source_video_id = ?').get(source_video_id);
    if (remainingClips.c === 0) {
      // No clips left, delete entire source video directory
      deleteVideoDir(source_video_id);
      db.prepare('DELETE FROM source_videos WHERE id = ?').run(source_video_id);
      logger.info('Source video dihapus (no clips remaining)', { sourceVideoId: source_video_id });
    }
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
  cleanupRejectedClips,
  ensureDirectories,
};
