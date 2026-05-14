'use strict';

const { z } = require('zod');

// ─── Source Ingest Agent ─────────────────────────────────────────────────────

const SourceIngestOutput = z.object({
  source_video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  source_url: z.string().url(),
  source_video_path: z.string(),
  source_duration: z.number().positive(),
  channel_title: z.string().optional(),
  video_title: z.string(),
  description: z.string().optional(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Transcript Agent ────────────────────────────────────────────────────────

const TranscriptSegment = z.object({
  id: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string(),
});

const TranscriptOutput = z.object({
  source_video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  text: z.string(),
  language: z.string().default('id'),
  segments: z.array(TranscriptSegment),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Scene Detect Agent ──────────────────────────────────────────────────────

const SceneSegment = z.object({
  index: z.number().int().nonnegative(),
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  duration_sec: z.number().positive(),
});

const SceneDetectOutput = z.object({
  source_video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  scenes: z.array(SceneSegment).min(1),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Clip Planner Agent ──────────────────────────────────────────────────────

const ClipPlan = z.object({
  clip_id: z.string().uuid(),
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  duration_sec: z.number().positive().max(60),
  score: z.number().min(0).max(100),
  hook_type: z.string(),
  reason: z.string(),
  caption_plan: z.string(),
  reframe_strategy: z.enum(['center', 'face_track', 'action_follow']).default('center'),
  risk_notes: z.string().optional(),
});

const ClipPlannerOutput = z.object({
  source_video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  clips: z.array(ClipPlan).min(1).max(10),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Clip Render Output ──────────────────────────────────────────────────────

const ClipRenderOutput = z.object({
  clip_id: z.string().uuid(),
  source_video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  final_video_path: z.string(),
  thumbnail_path: z.string(),
  start_sec: z.number().nonnegative(),
  end_sec: z.number().positive(),
  duration_sec: z.number().positive().max(60),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Research Agent (legacy) ─────────────────────────────────────────────────

const ResearchOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  topic: z.string().min(3),
  keywords: z.array(z.string()).min(1),
  trending_reason: z.string(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Script Agent (legacy) ───────────────────────────────────────────────────

const ScriptSegment = z.object({
  index: z.number().int().nonnegative(),
  type: z.string()
    .transform((v) => v.toLowerCase().replace(/[-_\s]/g, '') === 'buildup' ? 'buildup' : v)
    .pipe(z.enum(['hook', 'buildup', 'climax', 'cliffhanger'])),
  text: z.string().min(1),
  visual_keyword: z.string().min(2),
  sfx: z.string().optional(),
  duration_hint_sec: z.number().positive(),
});

const ScriptOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  topic: z.string(),
  hook_line: z.string(),
  segments: z.array(ScriptSegment).min(3).max(8),
  full_voiceover_text: z.string().min(20),
  music_mood: z.string(),
  total_duration_sec: z.number().positive().max(65),
  cliffhanger: z.string(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Metadata Agent ──────────────────────────────────────────────────────────

const MetadataOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  title: z.string().min(5).max(100),
  description: z.string().min(20),
  hashtags: z.array(z.string()).min(3).max(30),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Voiceover Agent (legacy) ────────────────────────────────────────────────

const VoiceoverSegment = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  audio_path: z.string(),
  duration_seconds: z.number().positive(),
});

const VoiceoverOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  segments: z.array(VoiceoverSegment).min(1),
  full_audio_path: z.string(),
  total_duration_seconds: z.number().positive().max(65),
  voice: z.string(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Visual Agent (legacy) ───────────────────────────────────────────────────

const VisualSegment = z.object({
  index: z.number().int().nonnegative(),
  keyword: z.string(),
  footage_path: z.string(),
  pexels_id: z.number().optional(),
  duration_seconds: z.number().positive(),
});

const VisualOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  segments: z.array(VisualSegment).min(1),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Clip Agent (legacy) ─────────────────────────────────────────────────────

const ClipOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  final_video_path: z.string(),
  thumbnail_path: z.string(),
  duration_seconds: z.number().positive().max(65),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Analytics ───────────────────────────────────────────────────────────────

const AnalyticsRow = z.object({
  video_id: z.string().optional(),
  title: z.string().optional(),
  views: z.coerce.number().int().nonnegative(),
  likes: z.coerce.number().int().nonnegative(),
  comments: z.coerce.number().int().nonnegative().optional().default(0),
  ctr: z.coerce.number().min(0).max(100).optional().default(0),
  avg_view_pct: z.coerce.number().min(0).max(100).optional().default(0),
});

// ─── Memory ──────────────────────────────────────────────────────────────────

const MemoryRecord = z.object({
  pattern_type: z.string().min(2),
  pattern_value: z.string().min(1),
  weight: z.number().min(0).max(10),
  views_avg: z.number().nonnegative(),
  engagement: z.number().min(0).max(100),
  clip_count: z.number().int().nonnegative(),
  last_updated: z.string().datetime(),
});

// ─── OpenRouter responses ─────────────────────────────────────────────────────

const OpenRouterTopicsResponse = z.object({
  topics: z.array(z.object({
    title: z.string(),
    keywords: z.array(z.string()),
    trending_reason: z.string(),
  })).min(1).max(10),
});

const OpenRouterMetadataResponse = z.object({
  title: z.string().min(5).max(100),
  description: z.string().min(20),
  hashtags: z.array(z.string()).min(3).max(30),
});

const OpenRouterScriptResponse = z.object({
  hook_line: z.string(),
  segments: z.array(z.object({
    index: z.number().int().nonnegative(),
    type: z.string()
    .transform((v) => v.toLowerCase().replace(/[-_\s]/g, '') === 'buildup' ? 'buildup' : v)
    .pipe(z.enum(['hook', 'buildup', 'climax', 'cliffhanger'])),
    text: z.string(),
    visual_keyword: z.string(),
    sfx: z.string().optional(),
    duration_hint_sec: z.number().positive(),
  })).min(3).max(8),
  full_voiceover_text: z.string(),
  music_mood: z.string(),
  total_duration_sec: z.number().positive().max(65),
  cliffhanger: z.string(),
});

const OpenRouterClipPlansResponse = z.object({
  clips: z.array(z.object({
    start_sec: z.number().nonnegative(),
    end_sec: z.number().positive(),
    score: z.number().min(0).max(100),
    hook_type: z.string(),
    reason: z.string(),
    caption_plan: z.string(),
    reframe_strategy: z.enum(['center', 'face_track', 'action_follow']).default('center'),
    risk_notes: z.string().optional(),
  })).min(1).max(10),
});

// ─── Validate helper ─────────────────────────────────────────────────────────

function validate(schema, data, context = 'unknown') {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      data: null,
      error: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    };
  }
  return { success: true, data: result.data, error: null };
}

module.exports = {
  // New clipper schemas
  SourceIngestOutput,
  TranscriptSegment,
  TranscriptOutput,
  SceneSegment,
  SceneDetectOutput,
  ClipPlan,
  ClipPlannerOutput,
  ClipRenderOutput,
  // Legacy schemas
  ResearchOutput,
  ScriptSegment,
  ScriptOutput,
  MetadataOutput,
  VoiceoverSegment,
  VoiceoverOutput,
  VisualSegment,
  VisualOutput,
  ClipOutput,
  AnalyticsRow,
  MemoryRecord,
  OpenRouterTopicsResponse,
  OpenRouterMetadataResponse,
  OpenRouterScriptResponse,
  OpenRouterClipPlansResponse,
  validate,
};
