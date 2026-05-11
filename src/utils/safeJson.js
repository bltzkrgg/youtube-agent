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
  const start = Math.min(
    str.indexOf('{') === -1 ? Infinity : str.indexOf('{'),
    str.indexOf('[') === -1 ? Infinity : str.indexOf('[')
  );
  const end = Math.max(
    str.lastIndexOf('}') === -1 ? -1 : str.lastIndexOf('}'),
    str.lastIndexOf(']') === -1 ? -1 : str.lastIndexOf(']')
  );
  if (start === Infinity || end === -1 || end < start) return null;
  return safeParseJson(str.slice(start, end + 1), context);
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
