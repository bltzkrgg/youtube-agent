#!/usr/bin/env node
'use strict';

/**
 * Manual trigger untuk clipper pipeline.
 * Usage: node src/trigger_clipper.js <youtube_url>
 */

require('dotenv').config();

const { triggerSourceIngest } = require('./agents/source_ingest');
const logger = require('./utils/logger');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node src/trigger_clipper.js <youtube_url>');
    console.error('Example: node src/trigger_clipper.js https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    process.exit(1);
  }

  const sourceUrl = args[0];

  // Validate URL
  if (!sourceUrl.includes('youtube.com') && !sourceUrl.includes('youtu.be')) {
    console.error('Error: URL harus berupa YouTube URL');
    process.exit(1);
  }

  logger.info('=== Manual Trigger Clipper Pipeline ===');
  logger.info(`Source URL: ${sourceUrl}`);

  try {
    await triggerSourceIngest(sourceUrl);
    logger.info('Pipeline dimulai! Monitor logs untuk progress.');
    logger.info('Pipeline: SourceIngest → Transcript + SceneDetect → ClipPlanner → ClipRender → Telegram');
  } catch (err) {
    logger.error('Gagal memulai pipeline', { error_message: err.message, stack: err.stack });
    process.exit(1);
  }
}

main();
