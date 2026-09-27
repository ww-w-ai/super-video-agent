// Pure run-finding over a sequence of per-instant canvas-pixel hashes:
// used by review.mjs's dead-air check (scripts/lib/browser.mjs's
// scanDeadAirBySeek supplies the hashes by seeking through window.__reel).
// No I/O, no browser — unit-testable on a plain hash array.

/**
 * Find runs of consecutive identical hashes spanning >= `runSecMin`
 * seconds. `times[i]` is the seek time that produced `hashes[i]`; any
 * pixel change (any hash change) ends a run.
 * @param {number[]} times seconds, same length as `hashes`, non-decreasing
 * @param {string[]} hashes one full-canvas pixel hash per time in `times`
 * @param {number} runSecMin minimum run span (seconds) to report
 * @returns {{startSec:number, durationSec:number}[]}
 */
export function deadAirRunsFromHashes(times, hashes, runSecMin) {
  const runs = [];
  let i = 0;
  while (i < hashes.length) {
    let j = i;
    while (j + 1 < hashes.length && hashes[j + 1] === hashes[i]) j++;
    const durationSec = times[j] - times[i];
    if (durationSec >= runSecMin) {
      runs.push({ startSec: times[i], durationSec });
    }
    i = j + 1;
  }
  return runs;
}

/**
 * Drop the intended end hold from dead-air runs: only the part of a run
 * before `holdStartSec` (the last spoken line's end) counts. A run that
 * still spans >= `runSecMin` before the hold stays flagged, shortened.
 * @param {{startSec:number, durationSec:number}[]} runs
 * @param {number} holdStartSec
 * @param {number} runSecMin
 * @returns {{startSec:number, durationSec:number}[]}
 */
export function excludeEndHold(runs, holdStartSec, runSecMin) {
  return runs
    .map((r) => ({ startSec: r.startSec, durationSec: Math.min(r.startSec + r.durationSec, holdStartSec) - r.startSec }))
    .filter((r) => r.durationSec >= runSecMin);
}
