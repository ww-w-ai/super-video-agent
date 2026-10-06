// Re-measures each word's start from the waveform and compares it with the time timings.json
// records (the TTS/STT time). Pure: samples in, facts out. Facts only; nothing here fails a reel.
import { rmsWindow } from "./audio-analysis.mjs";

/** Search this far either side of a recorded word start (s), never past halfway to the neighbour word. */
export const ONSET_WINDOW_SEC = 0.25;
/** A recorded start this far (s) from the measured onset is reported. Source: sync marks accept -20..+40 ms (references/qa.md); 120 ms is where a hard cut or a sound cue is seen as off. */
export const OFFSET_REPORT_SEC = 0.12;
/** The steepest 10 ms rise must reach this share of the window's loudest 10 ms, else "no clear onset" (a steady tone or silence has no onset). */
export const ONSET_MIN_RISE_SHARE = 0.25;
const RMS_WIN_SEC = 0.01;

/**
 * The onset (s) of the steepest 10 ms RMS rise in [fromSec, toSec], or null when nothing rises
 * clearly. A window that starts at the buffer head compares its first 10 ms with silence.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 */
export function steepestRise(samples, sampleRate, fromSec, toSec) {
  const win = Math.max(1, Math.round(sampleRate * RMS_WIN_SEC));
  const from = Math.max(0, Math.round(fromSec * sampleRate));
  const to = Math.min(samples.length, Math.round(toSec * sampleRate));
  if (to - from < 2 * win) return null;
  let prev = from === 0 ? 0 : rmsWindow(samples, from - win, win);
  let peak = 0;
  let best = 0;
  let bestIdx = null;
  for (let i = from; i + win <= to; i += win) {
    const r = rmsWindow(samples, i, win);
    if (r > peak) peak = r;
    if (r - prev > best) { best = r - prev; bestIdx = i; }
    prev = r;
  }
  if (bestIdx === null || peak <= 1e-6 || best < ONSET_MIN_RISE_SHARE * peak) return null;
  return bestIdx / sampleRate;
}

/**
 * @param {{lines: {id:string, text?:string, words?:{w:string,start:number,end:number}[], wordsMeasured?:number}[]}} timings
 * @param {Float32Array} samples narration, mono, on the same clock as timings.json
 * @param {number} sampleRate
 * @param {{windowSec?:number, reportSec?:number, lineIds?:string[]}} [opts]
 * @returns {{words: {lineId:string, index:number, w:string, recorded:number, onset:number|null, offsetSec:number|null,
 *   status:"ok"|"off"|"no-onset", lineWordsMeasured:number|null, lineInterpolated:boolean}[],
 *   reportSec:number, off:number, noOnset:number}}
 */
export function measureWordOnsets(timings, samples, sampleRate, opts = {}) {
  const windowSec = opts.windowSec ?? ONSET_WINDOW_SEC;
  const reportSec = opts.reportSec ?? OFFSET_REPORT_SEC;
  const only = opts.lineIds ? new Set(opts.lineIds) : null;
  const flat = [];
  for (const line of timings.lines || []) {
    (line.words || []).forEach((word, index) => {
      if (typeof word.start === "number") flat.push({ line, word, index });
    });
  }
  flat.sort((a, b) => a.word.start - b.word.start);
  const words = [];
  flat.forEach(({ line, word, index }, k) => {
    if (only && !only.has(line.id)) return;
    const prev = k > 0 ? flat[k - 1].word.start : null;
    const next = k < flat.length - 1 ? flat[k + 1].word.start : null;
    const left = prev == null ? windowSec : Math.min(windowSec, (word.start - prev) / 2);
    const right = next == null ? windowSec : Math.min(windowSec, (next - word.start) / 2);
    const onset = steepestRise(samples, sampleRate, word.start - left, word.start + right);
    const offsetSec = onset == null ? null : round3(onset - word.start);
    const count = (line.words || []).length;
    const measured = typeof line.wordsMeasured === "number" ? line.wordsMeasured : null;
    words.push({
      lineId: line.id, index, w: word.w, recorded: round3(word.start), onset: onset == null ? null : round3(onset), offsetSec,
      status: onset == null ? "no-onset" : Math.abs(offsetSec) > reportSec ? "off" : "ok",
      lineWordsMeasured: measured,
      lineInterpolated: measured !== null && measured < count,
    });
  });
  return {
    words, reportSec,
    off: words.filter((x) => x.status === "off").length,
    noOnset: words.filter((x) => x.status === "no-onset").length,
  };
}

/** A word is "after a pause" when its recorded start is this far (s) past the previous word's end. */
export const PAUSE_BEFORE_WORD_SEC = 0.12;
/** A start moves only when the sound begins at least this much (s) later. */
export const MIN_SNAP_SEC = 0.02;
/** Sound = a 10 ms window above this share of the line's loud level (amplitude), as stt_check's trim_to_sound. */
const SOUND_FLOOR_SHARE = 0.1;
/** How far past a recorded start the sound may begin (s), never past the next word's start. */
const SNAP_REACH_SEC = 0.6;
const SNAP_END_MARGIN_SEC = 0.03;

function rmsFrames(samples, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * RMS_WIN_SEC));
  const frames = new Float64Array(Math.floor(samples.length / win));
  for (let f = 0; f < frames.length; f++) frames[f] = rmsWindow(samples, f * win, win);
  return frames;
}

function soundFloor(frames) {
  const sorted = Float64Array.from(frames).sort();
  return SOUND_FLOOR_SHARE * sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))];
}

/** First frame in [from, to) at or above `floor`, or -1. */
function firstLoud(frames, floor, from, to) {
  for (let f = Math.max(0, from); f < Math.min(frames.length, to); f++) if (frames[f] >= floor) return f;
  return -1;
}

/**
 * N16: a word after a pause is timed early by the speech-to-text pass (it starts inside the
 * pause), so a caption changes before the voice. Moves such a word's start to where its sound
 * begins in the line's own energy envelope — one 10 ms RMS pass, no second recognition. Only ever
 * later: a start the pause leaves untouched, a word already on its sound, a pause with a breath
 * above the floor, and a sound that is not found before the next word stay as they are. A word
 * that sat wholly inside the pause keeps its duration at the new start.
 * @param {{w:string, start:number, end:number}[]} words on the clip's clock plus `offsetSec`
 * @param {Float32Array} samples the line's clip, mono
 * @param {number} sampleRate
 * @param {number} [offsetSec] the clip's start on the words' clock (the line's start)
 * @returns {{words:{w:string,start:number,end:number}[], moved:{index:number, w:string, from:number, to:number}[]}}
 */
export function snapStartsToSound(words, samples, sampleRate, offsetSec = 0) {
  const out = words.map((w) => ({ ...w }));
  const frames = rmsFrames(samples, sampleRate);
  if (!frames.length) return { words: out, moved: [] };
  const floor = soundFloor(frames);
  const at = (sec) => Math.round(sec / RMS_WIN_SEC);
  const moved = [];
  out.forEach((word, i) => {
    if (typeof word.start !== "number" || typeof word.end !== "number") return;
    const start = word.start - offsetSec;
    const prevEnd = i === 0 ? 0 : out[i - 1].end - offsetSec;
    if (i > 0 && start - prevEnd < PAUSE_BEFORE_WORD_SEC) return;
    if (firstLoud(frames, floor, at(Math.max(0, prevEnd)), at(start)) >= 0) return;
    const next = i < out.length - 1 && typeof out[i + 1].start === "number" ? out[i + 1].start - offsetSec : Infinity;
    const limit = Math.min(next - SNAP_END_MARGIN_SEC, start + SNAP_REACH_SEC);
    const onset = firstLoud(frames, floor, at(start), at(limit));
    if (onset < 0) return;
    const sound = onset * RMS_WIN_SEC;
    if (sound - start < MIN_SNAP_SEC) return;
    const endRel = word.end - offsetSec;
    const newEnd = sound + SNAP_END_MARGIN_SEC <= endRel ? endRel : Math.min(sound + (endRel - start), next);
    word.start = round3(sound + offsetSec);
    word.end = round3(Math.max(newEnd, sound + SNAP_END_MARGIN_SEC) + offsetSec);
    moved.push({ index: i, w: word.w, from: round3(words[i].start), to: word.start });
  });
  return { words: out, moved };
}

/** One line per reported word: off by more than the threshold, or with no clear onset. */
export function formatWordOnsets(report) {
  const lines = report.words
    .filter((w) => w.status !== "ok")
    .map((w) => {
      const tag = w.lineInterpolated ? " (line has interpolated words)" : "";
      return w.status === "off"
        ? `${w.lineId}#${w.index} "${w.w}": recorded ${w.recorded.toFixed(3)} s, sound starts ${w.onset.toFixed(3)} s (${w.offsetSec > 0 ? "+" : ""}${Math.round(w.offsetSec * 1000)} ms)${tag}`
        : `${w.lineId}#${w.index} "${w.w}": recorded ${w.recorded.toFixed(3)} s, no clear sound onset near it${tag}`;
    });
  const head = `${report.words.length} words measured; ${report.off} off by more than ${Math.round(report.reportSec * 1000)} ms, ${report.noOnset} with no clear onset\n`;
  return head + lines.map((l) => l + "\n").join("");
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
