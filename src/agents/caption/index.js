'use strict';

const axios = require('axios');

const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');

const AGENT = 'CaptionAgent';

/**
 * Advanced caption generation dengan:
 * - Word-level timing alignment
 * - Emphasis detection (kata kunci yang perlu di-highlight)
 * - Caption chunking (max 2-3 kata per frame untuk readability)
 * - Style recommendations (font size, color, animation)
 */

// ─── Main caption function ───────────────────────────────────────────────────

async function generateCaptions(clipPlan, transcript) {
  logger.info('Generating advanced captions', { agent: AGENT, clipId: clipPlan.clip_id });

  // Extract transcript segments for this clip
  const clipSegments = transcript.segments.filter(
    seg => seg.start >= clipPlan.start_sec && seg.end <= clipPlan.end_sec
  );

  if (clipSegments.length === 0) {
    logger.warn('No transcript segments found for clip', { agent: AGENT, clipId: clipPlan.clip_id });
    return _generateFallbackCaptions(clipPlan);
  }

  try {
    const captionPlan = await withRetry(
      () => rateLimited('openrouter', () => _generateCaptionPlan(clipPlan, clipSegments), 2000),
      { maxRetry: config.maxRetry, agent: AGENT, step: 'generateCaptionPlan' }
    );

    // Build word-level captions with timing
    const wordCaptions = _buildWordLevelCaptions(clipSegments, captionPlan);

    return {
      caption_style: captionPlan.style,
      emphasis_words: captionPlan.emphasis_words,
      word_captions: wordCaptions,
      srt_format: _generateSRT(wordCaptions),
    };
  } catch (err) {
    logger.error('Caption generation gagal', { 
      agent: AGENT, 
      error_message: err.message 
    });
    return _generateFallbackCaptions(clipPlan);
  }
}

// ─── Generate caption plan with LLM ──────────────────────────────────────────

async function _generateCaptionPlan(clipPlan, clipSegments) {
  const model = config.openrouter.models.clipPlanner;

  const fullText = clipSegments.map(seg => seg.text).join(' ');

  const prompt = `Kamu adalah caption expert untuk viral Shorts.

CLIP INFO:
Hook Type: ${clipPlan.hook_type}
Duration: ${clipPlan.duration_sec.toFixed(1)}s
Original Caption Plan: ${clipPlan.caption_plan}

TRANSCRIPT:
${fullText}

TUGAS:
Buat caption strategy untuk clip ini. Tentukan:

1. **EMPHASIS WORDS** - Kata kunci yang harus di-highlight (max 5-7 kata)
   - Angka/statistik
   - Kata emosional (shocking, amazing, etc)
   - Kata kunci topik

2. **CAPTION STYLE**
   - font_size: "large" (hook/climax) atau "medium" (normal)
   - color: "white", "yellow" (emphasis), "red" (warning)
   - animation: "none", "pop" (kata emphasis), "slide_up"
   - position: "bottom" (default), "center" (dramatic moment)

3. **CHUNKING STRATEGY**
   - max_words_per_chunk: 2-4 kata per caption frame
   - chunk_by: "natural_pause" atau "fixed_duration"

FORMAT JSON:
{
  "emphasis_words": ["kata1", "kata2", "kata3"],
  "style": {
    "font_size": "large",
    "color": "white",
    "animation": "pop",
    "position": "bottom"
  },
  "chunking": {
    "max_words_per_chunk": 3,
    "chunk_by": "natural_pause"
  }
}

Hanya JSON, tanpa teks lain.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens: 600,
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
  const parsed = extractJson(raw, `${AGENT}:generateCaptionPlan`);
  
  if (!parsed || !parsed.style) {
    throw new Error('Invalid response dari CaptionAgent');
  }

  return {
    emphasis_words: Array.isArray(parsed.emphasis_words) ? parsed.emphasis_words : [],
    style: parsed.style,
    chunking: parsed.chunking || { max_words_per_chunk: 3, chunk_by: 'natural_pause' },
  };
}

// ─── Build word-level captions ───────────────────────────────────────────────

function _buildWordLevelCaptions(clipSegments, captionPlan) {
  const wordCaptions = [];
  const emphasisSet = new Set(captionPlan.emphasis_words.map(w => w.toLowerCase()));
  const maxWords = captionPlan.chunking.max_words_per_chunk || 3;

  for (const seg of clipSegments) {
    const words = seg.text.trim().split(/\s+/);
    const segDuration = seg.end - seg.start;
    const timePerWord = segDuration / words.length;

    // Chunk words
    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords);
      const chunkStart = seg.start + (i * timePerWord);
      const chunkEnd = seg.start + ((i + chunk.length) * timePerWord);

      // Check if any word in chunk is emphasis
      const hasEmphasis = chunk.some(w => emphasisSet.has(w.toLowerCase().replace(/[.,!?]/g, '')));

      wordCaptions.push({
        start: parseFloat(chunkStart.toFixed(2)),
        end: parseFloat(chunkEnd.toFixed(2)),
        text: chunk.join(' '),
        emphasis: hasEmphasis,
      });
    }
  }

  return wordCaptions;
}

// ─── Generate SRT format ─────────────────────────────────────────────────────

function _generateSRT(wordCaptions) {
  let srt = '';
  
  for (let i = 0; i < wordCaptions.length; i++) {
    const caption = wordCaptions[i];
    const startTime = _formatSRTTime(caption.start);
    const endTime = _formatSRTTime(caption.end);
    
    srt += `${i + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${caption.text}\n\n`;
  }

  return srt;
}

function _formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

// ─── Fallback captions ───────────────────────────────────────────────────────

function _generateFallbackCaptions(clipPlan) {
  logger.info('Using fallback caption generation', { agent: AGENT });
  
  return {
    caption_style: {
      font_size: 'medium',
      color: 'white',
      animation: 'none',
      position: 'bottom',
    },
    emphasis_words: [],
    word_captions: [],
    srt_format: '',
  };
}

module.exports = { generateCaptions };
