// Bounded retry for failures that pass on a plain rerun: Playwright transport
// errors (withTransportRetry) and transient decode errors (isTransientDecodeError,
// used by lib/ffmpeg.mjs and the STT run). withRetry takes the predicate.
//
// Playwright transport/connection failures: both film
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

// Transient decode failures: a pipe read that fails with "Bad file descriptor" (EBADF),
// which ffmpeg reports as exit 247 (AVERROR(EBADF)) and Python's subprocess as
// "exit status 247". A plain rerun passes. Any other ffmpeg or Python error is real.
const TRANSIENT_DECODE_PATTERNS = [/Bad file descriptor/i, /\bEBADF\b/, /\bexited 247\b/, /\bexit status 247\b/];

/** True when `err` carries the transient decode signature (EBADF / exit 247). */
export function isTransientDecodeError(err) {
  if (!err) return false;
  const message = String((err && err.message) || err);
  return TRANSIENT_DECODE_PATTERNS.some((re) => re.test(message));
}

/**
 * Runs `fn(attempt)`. When `isRetryable(err)` is true, retries up to
 * `maxRetries` more times (default 2), calling `onRetry(attempt, err)` —
 * awaited — before each retry. Any other error, or the last attempt's
 * error, is rethrown as-is.
 * @param {(attempt:number) => Promise<T>} fn
 * @param {{isRetryable:(err:unknown) => boolean, maxRetries?:number, onRetry?:(attempt:number, err:Error) => any}} opts
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, opts) {
  const maxRetries = opts.maxRetries == null ? 2 : opts.maxRetries;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!opts.isRetryable(err) || attempt === maxRetries) throw err;
      if (opts.onRetry) await opts.onRetry(attempt + 1, err);
    }
  }
  throw lastErr;
}

/**
 * withRetry on Playwright transport errors (isTransportError); `onRetry` lets
 * the caller drop a stale session before the next attempt opens a fresh one.
 * @param {(attempt:number) => Promise<T>} fn
 * @param {{maxRetries?:number, onRetry?:(attempt:number, err:Error) => any}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export function withTransportRetry(fn, opts = {}) {
  return withRetry(fn, { ...opts, isRetryable: isTransportError });
}
