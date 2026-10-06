// Determinism probe (design.md §2.1, §2.4): seek(t) must be independent of
// seek history. Build a list of probe times (shot boundaries + boil bucket
// edges + spread samples), capture pixel hashes in order and shuffled, and
// compare.
import crypto from "node:crypto";

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Reads a `<t0>-<t1>` seconds value (verify.mjs / state-checks.mjs --range).
 * Throws unless both are numbers and t1 > t0.
 * @param {string|boolean|undefined} value
 * @returns {{from: number, to: number}}
 */
export function parseTimeRange(value) {
  const m = typeof value === "string" ? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(value) : null;
  const from = m ? Number(m[1]) : NaN;
  const to = m ? Number(m[2]) : NaN;
  if (!m || !(to > from)) throw new Error(`--range takes <t0>-<t1> seconds with t1 > t0, e.g. --range 42-61.5 (got "${value}")`);
  return { from, to };
}

/**
 * Build >=12 probe times covering shot boundaries and boil-bucket edges.
 * @param {{start:number,end:number,readAt:number}[]} shots
 * @param {number} duration
 * @param {number} boilHz
 * @param {{from:number,to:number}[]|null} [windows] probe only inside these
 *   time windows (verify.mjs --range / --world); null = the whole film.
 */
export function buildProbeTimes(shots, duration, boilHz = 8, windows = null) {
  const spans = windows && windows.length ? windows : [{ from: 0, to: duration }];
  const inside = (t) => t >= 0 && t <= duration && spans.some((w) => t >= w.from && t <= w.to);
  const times = new Set();
  const add = (t) => {
    const r = round(t);
    if (inside(r)) times.add(r);
  };
  for (const s of shots) {
    add(s.start);
    add(s.readAt);
    add(Math.max(s.start, s.end - 1 / 60));
  }
  // boil bucket edges: t just after n/hz for several n across each span
  const step = 1 / boilHz;
  for (const w of spans) {
    const first = Math.floor(w.from / step);
    const bucketCount = Math.max(1, Math.floor((w.to - w.from) / step));
    const sampleEvery = Math.max(1, Math.floor(bucketCount / 8));
    for (let n = 0; n < bucketCount; n += sampleEvery) add((first + n) * step + step / 2);
  }
  // even spread fallback to guarantee >= 12
  const total = spans.reduce((s, w) => s + (w.to - w.from), 0);
  for (let i = 0; i < 12 && times.size < 12; i++) add(timeAtFraction(spans, (total * i) / 12));
  return Array.from(times).sort((a, b) => a - b);
}

// The time `offset` seconds into the spans laid end to end.
function timeAtFraction(spans, offset) {
  let left = offset;
  for (const w of spans) {
    const len = w.to - w.from;
    if (left <= len) return w.from + left;
    left -= len;
  }
  return spans[spans.length - 1].to;
}

function round(t) {
  return Math.round(t * 1000) / 1000;
}

/** Fisher-Yates shuffle seeded by a fixed constant (deterministic test order). */
export function deterministicShuffle(arr, seedStr = "sva-verify") {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
