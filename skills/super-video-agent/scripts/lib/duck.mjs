// Pure gain-envelope math for ducking sound effects under narration
// (references/sound.md "Mix"): shared by render.mjs (library cue sounds,
// scripts/lib/audio-mix.mjs) and dub.mjs (the picture's whole sound bed,
// against a dubbed language's own narration windows — the language decides
// where speech is). A deterministic piecewise-linear gain envelope, not a
// compressor, so the same input always ducks the same way.
//
// The music bed's own -10dB duck (reel-audio.js duck(), inside the page)
// is untouched by this module — this only covers what render.mjs/dub.mjs
// mix in from outside the browser.

const DEFAULT_DUCK_DB = -6;
const DEFAULT_RAMP_SEC = 0.08;
// Gaps between lines shorter than this stay ducked: the bed rising 6 dB for
// a breath between two lines and dropping again is heard as pumping.
export const HOLD_GAP_SEC = 1.0;

/** dB -> linear amplitude multiplier (0dB -> 1, -6dB -> ~0.501). */
export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/**
 * Narration windows, sorted and merged where the gap between two is shorter
 * than HOLD_GAP_SEC (or than the two ramps), so the bed rises only in real
 * pauses, never for the breath between lines.
 * @param {{start:number, end:number}[]} narrationWindows
 * @param {number} [rampSec]
 * @returns {{start:number, end:number}[]}
 */
export function mergeDuckWindows(narrationWindows, rampSec = DEFAULT_RAMP_SEC) {
  const sorted = (narrationWindows || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start - last.end < Math.max(HOLD_GAP_SEC, 2 * rampSec)) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  return merged;
}

/**
 * Whether `t` (seconds) falls inside any of `narrationWindows` — used by
 * review.mjs to note that a sync mark landed during narration (so it was
 * measured at reduced amplitude if its sound source is one that gets
 * ducked), instead of letting a lower amplitude silently read as a sync
 * failure with no explanation.
 * @param {number} t
 * @param {{start:number, end:number}[]} narrationWindows
 */
export function isDuringNarration(t, narrationWindows) {
  return (narrationWindows || []).some((w) => t >= w.start && t <= w.end);
}

/**
 * Builds an ffmpeg `volume=eval=frame:volume='<expr>'` filter: holds unity
 * gain (1.0, 0dB) outside every narration window, ramps down to `duckDb`
 * over `rampSec` on entry, holds `duckDb` for the window, and ramps back up
 * over `rampSec` on exit. Returns null when there is nothing to duck
 * (duckDb is 0, or there are no narration windows) — the caller then
 * applies no filter, byte-identical to before ducking existed.
 * @param {{start:number, end:number}[]} narrationWindows
 * @param {{duckDb?:number, rampSec?:number}} [opts]
 * @returns {string|null}
 */
export function buildDuckVolumeExpr(narrationWindows, { duckDb = DEFAULT_DUCK_DB, rampSec = DEFAULT_RAMP_SEC } = {}) {
  if (!duckDb) return null;
  const windows = mergeDuckWindows(narrationWindows, rampSec);
  if (!windows.length) return null;
  const floor = dbToLinear(duckDb);
  const f = (n) => n.toFixed(6);
  const terms = windows.map(({ start, end }) => {
    const downStart = Math.max(0, start - rampSec);
    const upEnd = end + rampSec;
    // 1 -> floor over [downStart,start]; floor over [start,end]; floor -> 1
    // over [end,upEnd]; 1 everywhere else.
    return (
      `if(between(t,${f(downStart)},${f(start)}),1-(1-${f(floor)})*(t-${f(downStart)})/${f(rampSec)},` +
      `if(between(t,${f(start)},${f(end)}),${f(floor)},` +
      `if(between(t,${f(end)},${f(upEnd)}),${f(floor)}+(1-${f(floor)})*(t-${f(end)})/${f(rampSec)},1)))`
    );
  });
  // Windows are merged above, so at most one term is non-1 at any t; min()
  // over all of them picks up whichever one applies. ffmpeg's min() takes
  // exactly two arguments, so the terms are nested pairwise.
  const expr = terms.reduceRight((acc, term) => `min(${term},${acc})`);
  return `volume=eval=frame:volume='${expr}'`;
}

export const DUCK_DB_DEFAULT = DEFAULT_DUCK_DB;
export const DUCK_RAMP_SEC_DEFAULT = DEFAULT_RAMP_SEC;
