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
