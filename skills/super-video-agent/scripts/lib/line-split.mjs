// Cutting one synthesized request into per-line clips, and giving every clip the same quiet tail.
// Pure functions over Float32 mono samples and an engine's character times, so the rules are
// unit-tested without audio files. Used by voice/elevenlabs.mjs, voice/typecast.mjs and
// voice/fish.mjs (references/voice.md "One read per voice, cut per line").

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
 * Groups of items whose joined text stays within `maxChars` (one request each); an item longer
 * than the limit is a group of its own.
 * @template {{text:string}} T
 * @param {T[]} items
 * @param {number} maxChars
 * @returns {T[][]}
 */
export function groupByChars(items, maxChars) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && size + it.text.length + 1 > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.text.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
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
export function planCuts({ samples, sr, texts, words }) {
  const total = samples.length / sr;
  const lineWords = wordsToLines(words, texts);
  if (lineWords) {
    const edges = lineWords.map((ws) => ({ start: ws[0].start, end: ws[ws.length - 1].end }));
    return { by: "timestamps", edges, spans: cutSpans(edges, total), lineWords };
  }
  const edges = silenceEdges(samples, sr, texts.length);
  if (!edges || !plausibleSplit(edges, texts)) return null;
  return { by: "silence", edges, spans: cutSpans(edges, total), lineWords: null };
}

/**
 * One clip per line out of the request's samples, each ending at its last sound plus TAIL_SEC.
 * `wordsOf(k, from)` gives line k's words relative to its clip (optional). A clip whose sound
 * runs to its last window is flagged TAIL.
 * @param {{id:string, outPath:string}[]} items
 * @param {Float32Array} samples
 * @param {number} sr
 * @param {{edges:{end:number}[], spans:{from:number,to:number}[]}} plan
 * @param {(k:number, from:number)=>object[]|undefined} wordsOf
 * @param {(path:string, channels:Float32Array[], sr:number)=>void} write
 */
export function cutClips(items, samples, sr, plan, wordsOf, write) {
  return items.map((it, k) => {
    const { from, to } = plan.spans[k];
    const clip = samples.subarray(Math.round(from * sr), Math.round(to * sr));
    const tailed = withQuietTail(clip, sr, undefined, (plan.edges[k].end - from) * sr);
    write(it.outPath, [tailed.samples], sr);
    const result = { id: it.id, wavPath: it.outPath };
    const words = wordsOf && wordsOf(k, from);
    if (words) {
      result.words = words;
      result.wordsRelative = true;
    }
    if (tailed.cut) result.flag = "TAIL";
    return result;
  });
}
