// One freeze method for the page check (render time, frames by seek) and the
// file check (one decode, frames streamed in order). Coarse to fine: every
// 0.1 s compare a frame with the very next frame; only a run of unchanged
// samples long enough to hide a freeze is re-checked at every frame, +-1 s.
// Pure: frames are greyscale byte arrays of one size; no I/O here.

/** 0-255 grey delta above which a pixel counts as changed. */
export const CHANGE_THRESHOLD = 6;
/** A frame pair is unchanged when under this share of pixels changed (0.2 %). */
export const FREEZE_FRACTION = 0.002;
/** Shortest unchanged span reported as a freeze. */
export const FREEZE_MIN_SEC = 0.8;
/** Sparse sampling interval. */
export const FREEZE_STEP_SEC = 0.1;
/** Dense re-check margin on each side of a suspect run. */
export const FREEZE_RECHECK_SEC = 1;
/** Width of the greyscale frames both checks read: at 64 px a slow push-in changes under 0.2 % of pixels and read as frozen. */
export const FREEZE_SCAN_WIDTH = 320;

// Float slack for "duration >= 0.8 s" when the duration is n / fps.
const EPS = 1e-9;

/** Fraction of pixels (0-1) that changed by more than CHANGE_THRESHOLD. */
export function changedFraction(a, b) {
  let changed = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > CHANGE_THRESHOLD) changed++;
  }
  return n ? changed / n : 0;
}

/** True when two grey frames differ in under FREEZE_FRACTION of their pixels. */
export function isUnchanged(a, b) {
  return changedFraction(a, b) < FREEZE_FRACTION;
}

/** Scan frame size for a picture: at most `maxWidth` wide, even height, aspect kept (page and ffmpeg use the same numbers). */
export function scanSize(width, height, maxWidth = FREEZE_SCAN_WIDTH) {
  const w = Math.min(maxWidth, width);
  const h = Math.max(2, Math.round((w * height) / width / 2) * 2);
  return { w, h };
}

/** Successive sample pair indices round(k * step * fps), skipping repeats (a rate under 1/step samples every frame). */
export function sampleClock(fps, stepSec = FREEZE_STEP_SEC) {
  let k = 0;
  let last = -1;
  return () => {
    let f;
    do f = Math.round(k++ * stepSec * fps); while (f <= last);
    last = f;
    return f;
  };
}

/** Changed samples at pairs p and q leave pairs p+1..q-1 free to freeze: true when that span reaches `minSec`. */
export function couldFreeze(prevChanged, nextChanged, fps, minSec = FREEZE_MIN_SEC) {
  return (nextChanged - prevChanged - 1) / fps >= minSec - EPS;
}

/** Pair range [from, to) re-checked at every frame around suspect samples first..last; `to` may pass the last pair (callers clamp). */
export function recheckSpan(first, last, fps, recheckSec = FREEZE_RECHECK_SEC) {
  const pad = Math.round(recheckSec * fps);
  return { from: Math.max(0, first - pad), to: last + 1 + pad };
}

/**
 * Freeze runs in dense pair flags: flags[j] is pair base+j (frame base+j vs the next) unchanged.
 * A run of n unchanged pairs from pair i starts at i/fps and lasts n/fps.
 * @returns {{startSec:number, durationSec:number}[]}
 */
export function runsFromPairFlags(flags, base, fps, minSec = FREEZE_MIN_SEC) {
  const runs = [];
  let start = -1;
  for (let j = 0; j <= flags.length; j++) {
    if (j < flags.length && flags[j]) {
      if (start < 0) start = j;
      continue;
    }
    if (start >= 0 && (j - start) / fps >= minSec - EPS) runs.push({ startSec: (base + start) / fps, durationSec: (j - start) / fps });
    start = -1;
  }
  return runs;
}

/**
 * Suspect runs among sparse samples: consecutive unchanged samples whose
 * flanking changed samples leave room for a freeze.
 * @param {number[]} pairs sampled pair indices, ascending
 * @param {boolean[]} unchanged one flag per sample
 * @param {number} pairCount frame count - 1
 * @returns {{first:number, last:number}[]}
 */
export function suspectRuns(pairs, unchanged, pairCount, fps, minSec = FREEZE_MIN_SEC) {
  const out = [];
  let a = -1;
  for (let i = 0; i <= pairs.length; i++) {
    if (i < pairs.length && unchanged[i]) {
      if (a < 0) a = i;
      continue;
    }
    if (a >= 0) {
      const prev = a > 0 ? pairs[a - 1] : -1;
      const next = i < pairs.length ? pairs[i] : pairCount;
      if (couldFreeze(prev, next, fps, minSec)) out.push({ first: pairs[a], last: pairs[i - 1] });
    }
    a = -1;
  }
  return out;
}

/** Join ascending [from, to) spans that touch or overlap. */
function mergeSpans(spans) {
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** Pair comparer over an async frame getter that keeps the last two frames, so neighbouring pairs fetch each frame once. */
function pairComparer(getFrame) {
  const cache = new Map();
  const frame = async (i) => {
    if (!cache.has(i)) {
      if (cache.size >= 2) cache.delete(cache.keys().next().value);
      cache.set(i, await getFrame(i));
    }
    return cache.get(i);
  };
  return async (p) => isUnchanged(await frame(p), await frame(p + 1));
}

/**
 * The freeze method over random-access frames (the page seeks to each one).
 * @param {(index:number) => Promise<Uint8Array>|Uint8Array} getFrame grey frame `index` (time index / fps)
 * @param {{frameCount:number, fps:number, stepSec?:number, minSec?:number, recheckSec?:number}} opts
 * @returns {Promise<{runs:{startSec:number,durationSec:number}[], sampleTimes:number[], recheckSpans:{fromSec:number,toSec:number}[]}>}
 */
export async function scanFreezes(getFrame, { frameCount, fps, stepSec = FREEZE_STEP_SEC, minSec = FREEZE_MIN_SEC, recheckSec = FREEZE_RECHECK_SEC }) {
  const pairCount = Math.max(0, frameCount - 1);
  const unchangedAt = pairComparer(getFrame);
  const next = sampleClock(fps, stepSec);
  const pairs = [];
  for (let p = next(); p < pairCount; p = next()) pairs.push(p);
  const flags = [];
  for (const p of pairs) flags.push(await unchangedAt(p));
  const spans = mergeSpans(suspectRuns(pairs, flags, pairCount, fps, minSec)
    .map((r) => recheckSpan(r.first, r.last, fps, recheckSec))
    .map((s) => ({ from: s.from, to: Math.min(s.to, pairCount) })));
  const runs = [];
  for (const s of spans) {
    const dense = [];
    for (let p = s.from; p < s.to; p++) dense.push(await unchangedAt(p));
    runs.push(...runsFromPairFlags(dense, s.from, fps, minSec));
  }
  return { runs, sampleTimes: pairs.map((p) => p / fps), recheckSpans: spans.map((s) => spanSec(s, fps)) };
}

function spanSec(s, fps) {
  return { fromSec: s.from / fps, toSec: (s.to + 1) / fps };
}

/** Ring of the last `size` frames by index: holds the 1 s look-back a suspect run needs, never the whole film. */
function frameRing(size) {
  const slots = new Array(size);
  return {
    put: (i, f) => (slots[i % size] = f),
    get: (i) => slots[i % size],
  };
}

/**
 * The same freeze method over frames that arrive once, in order (one decode
 * of a file). Memory: the last recheckSec * fps + 2 frames, plus one flag per
 * frame of an open re-check span.
 * @param {{fps:number, stepSec?:number, minSec?:number, recheckSec?:number}} opts
 * @returns {{push:(frame:Uint8Array)=>void, finish:()=>{runs:{startSec:number,durationSec:number}[], sampleCount:number, recheckSpans:{fromSec:number,toSec:number}[]}}}
 */
export function createFreezeStream({ fps, stepSec = FREEZE_STEP_SEC, minSec = FREEZE_MIN_SEC, recheckSec = FREEZE_RECHECK_SEC }) {
  const pad = Math.round(recheckSec * fps);
  const ring = frameRing(pad + 2);
  const nextSample = sampleClock(fps, stepSec);
  const s = { index: -1, sample: nextSample(), sampleCount: 0, lastChanged: -1, open: null, win: null, runs: [], spans: [] };
  const unchangedAt = (p) => isUnchanged(ring.get(p), ring.get(p + 1));

  function fill(upTo) {
    while (s.win && s.win.from + s.win.flags.length <= upTo) s.win.flags.push(unchangedAt(s.win.from + s.win.flags.length));
  }
  function onSample(p, unchanged) {
    s.sampleCount++;
    if (!unchanged) {
      closeRun(p);
      return;
    }
    if (s.open) {
      s.open.last = p;
      return;
    }
    s.open = { first: p, last: p, prev: s.lastChanged };
    // A window still in its tail keeps its start, so overlapping re-checks never read a frame twice.
    if (s.win) s.win.until = Infinity;
    else s.win = { from: recheckSpan(p, p, fps, recheckSec).from, flags: [], until: Infinity, tail: -1 };
  }
  function closeRun(p) {
    s.lastChanged = p;
    if (!s.open) return;
    const r = s.open;
    s.open = null;
    if (couldFreeze(r.prev, p, fps, minSec)) s.win.tail = Math.max(s.win.tail, recheckSpan(r.first, r.last, fps, recheckSec).to);
    // A run too short to hide a freeze needs no re-check: its flags are dropped unless an earlier suspect's tail still runs.
    if (s.win.tail < 0) s.win = null;
    else s.win.until = s.win.tail;
  }
  function settle(pairCount) {
    const w = s.win;
    if (!w || (pairCount === undefined && w.from + w.flags.length < w.until)) return;
    const to = Math.min(w.from + w.flags.length, w.until);
    s.runs.push(...runsFromPairFlags(w.flags.slice(0, to - w.from), w.from, fps, minSec));
    s.spans.push(spanSec({ from: w.from, to }, fps));
    s.win = null;
  }

  return {
    push(frame) {
      ring.put(++s.index, frame);
      const p = s.index - 1;
      if (p < 0) return;
      if (p === s.sample) {
        onSample(p, unchangedAt(p));
        s.sample = nextSample();
      }
      fill(p);
      settle();
    },
    finish() {
      const pairCount = Math.max(0, s.index);
      if (s.open) closeRun(pairCount);
      if (s.win && s.win.tail >= 0) settle(pairCount);
      return { runs: s.runs, sampleCount: s.sampleCount, recheckSpans: s.spans };
    },
  };
}
