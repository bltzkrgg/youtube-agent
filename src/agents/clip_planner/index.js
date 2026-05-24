'use strict';

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { insertClip } = require('../../utils/db');
const { validate, ClipPlannerOutput, OpenRouterClipPlansResponse } = require('../../schemas');
const { scoreClipMoment } = require('../moment_scoring');
const { criticizeClipMoment } = require('../critic');
const { generateCaptions } = require('../caption');
const { determineReframeStrategy } = require('../reframe');

const AGENT = 'ClipPlannerAgent';

// Enable/disable advanced agents via env
const ENABLE_MOMENT_SCORING = process.env.ENABLE_MOMENT_SCORING !== 'false';
const ENABLE_CRITIC = process.env.ENABLE_CRITIC !== 'false';
const ENABLE_CAPTION_AGENT = process.env.ENABLE_CAPTION_AGENT !== 'false';
const ENABLE_REFRAME_AGENT = process.env.ENABLE_REFRAME_AGENT !== 'false';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runClipPlannerAgent() {
  const job = popJob('clip_planner');
  if (!job) {
    logger.info('Tidak ada job clip_planner di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Clip Planner Agent', { agent: AGENT, jobId: job.id });

  try {
    const { source_video_id, correlation_id } = job.payload;
    if (!source_video_id) throw new Error('source_video_id tidak ada di payload');

    const result = await _processClipPlanner(source_video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Clip Planner Agent selesai', { agent: AGENT, sourceVideoId: source_video_id, clipCount: result.clips.length });

    // Spawn clip render jobs ONLY for newly inserted clips
    // result.insertedClipIds contains only clips that were actually inserted
    if (result.insertedClipIds && result.insertedClipIds.length > 0) {
      for (const clipId of result.insertedClipIds) {
        pushJob('clip_render', { 
          clip_id: clipId,
          source_video_id, 
          correlation_id: result.correlation_id 
        }, {
          correlationId: result.correlation_id,
          priority: 'normal',
        });
      }
      logger.info(`Pushed ${result.insertedClipIds.length} clip_render jobs`, { agent: AGENT });
    } else {
      logger.info('No new clips to render (all duplicates)', { agent: AGENT });
    }
  } catch (err) {
    logger.error('Clip Planner Agent gagal', {
      agent: AGENT, step: 'runClipPlannerAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processClipPlanner(sourceVideoId, correlationId) {
  const sourceIngest = readVideoJson(sourceVideoId, 'source_ingest.json');
  const transcript = readVideoJson(sourceVideoId, 'transcript.json');
  const sceneDetect = readVideoJson(sourceVideoId, 'scene_detect.json');

  if (!sourceIngest) throw new Error(`source_ingest.json tidak ditemukan untuk ${sourceVideoId}`);
  if (!transcript) throw new Error(`transcript.json tidak ditemukan untuk ${sourceVideoId}`);
  if (!sceneDetect) throw new Error(`scene_detect.json tidak ditemukan untuk ${sourceVideoId}`);

  // Check permission gate
  const { getSourceVideo } = require('../../utils/db');
  const sourceVideo = getSourceVideo(sourceVideoId);
  
  if (!sourceVideo) {
    throw new Error(`Source video ${sourceVideoId} tidak ditemukan di database`);
  }

  // Log permission status (don't block, just warn)
  if (sourceVideo.permission_status === 'unknown' || sourceVideo.allowed_to_clip === 0) {
    logger.warn('Source video belum diverifikasi permission-nya', {
      agent: AGENT,
      sourceVideoId,
      permissionStatus: sourceVideo.permission_status,
      riskLevel: sourceVideo.risk_level,
      riskNotes: sourceVideo.risk_notes,
    });
  }

  if (config.dryRun) return _mockClipPlanner(sourceVideoId, correlationId);

  logger.info('Menganalisis transcript dan scene untuk menemukan viral moments', { agent: AGENT });

  let clipPlans;
  try {
    clipPlans = await withRetry(
      () => rateLimited('openrouter', () => _analyzeWithLLM(sourceIngest, transcript, sceneDetect), 2000),
      { maxRetry: config.maxRetry, agent: AGENT, step: 'llmAnalysis' }
    );
  } catch (llmErr) {
    logger.warn('LLM ClipPlanner gagal, mencoba heuristik fallback', {
      agent: AGENT, error_message: llmErr.message,
    });
    if (config.clipPlannerRequireLlm) {
      throw llmErr;
    }
    clipPlans = _heuristicClipPlans(transcript, sceneDetect, sourceIngest);
    logger.info(`Heuristic fallback: ${clipPlans.length} clip plan(s) generated`, { agent: AGENT });
  }

  if (!clipPlans || clipPlans.length === 0) {
    if (config.clipPlannerRequireLlm) {
      throw new Error('LLM tidak menghasilkan clip plan valid');
    }
    logger.warn('LLM returned empty plans, using heuristic fallback', { agent: AGENT });
    clipPlans = _heuristicClipPlans(transcript, sceneDetect, sourceIngest);
  }

  // Validate, repair, and sanitize clip plans
  const sourceDuration = sourceIngest.source_duration || Infinity;
  const transcriptSegments = transcript?.segments || [];

  const validatedPlans = clipPlans.map(plan => {
    // Must have numeric timestamps
    if (typeof plan.start_sec !== 'number' || typeof plan.end_sec !== 'number') {
      logger.warn('Clip plan missing start_sec/end_sec, skipped', { agent: AGENT, plan });
      return null;
    }

    // Normalize required string fields before repair
    plan.hook_type        = plan.hook_type || 'unknown';
    plan.caption_plan     = plan.caption_plan || 'Default caption';
    plan.reframe_strategy = plan.reframe_strategy || 'center';
    plan.risk_notes       = typeof plan.risk_notes === 'string' ? plan.risk_notes : '';

    // Normalize score
    if (typeof plan.score !== 'number' || plan.score < 0 || plan.score > 100) {
      plan.score = 50;
    }

    // Repair duration before validation
    plan = _repairClipDuration(plan, sourceDuration, transcriptSegments);

    // Validate duration after repair
    const duration = plan.end_sec - plan.start_sec;
    if (duration < config.clip.minDuration || duration > config.clip.maxDuration) {
      logger.warn(`Clip duration ${duration.toFixed(1)}s still out of range after repair, skipped`, { agent: AGENT, plan });
      return null;
    }

    return plan;
  }).filter(Boolean);

  if (validatedPlans.length === 0) {
    if (!config.clipPlannerRequireLlm) {
      logger.warn('Semua LLM clip plans tidak valid setelah repair, mencoba heuristik fallback', { agent: AGENT });
      const fallbackPlans = _heuristicClipPlans(transcript, sceneDetect, sourceIngest);
      const validFallback = fallbackPlans.filter(p =>
        typeof p.start_sec === 'number' && typeof p.end_sec === 'number' &&
        (p.end_sec - p.start_sec) >= config.clip.minDuration &&
        (p.end_sec - p.start_sec) <= config.clip.maxDuration
      );
      if (validFallback.length > 0) {
        logger.info(`Heuristic fallback: ${validFallback.length} valid clip(s)`, { agent: AGENT });
        validatedPlans.push(...validFallback);
      }
    }
    if (validatedPlans.length === 0) {
      throw new Error('Semua clip plans tidak valid setelah validasi dan repair');
    }
  }

  logger.info(`${validatedPlans.length} valid clips dari ${clipPlans.length} plans`, { agent: AGENT });

  // Assign clip_id to each plan
  const clipsWithId = validatedPlans.map((plan) => ({
    clip_id: uuidv4(),
    ...plan,
    duration_sec: plan.end_sec - plan.start_sec,
  }));

  // PHASE 2: Advanced processing per clip (SEQUENTIAL to avoid rate limits)
  const enrichedClips = [];
  
  for (const clip of clipsWithId) {
    logger.info(`Processing clip ${clip.clip_id}`, { agent: AGENT });

    let enrichedClip = { ...clip };

    // 1. Multi-perspective scoring (if enabled)
    if (ENABLE_MOMENT_SCORING) {
      try {
        const scoringResult = await scoreClipMoment(clip, transcript, sceneDetect, sourceIngest);
        enrichedClip.moment_scoring = scoringResult;
        // Update score dengan weighted average
        enrichedClip.score = Math.round(
          (clip.score * 0.4) + (scoringResult.final_score * 0.6)
        );
        logger.info(`Moment scoring complete`, { 
          agent: AGENT, 
          clipId: clip.clip_id, 
          originalScore: clip.score,
          newScore: enrichedClip.score 
        });
      } catch (err) {
        logger.warn(`Moment scoring failed for clip ${clip.clip_id}`, { 
          agent: AGENT, 
          error_message: err.message 
        });
        // Use fallback - keep original score
        enrichedClip.moment_scoring = {
          final_score: clip.score,
          confidence: 0,
          persona_scores: [],
          strengths: [],
          weaknesses: ['Scoring unavailable'],
          reasoning: 'Scoring service unavailable',
        };
      }
    }

    // 2. Risk assessment (if enabled)
    if (ENABLE_CRITIC) {
      try {
        const criticResult = await criticizeClipMoment(clip, transcript, sourceIngest);
        enrichedClip.risk_assessment = criticResult;
        
        // Update risk_notes - ensure it's a string, not null
        if (criticResult.concerns && criticResult.concerns.length > 0) {
          const riskParts = [
            enrichedClip.risk_notes || '',
            `Risk: ${criticResult.risk_level}`,
            ...criticResult.concerns
          ].filter(Boolean);
          enrichedClip.risk_notes = riskParts.join('; ');
        } else if (!enrichedClip.risk_notes) {
          // Ensure risk_notes is never null
          enrichedClip.risk_notes = '';
        }

        // Penalize score jika high risk
        if (criticResult.risk_level === 'high' || criticResult.risk_level === 'critical') {
          enrichedClip.score = Math.round(enrichedClip.score * 0.5);
        } else if (criticResult.risk_level === 'medium') {
          enrichedClip.score = Math.round(enrichedClip.score * 0.8);
        }

        logger.info(`Risk assessment complete`, { 
          agent: AGENT, 
          clipId: clip.clip_id, 
          riskLevel: criticResult.risk_level 
        });
      } catch (err) {
        logger.warn(`Risk assessment failed for clip ${clip.clip_id}`, { 
          agent: AGENT, 
          error_message: err.message 
        });
        // Ensure risk_notes is set
        if (!enrichedClip.risk_notes) {
          enrichedClip.risk_notes = '';
        }
      }
    } else {
      // If critic disabled, ensure risk_notes is set
      if (!enrichedClip.risk_notes) {
        enrichedClip.risk_notes = '';
      }
    }

    // 3. Advanced caption generation (if enabled)
    if (ENABLE_CAPTION_AGENT) {
      try {
        const captionResult = await generateCaptions(clip, transcript);
        enrichedClip.captions = captionResult;
        logger.info(`Caption generation complete`, { 
          agent: AGENT, 
          clipId: clip.clip_id,
          wordCount: captionResult.word_captions?.length || 0 
        });
      } catch (err) {
        logger.warn(`Caption generation failed for clip ${clip.clip_id}`, { 
          agent: AGENT, 
          error_message: err.message 
        });
        // Use fallback
        enrichedClip.captions = {
          caption_style: { font_size: 'medium', color: 'white', animation: 'none', position: 'bottom' },
          emphasis_words: [],
          word_captions: [],
          srt_format: '',
        };
      }
    }

    // 4. Smart reframe strategy (if enabled)
    if (ENABLE_REFRAME_AGENT) {
      try {
        const reframeResult = await determineReframeStrategy(clip, transcript, sourceIngest);
        enrichedClip.reframe_strategy = reframeResult.strategy;
        enrichedClip.reframe_details = reframeResult;
        logger.info(`Reframe strategy determined`, { 
          agent: AGENT, 
          clipId: clip.clip_id,
          strategy: reframeResult.strategy 
        });
      } catch (err) {
        logger.warn(`Reframe analysis failed for clip ${clip.clip_id}`, { 
          agent: AGENT, 
          error_message: err.message 
        });
        // Keep default reframe_strategy from clip
      }
    }

    // NORMALIZE CLIP BEFORE ADDING TO OUTPUT
    // Ensure all required fields have valid values (never null for strings)
    enrichedClip = _normalizeClip(enrichedClip);

    // Adjust clip end boundary to avoid mid-sentence cuts
    enrichedClip = _adjustClipBoundary(enrichedClip, transcript, sourceIngest);

    enrichedClips.push(enrichedClip);
  }

  // Sort by final score
  enrichedClips.sort((a, b) => b.score - a.score);

  // Apply hard cap on clips per source
  const originalCount = enrichedClips.length;
  const cappedClips = enrichedClips.slice(0, config.maxClipsPerSource);
  if (cappedClips.length < originalCount) {
    logger.info('Clip count limited by MAX_CLIPS_PER_SOURCE', {
      agent: AGENT, originalCount, limitedCount: cappedClips.length, maxClipsPerSource: config.maxClipsPerSource,
    });
  }

  // Final normalization before validation
  const normalizedClips = cappedClips.map(_normalizeClipForOutput);

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    clips: normalizedClips,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ClipPlannerOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ClipPlannerOutput gagal: ${error}`);

  writeVideoJson(sourceVideoId, 'clip_planner.json', data);

  // Insert clips into database (with duplicate check)
  const { getExistingClip } = require('../../utils/db');
  let insertedCount = 0;
  let skippedCount = 0;
  const insertedClipIds = []; // Track inserted clip IDs

  for (const clip of data.clips) {
    // IDEMPOTENCY: Check if clip already exists
    const existing = getExistingClip(sourceVideoId, clip.start_sec, clip.end_sec);
    if (existing) {
      logger.info('Clip sudah ada, skip insert', {
        agent: AGENT,
        existingClipId: existing.id,
        startSec: clip.start_sec,
        endSec: clip.end_sec,
      });
      skippedCount++;
      continue;
    }

    // Generate metadata for clip
    const clipTitle = `${sourceIngest.video_title} - ${clip.hook_type} clip`;
    const clipDescription = `Clip dari: ${sourceIngest.video_title}\nChannel: ${sourceIngest.channel_title}\nDuration: ${clip.duration_sec.toFixed(1)}s\n\n${clip.reason}`;
    const clipHashtags = `#Shorts #${clip.hook_type.replace('_', '')} #viral`;
    
    insertClip({
      id: clip.clip_id,
      source_video_id: sourceVideoId,
      correlation_id: correlationId,
      start_sec: clip.start_sec,
      end_sec: clip.end_sec,
      duration_sec: clip.duration_sec,
      score: clip.score,
      hook_type: clip.hook_type,
      caption_plan: clip.caption_plan,
      reframe_strategy: clip.reframe_strategy,
      risk_notes: clip.risk_notes || '',
      title: clipTitle,
      description: clipDescription,
      hashtags: clipHashtags,
      source_url: sourceIngest.source_url,
      source_channel: sourceIngest.channel_title,
      attribution: `Source: ${sourceIngest.channel_title} - ${sourceIngest.source_url}`,
      final_video_path: null,
      thumbnail_path: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    insertedCount++;
    insertedClipIds.push(clip.clip_id); // Track inserted clip ID
  }

  logger.info(`Clips inserted: ${insertedCount}, skipped (duplicate): ${skippedCount}`, { agent: AGENT });

  // Return data with insertedClipIds
  return {
    ...data,
    insertedClipIds, // Add list of inserted clip IDs
  };
}

// ─── LLM Analysis ────────────────────────────────────────────────────────────

async function _analyzeWithLLM(sourceIngest, transcript, sceneDetect) {
  const model = config.openrouter.models.clipPlanner; // Use clipPlanner model

  // Get memory recommendations (if available)
  const { getTopPatterns, getAvoidPatterns } = require('../memory');
  let memoryContext = '';
  
  try {
    const topHooks = getTopPatterns('hook_type', 3);
    const topDurations = getTopPatterns('duration_range', 2);
    const avoidHooks = getAvoidPatterns('hook_type', 3);
    
    if (topHooks.length > 0 || avoidHooks.length > 0) {
      memoryContext = `\n\nMEMORY RECOMMENDATIONS (dari performa clips sebelumnya):
${topHooks.length > 0 ? `✅ Hook types yang perform bagus: ${topHooks.map(p => `${p.value} (weight: ${p.weight.toFixed(2)})`).join(', ')}` : ''}
${topDurations.length > 0 ? `✅ Duration ranges yang perform bagus: ${topDurations.map(p => `${p.value} (weight: ${p.weight.toFixed(2)})`).join(', ')}` : ''}
${avoidHooks.length > 0 ? `⚠️ Hook types yang kurang perform: ${avoidHooks.map(p => p.value).join(', ')}` : ''}

Prioritaskan patterns yang perform bagus, hindari yang kurang perform.`;
    }
  } catch (err) {
    logger.warn('Gagal load memory recommendations (non-fatal)', { agent: AGENT, error_message: err.message });
  }

  // Build context for LLM
  const transcriptText = transcript.text.slice(0, 3000); // Limit to 3000 chars
  const transcriptSegments = transcript.segments.slice(0, 30).map((seg) => 
    `[${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s] ${seg.text}`
  ).join('\n');

  const sceneList = sceneDetect.scenes.slice(0, 20).map((scene) =>
    `Scene ${scene.index}: ${scene.start_sec.toFixed(1)}s - ${scene.end_sec.toFixed(1)}s (${scene.duration_sec.toFixed(1)}s)`
  ).join('\n');

  const prompt = `Kamu adalah AI Clipper Expert yang menganalisis video YouTube untuk menemukan momen terbaik untuk dijadikan Shorts viral.

SOURCE VIDEO:
Title: ${sourceIngest.video_title}
Channel: ${sourceIngest.channel_title}
Duration: ${sourceIngest.source_duration.toFixed(1)}s

TRANSCRIPT (first 3000 chars):
${transcriptText}

TRANSCRIPT SEGMENTS (with timestamps):
${transcriptSegments}

SCENE BOUNDARIES:
${sceneList}
${memoryContext}

TUGAS:
Identifikasi hingga ${config.maxClipsPerSource} momen terbaik dari video ini yang bisa dijadikan clip Shorts (max 60 detik per clip).

KRITERIA VIRAL MOMENT:
1. **Hook kuat** - Momen yang langsung menarik perhatian dalam 3 detik pertama
2. **Self-contained** - Clip bisa dipahami tanpa konteks video penuh
3. **Emotional peak** - Momen lucu, mengejutkan, kontroversial, atau inspiratif
4. **Clear message** - Ada takeaway atau punchline yang jelas
5. **Visual interest** - Bukan hanya talking head statis

HOOK TYPES:
- curiosity_gap: "Tunggu sampai kamu lihat ini..."
- shocking_fact: Fakta mengejutkan di awal
- controversy: Statement kontroversial
- humor: Momen lucu
- tutorial_hook: "Cara mudah untuk..."
- story_peak: Klimaks cerita

REFRAME STRATEGY:
- center: Crop center (default untuk talking head)
- face_track: Track wajah speaker (untuk close-up)
- action_follow: Follow aksi/objek utama

RISK NOTES:
Tandai jika clip mengandung:
- Konten sensitif (politik, agama, SARA)
- Klaim yang perlu fact-check
- Potensi copyright issue (musik, footage pihak ketiga)
- Misleading context jika diambil dari video penuh

FORMAT JSON (hanya JSON, tanpa teks lain):
{
  "clips": [
    {
      "start_sec": 12.5,
      "end_sec": 45.8,
      "score": 85,
      "hook_type": "curiosity_gap",
      "reason": "Kenapa momen ini viral (1-2 kalimat)",
      "caption_plan": "Caption/subtitle strategy untuk clip ini",
      "reframe_strategy": "center",
      "risk_notes": "Catatan risiko jika ada, atau kosongkan"
    }
  ]
}

PENTING:
- Clip harus align dengan scene boundaries (jangan potong di tengah scene)
- Duration 15-60 detik (ideal 30-45 detik)
- Score 0-100 berdasarkan potensi viral
- Urutkan dari score tertinggi
- Max ${config.maxClipsPerSource} clips, fokus pada yang terbaik`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.75,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://youtube-agent.local',
        'X-Title': 'YouTube Clipper Agent',
      },
      timeout: config.llmTimeouts.clipPlanner,
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, `${AGENT}:analyzeWithLLM`);
  if (!parsed) throw new Error('Gagal parse respons LLM untuk clip plans');

  const { success, data, error } = validate(OpenRouterClipPlansResponse, parsed, AGENT);
  if (!success) throw new Error(`Validasi clip plans dari LLM gagal: ${error}`);

  return data.clips;
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockClipPlanner(sourceVideoId, correlationId) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Clip Planner', { agent: AGENT });

  const clips = [
    {
      clip_id: uuidv4(),
      start_sec: 8.5,
      end_sec: 38.2,
      duration_sec: 29.7,
      score: 92,
      hook_type: 'shocking_fact',
      reason: 'Fakta mengejutkan tentang Indonesia yang langsung menarik perhatian di 3 detik pertama',
      caption_plan: 'Burn subtitle dengan emphasis pada angka dan fakta kunci',
      reframe_strategy: 'center',
      risk_notes: '',
    },
    {
      clip_id: uuidv4(),
      start_sec: 45.0,
      end_sec: 75.0,
      duration_sec: 30.0,
      score: 85,
      hook_type: 'curiosity_gap',
      reason: 'Build-up dramatis dengan reveal mengejutkan di akhir',
      caption_plan: 'Subtitle dengan pause dramatis sebelum reveal',
      reframe_strategy: 'center',
      risk_notes: 'Perlu fact-check klaim statistik',
    },
    {
      clip_id: uuidv4(),
      start_sec: 120.0,
      end_sec: 155.5,
      duration_sec: 35.5,
      score: 78,
      hook_type: 'humor',
      reason: 'Momen lucu dengan punchline kuat',
      caption_plan: 'Highlight punchline dengan font besar',
      reframe_strategy: 'face_track',
      risk_notes: '',
    },
  ];

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    clips,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(sourceVideoId, 'clip_planner.json', output);

  // Get source video for metadata
  const { getSourceVideo } = require('../../utils/db');
  const sourceVideo = getSourceVideo(sourceVideoId);

  // Insert mock clips into database with metadata
  for (const clip of clips) {
    const clipTitle = `${sourceVideo?.video_title || 'Mock Video'} - ${clip.hook_type} clip`;
    const clipDescription = `Clip dari: ${sourceVideo?.video_title || 'Mock Video'}\nChannel: ${sourceVideo?.channel_title || 'Mock Channel'}\nDuration: ${clip.duration_sec.toFixed(1)}s\n\n${clip.reason}`;
    const clipHashtags = `#Shorts #${clip.hook_type.replace('_', '')} #viral`;
    
    insertClip({
      id: clip.clip_id,
      source_video_id: sourceVideoId,
      correlation_id: correlationId,
      start_sec: clip.start_sec,
      end_sec: clip.end_sec,
      duration_sec: clip.duration_sec,
      score: clip.score,
      hook_type: clip.hook_type,
      caption_plan: clip.caption_plan,
      reframe_strategy: clip.reframe_strategy,
      risk_notes: clip.risk_notes,
      title: clipTitle,
      description: clipDescription,
      hashtags: clipHashtags,
      source_url: sourceVideo?.source_url || 'https://youtube.com/watch?v=mock',
      source_channel: sourceVideo?.channel_title || 'Mock Channel',
      attribution: `Source: ${sourceVideo?.channel_title || 'Mock Channel'} - ${sourceVideo?.source_url || 'mock'}`,
      final_video_path: null,
      thumbnail_path: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return output;
}

// ─── Clip duration repair ────────────────────────────────────────────────────

/**
 * Repair a clip that is too short or too long.
 *
 * Short clips: expand around the original midpoint to reach
 *   max(config.clip.minDuration, config.clip.targetShortRepairSeconds).
 *   Tries to align to nearby transcript segment boundaries.
 *
 * Long clips: trim end toward midpoint to reach config.clip.maxDuration.
 *
 * Always clamps 0 <= start_sec < end_sec <= sourceDuration.
 * Returns the (possibly modified) plan. Never throws.
 */
function _repairClipDuration(plan, sourceDuration, transcriptSegments) {
  const minDur    = config.clip.minDuration;
  const maxDur    = config.clip.maxDuration;
  const targetDur = Math.max(minDur, config.clip.targetShortRepairSeconds);
  const safeSrcDur = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : 3600;

  const originalStart = plan.start_sec;
  const originalEnd   = plan.end_sec;
  const duration      = originalEnd - originalStart;

  if (duration >= minDur && duration <= maxDur) return plan; // nothing to do

  const mid = (originalStart + originalEnd) / 2;

  let newStart = plan.start_sec;
  let newEnd   = plan.end_sec;

  // ── Too short ──────────────────────────────────────────────────────────────
  if (duration < minDur) {
    const half = targetDur / 2;
    newStart = Math.max(0, mid - half);
    newEnd   = Math.min(safeSrcDur, mid + half);

    // If clamping shortened us again, expand the other side
    const got = newEnd - newStart;
    if (got < minDur) {
      if (newStart === 0) {
        newEnd = Math.min(safeSrcDur, minDur);
      } else {
        newStart = Math.max(0, newEnd - minDur);
      }
    }

    // Snap to nearby transcript segment boundaries (within ±3s of our new edges)
    if (Array.isArray(transcriptSegments) && transcriptSegments.length > 0) {
      const SNAP_RADIUS = 3.0;

      // Try to extend start backward to a segment boundary
      const snapStart = transcriptSegments
        .filter(s => typeof s.start === 'number' && s.start >= (newStart - SNAP_RADIUS) && s.start <= newStart)
        .sort((a, b) => a.start - b.start)[0];
      if (snapStart) newStart = Math.max(0, snapStart.start);

      // Try to extend end forward to a segment boundary
      const snapEnd = transcriptSegments
        .filter(s => typeof s.end === 'number' && s.end >= newEnd && s.end <= (newEnd + SNAP_RADIUS))
        .sort((a, b) => a.end - b.end)[0];
      if (snapEnd) newEnd = Math.min(safeSrcDur, snapEnd.end);
    }
  }

  // ── Too long ───────────────────────────────────────────────────────────────
  if (duration > maxDur) {
    const half = maxDur / 2;
    newStart = Math.max(0, mid - half);
    newEnd   = Math.min(safeSrcDur, mid + half);
  }

  // Final clamp + sanity
  newStart = parseFloat(Math.max(0, newStart).toFixed(3));
  newEnd   = parseFloat(Math.min(safeSrcDur, newEnd).toFixed(3));
  if (newEnd <= newStart) newEnd = parseFloat(Math.min(safeSrcDur, newStart + minDur).toFixed(3));

  const repairedDuration = parseFloat((newEnd - newStart).toFixed(3));

  logger.info('Clip duration repaired', {
    agent: AGENT,
    clipHook: plan.hook_type,
    originalStart, originalEnd,
    originalDuration: parseFloat(duration.toFixed(3)),
    repairedStart: newStart, repairedEnd: newEnd,
    repairedDuration,
    reason: duration < minDur ? 'short_duration_repair' : 'long_duration_trim',
  });

  return {
    ...plan,
    start_sec:   newStart,
    end_sec:     newEnd,
    duration_sec: repairedDuration,
    repaired_short_duration: duration < minDur,
  };
}

// ─── Clip boundary extension (sentence-aware) ────────────────────────────────

const SENTENCE_END_RE = /[.!?…。！？]$/;

/**
 * Extend clip end_sec to avoid mid-sentence cuts.
 *  1. Look for transcript segments that end after clip.end_sec but start before
 *     clip.end_sec + CLIP_END_SENTENCE_EXTENSION_SECONDS.
 *  2. If the segment whose end is just inside or near clip.end_sec doesn't end
 *     with sentence-ending punctuation, extend to the next segment that does.
 *  3. Always add CLIP_END_PADDING_SECONDS after the final position.
 *  4. Cap at source duration and max clip duration (60s).
 *  5. Never moves start_sec; never produces negative/zero duration.
 *
 * Falls back gracefully if transcript is unavailable.
 */
function _adjustClipBoundary(clip, transcript, sourceIngest) {
  const padding  = config.clipEndPaddingSeconds;
  const maxExt   = config.clipEndSentenceExtensionSeconds;
  const sourceDur = sourceIngest?.source_duration || Infinity;
  const maxDur   = 60; // hard cap matches schema
  const maxEnd   = Math.min(sourceDur, clip.start_sec + maxDur);

  const originalEndSec = clip.end_sec;

  // Helper — clamp and rebuild clip
  const finalize = (newEnd, reason) => {
    const clamped = Math.min(newEnd, maxEnd);
    if (clamped <= clip.start_sec) {
      // Guard: never shrink to zero or negative
      return clip;
    }
    if (Math.abs(clamped - originalEndSec) > 0.01) {
      logger.info('Clip boundary adjusted', {
        agent: AGENT,
        clipId: clip.clip_id,
        originalEndSec,
        adjustedEndSec: parseFloat(clamped.toFixed(3)),
        reason,
      });
    }
    return {
      ...clip,
      end_sec: parseFloat(clamped.toFixed(3)),
      duration_sec: parseFloat((clamped - clip.start_sec).toFixed(3)),
    };
  };

  // No transcript — apply padding only
  const segments = transcript?.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return finalize(originalEndSec + padding, 'padding_only');
  }

  // Find the last segment that starts before or at end_sec (the "active" segment)
  const active = [...segments]
    .filter(s => typeof s.start === 'number' && typeof s.end === 'number')
    .reverse()
    .find(s => s.start <= originalEndSec);

  if (!active) {
    return finalize(originalEndSec + padding, 'padding_only');
  }

  // If the active segment already ends with sentence punctuation and its end is
  // within the extension window, snap to its end + padding
  const activeText = (active.text || '').trim();
  if (SENTENCE_END_RE.test(activeText)) {
    // Snap to the segment's natural end if it's close to our clip end
    const snapTarget = active.end + padding;
    if (snapTarget <= maxEnd && active.end >= originalEndSec - 0.5) {
      return finalize(snapTarget, 'sentence_end_snap');
    }
    // Otherwise just pad
    return finalize(originalEndSec + padding, 'padding');
  }

  // Active segment didn't end with punctuation — look ahead for sentence boundary
  const extensionWindow = originalEndSec + maxExt;
  const lookahead = segments.filter(
    s => typeof s.start === 'number' && typeof s.end === 'number'
      && s.start > originalEndSec
      && s.start <= extensionWindow
  );

  for (const seg of lookahead) {
    const segText = (seg.text || '').trim();
    if (SENTENCE_END_RE.test(segText)) {
      return finalize(seg.end + padding, 'sentence_extension');
    }
  }

  // No sentence boundary found in window — just add padding
  return finalize(originalEndSec + padding, 'padding');
}

// ─── Heuristic fallback clip plans (no LLM required) ─────────────────────────

function _heuristicClipPlans(transcript, sceneDetect, sourceIngest) {
  const TARGET_MIN = 30; // seconds
  const TARGET_MAX = 55;
  const MAX_CLIPS   = 3;

  const totalDuration = sourceIngest.source_duration || 0;
  const plans = [];

  // Strategy 1: use scene boundaries to build clips of 30-55s
  const scenes = (sceneDetect && Array.isArray(sceneDetect.scenes)) ? sceneDetect.scenes : [];

  if (scenes.length >= 2) {
    // Walk scenes greedily: accumulate until we hit target duration
    let startIdx = 0;
    while (startIdx < scenes.length && plans.length < MAX_CLIPS) {
      let accumulated = 0;
      let endIdx = startIdx;

      while (endIdx < scenes.length && accumulated < TARGET_MIN) {
        accumulated += scenes[endIdx].duration_sec || 0;
        endIdx++;
      }

      const startSec = scenes[startIdx].start_sec;
      const endSec   = scenes[Math.min(endIdx, scenes.length) - 1].end_sec;
      const duration = endSec - startSec;

      if (duration >= 15 && duration <= TARGET_MAX + 10) {
        plans.push({
          start_sec: parseFloat(startSec.toFixed(2)),
          end_sec:   parseFloat(Math.min(endSec, startSec + TARGET_MAX).toFixed(2)),
          score:     50,
          hook_type: 'unknown',
          reason:    'Heuristic clip from scene boundaries (LLM unavailable)',
          caption_plan:      '',
          reframe_strategy:  'center',
          risk_notes:        '',
        });
      }

      // Advance by at least one scene to avoid infinite loop
      startIdx = Math.max(endIdx, startIdx + 1);
    }
  }

  // Strategy 2: if not enough scenes, divide transcript into equal chunks
  if (plans.length === 0 && totalDuration > 30) {
    const chunkSize = Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.floor(totalDuration / 3)));
    const numChunks = Math.min(MAX_CLIPS, Math.floor(totalDuration / chunkSize));

    for (let i = 0; i < numChunks; i++) {
      const startSec = i * chunkSize;
      const endSec   = Math.min(startSec + chunkSize, totalDuration);
      if (endSec - startSec >= 15) {
        plans.push({
          start_sec: parseFloat(startSec.toFixed(2)),
          end_sec:   parseFloat(endSec.toFixed(2)),
          score:     50,
          hook_type: 'unknown',
          reason:    'Heuristic clip from duration split (LLM unavailable)',
          caption_plan:      '',
          reframe_strategy:  'center',
          risk_notes:        '',
        });
      }
    }
  }

  // Strategy 3: last resort — one clip from start
  if (plans.length === 0 && totalDuration >= 15) {
    const endSec = Math.min(TARGET_MAX, totalDuration);
    plans.push({
      start_sec:         0,
      end_sec:           parseFloat(endSec.toFixed(2)),
      score:             50,
      hook_type:         'unknown',
      reason:            'Heuristic clip (LLM unavailable, last resort)',
      caption_plan:      '',
      reframe_strategy:  'center',
      risk_notes:        '',
    });
  }

  logger.info(`Heuristic clip plans: ${plans.length} clip(s)`, { agent: AGENT });
  return plans;
}

// ─── Normalize clip output ───────────────────────────────────────────────────

function _normalizeClipForOutput(clip) {
  // Final normalization before ClipPlannerOutput validation
  // Ensures all required fields have valid values and correct types
  return {
    ...clip,
    // Required string fields - never null
    risk_notes: typeof clip.risk_notes === 'string' ? clip.risk_notes : '',
    caption_plan: typeof clip.caption_plan === 'string' ? clip.caption_plan : '',
    hook_type: typeof clip.hook_type === 'string' ? clip.hook_type : 'unknown',
    reframe_strategy: ['center', 'zoom_in', 'face_track', 'action_follow'].includes(clip.reframe_strategy)
      ? clip.reframe_strategy
      : 'center',
    // Required numeric fields with validation
    score: Number.isFinite(Number(clip.score)) ? Number(clip.score) : 50,
    duration_sec: Number.isFinite(Number(clip.duration_sec))
      ? Number(clip.duration_sec)
      : Number(clip.end_sec) - Number(clip.start_sec),
  };
}

function _normalizeClip(clip) {
  // Ensure all required fields have valid values (never null for required strings)
  return {
    ...clip,
    // Required string fields - never null
    hook_type: clip.hook_type || 'unknown',
    caption_plan: clip.caption_plan || '',
    reframe_strategy: clip.reframe_strategy || 'center',
    risk_notes: clip.risk_notes || '', // CRITICAL: Never null
    
    // Required numeric fields
    start_sec: typeof clip.start_sec === 'number' ? clip.start_sec : 0,
    end_sec: typeof clip.end_sec === 'number' ? clip.end_sec : 0,
    duration_sec: typeof clip.duration_sec === 'number' ? clip.duration_sec : 0,
    score: typeof clip.score === 'number' ? Math.max(0, Math.min(100, clip.score)) : 50,
    
    // Optional fields - can be null/undefined
    reason: clip.reason || '',
    
    // Nested objects - ensure they exist if referenced
    moment_scoring: clip.moment_scoring || undefined,
    risk_assessment: clip.risk_assessment || undefined,
    captions: clip.captions || undefined,
    reframe_details: clip.reframe_details || undefined,
  };
}

module.exports = { runClipPlannerAgent };
