// Retry helper for Playwright transport/connection failures — both film
// sessions had render.mjs die once on one of these (mid-segment, no page
// error involved) and pass clean on a plain rerun. Only these error shapes
// retry; a real page error (pageerror thrown from inside the reel, a
// thrown Error from application logic) is never retried — retrying that
// would just re-run the same broken frame.

const TRANSPORT_ERROR_PATTERNS = [
  /protocol error/i,
  /target closed/i,
  /target page, context or browser has been closed/i,
  /websocket error/i,
  /browser has disconnected/i,
  /session closed/i,
  /connection closed/i,
  /pipe.*(closed|broken)/i,
];

/** True when `err` looks like a Playwright transport/connection failure, not a real page/application error. */
export function isTransportError(err) {
  if (!err) return false;
  const message = String((err && err.message) || err);
  return TRANSPORT_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Runs `fn(attempt)`. On a transport error (isTransportError), retries up
 * to `maxRetries` more times (default 2), calling `onRetry(attempt, err)`
 * — awaited — before each retry so the caller can drop a stale session
 * before the next attempt opens a fresh one. Any non-transport error, or
 * the last attempt's transport error, is rethrown as-is.
 * @param {(attempt:number) => Promise<T>} fn
 * @param {{maxRetries?:number, onRetry?:(attempt:number, err:Error) => any}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withTransportRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries == null ? 2 : opts.maxRetries;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isTransportError(err) || attempt === maxRetries) throw err;
      if (opts.onRetry) await opts.onRetry(attempt + 1, err);
    }
  }
  throw lastErr;
}
