'use strict';

const { VIRAL_KEYWORDS } = require('./viralKeywords');

const AGENT = 'LocalHeuristic';

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const NUMBER_RE = /\b\d+\b/;
const EARLY_BONUS_DECAY = 0.02;
const EARLY_BONUS_BASE = 1.5;
const KEYWORD_WEIGHT = 1.4;
const QUESTION_BONUS = 1.8;
const CONTRAST_BONUS = 1.4;
const NUMBER_BONUS = 1.2;
const PUNCTUATION_BONUS = 0.8;
const DENSITY_DIVISOR = 2.8;
const DENSITY_CAP = 2.0;
const OVERLAP_RATIO = 0.35;
const HOOK_WORD_LIMIT = 16;
const TITLE_WORD_LIMIT = 8;
const CAPTION_WORD_LIMIT = 18;

/**
 * Pick top N clip candidates from transcript using viral-keyword scoring.
 * No external API calls — runs entirely on local CPU.
 *
 * Algorithm (ported from errnex/auto-clip src/analyzer.py:_analyze_locally):
 *  1. Enumerate all (start, end) windows with duration in [minDuration, maxDuration].
 *  2. Score each candidate's concatenated text using viral signals
 *     (keywords, question, contrast, number, density, early-bonus, punctuation).
 *  3. Sort by score desc, greedily pick non-overlapping top N.
 *  4. Re-sort by start time, emit plans compatible with ClipPlanner schema.
 *
 * Returns an array of clip plan objects ready to be inserted via insertClip().
 * Returns an empty array if no valid candidates exist (caller decides fallback).
 *
 * @param {Object} opts
 * @param {Array}  opts.segments      transcript.segments[] with {start, end, text}
 * @param {number} opts.minDuration   minimum clip duration (seconds)
 * @param {number} opts.maxDuration   maximum clip duration (seconds)
 * @param {number} opts.desiredClips  how many clips to return
 * @returns {Array}                   clip plan objects
 */
function analyzeTranscriptViral({ segments, minDuration, maxDuration, desiredClips }) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!Number.isFinite(minDuration) || !Number.isFinite(maxDuration)) return [];
  if (!(maxDuration > minDuration)) return [];

  const candidates = [];

  for (let startIndex = 0; startIndex < segments.length; startIndex++) {
    const startSec = Number(segments[startIndex].start);
    if (!Number.isFinite(startSec)) continue;

    const textParts = [];

    for (let endIndex = startIndex; endIndex < segments.length; endIndex++) {
      const endSec = Number(segments[endIndex].end);
      if (!Number.isFinite(endSec)) continue;

      const duration = endSec - startSec;
      if (duration > maxDuration) break;

      textParts.push(_cleanText(segments[endIndex].text));

      if (duration >= minDuration) {
        const text = _cleanText(textParts.join(' '));
        if (!text) continue;
        const { score, signals } = _scoreText(text, duration, startIndex);
        candidates.push({
          start: startSec,
          end: endSec,
          duration,
          text,
          score,
          signals,
        });
      }
    }
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];
  for (const candidate of candidates) {
    if (_overlapsExisting(candidate, selected)) continue;
    selected.push(candidate);
    if (selected.length >= desiredClips) break;
  }

  if (selected.length === 0) return [];

  selected.sort((a, b) => a.start - b.start);

  return selected.map((candidate, index) => _candidateToPlan(index + 1, candidate));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function _scoreText(text, duration, startIndex) {
  const lowered = text.toLowerCase();
  const words = lowered.match(WORD_RE) || [];
  const uniqueWords = new Set(words);

  const keywordHits = [];
  for (const group of Object.values(VIRAL_KEYWORDS)) {
    for (const keyword of group) {
      if (uniqueWords.has(keyword) || lowered.includes(keyword)) {
        keywordHits.push(keyword);
      }
    }
  }
  const uniqueKeywordHits = [...new Set(keywordHits)];

  const questionBonus =
    text.includes('?') || ['kenapa', 'why', 'how'].some((w) => uniqueWords.has(w))
      ? QUESTION_BONUS
      : 0;

  const contrastBonus = ['tapi', 'tetapi', 'but', 'however'].some((w) => uniqueWords.has(w))
    ? CONTRAST_BONUS
    : 0;

  const numberBonus = NUMBER_RE.test(text) ? NUMBER_BONUS : 0;

  const density = words.length / Math.max(duration, 1.0);
  const densityBonus = Math.min(DENSITY_CAP, density / DENSITY_DIVISOR);

  const earlyBonus = Math.max(0, EARLY_BONUS_BASE - startIndex * EARLY_BONUS_DECAY);

  const punctuationBonus = text.includes('!') || text.includes(':') ? PUNCTUATION_BONUS : 0;

  const score =
    uniqueKeywordHits.length * KEYWORD_WEIGHT +
    questionBonus +
    contrastBonus +
    numberBonus +
    densityBonus +
    earlyBonus +
    punctuationBonus;

  const signals = [];
  if (uniqueKeywordHits.length) {
    signals.push('keyword kuat: ' + uniqueKeywordHits.slice(0, 5).join(', '));
  }
  if (questionBonus) signals.push('ada pertanyaan/hook');
  if (contrastBonus) signals.push('ada kontras/opini');
  if (numberBonus) signals.push('ada angka yang mudah dipahami');
  if (densityBonus > 1) signals.push('informasi cukup padat');

  return {
    score,
    signals: signals.length ? signals : ['alur bicara cukup padat dan bisa berdiri sendiri'],
  };
}

function _overlapsExisting(candidate, selected) {
  for (const item of selected) {
    const overlapStart = Math.max(candidate.start, item.start);
    const overlapEnd = Math.min(candidate.end, item.end);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    const shorter = Math.min(candidate.duration, item.duration);
    if (shorter > 0 && overlap / shorter > OVERLAP_RATIO) return true;
  }
  return false;
}

// ─── Plan shape conversion ───────────────────────────────────────────────────

function _candidateToPlan(index, candidate) {
  const hook = _firstSentence(candidate.text);
  const title = _makeTitle(hook, index);
  const caption = _makeCaption(hook);

  const startSec = parseFloat(candidate.start.toFixed(2));
  const endSec = parseFloat(candidate.end.toFixed(2));
  const durationSec = parseFloat((endSec - startSec).toFixed(2));

  const scaledScore = Math.max(0, Math.min(100, Math.round(candidate.score * 4)));

  return {
    start_sec: startSec,
    end_sec: endSec,
    duration_sec: durationSec,
    score: scaledScore,
    hook_type: 'local_heuristic',
    reason: 'Local heuristic: ' + candidate.signals.join('; ') + '.',
    caption_plan: caption,
    reframe_strategy: 'center',
    risk_notes: '',
    title,
  };
}

function _firstSentence(text) {
  const cleaned = _cleanText(text);
  const parts = cleaned.split(SENTENCE_SPLIT_RE);
  const sentence = parts[0] || cleaned;
  const words = sentence.split(/\s+/);
  if (words.length > HOOK_WORD_LIMIT) {
    return words.slice(0, HOOK_WORD_LIMIT).join(' ') + '...';
  }
  return sentence || 'Momen penting dari video ini';
}

function _makeTitle(hook, index) {
  const words = (hook.match(WORD_RE) || []);
  if (words.length === 0) return `Clip ${String(index).padStart(2, '0')}`;
  return words
    .slice(0, TITLE_WORD_LIMIT)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function _makeCaption(hook) {
  const words = hook.split(/\s+/);
  const short = words.slice(0, CAPTION_WORD_LIMIT).join(' ');
  return `${short} #shorts #reels #tiktok`;
}

function _cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

module.exports = { analyzeTranscriptViral, _scoreText, _overlapsExisting, _cleanText };
