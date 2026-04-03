'use strict';

require('dotenv').config();
const path = require('path');

// Validate required env vars at startup
const REQUIRED = [
  'OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

if (process.env.DRY_RUN !== 'true') {
  REQUIRED.push('PEXELS_API_KEY');
}

for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[CONFIG] Error: env var ${key} wajib diisi`);
    process.exit(1);
  }
}

const config = {
  // Runtime mode
  dryRun: process.env.DRY_RUN === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',

  // AI — OpenRouter (script, metadata, memory)
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3-haiku',
    baseUrl: 'https://openrouter.ai/api/v1',
  },

  // Edge TTS (voiceover)
  tts: {
    voice: process.env.TTS_VOICE || 'id-ID-ArdiNeural',
    rate: process.env.TTS_RATE || '+0%',
  },

  // Pexels (stock footage)
  pexels: {
    apiKey: process.env.PEXELS_API_KEY,
    baseUrl: 'https://api.pexels.com/videos',
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  // Retry
  maxRetry: parseInt(process.env.MAX_RETRY || '3', 10),

  // Timeouts (ms)
  timeouts: {
    research: parseInt(process.env.TIMEOUT_RESEARCH || '300000', 10),
    clip: parseInt(process.env.TIMEOUT_CLIP || '1800000', 10),
    upload: parseInt(process.env.TIMEOUT_UPLOAD || '600000', 10),
    default: parseInt(process.env.TIMEOUT_DEFAULT || '60000', 10),
  },

  // Video
  video: {
    maxDuration: parseInt(process.env.VIDEO_MAX_DURATION || '55', 10),
    width: parseInt(process.env.VIDEO_WIDTH || '1080', 10),
    height: parseInt(process.env.VIDEO_HEIGHT || '1920', 10),
    fps: parseInt(process.env.VIDEO_FPS || '30', 10),
  },

  // Content
  content: {
    niche: process.env.CONTENT_NICHE || 'fakta unik indonesia',
    language: process.env.CONTENT_LANGUAGE || 'id',
    country: process.env.CONTENT_COUNTRY || 'ID',
  },

  // Paths
  paths: {
    output: path.resolve(process.env.OUTPUT_DIR || './output'),
    cache: path.resolve(process.env.CACHE_DIR || './cache'),
    memory: path.resolve(process.env.MEMORY_DIR || './memory'),
    logs: path.resolve(process.env.LOG_DIR || './logs'),
    db: path.resolve('./data.db'),
    python: path.resolve('./python'),
  },

  // Cache
  cacheTtlHours: parseInt(process.env.CACHE_TTL_HOURS || '6', 10),

  // Cleanup
  rejectedVideoTtlDays: parseInt(process.env.REJECTED_VIDEO_TTL_DAYS || '7', 10),
};

module.exports = config;
