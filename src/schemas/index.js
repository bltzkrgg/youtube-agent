'use strict';

const { z } = require('zod');

// ─── Research Agent ──────────────────────────────────────────────────────────

const ResearchOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  topic: z.string().min(3),
  keywords: z.array(z.string()).min(1),
  trending_reason: z.string(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Script Agent ────────────────────────────────────────────────────────────

const ScriptSegment = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(['hook', 'buildup', 'climax', 'cliffhanger']),
  text: z.string().min(1),           // narration text for TTS
  visual_keyword: z.string().min(2), // Pexels search query
  sfx: z.string().optional(),        // sound effect hint: whoosh, hit, glitch, silence
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
  affiliate_keywords: z.array(z.string()),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Affiliate Agent ─────────────────────────────────────────────────────────

const AffiliateLink = z.object({
  keyword: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
});

const AffiliateOutput = z.object({
  video_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  links: z.array(AffiliateLink),
  formatted_description: z.string(),
  version: z.string().default('1.0'),
  created_at: z.string().datetime(),
});

// ─── Voiceover Agent ─────────────────────────────────────────────────────────

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

// ─── Visual Agent ─────────────────────────────────────────────────────────────

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

// ─── Clip Agent ──────────────────────────────────────────────────────────────

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
  topic: z.string().min(2),
  weight: z.number().min(0).max(10),
  views_avg: z.number().nonnegative(),
  engagement: z.number().min(0).max(100),
  video_count: z.number().int().nonnegative(),
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
  affiliate_keywords: z.array(z.string()),
});

const OpenRouterScriptResponse = z.object({
  hook_line: z.string(),
  segments: z.array(z.object({
    index: z.number().int().nonnegative(),
    type: z.enum(['hook', 'buildup', 'climax', 'cliffhanger']),
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
  ResearchOutput,
  ScriptSegment,
  ScriptOutput,
  MetadataOutput,
  AffiliateOutput,
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
  validate,
};
