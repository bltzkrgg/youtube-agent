#!/usr/bin/env node
'use strict';

// Test Step 1: insertSourceVideo dengan semua parameter

process.env.DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat';

const { insertSourceVideo, getSourceVideo } = require('./src/utils/db');
const { v4: uuidv4 } = require('uuid');

console.log('🧪 Testing Step 1: insertSourceVideo dengan permission/risk parameters\n');

try {
  const testId = uuidv4();
  const now = new Date().toISOString();

  // Test insert dengan semua parameter
  insertSourceVideo({
    id: testId,
    correlation_id: uuidv4(),
    source_url: 'https://youtube.com/watch?v=test_step1',
    source_video_path: '/tmp/test.mp4',
    source_duration: 180.5,
    channel_title: 'Test Channel',
    video_title: 'Test Video',
    description: 'Test description',
    permission_status: 'unknown',
    allowed_to_clip: 0,
    risk_level: 'manual_review',
    risk_notes: 'Test risk notes',
    status: 'processing',
    created_at: now,
    updated_at: now,
  });

  console.log('✅ insertSourceVideo berhasil dengan ID:', testId);

  // Verify data
  const retrieved = getSourceVideo(testId);
  if (!retrieved) {
    throw new Error('Data tidak ditemukan setelah insert');
  }

  console.log('✅ Data berhasil di-retrieve');
  console.log('   - permission_status:', retrieved.permission_status);
  console.log('   - allowed_to_clip:', retrieved.allowed_to_clip);
  console.log('   - risk_level:', retrieved.risk_level);
  console.log('   - risk_notes:', retrieved.risk_notes.slice(0, 50) + '...');

  // Verify defaults
  if (retrieved.permission_status !== 'unknown') {
    throw new Error(`Expected permission_status='unknown', got '${retrieved.permission_status}'`);
  }
  if (retrieved.allowed_to_clip !== 0) {
    throw new Error(`Expected allowed_to_clip=0, got ${retrieved.allowed_to_clip}`);
  }

  console.log('\n✅ STEP 1 PASSED: insertSourceVideo menerima dan menyimpan semua parameter dengan benar\n');
  process.exit(0);
} catch (err) {
  console.error('\n❌ STEP 1 FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}
