'use strict';

const logger = require('./logger');

/**
 * Safely parse a JSON string. Returns null on failure instead of throwing.
 * ALL JSON.parse calls in the codebase MUST use this function.
 */
function safeParseJson(str, context = 'unknown') {
  if (typeof str !== 'string') {
    logger.warn('safeParseJson: input bukan string', { context, type: typeof str });
    return null;
  }
  try {
    return JSON.parse(str);
  } catch (err) {
    logger.warn('safeParseJson: gagal parse JSON', {
      context,
      error_message: err.message,
      preview: str.slice(0, 200),
    });
    return null;
  }
}

/**
 * Extract the first JSON object or array found inside a string.
 * Useful when LLM wraps JSON inside markdown code blocks.
 */
function extractJson(str, context = 'unknown') {
  if (!str) return null;

  // Try direct parse first
  const direct = safeParseJson(str, context);
  if (direct !== null) return direct;

  // Strip markdown code blocks
  const stripped = str
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const fromStripped = safeParseJson(stripped, context);
  if (fromStripped !== null) return fromStripped;

  // Find first { or [ and try from there
  const start = Math.min(
    str.indexOf('{') === -1 ? Infinity : str.indexOf('{'),
    str.indexOf('[') === -1 ? Infinity : str.indexOf('[')
  );
  if (start === Infinity) return null;

  const slice = str.slice(start);
  return safeParseJson(slice, context);
}

/**
 * Safely stringify a value. Returns '{}' on failure.
 */
function safeStringifyJson(value, context = 'unknown') {
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.warn('safeStringifyJson: gagal stringify', {
      context,
      error_message: err.message,
    });
    return '{}';
  }
}

module.exports = { safeParseJson, extractJson, safeStringifyJson };
