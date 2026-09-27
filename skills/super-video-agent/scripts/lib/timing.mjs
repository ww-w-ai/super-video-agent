// Pure timing math for voice.mjs: no I/O, no network, fully unit-testable.
// "Measured, never guessed" (design.md §2): callers pass in measured
// per-line durations (seconds, from ffprobe on the synthesized audio); this
// module only does the arithmetic of laying them out on one timeline.

const HEAD_SEC = 0.4;
const TAIL_SEC = 0.4;

/**
 * Lay out measured line durations on a single timeline with `gapMs` of
 * silence between consecutive lines, a fixed 0.4s head silence, and a
 * `tailSec` tail silence (default 0.4s — pass a longer value to keep a
 * wordless end card via plan.json meta.tailSec).
 * @param {number[]} durations seconds, one per line, in order
 * @param {number} gapMs milliseconds of silence between lines
 * @param {number} [tailSec] tail silence in seconds (default 0.4)
 * @returns {{lineTimes: {start:number end:number}[], totalDuration: number}}
 */
export function computeLineTimes(durations, gapMs, tailSec = TAIL_SEC) {
  const gapSec = gapMs / 1000;
  let offset = HEAD_SEC;
  const lineTimes = [];
  for (let i = 0; i < durations.length; i++) {
    const start = offset;
    const end = start + durations[i];
    lineTimes.push({ start, end });
    offset = end + (i < durations.length - 1 ? gapSec : 0);
  }
  const totalDuration = offset + tailSec;
  return { lineTimes, totalDuration };
}

/**
 * Build the ordered list of audio segments (silence + line clips) that must
 * be concatenated to produce narration.wav, given measured line durations.
 * Pure description — no ffmpeg call happens here.
 * @param {{id:string durationSec:number}[]} lines
 * @param {number} gapMs
 * @param {number} [tailSec] tail silence in seconds (default 0.4)
 * @returns {{kind:"silence"|"line", id?:string, durationSec:number}[]}
 */
export function buildConcatSegments(lines, gapMs, tailSec = TAIL_SEC) {
  const gapSec = gapMs / 1000;
  const segments = [{ kind: "silence", durationSec: HEAD_SEC }];
  lines.forEach((line, i) => {
    segments.push({ kind: "line", id: line.id, durationSec: line.durationSec });
    if (i < lines.length - 1) {
      segments.push({ kind: "silence", durationSec: gapSec });
    }
  });
  segments.push({ kind: "silence", durationSec: tailSec });
  return segments;
}

/**
 * Proportional word timing within a measured line window, split by
 * character count (design.md §2.2 timeline(): "word times from provider
 * alignment, else proportional to characters within the measured line").
 * @param {string} text the caption text to split into words (never `say`)
 * @param {number} start line start (absolute seconds on the narration timeline)
 * @param {number} end line end (absolute seconds)
 * @returns {{w:string,start:number,end:number}[]}
 */
export function wordsProportional(text, start, end) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const totalChars = words.reduce((a, w) => a + w.length, 0) || 1;
  const dur = end - start;
  let cursor = start;
  return words.map((w) => {
    const wDur = (w.length / totalChars) * dur;
    const wStart = cursor;
    const wEnd = wStart + wDur;
    cursor = wEnd;
    return { w, start: wStart, end: wEnd };
  });
}

/**
 * Word timing from provider character-level alignment, offset onto the
 * absolute narration timeline. `charStarts`/`charEnds` are seconds relative
 * to the synthesized line clip (as ElevenLabs with-timestamps returns).
 * @param {string} text
 * @param {number[]} charStarts
 * @param {number[]} charEnds
 * @param {number} lineStart absolute start of this line on the timeline
 */
export function wordsFromCharAlignment(text, charStarts, charEnds, lineStart) {
  const words = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const wStartIdx = i;
    while (i < n && !/\s/.test(text[i])) i++;
    const wEndIdx = i - 1;
    const w = text.slice(wStartIdx, wEndIdx + 1);
    const s = charStarts[wStartIdx];
    const e = charEnds[wEndIdx];
    if (typeof s === "number" && typeof e === "number") {
      words.push({ w, start: lineStart + s, end: lineStart + e });
    }
  }
  return words;
}

export const HEAD_SILENCE_SEC = HEAD_SEC;
export const TAIL_SILENCE_SEC = TAIL_SEC;
