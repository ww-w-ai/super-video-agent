// Cutting one synthesized request into per-line clips. A line is cut late, not tight: it keeps its whole
// natural decay and some room tone after the last word (the film leaves about 0.5 s after a line anyway),
// ends with a gentle fade-out, starts a little before its first word with a soft fade-in, never begins
// with the previous line's tail, and gets the same quiet tail. Where the decay ends is judged by perceived
// level (perceived-level.mjs), not by raw sample values. Pure functions over Float32 mono samples and an
// engine's character times, so the rules are unit-tested without audio files. Used by voice/elevenlabs.mjs,
// voice/typecast.mjs and voice/fish.mjs (references/voice.md "One read per voice, cut per line").
import { kWeight, shortLevels, lineLoudness, audibleFloorLufs, SHORT_WINDOW_SEC } from "./perceived-level.mjs";

export const TAIL_SEC = 0.3;
const WIN_SEC = 0.02;
const REL_DB = -30;
const GAP_SEC = 0.2;
const BURST_SEC = 0.3;
const DECAY_SETTLE_SEC = 0.01;

/**
 * The cut margins, in seconds; `cutOptions` arguments override any of them.
 *  headKeepSec  a clip starts this long before its line's first word (never before the previous clip's cut)
 *  minTailSec   a clip ends at least this long after its line's last word, when the gap to the next line allows
 *  maxTailSec   and at most this long after it (room tone above the floor never settles)
 *  guardSec     a clip stops this long before the next line's first word
 *  fadeInSec / fadeOutSec  the fades at the head and at the cut
 */
export const DEFAULT_CUT = Object.freeze({ headKeepSec: 0.1, minTailSec: 0.2, maxTailSec: 0.6, guardSec: 0.02, fadeInSec: 0.02, fadeOutSec: 0.03 });
export const FADE_IN_SEC = DEFAULT_CUT.fadeInSec;
export const FADE_OUT_SEC = DEFAULT_CUT.fadeOutSec;
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
 * Where each line's clip may run: from `headKeepSec` before its speech (not before the previous
 * line's spoken end) to `guardSec` before the next line's speech, so a line's decay can use the
 * whole gap. withQuietTail ends the clip where the decay is over, plus the tail margin.
 * @param {{start:number, end:number}[]} edges spoken start/end of each line, in order
 * @param {number} totalSec length of the whole request's audio
 * @param {Partial<typeof DEFAULT_CUT>} [cutOptions]
 * @returns {{from:number, to:number}[]}
 */
export function cutSpans(edges, totalSec, cutOptions = {}) {
  const { headKeepSec, guardSec } = { ...DEFAULT_CUT, ...cutOptions };
  let prevEnd = 0;
  return edges.map((e, i) => {
    const next = edges[i + 1];
    const to = next ? Math.max(e.end, next.start - guardSec) : totalSec;
    const span = { from: Math.max(prevEnd, e.start - headKeepSec), to };
    prevEnd = e.end;
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
 * First sample at or after `from` where the perceived level (5 ms windows of the K-weighted signal)
 * stays under `floorLufs` for DECAY_SETTLE_SEC, or the end of the samples when it never does.
 * @param {Float64Array|Float32Array} weighted K-weighted samples (perceived-level.mjs kWeight)
 * @param {number} sr
 * @param {number} from sample index where speech ended
 * @param {number} floorLufs
 */
export function decayEnd(weighted, sr, from, floorLufs) {
  const { levels, win } = shortLevels(weighted, sr);
  const need = Math.max(1, Math.round(DECAY_SETTLE_SEC / SHORT_WINDOW_SEC));
  const first = Math.ceil(from / win);
  let quiet = 0;
  for (let w = first; w < levels.length; w++) {
    quiet = levels[w] < floorLufs ? quiet + 1 : 0;
    if (quiet >= need) return (w - need + 1) * win;
  }
  return weighted.length;
}

/** Linear fade in over the first `sec` of `samples`, in place. */
export function fadeIn(samples, sr, sec = FADE_IN_SEC) {
  const n = Math.min(samples.length, Math.round(sr * sec));
  for (let i = 0; i < n; i++) samples[i] *= i / n;
}

/** Linear fade to zero over the `sec` before sample `end`, in place. */
export function fadeOutAt(samples, sr, end, sec = FADE_OUT_SEC) {
  const n = Math.min(end, Math.round(sr * sec));
  for (let i = 0; i < n; i++) samples[end - 1 - i] *= i / n;
}

/**
 * The clip up to where its line has decayed, then exactly `tailSec` of silence. The cut is late: the
 * first point after the speech end where the perceived level stays under the audible floor (the line's
 * own loudness less AUDIBLE_BELOW_LINE_LU, perceived-level.mjs), but never earlier than `minTailSec`
 * after the speech end, never later than `maxTailSec` after it, and never past the end of `samples`
 * (the caller's limit: the next line's start). A gentle fade-out ends the kept part. `cut` is true when
 * the speech still sounds in the clip's last window — the engine stopped mid-sound. `minEnd` (a sample
 * index, from the engine's own timing of the last character) keeps a short last word after a pause from
 * being mistaken for a noise burst. `kept` is the number of source samples the clip keeps.
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {number} [tailSec]
 * @param {number} [minEnd]
 * @param {Partial<typeof DEFAULT_CUT>} [cutOptions]
 * @returns {{samples:Float32Array, cut:boolean, kept:number}}
 */
export function withQuietTail(samples, sr, tailSec = TAIL_SEC, minEnd = 0, cutOptions = {}) {
  const opts = { ...DEFAULT_CUT, ...cutOptions };
  const speech = Math.min(samples.length, Math.max(speechEnd(samples, sr), Math.round(minEnd)));
  const weighted = kWeight(samples, sr);
  const floor = audibleFloorLufs(lineLoudness(weighted, sr, 0, Math.max(1, speech)));
  const settled = decayEnd(weighted, sr, speech, floor);
  const lowest = speech + Math.round(sr * opts.minTailSec), highest = speech + Math.round(sr * opts.maxTailSec);
  const end = Math.min(samples.length, highest, Math.max(settled, lowest));
  const out = new Float32Array(end + Math.round(sr * tailSec));
  out.set(samples.subarray(0, end));
  fadeOutAt(out, sr, end, opts.fadeOutSec);
  return { samples: out, cut: samples.length - speech < Math.round(sr * WIN_SEC), kept: end };
}

// ---- One request for every line of a voice: where to cut it ----------------------------------
// Typecast returns word times, Fish returns none; both are cut into one clip per line by the
// functions below (references/voice.md "One read per voice, cut per line").

const MIN_GAP_SEC = 0.15;
const PLAUSIBLE_RATIO = [0.4, 2.5];

/**
 * A line in a joined request needs a sentence end, or the engine reads it into the next line
 * with no pause between them. A line that already ends in one (before any closing `[tag]`) is
 * sent as it is.
 * @param {string} text
 */
export function withSentenceEnd(text) {
  const bare = text.replace(/(?:\s*\[[^\]\n]*\])+\s*$/, "").trim();
  return /[.!?…。！？]["'”’」』)]*$/.test(bare) ? text : `${text}.`;
}

/**
 * Characters one item adds to a joined request: its text as sent (withSentenceEnd may add a full
 * stop) plus the joining space. Providers count this, not the raw text, against their limit.
 * @param {{text:string}} item
 */
export function sentLength(item) {
  return withSentenceEnd(item.text).length + 1;
}

/**
 * Groups of items whose joined text stays within `maxChars` (one request each); an item longer
 * than the limit is a group of its own. `measure` is the size an item adds to the request
 * (default: its text plus the joining space; pass sentLength to count the added punctuation).
 * @template {{text:string}} T
 * @param {T[]} items
 * @param {number} maxChars
 * @param {(item:T)=>number} [measure]
 * @returns {T[][]}
 */
export function groupByChars(items, maxChars, measure = (it) => it.text.length + 1) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    const n = measure(it);
    if (cur.length && size + n > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * A single line past the provider's request limit cannot be split by batching: throw naming it
 * before any request is sent. The length counted is what is sent (see sentLength), not the raw text.
 * @param {{id:string, text:string}[]} lines
 * @param {{limit:number, provider:string}} opts
 */
export function refuseOversize(lines, { limit, provider }) {
  for (const it of lines) {
    const sent = sentLength(it) - 1;
    if (sent <= limit) continue;
    throw new Error(`${provider}: line "${it.id}" is ${sent} characters as sent; one request takes at most ${limit}. Split the line in plan.json.`);
  }
}

const unspaced = (s) => String(s).replace(/\s+/g, "");

/**
 * The service's word times split back into lines. The words must spell the lines' text (spaces
 * ignored) and every line must end on a word boundary; otherwise null, and the caller cuts at
 * the silences instead.
 * @param {{text:string,start:number,end:number}[]|null|undefined} words clip-relative seconds
 * @param {string[]} texts the text sent for each line, in order
 * @returns {{text:string,start:number,end:number}[][]|null}
 */
export function wordsToLines(words, texts) {
  if (!Array.isArray(words)) return null;
  const spoken = words.filter((x) => unspaced(x.text ?? "") && Number.isFinite(x.start) && Number.isFinite(x.end));
  if (spoken.map((x) => unspaced(x.text)).join("") !== texts.map(unspaced).join("")) return null;
  const lines = [];
  let at = 0;
  for (const t of texts) {
    const want = unspaced(t).length;
    const own = [];
    let got = 0;
    while (got < want && at < spoken.length) {
      got += unspaced(spoken[at].text).length;
      own.push(spoken[at++]);
    }
    if (got !== want || !own.length) return null;
    lines.push(own);
  }
  return lines;
}

/**
 * Spoken start/end of each line from a request's audio alone: the `count - 1` longest silences
 * inside the speech are the breaks between lines. Null when the audio has fewer breaks than that.
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {number} count number of lines
 * @returns {{start:number, end:number}[]|null}
 */
export function silenceEdges(samples, sr, count) {
  if (count < 1) return null;
  const { loud, w } = windowLoud(samples, sr);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return null;
  const runs = [];
  for (let i = first; i <= last; ) {
    if (loud[i]) { i++; continue; }
    const s = i;
    while (!loud[i]) i++;
    runs.push({ s, e: i });
  }
  const minWin = Math.round(MIN_GAP_SEC / WIN_SEC);
  const long = runs.filter((r) => r.e - r.s >= minWin);
  if (long.length < count - 1) return null;
  const breaks = long.sort((a, b) => b.e - b.s - (a.e - a.s)).slice(0, count - 1).sort((a, b) => a.s - b.s);
  const edges = [];
  for (let k = 0; k < count; k++) {
    const s = k === 0 ? first : breaks[k - 1].e;
    const e = k === count - 1 ? last + 1 : breaks[k].s;
    edges.push({ start: (s * w) / sr, end: (e * w) / sr });
  }
  return edges;
}

/** True when no line's seconds per character is far from the median: a cut at a pause inside a line fails it. */
export function plausibleSplit(edges, texts) {
  if (edges.length < 3) return true;
  const rate = edges.map((e, k) => (e.end - e.start) / Math.max(1, unspaced(texts[k]).length));
  const median = [...rate].sort((a, b) => a - b)[Math.floor(rate.length / 2)];
  return rate.every((r) => r >= median * PLAUSIBLE_RATIO[0] && r <= median * PLAUSIBLE_RATIO[1]);
}

/**
 * How to cut one request's audio into one clip per line: by the service's word times when it
 * returned them and they map onto the lines, otherwise at the silences. Null when neither does.
 * @param {{samples:Float32Array, sr:number, texts:string[], words?:{text:string,start:number,end:number}[]|null}} a
 * @returns {{by:"timestamps"|"silence", edges:{start:number,end:number}[], spans:{from:number,to:number}[], lineWords:object[][]|null}|null}
 */
export function planCuts({ samples, sr, texts, words, cutOptions = {} }) {
  const total = samples.length / sr;
  const lineWords = wordsToLines(words, texts);
  if (lineWords) {
    const edges = lineWords.map((ws) => ({ start: ws[0].start, end: ws[ws.length - 1].end }));
    return { by: "timestamps", edges, spans: cutSpans(edges, total, cutOptions), lineWords };
  }
  const edges = silenceEdges(samples, sr, texts.length);
  if (!edges || !plausibleSplit(edges, texts)) return null;
  return { by: "silence", edges, spans: cutSpans(edges, total, cutOptions), lineWords: null };
}

/**
 * The per-line clips of one request, in order: each starts no earlier than the previous clip's
 * cut (so it never begins with that line's tail) and fades in; each ends as withQuietTail says.
 * `from` is where the clip starts in the request, in seconds.
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {{edges:{end:number}[], spans:{from:number,to:number}[]}} plan
 * @param {Partial<typeof DEFAULT_CUT>} [cutOptions]
 * @returns {{samples:Float32Array, cut:boolean, from:number}[]}
 */
export function cutLineSamples(samples, sr, plan, cutOptions = {}) {
  const opts = { ...DEFAULT_CUT, ...cutOptions };
  let prevCut = 0;
  return plan.spans.map((span, k) => {
    const from = Math.max(span.from, prevCut);
    const a = Math.round(from * sr);
    const clip = samples.subarray(a, Math.max(a, Math.round(span.to * sr)));
    const tailed = withQuietTail(clip, sr, undefined, Math.max(0, (plan.edges[k].end - from) * sr), opts);
    fadeIn(tailed.samples, sr, opts.fadeInSec);
    prevCut = from + tailed.kept / sr;
    return { samples: tailed.samples, cut: tailed.cut, from };
  });
}

/**
 * One clip per line out of the request's samples (cutLineSamples), written through `write`.
 * `wordsOf(k, from)` gives line k's words relative to its clip (optional). A clip whose sound
 * runs to its last window is flagged TAIL.
 * @param {{id:string, outPath:string}[]} items
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {{edges:{end:number}[], spans:{from:number,to:number}[]}} plan
 * @param {(k:number, from:number)=>object[]|undefined} wordsOf
 * @param {(path:string, channels:Float32Array[], sr:number)=>void} write
 * @param {Partial<typeof DEFAULT_CUT>} [cutOptions]
 */
export function cutClips(items, samples, sr, plan, wordsOf, write, cutOptions = {}) {
  const clips = cutLineSamples(samples, sr, plan, cutOptions);
  return items.map((it, k) => {
    const { from, cut } = clips[k];
    write(it.outPath, [clips[k].samples], sr);
    const result = { id: it.id, wavPath: it.outPath };
    const words = wordsOf && wordsOf(k, from);
    if (words) {
      result.words = words;
      result.wordsRelative = true;
    }
    if (cut) result.flag = "TAIL";
    return result;
  });
}
