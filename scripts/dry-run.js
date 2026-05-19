#!/usr/bin/env node
'use strict';

/**
 * Dry-run E2E test untuk AI Clipper
 * Menjalankan full pipeline dengan mock data tanpa download/render berat
 */

process.env.DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test-key-dry-run';
process.env.TELEGRAM_BOT_TOKEN = 'test-token-dry-run';
process.env.TELEGRAM_CHAT_ID = 'test-chat-dry-run';

const { hardResetDatabase, getDb } = require('../src/utils/db');
const { triggerSourceIngest } = require('../src/agents/source_ingest');
const { runTranscriptAgent } = require('../src/agents/transcript');
const { runSceneDetectAgent } = require('../src/agents/scene_detect');
const { runClipPlannerAgent } = require('../src/agents/clip_planner');
const { runClipRenderAgent } = require('../src/agents/clip_render');
const { updateSourceVideo } = require('../src/utils/db');
const { v4: uuidv4 } = require('uuid');

console.log('🧪 DRY-RUN E2E TEST\n');
console.log('Testing full pipeline: SourceIngest → Transcript → SceneDetect → ClipPlanner → ClipRender\n');

// Clean database
hardResetDatabase();
console.log('✅ Database cleaned\n');

(async () => {
  try {
    const testUrl = 'https://youtube.com/watch?v=dry_run_test';
    
    // STEP 1: Source Ingest
    console.log('📥 STEP 1: Source Ingest...');
    await triggerSourceIngest(testUrl);
    
    const db = getDb();
    const sourceVideo = db.prepare('SELECT * FROM source_videos WHERE source_url = ?').get(testUrl);
    if (!sourceVideo) throw new Error('Source video not created');
    console.log(`✅ Source video created: ${sourceVideo.id}`);
    console.log(`   - permission_status: ${sourceVideo.permission_status}`);
    console.log(`   - allowed_to_clip: ${sourceVideo.allowed_to_clip}`);
    console.log(`   - risk_level: ${sourceVideo.risk_level}\n`);
    
    // STEP 2: Transcript
    console.log('📝 STEP 2: Transcript...');
    await runTranscriptAgent();
    console.log('✅ Transcript completed\n');
    
    // STEP 3: Scene Detect
    console.log('🎬 STEP 3: Scene Detect...');
    await runSceneDetectAgent();
    console.log('✅ Scene detect completed\n');
    
    // STEP 4: Clip Planner
    console.log('🎯 STEP 4: Clip Planner...');
    await runClipPlannerAgent();
    
    const clips = db.prepare('SELECT * FROM clips WHERE source_video_id = ?').all(sourceVideo.id);
    console.log(`✅ Clip planner completed: ${clips.length} clip(s) created`);
    for (const clip of clips) {
      console.log(`   - Clip ${clip.id}: ${clip.start_sec}s-${clip.end_sec}s, status=${clip.status}`);
    }
    console.log();
    
    // Ensure source is NOT approved for permission gate test
    if (sourceVideo.allowed_to_clip !== 0) {
      updateSourceVideo(sourceVideo.id, {
        permission_status: 'unknown',
        allowed_to_clip: 0,
        risk_level: 'manual_review',
        risk_notes: 'Source permission not verified',
      });
      console.log('⚠️  Reset source to unapproved for permission gate test\n');
    }
    
    // STEP 5: Clip Render (should be blocked by permission gate)
    console.log('🎨 STEP 5: Clip Render (permission gate test)...');
    
    // Manually push render jobs (ClipPlanner doesn't push in DRY_RUN if no insertedClipIds)
    const { pushJob } = require('../src/utils/queue');
    for (const clip of clips) {
      const renderCorrelationId = uuidv4(); // Unique correlation ID per clip
      pushJob('clip_render', {
        clip_id: clip.id,
        source_video_id: sourceVideo.id,
        correlation_id: renderCorrelationId,
      }, {
        correlationId: renderCorrelationId,
        priority: 'normal',
      });
    }
    
    // Run render (should be blocked)
    for (let i = 0; i < clips.length; i++) {
      await runClipRenderAgent();
    }
    
    const clipsAfterRender = db.prepare('SELECT * FROM clips WHERE source_video_id = ?').all(sourceVideo.id);
    const manualReviewCount = clipsAfterRender.filter(c => c.status === 'manual_review').length;
    console.log(`✅ Clip render completed (blocked by permission gate)`);
    console.log(`   - ${manualReviewCount} clip(s) in manual_review status\n`);
    
    if (manualReviewCount !== clips.length) {
      throw new Error(`Expected all clips to be manual_review, got ${manualReviewCount}/${clips.length}`);
    }
    
    // STEP 6: Approve source and re-render
    console.log('✅ STEP 6: Approve source and re-render...');
    updateSourceVideo(sourceVideo.id, {
      permission_status: 'approved',
      allowed_to_clip: 1,
      risk_level: 'low',
      risk_notes: 'Approved for dry-run test',
    });
    console.log('✅ Source approved\n');
    
    // Re-enqueue clips (simulate /approve_source)
    for (const clip of clipsAfterRender) {
      if (clip.status === 'manual_review') {
        const reRenderCorrelationId = uuidv4(); // Unique correlation ID
        pushJob('clip_render', {
          clip_id: clip.id,
          source_video_id: sourceVideo.id,
          correlation_id: reRenderCorrelationId,
        }, {
          correlationId: reRenderCorrelationId,
          priority: 'normal',
        });
      }
    }
    
    // Run render again
    console.log('🎨 STEP 7: Clip Render (after approval)...');
    for (let i = 0; i < clips.length; i++) {
      await runClipRenderAgent();
    }
    
    const clipsAfterApproval = db.prepare('SELECT * FROM clips WHERE source_video_id = ?').all(sourceVideo.id);
    const pendingReviewCount = clipsAfterApproval.filter(c => c.status === 'pending_review').length;
    console.log(`✅ Clip render completed (after approval)`);
    console.log(`   - ${pendingReviewCount} clip(s) in pending_review status\n`);
    
    if (pendingReviewCount !== clips.length) {
      throw new Error(`Expected all clips to be pending_review, got ${pendingReviewCount}/${clips.length}`);
    }
    
    // STEP 8: Validate data
    console.log('🔍 STEP 8: Validate data...');
    
    // Check source_videos
    const sourceCount = db.prepare('SELECT COUNT(*) as count FROM source_videos').get();
    console.log(`✅ source_videos: ${sourceCount.count} row(s)`);
    
    // Check clips
    const clipCount = db.prepare('SELECT COUNT(*) as count FROM clips').get();
    console.log(`✅ clips: ${clipCount.count} row(s)`);
    
    // Check jobs
    const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get();
    console.log(`✅ jobs: ${jobCount.count} row(s)`);
    
    // Check idempotency
    console.log('\n🔒 STEP 9: Test idempotency...');
    await triggerSourceIngest(testUrl);
    const sourceCount2 = db.prepare('SELECT COUNT(*) as count FROM source_videos WHERE source_url = ?').get(testUrl);
    if (sourceCount2.count !== 1) {
      throw new Error(`Idempotency failed: expected 1 source, got ${sourceCount2.count}`);
    }
    console.log('✅ Source URL idempotency: PASSED');
    
    // Test render idempotency
    await runClipRenderAgent();
    const clipsAfterRetry = db.prepare('SELECT * FROM clips WHERE source_video_id = ?').all(sourceVideo.id);
    const stillPendingReview = clipsAfterRetry.filter(c => c.status === 'pending_review').length;
    if (stillPendingReview !== clips.length) {
      throw new Error(`Render idempotency failed: status changed on retry`);
    }
    console.log('✅ Render idempotency: PASSED');
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ DRY-RUN E2E TEST PASSED');
    console.log('='.repeat(60));
    console.log('\nSummary:');
    console.log(`  - Source videos: ${sourceCount.count}`);
    console.log(`  - Clips created: ${clipCount.count}`);
    console.log(`  - Permission gate: WORKING`);
    console.log(`  - Idempotency: WORKING`);
    console.log(`  - Pipeline flow: COMPLETE\n`);
    
    process.exit(0);
  } catch (err) {
    console.error('\n❌ DRY-RUN E2E TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
