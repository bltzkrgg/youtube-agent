'use strict';

const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');

const AGENT = 'ReframeAgent';

/**
 * Smart reframing strategy untuk 9:16 conversion.
 * Analyzes video content dan determines optimal crop strategy:
 * - center: Simple center crop (default)
 * - face_track: Track speaker's face
 * - action_follow: Follow main action/object
 * - split_screen: Multiple subjects
 * - zoom_in: Close-up untuk emphasis
 */

// ─── Main reframe function ───────────────────────────────────────────────────

async function determineReframeStrategy(clipPlan, transcript, sourceIngest) {
  logger.info('Determining reframe strategy', { agent: AGENT, clipId: clipPlan.clip_id });

  // Extract transcript for this clip
  const clipTranscript = transcript.segments
    .filter(seg => seg.start >= clipPlan.start_sec && seg.end <= clipPlan.end_sec)
    .map(seg => seg.text)
    .join(' ');

  try {
    const strategy = await withRetry(
      () => rateLimited('openrouter', () => _analyzeReframeStrategy(clipPlan, clipTranscript, sourceIngest), 2000),
      { maxRetry: config.maxRetry, agent: AGENT, step: 'analyzeReframe' }
    );

    return strategy;
  } catch (err) {
    logger.error('Reframe analysis gagal', { 
      agent: AGENT, 
      error_message: err.message 
    });
    // Fallback to center
    return {
      strategy: 'center',
      reasoning: 'Fallback to center crop due to analysis failure',
      keyframes: [],
    };
  }
}

// ─── Analyze reframe strategy with LLM ───────────────────────────────────────

async function _analyzeReframeStrategy(clipPlan, clipTranscript, sourceIngest) {
  const model = config.openrouter.models.clipPlanner;

  const prompt = `Kamu adalah video reframing expert untuk Shorts (9:16 vertical format).

SOURCE VIDEO:
Title: ${sourceIngest.video_title}
Channel: ${sourceIngest.channel_title}

CLIP INFO:
Duration: ${clipPlan.duration_sec.toFixed(1)}s
Hook Type: ${clipPlan.hook_type}

TRANSCRIPT:
${clipTranscript.slice(0, 500)}

TUGAS:
Tentukan reframing strategy terbaik untuk convert video ini ke 9:16.

AVAILABLE STRATEGIES:

1. **center** - Simple center crop
   - Use when: Talking head centered, minimal movement
   - Pros: Safe, works for most content
   - Cons: Might cut important side elements
   - SUPPORTED: ✅ Fully implemented

2. **face_track** - Track speaker's face
   - Use when: Single speaker, face is main focus
   - Pros: Keeps speaker in frame even if they move
   - Cons: Requires face detection
   - SUPPORTED: ⚠️ Fallback to center (face tracking not yet implemented)

3. **action_follow** - Follow main action/object
   - Use when: Demo, tutorial, sports, action scenes
   - Pros: Keeps important action in frame
   - Cons: Complex, might be jerky
   - SUPPORTED: ⚠️ Fallback to center (motion tracking not yet implemented)

4. **zoom_in** - Progressive zoom for emphasis
   - Use when: Dramatic moment, climax, reveal
   - Pros: Adds visual interest, emphasizes emotion
   - Cons: Might crop too much
   - SUPPORTED: ✅ Implemented via FFmpeg zoompan filter

PENTING:
- face_track dan action_follow akan fallback ke center (belum diimplementasi)
- Prioritaskan center dan zoom_in untuk hasil terbaik
- Jangan gunakan split_screen (tidak didukung renderer)

KEYFRAMES (optional):
Jika strategy berubah di tengah clip, specify keyframes:
[
  { "time_sec": 5.0, "strategy": "center" },
  { "time_sec": 15.0, "strategy": "zoom_in" }
]

FORMAT JSON:
{
  "strategy": "face_track",
  "reasoning": "Kenapa strategy ini dipilih (1-2 kalimat)",
  "keyframes": [],
  "fallback_strategy": "center"
}

Hanya JSON, tanpa teks lain.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://youtube-agent.local',
        'X-Title': 'YouTube Clipper Agent',
      },
      timeout: 30000,
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, `${AGENT}:analyzeReframe`);
  
  if (!parsed || !parsed.strategy) {
    throw new Error('Invalid response dari ReframeAgent');
  }

  // Validate strategy - only allow supported strategies
  const validStrategies = ['center', 'zoom_in'];
  const fallbackStrategies = ['face_track', 'action_follow']; // Will fallback to center
  
  if (!validStrategies.includes(parsed.strategy) && !fallbackStrategies.includes(parsed.strategy)) {
    logger.warn(`Invalid strategy ${parsed.strategy}, fallback to center`, { agent: AGENT });
    parsed.strategy = 'center';
  }
  
  // Warn if using fallback strategy
  if (fallbackStrategies.includes(parsed.strategy)) {
    logger.warn(`Strategy ${parsed.strategy} not yet implemented, will fallback to center in renderer`, { agent: AGENT });
  }

  return {
    strategy: parsed.strategy,
    reasoning: parsed.reasoning || 'No reasoning provided',
    keyframes: Array.isArray(parsed.keyframes) ? parsed.keyframes : [],
    fallback_strategy: 'center',
  };
}

module.exports = { determineReframeStrategy };
