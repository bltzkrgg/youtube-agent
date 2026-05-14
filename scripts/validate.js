#!/usr/bin/env node
'use strict';

/**
 * Validation script untuk AI Clipper
 * Validates config, DB schema, queue, dan schemas tanpa heavy processing
 */

require('dotenv').config();

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { getDb } = require('../src/utils/db');
const { validate } = require('../src/schemas');
const { v4: uuidv4 } = require('uuid');

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`❌ ERROR: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`⚠️  WARNING: ${msg}`);
  warnings++;
}

function success(msg) {
  console.log(`✅ ${msg}`);
}

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ─── 1. Validate Config/Env ──────────────────────────────────────────────────

section('1. Config & Environment');

try {
  // In DRY_RUN mode, API keys are optional
  const isDryRun = process.env.DRY_RUN === 'true' || config.dryRun;
  
  if (!config.openrouter.apiKey) {
    if (isDryRun) {
      warn('OPENROUTER_API_KEY tidak diset (OK untuk DRY_RUN)');
    } else {
      error('OPENROUTER_API_KEY tidak diset');
    }
  } else {
    success('OPENROUTER_API_KEY configured');
  }

  if (!config.telegram.botToken) {
    if (isDryRun) {
      warn('TELEGRAM_BOT_TOKEN tidak diset (OK untuk DRY_RUN)');
    } else {
      error('TELEGRAM_BOT_TOKEN tidak diset');
    }
  } else {
    success('TELEGRAM_BOT_TOKEN configured');
  }

  if (!config.telegram.chatId) {
    if (isDryRun) {
      warn('TELEGRAM_CHAT_ID tidak diset (OK untuk DRY_RUN)');
    } else {
      error('TELEGRAM_CHAT_ID tidak diset');
    }
  } else {
    success('TELEGRAM_CHAT_ID configured');
  }

  success(`DRY_RUN mode: ${isDryRun}`);
  success(`Max retry: ${config.maxRetry}`);
  success(`Output dir: ${config.paths.output}`);
  success(`Database: ${config.paths.db}`);
} catch (err) {
  error(`Config validation failed: ${err.message}`);
}

// ─── 2. Validate DB Schema ───────────────────────────────────────────────────

section('2. Database Schema');

try {
  const db = getDb();
  
  // Check tables exist
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
  `).all().map(r => r.name);

  const requiredTables = ['jobs', 'dead_letter', 'source_videos', 'clips', 'analytics', 'memory'];
  for (const table of requiredTables) {
    if (tables.includes(table)) {
      success(`Table '${table}' exists`);
    } else {
      error(`Table '${table}' missing`);
    }
  }

  // Check source_videos columns
  const sourceVideosInfo = db.prepare(`PRAGMA table_info(source_videos)`).all();
  const sourceVideosColumns = sourceVideosInfo.map(c => c.name);
  
  const requiredSourceColumns = ['id', 'source_url', 'permission_status', 'allowed_to_clip', 'risk_level', 'risk_notes'];
  for (const col of requiredSourceColumns) {
    if (sourceVideosColumns.includes(col)) {
      success(`source_videos.${col} exists`);
    } else {
      error(`source_videos.${col} missing`);
    }
  }

  // Check clips columns
  const clipsInfo = db.prepare(`PRAGMA table_info(clips)`).all();
  const clipsColumns = clipsInfo.map(c => c.name);
  
  const requiredClipsColumns = ['id', 'source_video_id', 'start_sec', 'end_sec', 'title', 'description', 'hashtags', 'attribution'];
  for (const col of requiredClipsColumns) {
    if (clipsColumns.includes(col)) {
      success(`clips.${col} exists`);
    } else {
      error(`clips.${col} missing`);
    }
  }

  // Check memory columns
  const memoryInfo = db.prepare(`PRAGMA table_info(memory)`).all();
  const memoryColumns = memoryInfo.map(c => c.name);
  
  const requiredMemoryColumns = ['pattern_type', 'pattern_value', 'weight', 'clip_count'];
  for (const col of requiredMemoryColumns) {
    if (memoryColumns.includes(col)) {
      success(`memory.${col} exists`);
    } else {
      error(`memory.${col} missing`);
    }
  }

  // Check analytics columns
  const analyticsInfo = db.prepare(`PRAGMA table_info(analytics)`).all();
  const analyticsColumns = analyticsInfo.map(c => c.name);
  
  if (analyticsColumns.includes('clip_id')) {
    success('analytics.clip_id exists (correct schema)');
  } else {
    error('analytics.clip_id missing (using legacy schema?)');
  }

} catch (err) {
  error(`Database validation failed: ${err.message}`);
}

// ─── 3. Validate DB Helpers ──────────────────────────────────────────────────

section('3. Database Helpers');

try {
  const db = require('../src/utils/db');
  
  const requiredHelpers = [
    'getSourceVideo',
    'insertSourceVideo',
    'getClip',
    'getClipsBySourceVideo',
    'getExistingClip',
    'insertClip',
    'updateClip',
    'insertAnalytics',
    'getAnalyticsByClip',
    'upsertMemory',
    'getTopPatterns',
    'getAvoidPatterns',
  ];

  for (const helper of requiredHelpers) {
    if (typeof db[helper] === 'function') {
      success(`Helper '${helper}' exists`);
    } else {
      error(`Helper '${helper}' missing`);
    }
  }
} catch (err) {
  error(`Helper validation failed: ${err.message}`);
}

// ─── 4. Validate Queue ────────────────────────────────────────────────────────

section('4. Queue System');

try {
  const { pushJob, popJob } = require('../src/utils/queue');
  
  // Test enqueue
  const testCorrelationId = uuidv4();
  pushJob('test_validation', { test: true, correlation_id: testCorrelationId }, {
    correlationId: testCorrelationId,
    priority: 'low',
  });
  success('pushJob() works');

  // Test dequeue
  const job = popJob('test_validation');
  if (job && job.payload.test === true) {
    success('popJob() works');
  } else {
    error('popJob() failed to retrieve job');
  }

  // Cleanup
  const { deleteJob } = require('../src/utils/db');
  if (job) deleteJob(job.id);

} catch (err) {
  error(`Queue validation failed: ${err.message}`);
}

// ─── 5. Validate Schemas ──────────────────────────────────────────────────────

section('5. Schema Validation');

try {
  const schemas = require('../src/schemas');
  
  // Test SourceIngestOutput
  const sourceIngestSample = {
    source_video_id: uuidv4(),
    correlation_id: uuidv4(),
    source_url: 'https://youtube.com/watch?v=test',
    source_video_path: '/path/to/video.mp4',
    source_duration: 180.5,
    video_title: 'Test Video',
    version: '1.0',
    created_at: new Date().toISOString(),
  };
  
  const { success: s1, error: e1 } = validate(schemas.SourceIngestOutput, sourceIngestSample);
  if (s1) {
    success('SourceIngestOutput schema valid');
  } else {
    error(`SourceIngestOutput schema invalid: ${e1}`);
  }

  // Test ClipPlan
  const clipPlanSample = {
    clip_id: uuidv4(),
    start_sec: 10.0,
    end_sec: 40.0,
    duration_sec: 30.0,
    score: 85,
    hook_type: 'curiosity_gap',
    reason: 'Test reason',
    caption_plan: 'Test caption',
    reframe_strategy: 'center',
  };
  
  const { success: s2, error: e2 } = validate(schemas.ClipPlan, clipPlanSample);
  if (s2) {
    success('ClipPlan schema valid');
  } else {
    error(`ClipPlan schema invalid: ${e2}`);
  }

  // Test reframe_strategy enum
  const reframeStrategies = ['center', 'zoom_in', 'face_track', 'action_follow'];
  for (const strategy of reframeStrategies) {
    const sample = { ...clipPlanSample, reframe_strategy: strategy };
    const { success: s } = validate(schemas.ClipPlan, sample);
    if (s) {
      success(`reframe_strategy '${strategy}' valid`);
    } else {
      error(`reframe_strategy '${strategy}' invalid`);
    }
  }

} catch (err) {
  error(`Schema validation failed: ${err.message}`);
}

// ─── 6. Validate Python Scripts ──────────────────────────────────────────────

section('6. Python Scripts');

try {
  const fs = require('fs');
  const path = require('path');
  
  const pythonScripts = [
    'whisper_transcribe.py',
    'scene_detect.py',
    'clip_render.py',
  ];

  for (const script of pythonScripts) {
    const scriptPath = path.join(config.paths.python, script);
    if (fs.existsSync(scriptPath)) {
      success(`Python script '${script}' exists`);
    } else {
      error(`Python script '${script}' missing`);
    }
  }
} catch (err) {
  error(`Python script validation failed: ${err.message}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

section('Validation Summary');

console.log(`Total checks: ${errors + warnings + (errors === 0 && warnings === 0 ? 1 : 0)}`);
console.log(`✅ Passed: ${errors === 0 && warnings === 0 ? 'All' : 'Some'}`);
console.log(`❌ Errors: ${errors}`);
console.log(`⚠️  Warnings: ${warnings}\n`);

if (errors > 0) {
  console.error('❌ Validation FAILED. Fix errors before running pipeline.');
  process.exit(1);
} else if (warnings > 0) {
  console.warn('⚠️  Validation passed with warnings. Review warnings before production.');
  process.exit(0);
} else {
  console.log('✅ Validation PASSED. System ready for testing.');
  process.exit(0);
}
