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

    // Spawn clip render jobs for each planned clip
    for (const clip of result.clips) {
      pushJob('clip_render', { 
        clip_id: clip.clip_id,
        source_video_id, 
        correlation_id: result.correlation_id 
      }, {
        correlationId: result.correlation_id,
        priority: 'normal',
      });
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

  const clipPlans = await withRetry(
    () => rateLimited('openrouter', () => _analyzeWithLLM(sourceIngest, transcript, sceneDetect), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'llmAnalysis' }
  );

  if (!clipPlans || clipPlans.length === 0) {
    throw new Error('LLM tidak menghasilkan clip plan valid');
  }

  // Validate and sanitize clip plans
  const validatedPlans = clipPlans.filter(plan => {
    // Validate required fields
    if (typeof plan.start_sec !== 'number' || typeof plan.end_sec !== 'number') {
      logger.warn('Clip plan missing start_sec/end_sec, skipped', { agent: AGENT, plan });
      return false;
    }
    
    // Validate duration
    const duration = plan.end_sec - plan.start_sec;
    if (duration < 10 || duration > 60) {
      logger.warn(`Clip duration ${duration}s out of range (10-60s), skipped`, { agent: AGENT, plan });
      return false;
    }
    
    // Validate score
    if (typeof plan.score !== 'number' || plan.score < 0 || plan.score > 100) {
      logger.warn(`Invalid score ${plan.score}, defaulting to 50`, { agent: AGENT, plan });
      plan.score = 50;
    }
    
    // Ensure required string fields
    plan.hook_type = plan.hook_type || 'unknown';
    plan.caption_plan = plan.caption_plan || 'Default caption';
    plan.reframe_strategy = plan.reframe_strategy || 'center';
    plan.risk_notes = plan.risk_notes || null;
    
    return true;
  });

  if (validatedPlans.length === 0) {
    throw new Error('Semua clip plans tidak valid setelah validasi');
  }

  logger.info(`${validatedPlans.length} valid clips dari ${clipPlans.length} plans`, { agent: AGENT });

  // Assign clip_id to each plan
  const clipsWithId = validatedPlans.map((plan) => ({
    clip_id: uuidv4(),
    ...plan,
    duration_sec: plan.end_sec - plan.start_sec,
  }));

  // PHASE 2: Advanced processing per clip
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
      }
    }

    // 2. Risk assessment (if enabled)
    if (ENABLE_CRITIC) {
      try {
        const criticResult = await criticizeClipMoment(clip, transcript, sourceIngest);
        enrichedClip.risk_assessment = criticResult;
        
        // Update risk_notes
        if (criticResult.concerns.length > 0) {
          enrichedClip.risk_notes = [
            enrichedClip.risk_notes || '',
            `Risk: ${criticResult.risk_level}`,
            ...criticResult.concerns
          ].filter(Boolean).join('; ');
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
          wordCount: captionResult.word_captions.length 
        });
      } catch (err) {
        logger.warn(`Caption generation failed for clip ${clip.clip_id}`, { 
          agent: AGENT, 
          error_message: err.message 
        });
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
      }
    }

    enrichedClips.push(enrichedClip);
  }

  // Sort by final score
  enrichedClips.sort((a, b) => b.score - a.score);

  const output = {
    source_video_id: sourceVideoId,
    correlation_id: correlationId,
    clips: enrichedClips,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(ClipPlannerOutput, output, AGENT);
  if (!success) throw new Error(`Validasi ClipPlannerOutput gagal: ${error}`);

  writeVideoJson(sourceVideoId, 'clip_planner.json', data);

  // Insert clips into database
  for (const clip of data.clips) {
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
      risk_notes: clip.risk_notes || null,
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
  }

  return data;
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
Identifikasi 3-7 momen terbaik dari video ini yang bisa dijadikan clip Shorts (max 60 detik per clip).

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
- Max 7 clips, fokus pada yang terbaik`;

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
      timeout: 45000,
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
      risk_notes: null,
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
      risk_notes: null,
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

  // Insert mock clips into database
  for (const clip of clips) {
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
      final_video_path: null,
      thumbnail_path: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return output;
}

module.exports = { runClipPlannerAgent };
