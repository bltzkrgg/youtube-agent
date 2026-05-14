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

2. **face_track** - Track speaker's face
   - Use when: Single speaker, face is main focus
   - Pros: Keeps speaker in frame even if they move
   - Cons: Requires face detection (fallback to center if fails)

3. **action_follow** - Follow main action/object
   - Use when: Demo, tutorial, sports, action scenes
   - Pros: Keeps important action in frame
   - Cons: Complex, might be jerky

4. **zoom_in** - Progressive zoom for emphasis
   - Use when: Dramatic moment, climax, reveal
   - Pros: Adds visual interest, emphasizes emotion
   - Cons: Might crop too much

5. **split_screen** - Multiple subjects side by side
   - Use when: Interview, debate, comparison
   - Pros: Shows multiple people/objects
   - Cons: Complex, might be too busy

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

  // Validate strategy
  const validStrategies = ['center', 'face_track', 'action_follow', 'zoom_in', 'split_screen'];
  if (!validStrategies.includes(parsed.strategy)) {
    parsed.strategy = 'center';
  }

  return {
    strategy: parsed.strategy,
    reasoning: parsed.reasoning || 'No reasoning provided',
    keyframes: Array.isArray(parsed.keyframes) ? parsed.keyframes : [],
    fallback_strategy: parsed.fallback_strategy || 'center',
  };
}

module.exports = { determineReframeStrategy };
