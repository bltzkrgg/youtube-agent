'use strict';

const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');

const AGENT = 'CriticAgent';

/**
 * Risk assessment agent untuk detect konten yang:
 * - Misleading (out of context)
 * - Sensitive (politik, agama, SARA)
 * - Copyright issues
 * - Fact-check needed
 * - Clickbait tanpa substance
 */

// ─── Main critic function ────────────────────────────────────────────────────

async function criticizeClipMoment(clipPlan, transcript, sourceIngest) {
  logger.info('Memulai risk assessment', { agent: AGENT, clipId: clipPlan.clip_id });

  try {
    const assessment = await withRetry(
      () => rateLimited('openrouter', () => _assessRisk(clipPlan, transcript, sourceIngest), 2000),
      { maxRetry: config.maxRetry, agent: AGENT, step: 'assessRisk' }
    );

    return assessment;
  } catch (err) {
    // Check for 429 rate limit
    const is429 = err.response?.status === 429 || err.message?.includes('429');
    
    logger.error('Critic assessment gagal', { 
      agent: AGENT, 
      error_message: err.message,
      status: err.response?.status,
      is429 
    });
    
    // Return safe default with valid structure
    return {
      risk_level: 'unknown',
      is_safe: false,
      concerns: is429 ? ['Rate limit reached, manual review required'] : ['Assessment failed, manual review required'],
      recommendations: ['Manual review before publish'],
      fact_check_needed: false,
      context_warning: null,
      risk_notes: is429
        ? 'Rate limit reached, manual review required'
        : 'Assessment failed, manual review required',
    };
  }
}

// ─── Risk assessment with LLM ────────────────────────────────────────────────

async function _assessRisk(clipPlan, transcript, sourceIngest) {
  const model = config.openrouter.models.clipPlanner;

  // Extract relevant transcript segment
  const clipTranscript = transcript.segments
    .filter(seg => seg.start >= clipPlan.start_sec && seg.end <= clipPlan.end_sec)
    .map(seg => seg.text)
    .join(' ');

  // Get surrounding context (30s before and after)
  const contextBefore = transcript.segments
    .filter(seg => seg.end > clipPlan.start_sec - 30 && seg.end <= clipPlan.start_sec)
    .map(seg => seg.text)
    .join(' ');

  const contextAfter = transcript.segments
    .filter(seg => seg.start >= clipPlan.end_sec && seg.start < clipPlan.end_sec + 30)
    .map(seg => seg.text)
    .join(' ');

  const prompt = `Kamu adalah content safety critic yang bertugas assess risk dari clip yang akan dipublish.

SOURCE VIDEO:
Title: ${sourceIngest.video_title}
Channel: ${sourceIngest.channel_title}
Full Duration: ${sourceIngest.source_duration.toFixed(1)}s

CLIP CANDIDATE:
Duration: ${clipPlan.duration_sec.toFixed(1)}s (${clipPlan.start_sec.toFixed(1)}s - ${clipPlan.end_sec.toFixed(1)}s)
Hook Type: ${clipPlan.hook_type}

CONTEXT BEFORE (30s sebelum clip):
${contextBefore.slice(0, 300) || 'N/A'}

CLIP TRANSCRIPT:
${clipTranscript}

CONTEXT AFTER (30s setelah clip):
${contextAfter.slice(0, 300) || 'N/A'}

TUGAS:
Assess risk dari clip ini. Check untuk:

1. **MISLEADING CONTEXT**
   - Apakah clip ini misleading jika diambil dari video penuh?
   - Apakah ada konteks penting yang hilang?
   - Apakah bisa disalahpahami?

2. **SENSITIVE CONTENT**
   - Politik, agama, SARA
   - Konten dewasa atau kekerasan
   - Misinformasi atau hoax

3. **COPYRIGHT ISSUES**
   - Apakah ada mention musik/brand/footage pihak ketiga?
   - Apakah ada potensi copyright claim?

4. **FACT-CHECK NEEDED**
   - Apakah ada klaim yang perlu diverifikasi?
   - Apakah ada statistik/data yang perlu dicek?

5. **CLICKBAIT WITHOUT SUBSTANCE**
   - Apakah hook terlalu clickbait tanpa deliver value?
   - Apakah ada overpromise?

RISK LEVELS:
- "safe" - Aman untuk publish
- "low" - Risk rendah, bisa publish dengan catatan
- "medium" - Perlu review manual
- "high" - Tidak disarankan publish
- "critical" - Jangan publish

FORMAT JSON:
{
  "risk_level": "low",
  "is_safe": true,
  "concerns": ["List concern jika ada, atau array kosong"],
  "recommendations": ["Rekomendasi action, atau array kosong jika safe"],
  "fact_check_needed": false,
  "context_warning": "Warning jika ada konteks yang hilang (opsional)"
}

Hanya JSON, tanpa teks lain.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, // Lower temperature untuk consistency
      max_tokens: 800,
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
  const parsed = extractJson(raw, `${AGENT}:assessRisk`);
  
  if (!parsed || !parsed.risk_level) {
    throw new Error('Invalid response dari CriticAgent');
  }

  // Validate risk_level
  const validLevels = ['safe', 'low', 'medium', 'high', 'critical'];
  if (!validLevels.includes(parsed.risk_level)) {
    parsed.risk_level = 'medium'; // Default to medium if invalid
  }

  // Ensure all required fields with safe defaults
  return {
    risk_level: parsed.risk_level,
    is_safe: parsed.is_safe !== false, // Default true jika tidak ada
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    fact_check_needed: parsed.fact_check_needed === true,
    context_warning: parsed.context_warning || null,
  };
}

module.exports = { criticizeClipMoment };
