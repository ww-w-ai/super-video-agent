// The messages that mark a `claude -p` call as a dropped connection (not a failed job). One list, used by run.mjs.
export const NETWORK_ERROR_PATTERNS = [
  /Can't reach the API server/i,
  /Unable to connect to API/i,
  /SSL certificate hostname mismatch/i,
  /\bENOTFOUND\b/,
  /\bECONNRESET\b/,
  /socket hang up/i,
];

export const DEFAULT_MAX_NETWORK_RETRIES = 40;
/** Seconds to wait before network retry 1, 2, 3...; the last value repeats. */
export const DEFAULT_NETWORK_BACKOFF_SEC = [30, 60, 90];

export const isNetworkError = (text) => NETWORK_ERROR_PATTERNS.some((re) => re.test(String(text ?? "")));

/** Wait before network retry number `attempt` (1-based). */
export const backoffMs = (attempt, seconds) => Math.round(seconds[Math.min(attempt, seconds.length) - 1] * 1000);
