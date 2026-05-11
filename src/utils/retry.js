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

function isRetryable(err) {
  if (!err) return false;
  const status = err.response?.status || err.status;
  const nonRetryableStatuses = [400, 401, 403, 404];

  if (nonRetryableStatuses.includes(status)) {
    const errorText = (err.message || '').toLowerCase() + JSON.stringify(err.response?.data || '').toLowerCase();
    if (errorText.includes('billing') || errorText.includes('precondition')) return false;
    if (status !== 400) return false;
  }
  
  if (err.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code)) return true;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return (err.message || '').toLowerCase().includes('timeout');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry, sleep, isRetryable };
