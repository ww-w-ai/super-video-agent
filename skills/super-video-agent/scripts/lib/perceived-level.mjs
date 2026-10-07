// Perceived level of a clip, for judging its edges the way a listener hears them.
//
// K-weighting and the level formula are ITU-R BS.1770-4 (the loudness measure behind EBU R128): a
// high-shelf (+4 dB above about 2 kHz, the head's acoustic effect) and a high-pass at 38 Hz (the
// RLB weighting), which together follow the ear's sensitivity at speech levels (the equal-loudness
// contours of ISO 226: the ear needs far more level at low frequencies, so a rumble that a raw
// sample reading counts as loud is not heard). Level = -0.691 + 10 log10(mean square of the
// weighted signal), in LUFS for a mono signal; the standard measures 400 ms blocks and gates at
// -70 LUFS (absolute) and 10 LU under the average (relative). Edges last milliseconds, so the short
// windows here (5 ms) keep the weighting and the formula and drop the block length: they are
// short-window levels in the same unit, not BS.1770 loudness values.
//
// Audible floor, the one assumption not taken from a standard: speech is played at about 65-70 dB SPL
// (a -16 LUFS master) and a quiet room's noise is about 30-35 dBA, so a sound more than
// AUDIBLE_BELOW_LINE_LU under the line's own loudness is below the room's noise; ABSOLUTE_FLOOR_LUFS
// is the same limit for a line that is itself very quiet. A mix around the line masks more: the caller
// can raise the floor to the level of what plays under it (`maskLufs`).

export const AUDIBLE_BELOW_LINE_LU = 35;
export const ABSOLUTE_FLOOR_LUFS = -65;
export const SHORT_WINDOW_SEC = 0.005;

const LUFS_OFFSET = -0.691;

/** Biquad coefficients of one BS.1770-4 stage for any sample rate (the standard's analog design, bilinear transform). */
function stageShelf(rate) {
  const f0 = 1681.974450955533, gain = 3.999843853973347, q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return { b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
}

function stageHighpass(rate) {
  const f0 = 38.13547087602444, q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / rate);
  const a0 = 1 + k / q + k * k;
  return { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
}

function biquad(input, { b, a }) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

/**
 * The signal after BS.1770-4 K-weighting.
 * @param {Float32Array} samples mono
 * @param {number} rate
 * @returns {Float64Array}
 */
export function kWeight(samples, rate) {
  return biquad(biquad(samples, stageShelf(rate)), stageHighpass(rate));
}

/** Level in LUFS of the mean square of weighted samples [from, to). -120 for silence. */
export function levelLufs(weighted, from, to) {
  const n = Math.max(0, to - from);
  if (!n) return -120;
  let sum = 0;
  for (let i = from; i < to; i++) sum += weighted[i] * weighted[i];
  const ms = sum / n;
  return ms > 0 ? Math.max(-120, LUFS_OFFSET + 10 * Math.log10(ms)) : -120;
}

/**
 * Short-window levels (LUFS, one per non-overlapping window) of weighted samples.
 * @returns {{levels:Float64Array, win:number}}
 */
export function shortLevels(weighted, rate, winSec = SHORT_WINDOW_SEC) {
  const win = Math.max(1, Math.round(rate * winSec));
  const n = Math.floor(weighted.length / win);
  const levels = new Float64Array(n);
  for (let w = 0; w < n; w++) levels[w] = levelLufs(weighted, w * win, (w + 1) * win);
  return { levels, win };
}

/**
 * The loudness of a line's own sound over weighted samples [from, to): 100 ms blocks, gated as
 * BS.1770 gates (blocks under -70 LUFS dropped, then blocks more than 10 LU under the remaining average).
 */
export function lineLoudness(weighted, rate, from = 0, to = weighted.length) {
  const block = Math.max(1, Math.round(rate * 0.1));
  const blocks = [];
  for (let s = from; s + block <= to; s += block) blocks.push(levelLufs(weighted, s, s + block));
  if (!blocks.length) return levelLufs(weighted, from, to);
  const mean = (xs) => LUFS_OFFSET + 10 * Math.log10(xs.reduce((a, l) => a + 10 ** ((l - LUFS_OFFSET) / 10), 0) / xs.length);
  const above = blocks.filter((l) => l > -70);
  if (!above.length) return -120;
  const kept = above.filter((l) => l > mean(above) - 10);
  return mean(kept.length ? kept : above);
}

/**
 * The level (LUFS) under which a sound is not heard: AUDIBLE_BELOW_LINE_LU under the line's own
 * loudness, never lower than ABSOLUTE_FLOOR_LUFS, and never lower than what plays under it (`maskLufs`).
 */
export function audibleFloorLufs(lineLufs, maskLufs = -Infinity) {
  return Math.max(ABSOLUTE_FLOOR_LUFS, lineLufs - AUDIBLE_BELOW_LINE_LU, maskLufs);
}

// What a listener hears at a clip's edges, judged on the weighted levels above. Thresholds were set on
// the 144 lines of one finished film whose owner named the places that sounded cut or abrupt: the
// sound at those places stopped (or started) within 5 LU (or 15 LU) of the line's own loudness, while a
// natural release dies away well under it.

/** A sound counts as audible at the edge when it is this far over the floor (keeps filter ringing and room tone out). */
export const AUDIBLE_BAND_LU = 10;
/** A line is cut when the last 20 ms before its sound stops were within this many LU of the line's own loudness. */
export const TAIL_CUT_BELOW_LINE_LU = 5;
/** A start is abrupt when sound within this many LU of the line's loudness is audible in the first HEAD_WITHIN_WINDOWS windows. */
export const HEAD_ABRUPT_BELOW_LINE_LU = 15;
export const HEAD_WITHIN_WINDOWS = 3;
const LOOKBACK_WINDOWS = 4;

const round1 = (x) => Math.round(x * 10) / 10;

function loudestOf(levels, from, to) {
  let m = -Infinity;
  for (let i = Math.max(0, from); i < Math.min(levels.length, to); i++) m = Math.max(m, levels[i]);
  return m;
}

function headAudibility(levels, band, lineLufs) {
  const first = levels.findIndex((l) => l >= band);
  if (first < 0) return { audibleAtSec: null, relLine: null, abrupt: false };
  const relLine = loudestOf(levels, first, first + LOOKBACK_WINDOWS) - lineLufs;
  return { audibleAtSec: first * SHORT_WINDOW_SEC, relLine: round1(relLine), abrupt: first < HEAD_WITHIN_WINDOWS && relLine > -HEAD_ABRUPT_BELOW_LINE_LU };
}

function tailAudibility(levels, band, lineLufs) {
  let last = levels.length - 1;
  while (last >= 0 && levels[last] < band) last--;
  if (last < 0) return { audibleUntilSec: null, relLine: null, cut: false };
  const relLine = loudestOf(levels, last - LOOKBACK_WINDOWS + 1, last + 1) - lineLufs;
  return { audibleUntilSec: (last + 1) * SHORT_WINDOW_SEC, relLine: round1(relLine), cut: relLine > -TAIL_CUT_BELOW_LINE_LU };
}

/**
 * Whether a clip's start or end can be heard as abrupt or cut, by perceived level (see above).
 * `headMaskLufs` / `tailMaskLufs` raise the floor at that edge to the level of what plays under it.
 * @param {Float32Array} samples mono
 * @param {number} rate
 * @param {{headMaskLufs?:number, tailMaskLufs?:number}} [mask]
 * @returns {{lineLufs:number, head:{audibleAtSec:number|null, relLine:number|null, abrupt:boolean}, tail:{audibleUntilSec:number|null, relLine:number|null, cut:boolean}}|null} null for a silent clip
 */
export function edgeAudibility(samples, rate, { headMaskLufs = -Infinity, tailMaskLufs = -Infinity } = {}) {
  const weighted = kWeight(samples, rate);
  const lineLufs = lineLoudness(weighted, rate);
  if (lineLufs <= -120) return null;
  const { levels } = shortLevels(weighted, rate);
  const bandAt = (mask) => audibleFloorLufs(lineLufs, mask) + AUDIBLE_BAND_LU;
  return { lineLufs: round1(lineLufs), head: headAudibility(levels, bandAt(headMaskLufs), lineLufs), tail: tailAudibility(levels, bandAt(tailMaskLufs), lineLufs) };
}
