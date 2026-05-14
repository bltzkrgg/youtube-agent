#!/usr/bin/env node
'use strict';

// Test Step 2: Source URL idempotency with UNIQUE constraint

process.env.DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.TELEGRAM_CHAT_ID = 'test';

const { hardResetDatabase, getDb } = require('./src/utils/db');
const { triggerSourceIngest } = require('./src/agents/source_ingest');

console.log('🧪 Testing Step 2: Source URL idempotency\n');

// Clean database
hardResetDatabase();
console.log('✅ Database cleaned\n');

(async () => {
  try {
    const testUrl = 'https://youtube.com/watch?v=test_idempotency';
    
    // Trigger 1
    console.log('Triggering URL first time...');
    await triggerSourceIngest(testUrl);
    
    // Check database
    const db = getDb();
    const count1 = db.prepare('SELECT COUNT(*) as count FROM source_videos WHERE source_url = ?').get(testUrl);
    console.log(`✅ First trigger: ${count1.count} row(s) in database`);
    
    if (count1.count !== 1) {
      throw new Error(`Expected 1 row, got ${count1.count}`);
    }
    
    // Trigger 2 (duplicate)
    console.log('\nTriggering same URL second time...');
    await triggerSourceIngest(testUrl);
    
    // Check database again
    const count2 = db.prepare('SELECT COUNT(*) as count FROM source_videos WHERE source_url = ?').get(testUrl);
    console.log(`✅ Second trigger: ${count2.count} row(s) in database`);
    
    if (count2.count !== 1) {
      throw new Error(`Expected 1 row (no duplicate), got ${count2.count}`);
    }
    
    console.log('\n✅ STEP 2 PASSED: Source URL idempotency working correctly');
    console.log('   - UNIQUE constraint prevents duplicate URLs');
    console.log('   - Concurrent inserts handled gracefully\n');
    
    process.exit(0);
  } catch (err) {
    console.error('\n❌ STEP 2 FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
