'use strict';

require('dotenv').config();
const path = require('path');

// Validate required env vars at startup
const REQUIRED = [];

// In DRY_RUN mode, API keys are optional
if (process.env.DRY_RUN !== 'true') {
  REQUIRED.push('OPENROUTER_API_KEY');
  REQUIRED.push('TELEGRAM_BOT_TOKEN');
  REQUIRED.push('TELEGRAM_CHAT_ID');
}

// YouTube API is optional for clipper (only needed for legacy research agent)
// if (process.env.DRY_RUN !== 'true') {
//   REQUIRED.push('YOUTUBE_API_KEY');
// }

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[CONFIG] Error: env var ${key} wajib diisi`);
    process.exit(1);
  }
}

const DEFAULT_MODEL = 'anthropic/claude-3-haiku';

const config = {
  // Runtime mode
  dryRun: process.env.DRY_RUN === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
  maxProductionSlots: parseInt(process.env.MAX_PRODUCTION_SLOTS) || 3,

  // AI — OpenRouter (per-agent model override)
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      research:      process.env.RESEARCH_MODEL       || DEFAULT_MODEL,
      script:        process.env.SCRIPT_MODEL         || DEFAULT_MODEL,
      metadata:      process.env.METADATA_MODEL       || DEFAULT_MODEL,
      clipPlanner:   process.env.CLIP_PLANNER_MODEL   || DEFAULT_MODEL,
    },
  },

  // YouTube Data API v3 (optional, only for legacy research agent)
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || null,
  },

  // yt-dlp config
  ytdlp: {
    format: process.env.YTDLP_FORMAT || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || null, // e.g., 'chrome', 'firefox'
  },

  // Whisper config
  whisper: {
    model: process.env.WHISPER_MODEL || 'base', // tiny, base, small, medium, large
  },

  // Scene detection config
  sceneDetect: {
    threshold: parseFloat(process.env.SCENE_DETECT_THRESHOLD || '27.0'),
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId:   process.env.TELEGRAM_CHAT_ID,
  },

  // Retry
  maxRetry: parseInt(process.env.MAX_RETRY || '3', 10),

  // Timeouts (ms)
  timeouts: {
    research: parseInt(process.env.TIMEOUT_RESEARCH || '300000',  10),
    visual:   parseInt(process.env.TIMEOUT_VISUAL   || '3600000', 10), // 1h — Veo can be slow
    clip:     parseInt(process.env.TIMEOUT_CLIP     || '1800000', 10),
    upload:   parseInt(process.env.TIMEOUT_UPLOAD   || '600000',  10),
    default:  parseInt(process.env.TIMEOUT_DEFAULT  || '1800000', 10),
  },

  // Video
  video: {
    maxDuration: parseInt(process.env.VIDEO_MAX_DURATION || '55',   10),
    width:       parseInt(process.env.VIDEO_WIDTH        || '1080', 10),
    height:      parseInt(process.env.VIDEO_HEIGHT       || '1920', 10),
    fps:         parseInt(process.env.VIDEO_FPS          || '30',   10),
  },

  // Content
  content: {
    niche:    process.env.CONTENT_NICHE    || 'fakta unik indonesia',
    language: process.env.CONTENT_LANGUAGE || 'id',
    country:  process.env.CONTENT_COUNTRY  || 'ID',
  },

  // Paths
  paths: {
    output: path.resolve(process.env.OUTPUT_DIR || './output'),
    cache:  path.resolve(process.env.CACHE_DIR  || './cache'),
    memory: path.resolve(process.env.MEMORY_DIR || './memory'),
    logs:   path.resolve(process.env.LOG_DIR    || './logs'),
    db:     path.resolve('./data.db'),
    python: path.resolve('./python'),
  },

  // Cache
  cacheTtlHours: parseInt(process.env.CACHE_TTL_HOURS || '6', 10),

  // Cleanup
  rejectedVideoTtlDays: parseInt(process.env.REJECTED_VIDEO_TTL_DAYS || '7', 10),
};

module.exports = config;
