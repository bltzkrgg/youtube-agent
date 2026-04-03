'use strict';

const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const { notify } = require('../bot/telegram');

const AGENT = 'Scheduler';

const activeTasks = [];

// ─── Pipeline schedule (UTC) ─────────────────────────────────────────────────
//
//  Research hanya di-trigger sekali sehari (00:00 UTC).
//  Semua pipeline agent poll queue setiap 5 menit — langsung return jika
//  tidak ada job. Ini memastikan pipeline tidak terputus meski satu stage
//  butuh waktu lebih lama dari jadwal tetap.
//
//  00:00       → Research  (trigger harian)
//  */5 min     → Script, Metadata, Affiliate, Voiceover, Visual, Clip,
//                Telegram (poll queue)
//  16:00       → Analytics (proses CSV dari queue)
//  16:30       → Memory    (update learning weights)
//  Sun 03:00   → Cleanup   (hapus rejected videos >7 hari)

const SCHEDULES = [
  // ── Trigger harian ──────────────────────────────────────────────────────
  {
    name: 'Research',
    cron: '0 0 * * *',
    agent: () => require('../agents/research').runResearchAgent(),
  },

  // ── Pipeline agents — poll setiap 5 menit ───────────────────────────────
  {
    name: 'Script',
    cron: '*/5 * * * *',
    agent: () => require('../agents/script').runScriptAgent(),
  },
  {
    name: 'Metadata',
    cron: '*/5 * * * *',
    agent: () => require('../agents/metadata').runMetadataAgent(),
  },
  {
    name: 'Voiceover',
    cron: '*/5 * * * *',
    agent: () => require('../agents/voiceover').runVoiceoverAgent(),
  },
  {
    name: 'Visual',
    cron: '*/5 * * * *',
    agent: () => require('../agents/visual').runVisualAgent(),
  },
  {
    name: 'Clip',
    cron: '*/5 * * * *',
    agent: () => require('../agents/clip').runClipAgent(),
  },
  {
    name: 'Telegram',
    cron: '*/5 * * * *',
    agent: () => require('../bot/telegram').runTelegramAgent(),
  },

  // ── Analytics & Memory — harian ─────────────────────────────────────────
  {
    name: 'Analytics',
    cron: '0 16 * * *',
    agent: () => require('../agents/analytics').runAnalyticsAgent(),
  },
  {
    name: 'Memory',
    cron: '30 16 * * *',
    agent: () => require('../agents/memory').runMemoryAgent(),
  },

  // ── Cleanup mingguan ─────────────────────────────────────────────────────
  {
    name: 'Cleanup',
    cron: '0 3 * * 0',
    agent: () => _runCleanup(),
  },
];

// ─── Init ─────────────────────────────────────────────────────────────────────

function initScheduler() {
  logger.info(`Menginisialisasi ${SCHEDULES.length} jadwal`, { agent: AGENT });

  for (const schedule of SCHEDULES) {
    if (!cron.validate(schedule.cron)) {
      logger.error(`Cron expression tidak valid: ${schedule.cron}`, { agent: AGENT, name: schedule.name });
      continue;
    }

    const task = cron.schedule(schedule.cron, async () => {
      logger.info(`Cron triggered: ${schedule.name}`, { agent: AGENT });
      try {
        await schedule.agent();
      } catch (err) {
        logger.error(`Cron ${schedule.name} gagal`, {
          agent: AGENT, step: schedule.name,
          error_message: err.message, stack: err.stack,
          timestamp: new Date().toISOString(),
        });
        notify(`⚠️ Cron ${schedule.name} gagal: ${err.message}`).catch(() => {});
      }
    }, { scheduled: true, timezone: 'UTC' });

    activeTasks.push(task);
    logger.info(`Jadwal terdaftar: ${schedule.name} [${schedule.cron} UTC]`, { agent: AGENT });
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function _runCleanup() {
  logger.info('Menjalankan cleanup mingguan', { agent: AGENT });
  try {
    const { cleanupRejectedVideos } = require('../utils/storage');
    const { getDb } = require('../utils/db');
    cleanupRejectedVideos(getDb());
    logger.info('Cleanup selesai', { agent: AGENT });
  } catch (err) {
    logger.error('Cleanup gagal', { agent: AGENT, error_message: err.message });
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function stopScheduler() {
  logger.info(`Menghentikan ${activeTasks.length} cron tasks`, { agent: AGENT });
  for (const task of activeTasks) task.stop();
}

module.exports = { initScheduler, stopScheduler };
