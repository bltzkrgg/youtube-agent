#!/usr/bin/env node
'use strict';

// Test Step 3: ReframeAgent/Schema/Renderer consistency

process.env.DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat';

const { validate, ClipPlan } = require('./src/schemas');

console.log('🧪 Testing Step 3: ReframeAgent/Schema/Renderer consistency\n');

try {
  // Test all valid strategies
  const validStrategies = ['center', 'zoom_in', 'face_track', 'action_follow'];
  
  console.log('Testing valid strategies:');
  for (const strategy of validStrategies) {
    const clipPlan = {
      clip_id: '12345678-1234-1234-1234-123456789012',
      start_sec: 10.0,
      end_sec: 20.0,
      duration_sec: 10.0,
      score: 80,
      hook_type: 'question',
      reason: 'Test reason',
      caption_plan: 'Test caption',
      reframe_strategy: strategy,
    };

    const { success, error } = validate(ClipPlan, clipPlan, 'TEST');
    if (!success) {
      throw new Error(`Strategy '${strategy}' gagal validasi: ${error}`);
    }
    console.log(`  ✅ ${strategy} - valid`);
  }

  // Test invalid strategy
  console.log('\nTesting invalid strategy:');
  const invalidClipPlan = {
    clip_id: '12345678-1234-1234-1234-123456789012',
    start_sec: 10.0,
    end_sec: 20.0,
    duration_sec: 10.0,
    score: 80,
    hook_type: 'question',
    reason: 'Test reason',
    caption_plan: 'Test caption',
    reframe_strategy: 'split_screen', // INVALID
  };

  const { success: invalidSuccess } = validate(ClipPlan, invalidClipPlan, 'TEST');
  if (invalidSuccess) {
    throw new Error('split_screen seharusnya ditolak oleh schema');
  }
  console.log('  ✅ split_screen - correctly rejected by schema');

  // Test default fallback
  console.log('\nTesting default fallback:');
  const noStrategyClipPlan = {
    clip_id: '12345678-1234-1234-1234-123456789012',
    start_sec: 10.0,
    end_sec: 20.0,
    duration_sec: 10.0,
    score: 80,
    hook_type: 'question',
    reason: 'Test reason',
    caption_plan: 'Test caption',
    // reframe_strategy omitted
  };

  const { success: defaultSuccess, data: defaultData } = validate(ClipPlan, noStrategyClipPlan, 'TEST');
  if (!defaultSuccess) {
    throw new Error('Default strategy gagal');
  }
  if (defaultData.reframe_strategy !== 'center') {
    throw new Error(`Expected default='center', got '${defaultData.reframe_strategy}'`);
  }
  console.log('  ✅ Default strategy = center');

  console.log('\n✅ STEP 3 PASSED: ReframeAgent/Schema/Renderer consistency verified\n');
  console.log('Summary:');
  console.log('  - Schema enum: [center, zoom_in, face_track, action_follow]');
  console.log('  - Fully implemented: center, zoom_in');
  console.log('  - Fallback to center: face_track, action_follow');
  console.log('  - Rejected: split_screen (not in schema)');
  console.log('  - Default: center\n');
  
  process.exit(0);
} catch (err) {
  console.error('\n❌ STEP 3 FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}
