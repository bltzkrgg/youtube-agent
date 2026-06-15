'use strict';

const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');

const AGENT = 'MomentScoringAgent';

/**
 * Multi-perspective scoring untuk clip moments.
 * Menggunakan beberapa "persona" LLM untuk evaluate moment dari berbagai sudut pandang.
 */

const SCORING_PERSONAS = [
  {
    name: 'viral_expert',
    prompt: `Kamu adalah viral content expert yang fokus pada:
- Hook strength (3 detik pertama)
- Emotional impact (surprise, humor, controversy)
- Shareability (apakah orang akan share ini?)
- Retention potential (apakah orang akan nonton sampai habis?)

Score 0-100 berdasarkan potensi viral.`,
  },
  {
    name: 'audience_psychologist',
    prompt: `Kamu adalah audience psychologist yang fokus pada:
- Curiosity gap (apakah bikin penasaran?)
- Emotional resonance (apakah relatable?)
- Cognitive ease (apakah mudah dipahami?)
- Social proof potential (apakah orang akan engage di comments?)

Score 0-100 berdasarkan psychological appeal.`,
  },
  {
    name: 'content_strategist',
    prompt: `Kamu adalah content strategist yang fokus pada:
- Platform fit (cocok untuk Shorts format?)
- Trend alignment (sesuai trend saat ini?)
- Niche relevance (sesuai target audience?)
- Competitive advantage (unik dibanding konten serupa?)

Score 0-100 berdasarkan strategic value.`,
  },
];

// ─── Main scoring function ───────────────────────────────────────────────────

async function scoreClipMoment(clipPlan, transcript, sceneDetect, sourceIngest) {
  logger.info('Memulai multi-perspective scoring', { agent: AGENT, clipId: clipPlan.clip_id });

  const scores = [];

  for (const persona of SCORING_PERSONAS) {
    try {
      const timeoutMs = config.llmTimeouts.optionalAgent;
      const scorePromise = withRetry(
        () => rateLimited('openrouter', () => _scoreWithPersona(persona, clipPlan, transcript, sceneDetect, sourceIngest), 2000),
        { maxRetry: 2, agent: AGENT, step: `score_${persona.name}` }
      );
      // Race against a per-persona timeout so a slow persona can't block the pipeline
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Persona ${persona.name} timeout after ${timeoutMs}ms`)), timeoutMs)
      );
      const score = await Promise.race([scorePromise, timeoutPromise]);
      scores.push({ persona: persona.name, ...score });
    } catch (err) {
      const is429 = err.response?.status === 429 || err.message?.includes('429');
      logger.warn(`Scoring gagal untuk persona ${persona.name}`, { 
        agent: AGENT, 
        error_message: err.message,
        is429 
      });
      // Continue dengan persona lain
    }
  }

  if (scores.length === 0) {
    // All personas failed - return safe fallback
    logger.warn('All persona scoring failed, using fallback', { agent: AGENT });
    return {
      final_score: clipPlan.score || 50,
      confidence: 0,
      persona_scores: [],
      strengths: [],
      weaknesses: ['Scoring unavailable - using default score'],
      reasoning: 'Scoring service unavailable',
    };
  }

  // Aggregate scores
  const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const confidence = scores.length / SCORING_PERSONAS.length; // 1.0 jika semua berhasil

  // Identify strengths and weaknesses
  const strengths = scores
    .filter(s => s.score >= 70)
    .map(s => s.reasoning)
    .slice(0, 2);

  const weaknesses = scores
    .filter(s => s.score < 60)
    .map(s => s.reasoning)
    .slice(0, 2);

  return {
    final_score: Math.round(avgScore),
    confidence,
    persona_scores: scores,
    strengths,
    weaknesses,
    reasoning: `Scored by ${scores.length}/${SCORING_PERSONAS.length} personas`,
  };
}

// ─── Score with single persona ───────────────────────────────────────────────

async function _scoreWithPersona(persona, clipPlan, transcript, sceneDetect, sourceIngest) {
  const model = config.openrouter.models.clipPlanner;

  // Extract relevant transcript segment
  const clipTranscript = transcript.segments
    .filter(seg => seg.start >= clipPlan.start_sec && seg.end <= clipPlan.end_sec)
    .map(seg => seg.text)
    .join(' ');

  // Find overlapping scenes
  const clipScenes = sceneDetect.scenes
    .filter(scene => 
      (scene.start_sec >= clipPlan.start_sec && scene.start_sec < clipPlan.end_sec) ||
      (scene.end_sec > clipPlan.start_sec && scene.end_sec <= clipPlan.end_sec)
    );

  const prompt = `${persona.prompt}

SOURCE VIDEO:
Title: ${sourceIngest.video_title}
Channel: ${sourceIngest.channel_title}

CLIP CANDIDATE:
Duration: ${clipPlan.duration_sec.toFixed(1)}s (${clipPlan.start_sec.toFixed(1)}s - ${clipPlan.end_sec.toFixed(1)}s)
Hook Type: ${clipPlan.hook_type}
Current Score: ${clipPlan.score}

TRANSCRIPT (clip segment):
${clipTranscript.slice(0, 500)}

SCENE COUNT: ${clipScenes.length} scenes dalam clip ini

ORIGINAL REASONING:
${clipPlan.reason}

TUGAS:
Evaluate clip ini dari perspektif ${persona.name}. Berikan:
1. Score 0-100
2. Reasoning singkat (1-2 kalimat)
3. Improvement suggestions (opsional)

FORMAT JSON:
{
  "score": 85,
  "reasoning": "Kenapa score ini (1-2 kalimat)",
  "improvement": "Saran improvement jika ada (opsional)"
}

Hanya JSON, tanpa teks lain.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
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
      timeout: config.llmTimeouts.optionalAgent,
      validateStatus: (status) => status < 500, // Don't throw on 4xx
    }
  );

  // Handle 429 rate limit
  if (res.status === 429) {
    const retryAfter = res.headers['retry-after'] || 60;
    const error = new Error(`Rate limit exceeded. Retry after ${retryAfter}s`);
    error.response = { status: 429 };
    throw error;
  }

  // Handle other 4xx errors
  if (res.status >= 400) {
    const error = new Error(`OpenRouter error: ${res.status} ${res.statusText}`);
    error.response = { status: res.status };
    throw error;
  }

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, `${AGENT}:${persona.name}`);
  
  if (!parsed || typeof parsed.score !== 'number') {
    throw new Error(`Invalid response dari ${persona.name}`);
  }

  return {
    score: Math.max(0, Math.min(100, parsed.score)),
    reasoning: parsed.reasoning || 'No reasoning provided',
    improvement: parsed.improvement || null,
  };
}

module.exports = { scoreClipMoment };
