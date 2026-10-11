// Allowances applied to freeze (dead-air) runs found by scripts/lib/freeze-scan.mjs:
// the end hold after the last line and the spans the page or --holds declare.
// Pure, no I/O.

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

/**
 * Split dead-air runs by the spans the page declared as intended slow motion or hold
 * (window.__reel.holds, seconds). The part of a run inside a hold goes to `intendedHolds`
 * (reported like the end hold, never flagged); the parts outside stay in `runs` when they
 * still span >= `runSecMin`.
 * @param {{startSec:number, durationSec:number}[]} runs
 * @param {{from:number, to:number}[]} holds
 * @param {number} runSecMin
 * @returns {{runs:{startSec:number,durationSec:number}[], intendedHolds:{startSec:number,durationSec:number}[]}}
 */
export function splitIntendedHolds(runs, holds, runSecMin) {
  const spans = (holds || []).filter((h) => Number.isFinite(h.from) && Number.isFinite(h.to) && h.to > h.from)
    .sort((a, b) => a.from - b.from);
  const kept = [];
  const intendedHolds = [];
  for (const r of runs) {
    const end = r.startSec + r.durationSec;
    let cursor = r.startSec;
    for (const h of spans) {
      const a = Math.max(h.from, cursor);
      const b = Math.min(h.to, end);
      if (b <= a) continue;
      if (a > cursor) kept.push({ startSec: cursor, durationSec: a - cursor });
      intendedHolds.push({ startSec: a, durationSec: b - a });
      cursor = b;
    }
    if (end > cursor) kept.push({ startSec: cursor, durationSec: end - cursor });
  }
  return { runs: kept.filter((r) => r.durationSec >= runSecMin), intendedHolds };
}
