'use strict';

const logger = require('./logger');

/**
 * Retry a function with exponential backoff + jitter.
 * Only retries on network errors, HTTP 429, and 5xx responses.
 *
 * delay = base * (2 ^ retryCount) + jitter
 *
 * @param {Function} fn          - async function to retry
 * @param {Object}   opts
 * @param {number}   opts.maxRetry   - max attempts (default 3)
 * @param {number}   opts.baseDelay  - base delay in ms (default 1000)
 * @param {string}   opts.agent      - agent name for logging
 * @param {string}   opts.step       - step name for logging
 */
async function withRetry(fn, opts = {}) {
  const maxRetry = opts.maxRetry ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const agent = opts.agent || 'unknown';
  const step = opts.step || 'withRetry';

  let lastError;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) {
        logger.error('Error tidak dapat di-retry, langsung gagal', {
          agent,
          step,
          attempt,
          error_message: err.message,
        });
        throw err;
      }

      if (attempt === maxRetry) break;

      const jitter = Math.random() * 500;
      const delay = baseDelay * Math.pow(2, attempt) + jitter;

      logger.warn(`Retry attempt ${attempt + 1}/${maxRetry}, menunggu ${Math.round(delay)}ms`, {
        agent,
        step,
        error_message: err.message,
      });

      await sleep(delay);
    }
  }

  logger.error(`Semua ${maxRetry} retry gagal`, {
    agent,
    step,
    error_message: lastError?.message,
    stack: lastError?.stack,
    timestamp: new Date().toISOString(),
  });
  throw lastError;
}

/**
 * Determine if an error is retryable.
 */
function isRetryable(err) {
  // Network errors
  if (err.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) {
    return true;
  }

  // Axios HTTP errors
  const status = err.response?.status;
  if (status) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  // Generic "network" or "timeout" message
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('network') || msg.includes('socket')) {
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry, sleep, isRetryable };
