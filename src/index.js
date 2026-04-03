'use strict';

require('dotenv').config();

const config = require('./config');
const logger = require('./utils/logger');
const { ensureDirectories } = require('./utils/storage');
const { initBot, notify } = require('./bot/telegram');
const { initScheduler, stopScheduler } = require('./scheduler/cron');
const { closeDb } = require('./utils/db');

const APP_VERSION = '1.0.0';
let isShuttingDown = false;

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== YouTube Shorts Agent dimulai ===', { version: APP_VERSION });
  logger.info(`Mode: ${config.dryRun ? 'DRY_RUN' : 'PRODUCTION'}`, {});

  try {
    // Step 1: Ensure all directories exist
    ensureDirectories();
    logger.info('Direktori output siap');

    // Step 2: Initialize Telegram bot
    initBot();
    logger.info('Telegram Bot aktif');

    // Step 3: Start cron scheduler
    initScheduler();
    logger.info('Scheduler aktif');

    // Step 4: Send startup notification
    await notify(
      `🤖 YouTube Shorts Agent v${APP_VERSION} aktif!\n` +
      `Mode: ${config.dryRun ? 'DRY_RUN' : 'PRODUCTION'}\n` +
      `Ketik /help untuk daftar perintah.`
    );

    logger.info('=== Agent siap menerima perintah ===');

    // If --run-now flag is passed, trigger research immediately
    if (process.argv.includes('--run-now')) {
      logger.info('Flag --run-now terdeteksi, memulai pipeline sekarang');
      const { triggerResearch } = require('./agents/research');
      await triggerResearch().catch((err) => {
        logger.error('Pipeline --run-now gagal', { error_message: err.message });
      });
    }

  } catch (err) {
    logger.error('Gagal menginisialisasi agent', {
      step: 'main',
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    process.exit(1);
  }
}

// ─── Graceful shutdown (rule 47) ──────────────────────────────────────────────

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Menerima sinyal ${signal}, memulai graceful shutdown...`);

  try {
    // 1. Stop accepting new cron jobs
    stopScheduler();
    logger.info('Scheduler dihentikan');

    // 2. Wait for active clip job to finish (max 60s)
    logger.info('Menunggu job aktif selesai (max 60s)...');
    await _waitForActiveJobs(60000);

    // 3. Notify Telegram
    await notify(`🔴 Agent dihentikan (${signal})`).catch(() => {});

    // 4. Close database
    closeDb();
    logger.info('Database ditutup');

    logger.info('Graceful shutdown selesai');
    process.exit(0);
  } catch (err) {
    logger.error('Error saat shutdown', { error_message: err.message });
    process.exit(1);
  }
}

async function _waitForActiveJobs(maxWaitMs) {
  const start = Date.now();
  const { getDb } = require('./utils/db');

  while (Date.now() - start < maxWaitMs) {
    const processing = getDb().prepare(
      "SELECT COUNT(*) as c FROM jobs WHERE status = 'processing'"
    ).get();

    if (processing.c === 0) {
      logger.info('Semua job selesai');
      return;
    }

    logger.info(`Masih ada ${processing.c} job aktif, menunggu...`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.warn('Timeout menunggu job aktif, melanjutkan shutdown');
}

// ─── Signal handlers ──────────────────────────────────────────────────────────

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error_message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });
  // Don't exit — stay running (rule 10)
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error_message: String(reason),
    timestamp: new Date().toISOString(),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

main();
