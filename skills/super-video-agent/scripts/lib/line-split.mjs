// Cutting one synthesized request into per-line clips, and giving every clip the same quiet tail.
// Pure functions over Float32 mono samples and an engine's character times, so the rules are
// unit-tested without audio files. Used by voice/elevenlabs.mjs (references/voice.md
// "ElevenLabs: one request, cut per line").

export const TAIL_SEC = 0.3;
const WIN_SEC = 0.02;
const REL_DB = -30;
const GAP_SEC = 0.2;
const BURST_SEC = 0.3;
const HEAD_KEEP_SEC = 0.1;
const END_PUNCT = /[.,!?…。、！？]/;

/**
 * Index range [first, last] of the sounding characters of `chars[from, to)`: whitespace and
 * characters inside a silent `[tag]` (a pause) are skipped at both ends, and end punctuation at
 * the end, because the engine times the silence after a sentence as the length of its full stop.
 * Other tags stay inside the range: a `[laughs]` or `[sighs]` is sound.
 * @param {string} chars the request text as the engine echoed it
 * @param {number} from
 * @param {number} to
 * @param {Set<number>} silentChars indexes inside silent `[tag]` spans
 * @returns {[number, number]|null}
 */
export function spokenRange(chars, from, to, silentChars) {
  const skip = (i) => /\s/.test(chars[i]) || silentChars.has(i);
  let first = from;
  while (first < to && skip(first)) first++;
  let last = to - 1;
  while (last > first && (skip(last) || END_PUNCT.test(chars[last]))) last--;
  return first < to ? [first, last] : null;
}

/**
 * Where to cut each line out of the whole request: midway through the silence between one line's
 * last spoken character and the next line's first, starting at most HEAD_KEEP_SEC before the line.
 * @param {{start:number, end:number}[]} edges spoken start/end of each line, in order
 * @param {number} totalSec length of the whole request's audio
 * @returns {{from:number, to:number}[]}
 */
export function cutSpans(edges, totalSec) {
  let prevCut = 0;
  return edges.map((e, i) => {
    const next = edges[i + 1];
    const to = next ? (e.end + next.start) / 2 : totalSec;
    const span = { from: Math.max(prevCut, e.start - HEAD_KEEP_SEC), to };
    prevCut = to;
    return span;
  });
}

function windowLoud(samples, sr) {
  const w = Math.max(1, Math.round(sr * WIN_SEC));
  const rms = [];
  for (let s = 0; s + w <= samples.length; s += w) {
    let e = 0;
    for (let i = s; i < s + w; i++) e += samples[i] * samples[i];
    rms.push(Math.sqrt(e / w));
  }
  const peak = Math.max(0, ...rms);
  const floor = peak * 10 ** (REL_DB / 20);
  return { loud: rms.map((r) => r > floor), w };
}

/**
 * Sample index where speech ends: the last window within 30 dB of the clip's loudest window, so
 * breath and room tone after it do not count. A short burst (≤ BURST_SEC) after a quiet gap
 * (≥ GAP_SEC) at the very end is noise, not the line's last sound, and is left out.
 * @param {Float32Array} samples
 * @param {number} sr
 */
export function speechEnd(samples, sr) {
  const { loud, w } = windowLoud(samples, sr);
  const gapWin = Math.round(GAP_SEC / WIN_SEC), burstWin = Math.round(BURST_SEC / WIN_SEC);
  let end = loud.lastIndexOf(true) + 1;
  while (end > 0) {
    let start = end;
    while (start > 0 && loud[start - 1]) start--;
    let gap = 0;
    while (start - gap > 0 && !loud[start - gap - 1]) gap++;
    if (end - start <= burstWin && gap >= gapWin && start - gap > 0) end = start - gap;
    else break;
  }
  return end * w;
}

/**
 * The clip up to where speech ends, then exactly `tailSec` of silence. `cut` is true when the
 * speech still sounds in the clip's last window — the engine stopped mid-sound. `minEnd` (a
 * sample index, from the engine's own timing of the last character) keeps a short last word
 * after a pause from being mistaken for a noise burst.
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {number} [tailSec]
 * @param {number} [minEnd]
 * @returns {{samples:Float32Array, cut:boolean}}
 */
export function withQuietTail(samples, sr, tailSec = TAIL_SEC, minEnd = 0) {
  const end = Math.min(samples.length, Math.max(speechEnd(samples, sr), Math.round(minEnd)));
  const out = new Float32Array(end + Math.round(sr * tailSec));
  out.set(samples.subarray(0, end));
  return { samples: out, cut: samples.length - end < Math.round(sr * WIN_SEC) };
}
