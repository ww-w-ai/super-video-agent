// Blink analysis from an eye-closure series (0 open .. 1 closed) per character. Pure: the series
// come from the page hook window.__reel.blink(t), from a GLB clip's morph-weight keyframes
// (glb-clip-tracks.mjs), or from keyframe arrays found in the source (source-review.mjs).
// Report only: thresholds are named constants, nothing here fails a reel.

/** A blink starts when closure rises past this (0 open .. 1 closed) and ends when it falls back under it. */
export const OPEN_LEVEL = 0.1;
/** A closure that never reaches this is a flutter of the lid, not a blink, and is not counted. */
export const BLINK_PEAK_MIN = 0.5;
/** Shortest human blink, start to end: ~100 ms (a blink lasts ~100–400 ms; Kwon et al. 2013, Schiffman 2001). */
export const MIN_BLINK_SEC = 0.1;
/** Shortest usual gap between blinks, start to start. Humans blink about every 2–10 s (~15–20 per minute at rest); under 1.5 s reads as nervous. */
export const MIN_INTERVAL_SEC = 1.5;
/** This many blinks inside FLUTTER_WINDOW_SEC is a flutter. */
export const FLUTTER_COUNT = 3;
export const FLUTTER_WINDOW_SEC = 1.0;

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Time where the line from (t0,v0) to (t1,v1) crosses `level`. */
function cross(t0, v0, t1, v1, level) {
  if (v1 === v0) return t1;
  return t0 + ((level - v0) / (v1 - v0)) * (t1 - t0);
}

/**
 * Blinks in one series. A blink is a run above OPEN_LEVEL whose peak reaches BLINK_PEAK_MIN;
 * start and end are the interpolated crossings of OPEN_LEVEL, closing runs start to peak, opening
 * peak to end. A series that begins or ends inside a run reports that blink with the sampled edge.
 * @param {{t:number, v:number}[]} series in time order
 */
export function findBlinks(series) {
  const blinks = [];
  let i = 0;
  while (i < series.length) {
    if (series[i].v <= OPEN_LEVEL) { i++; continue; }
    let j = i;
    while (j < series.length && series[j].v > OPEN_LEVEL) j++;
    // run = series[i..j-1]
    const start = i > 0 ? cross(series[i - 1].t, series[i - 1].v, series[i].t, series[i].v, OPEN_LEVEL) : series[i].t;
    const end = j < series.length ? cross(series[j - 1].t, series[j - 1].v, series[j].t, series[j].v, OPEN_LEVEL) : series[j - 1].t;
    let peak = series[i];
    let heldFrom = null, heldTo = null;
    for (let k = i; k < j; k++) {
      if (series[k].v > peak.v) peak = series[k];
      if (series[k].v >= BLINK_PEAK_MIN) { heldFrom ??= series[k].t; heldTo = series[k].t; }
    }
    if (peak.v >= BLINK_PEAK_MIN) {
      blinks.push({ start: r3(start), peakAt: r3(peak.t), peak: r3(peak.v), end: r3(end),
        closeSec: r3(peak.t - start), openSec: r3(end - peak.t), totalSec: r3(end - start), heldSec: r3(heldTo - heldFrom) });
    }
    i = j;
  }
  return blinks;
}

/**
 * Flags for a character's blinks: fast (total under MIN_BLINK_SEC), close (start-to-start gap
 * under MIN_INTERVAL_SEC), flutter (FLUTTER_COUNT blinks within FLUTTER_WINDOW_SEC).
 * @returns {{count:number, blinks:object[], intervals:number[], flags:{type:string, at:number, detail:string}[]}}
 */
export function analyzeBlinks(series) {
  const blinks = findBlinks(series);
  const intervals = blinks.slice(1).map((b, k) => r3(b.start - blinks[k].start));
  const flags = [];
  blinks.forEach((b) => {
    if (b.totalSec < MIN_BLINK_SEC) {
      flags.push({ type: "fast-blink", at: b.start, detail: `closes and opens in ${Math.round(b.totalSec * 1000)} ms (close ${Math.round(b.closeSec * 1000)}, open ${Math.round(b.openSec * 1000)}); a human blink takes at least ~${Math.round(MIN_BLINK_SEC * 1000)} ms` });
    }
  });
  intervals.forEach((gap, k) => {
    if (gap < MIN_INTERVAL_SEC) {
      flags.push({ type: "close-blinks", at: blinks[k + 1].start, detail: `${gap.toFixed(3)} s after the previous blink; people blink about every 2–10 s, under ${MIN_INTERVAL_SEC} s apart is frequent` });
    }
  });
  for (let k = 0; k + FLUTTER_COUNT - 1 < blinks.length; k++) {
    const span = blinks[k + FLUTTER_COUNT - 1].start - blinks[k].start;
    if (span <= FLUTTER_WINDOW_SEC) {
      flags.push({ type: "flutter", at: blinks[k].start, detail: `${FLUTTER_COUNT} blinks within ${span.toFixed(3)} s` });
    }
  }
  flags.sort((a, b) => a.at - b.at);
  return { count: blinks.length, blinks, intervals, flags };
}

/** Per-character result for {character: series}. */
export function analyzeAll(seriesByCharacter) {
  const out = {};
  for (const [name, series] of Object.entries(seriesByCharacter)) out[name] = analyzeBlinks(series);
  return out;
}

/** Printable report: per character, count, intervals, the slowest and fastest blink, and every flag. */
export function formatBlinks(byCharacter) {
  const names = Object.keys(byCharacter).sort();
  if (!names.length) return "no eye-closure series to read\n";
  let s = "";
  for (const n of names) {
    const r = byCharacter[n];
    const dur = r.blinks.map((b) => b.totalSec);
    const range = dur.length ? `, blink ${Math.round(Math.min(...dur) * 1000)}–${Math.round(Math.max(...dur) * 1000)} ms` : "";
    const gaps = r.intervals.length ? `, gaps ${Math.min(...r.intervals).toFixed(2)}–${Math.max(...r.intervals).toFixed(2)} s` : "";
    s += `${n}: ${r.count} blink${r.count === 1 ? "" : "s"}${range}${gaps}\n`;
    for (const f of r.flags) s += `  ${f.at.toFixed(3)} s ${f.type}: ${f.detail}\n`;
  }
  return s;
}
