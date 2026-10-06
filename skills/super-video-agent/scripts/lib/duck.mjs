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

// Gentle defaults (owner-approved): the bed also carries the page's own duck, so a
// deep, fast dub duck stacks into audible pumping (see measureDuckSwing).
const DEFAULT_DUCK_DB = -2.5;
const DEFAULT_RAMP_SEC = 0.8;
// Gaps between lines shorter than this stay ducked: the bed rising for a
// breath between two lines and dropping again is heard as pumping.
export const HOLD_GAP_SEC = 1.5;
// The page's own duck (engine/reel-audio.js duck(): depthDb -10, rampMs 120).
export const PAGE_DUCK_DB_DEFAULT = -10;
export const PAGE_DUCK_RAMP_SEC = 0.12;

/** dB -> linear amplitude multiplier (0dB -> 1, -6dB -> ~0.501). */
export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/**
 * Narration windows, sorted and merged where the gap between two is shorter
 * than HOLD_GAP_SEC, so the bed rises only in real pauses, never for the
 * breath between lines. Ramps that overlap in a short gap resolve by min().
 * @param {{start:number, end:number}[]} narrationWindows
 * @returns {{start:number, end:number}[]}
 */
export function mergeDuckWindows(narrationWindows) {
  const sorted = (narrationWindows || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start - last.end < HOLD_GAP_SEC) {
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
  const windows = mergeDuckWindows(narrationWindows);
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

/** Linear gain per `stepSec` sample: 1 outside the windows, `floor` inside, linear ramps on both sides (min over windows). */
function gainEnvelope(windows, { duckDb, rampSec, durationSec, stepSec }) {
  const n = Math.ceil(durationSec / stepSec);
  const gain = new Float64Array(n).fill(1);
  const floor = dbToLinear(duckDb);
  for (const { start, end } of windows) {
    const from = Math.max(0, Math.floor((start - rampSec) / stepSec));
    const to = Math.min(n - 1, Math.ceil((end + rampSec) / stepSec));
    for (let i = from; i <= to; i++) {
      const t = i * stepSec;
      const g = t < start ? 1 - (1 - floor) * Math.min(1, (t - (start - rampSec)) / rampSec) : t <= end ? floor : floor + (1 - floor) * Math.min(1, (t - end) / rampSec);
      if (g < gain[i]) gain[i] = g;
    }
  }
  return gain;
}

const toDb = (g) => 20 * Math.log10(Math.max(g, 1e-6));

/**
 * What the bed is lowered by when the page's own duck (already inside the
 * picture's bed, against the base lines) and the dub's duck (against the
 * dubbed lines) stack: the product of both gain envelopes, as facts.
 * @param {{pageWindows:{start:number,end:number}[], dubWindows:{start:number,end:number}[], durationSec:number,
 *   pageDb?:number, pageRampSec?:number, dubDb?:number, dubRampSec?:number, stepSec?:number}} o
 * @returns {{pageDb:number, dubDb:number, deepestDb:number, deepestAtSec:number, stackedSec:number, pageOnlyDeepestDb:number}}
 *   deepestDb: the largest combined drop below unity (negative); stackedSec: time where the combined drop is
 *   more than 0.5 dB deeper than the page's own duck at that moment.
 */
export function measureDuckSwing({ pageWindows, dubWindows, durationSec, pageDb = PAGE_DUCK_DB_DEFAULT, pageRampSec = PAGE_DUCK_RAMP_SEC, dubDb = DEFAULT_DUCK_DB, dubRampSec = DEFAULT_RAMP_SEC, stepSec = 0.01 }) {
  const page = gainEnvelope(pageWindows || [], { duckDb: pageDb, rampSec: pageRampSec, durationSec, stepSec });
  const dub = gainEnvelope(mergeDuckWindows(dubWindows), { duckDb: dubDb, rampSec: dubRampSec, durationSec, stepSec });
  let deepest = 1;
  let deepestAt = 0;
  let pageDeepest = 1;
  let stacked = 0;
  for (let i = 0; i < page.length; i++) {
    const g = page[i] * dub[i];
    if (g < deepest) {
      deepest = g;
      deepestAt = i * stepSec;
    }
    if (page[i] < pageDeepest) pageDeepest = page[i];
    if (toDb(g) < toDb(page[i]) - 0.5) stacked += stepSec;
  }
  return { pageDb, dubDb, deepestDb: toDb(deepest), deepestAtSec: deepestAt, stackedSec: stacked, pageOnlyDeepestDb: toDb(pageDeepest) };
}

/** The line dub.mjs prints for measureDuckSwing (facts; the model judges whether the bed sounds too low). */
export function formatDuckSwingReport(r) {
  return (
    `bed duck: dub ${r.dubDb} dB on top of the page's own duck (assumed ${r.pageDb} dB against the base lines); ` +
    `deepest combined drop ${r.deepestDb.toFixed(1)} dB at ${r.deepestAtSec.toFixed(2)}s, ${r.stackedSec.toFixed(1)}s of the film ducked deeper than the page's duck alone\n`
  );
}

export const DUCK_DB_DEFAULT = DEFAULT_DUCK_DB;
export const DUCK_RAMP_SEC_DEFAULT = DEFAULT_RAMP_SEC;
