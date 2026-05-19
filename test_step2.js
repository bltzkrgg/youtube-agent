#!/usr/bin/env node
'use strict';

// Test Step 2: Permission gate enforcement

process.env.DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat';

const { insertSourceVideo, insertClip, getClip, updateSourceVideo, hardResetDatabase } = require('./src/utils/db');
const { v4: uuidv4 } = require('uuid');
const { runClipRenderAgent } = require('./src/agents/clip_render');
const { pushJob } = require('./src/utils/queue');
const { writeVideoJson } = require('./src/utils/storage');

console.log('🧪 Testing Step 2: Permission gate enforcement\n');

// Clean database first
hardResetDatabase();
console.log('✅ Database cleaned\n');

(async () => {
  try {
    const sourceId = uuidv4();
    const clipId = uuidv4();
    const now = new Date().toISOString();

    // Create source video with allowed_to_clip = 0
    insertSourceVideo({
      id: sourceId,
      correlation_id: uuidv4(),
      source_url: 'https://youtube.com/watch?v=test_step2',
      source_video_path: '/tmp/test.mp4',
      source_duration: 180.5,
      channel_title: 'Test Channel',
      video_title: 'Test Video',
      description: 'Test description',
      permission_status: 'unknown',
      allowed_to_clip: 0, // NOT ALLOWED
      risk_level: 'manual_review',
      risk_notes: 'Source permission not verified',
      status: 'processing',
      created_at: now,
      updated_at: now,
    });

    console.log('✅ Created source video with allowed_to_clip=0');

    // Create source_ingest.json
    writeVideoJson(sourceId, 'source_ingest.json', {
      source_video_id: sourceId,
      source_url: 'https://youtube.com/watch?v=test_step2',
      source_video_path: '/tmp/test.mp4',
      source_duration: 180.5,
      channel_title: 'Test Channel',
      video_title: 'Test Video',
      description: 'Test description',
    });

    console.log('✅ Created source_ingest.json');

    // Create clip
    insertClip({
      id: clipId,
      source_video_id: sourceId,
      correlation_id: uuidv4(),
      start_sec: 10.0,
      end_sec: 20.0,
      duration_sec: 10.0,
      score: 0.8,
      hook_type: 'question',
      caption_plan: 'test',
      reframe_strategy: 'center',
      risk_notes: '',
      title: 'Test Clip',
      description: 'Test',
      hashtags: '#test',
      source_url: 'https://youtube.com/watch?v=test_step2',
      source_channel: 'Test Channel',
      attribution: 'Test',
      final_video_path: null,
      thumbnail_path: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    console.log('✅ Created clip with status=pending');

    // Push render job
    pushJob('clip_render', { 
      clip_id: clipId, 
      source_video_id: sourceId,
      correlation_id: uuidv4() 
    }, {
      correlationId: uuidv4(),
      priority: 'normal',
    });

    console.log('✅ Pushed clip_render job');

    // Run ClipRenderAgent (should block)
    await runClipRenderAgent();

    // Check clip status
    const clipAfter = getClip(clipId);
    if (!clipAfter) {
      throw new Error('Clip tidak ditemukan setelah render');
    }

    console.log('   Clip status after render:', clipAfter.status);
    console.log('   Clip risk_notes:', clipAfter.risk_notes);

    if (clipAfter.status !== 'manual_review') {
      throw new Error(`Expected status='manual_review', got '${clipAfter.status}'`);
    }

    if (!clipAfter.risk_notes || !clipAfter.risk_notes.includes('Permission gate')) {
      throw new Error('Expected risk_notes to contain "Permission gate"');
    }

    console.log('\n✅ TEST 1 PASSED: Unknown source blocked correctly\n');

    // TEST 2: Approved source should render
    const sourceId2 = uuidv4();
    const clipId2 = uuidv4();

    insertSourceVideo({
      id: sourceId2,
      correlation_id: uuidv4(),
      source_url: 'https://youtube.com/watch?v=test_step2_approved',
      source_video_path: '/tmp/test2.mp4',
      source_duration: 180.5,
      channel_title: 'Test Channel 2',
      video_title: 'Test Video 2',
      description: 'Test description 2',
      permission_status: 'approved',
      allowed_to_clip: 1, // ALLOWED
      risk_level: 'low',
      risk_notes: 'Manually approved',
      status: 'processing',
      created_at: now,
      updated_at: now,
    });

    console.log('✅ Created source video with allowed_to_clip=1');

    // Create source_ingest.json
    writeVideoJson(sourceId2, 'source_ingest.json', {
      source_video_id: sourceId2,
      source_url: 'https://youtube.com/watch?v=test_step2_approved',
      source_video_path: '/tmp/test2.mp4',
      source_duration: 180.5,
      channel_title: 'Test Channel 2',
      video_title: 'Test Video 2',
      description: 'Test description 2',
    });

    console.log('✅ Created source_ingest.json for approved source');

    insertClip({
      id: clipId2,
      source_video_id: sourceId2,
      correlation_id: uuidv4(),
      start_sec: 10.0,
      end_sec: 20.0,
      duration_sec: 10.0,
      score: 0.8,
      hook_type: 'question',
      caption_plan: 'test',
      reframe_strategy: 'center',
      risk_notes: '',
      title: 'Test Clip 2',
      description: 'Test 2',
      hashtags: '#test',
      source_url: 'https://youtube.com/watch?v=test_step2_approved',
      source_channel: 'Test Channel 2',
      attribution: 'Test 2',
      final_video_path: null,
      thumbnail_path: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    pushJob('clip_render', { 
      clip_id: clipId2, 
      source_video_id: sourceId2,
      correlation_id: uuidv4() 
    }, {
      correlationId: uuidv4(),
      priority: 'normal',
    });

    await runClipRenderAgent();

    const clipAfter2 = getClip(clipId2);
    console.log('   Clip status after render:', clipAfter2.status);

    if (clipAfter2.status !== 'pending_review') {
      throw new Error(`Expected status='pending_review', got '${clipAfter2.status}'`);
    }

    console.log('\n✅ TEST 2 PASSED: Approved source rendered correctly\n');

    console.log('✅ STEP 2 PASSED: Permission gate enforcement working correctly\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ STEP 2 FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
