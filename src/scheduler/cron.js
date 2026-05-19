'use strict';

const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const { notify } = require('../bot/telegram');

const AGENT = 'Scheduler';

const activeTasks = [];

// ─── Pipeline schedule (UTC) ─────────────────────────────────────────────────
//
//  NEW CLIPPER PIPELINE:
//  Manual trigger → SourceIngest → Transcript + SceneDetect (parallel) →
//  ClipPlanner → ClipRender (per clip) → TelegramReview → Analytics → Memory
//
//  */5 min     → All pipeline agents poll queue
//  16:00       → Analytics (proses CSV dari queue)
//  16:30       → Memory    (update learning weights)
//  Sun 03:00   → Cleanup   (hapus rejected clips >7 hari)

const SCHEDULES = [
  // ── NEW CLIPPER PIPELINE — poll setiap 5 menit ──────────────────────────
  {
    name: 'SourceIngest',
    cron: '*/5 * * * *',
    agent: () => require('../agents/source_ingest').runSourceIngestAgent(),
  },
  {
    name: 'Transcript',
    cron: '*/5 * * * *',
    agent: () => require('../agents/transcript').runTranscriptAgent(),
  },
  {
    name: 'SceneDetect',
    cron: '*/5 * * * *',
    agent: () => require('../agents/scene_detect').runSceneDetectAgent(),
  },
  {
    name: 'ClipPlanner',
    cron: '*/5 * * * *',
    agent: () => require('../agents/clip_planner').runClipPlannerAgent(),
  },
  {
    name: 'ClipRender',
    cron: '*/5 * * * *',
    agent: () => require('../agents/clip_render').runClipRenderAgent(),
  },
  {
    name: 'Telegram',
    cron: '*/5 * * * *',
    agent: () => require('../bot/telegram').runTelegramAgent(),
  },

  // ── LEGACY PIPELINE (disabled by default, uncomment to enable) ──────────
  // {
  //   name: 'Research',
  //   cron: '0 0 * * *',
  //   agent: () => require('../agents/research').runResearchAgent(),
  // },
  // {
  //   name: 'Script',
  //   cron: '*/5 * * * *',
  //   agent: () => require('../agents/script').runScriptAgent(),
  // },
  // {
  //   name: 'Metadata',
  //   cron: '*/5 * * * *',
  //   agent: () => require('../agents/metadata').runMetadataAgent(),
  // },
  // {
  //   name: 'Voiceover',
  //   cron: '*/5 * * * *',
  //   agent: () => require('../agents/voiceover').runVoiceoverAgent(),
  // },
  // {
  //   name: 'Visual',
  //   cron: '*/5 * * * *',
  //   agent: () => require('../agents/visual').runVisualAgent(),
  // },
  // {
  //   name: 'Clip',
  //   cron: '*/5 * * * *',
  //   agent: () => require('../agents/clip').runClipAgent(),
  // },

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
  // ── Rejection penalty — near-realtime (every minute) ────────────────────
  {
    name: 'MemoryPenalty',
    cron: '* * * * *',
    agent: () => require('../agents/memory').runMemoryPenaltyAgent(),
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
    const { cleanupRejectedClips } = require('../utils/storage');
    const { getDb } = require('../utils/db');
    cleanupRejectedClips(getDb());
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
