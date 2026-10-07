// Audio measurement helpers for review.mjs's audio section. Technical checks
// do not certify art, so this measures sound and does not judge it.
// Loudness/true peak come from ffmpeg's
// ebur128 filter; onset/silence come from decoded PCM so they can be
// unit-tested on synthetic buffers with no ffmpeg involved at all.
import { run, ffmpeg } from "./ffmpeg.mjs";

/**
 * Integrated loudness (LUFS) and true peak (dBFS) of `mp4Path`, via
 * ffmpeg's ebur128 filter. ebur128's summary prints at ffmpeg's default
 * (info) loglevel — the shared `ffmpeg()` wrapper hides it at
 * `-loglevel error`, so this calls `run` directly.
 */
export async function measureLoudness(mp4Path) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    mp4Path,
    "-af",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const integrated = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr);
  const truePeak = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/.exec(stderr);
  return {
    integratedLufs: integrated ? parseFloat(integrated[1]) : null,
    truePeakDb: truePeak ? parseFloat(truePeak[1]) : null,
  };
}

/** Decode `mp4Path`'s audio track to mono 32-bit float PCM at `sampleRate`. */
export async function decodeMonoPcm(mp4Path, sampleRate) {
  const { stdout } = await ffmpeg([
    "-i",
    mp4Path,
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-",
  ]);
  const n = Math.floor(stdout.length / 4);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = stdout.readFloatLE(i * 4);
  return samples;
}

/** RMS of `windowLen` samples starting at `startIdx` (0 outside the buffer). */
export function rmsWindow(samples, startIdx, windowLen) {
  const start = Math.max(0, startIdx);
  const end = Math.min(samples.length, startIdx + windowLen);
  const n = Math.max(0, end - start);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** The level at or under which a 10 ms window counts as silence (review.mjs's audio gate and voice.mjs's silence gate share it). */
export const SILENCE_THRESHOLD_DB = -50;
/** A pause between voiced audio longer than this fails unless the plan asks for it. */
export const SILENCE_GATE_SEC = 1.0;

/** Per-10 ms-window "above threshold" flags, and the window length in samples. */
function rmsWindows(samples, sampleRate, thresholdDb) {
  const thresholdLin = Math.pow(10, thresholdDb / 20);
  const winLen = Math.max(1, Math.round(sampleRate * 0.01));
  const loud = [];
  for (let i = 0; i < samples.length; i += winLen) loud.push(rmsWindow(samples, i, winLen) > thresholdLin);
  return { loud, winLen };
}

/**
 * Longest run of near-silence (RMS <= thresholdDb) after the first sound in
 * `samples`, scanned in 10ms windows (review.mjs's audio gate: "longest
 * silence >= 1 beat after first sound").
 * @returns {{longestSilenceSec:number, firstSoundSec:number|null, trailingSilenceSec?:number}} the trailing run is
 *   the silence that reaches the end of `samples`; it is not a gap between sounds
 */
export function longestSilenceAfterFirstSound(samples, sampleRate, opts) {
  const o = opts || {};
  const { loud, winLen } = rmsWindows(samples, sampleRate, o.thresholdDb == null ? SILENCE_THRESHOLD_DB : o.thresholdDb);
  const first = loud.indexOf(true);
  if (first === -1) return { longestSilenceSec: 0, firstSoundSec: null };
  let longestRun = 0;
  let curRun = 0;
  for (let w = first; w < loud.length; w++) {
    if (!loud[w]) curRun++;
    else {
      if (curRun > longestRun) longestRun = curRun;
      curRun = 0;
    }
  }
  if (curRun > longestRun) longestRun = curRun;
  // curRun is now the silence that runs to the end of the samples (0 when the last window is loud).
  return { longestSilenceSec: (longestRun * winLen) / sampleRate, firstSoundSec: (first * winLen) / sampleRate, trailingSilenceSec: (curRun * winLen) / sampleRate };
}

/**
 * Every silence between voiced audio (after the first sound, before the last)
 * of at least `minSec`, on the same 10 ms windows and threshold as
 * longestSilenceAfterFirstSound. Leading and trailing silence are not gaps.
 * @returns {{startSec:number, endSec:number, durationSec:number}[]}
 */
export function silenceGaps(samples, sampleRate, opts) {
  const o = opts || {};
  const minSec = o.minSec == null ? SILENCE_GATE_SEC : o.minSec;
  const { loud, winLen } = rmsWindows(samples, sampleRate, o.thresholdDb == null ? SILENCE_THRESHOLD_DB : o.thresholdDb);
  const winSec = winLen / sampleRate;
  const gaps = [];
  let runStart = -1;
  let seenSound = false;
  for (let w = 0; w < loud.length; w++) {
    if (!loud[w]) {
      if (seenSound && runStart === -1) runStart = w;
      continue;
    }
    if (runStart !== -1) {
      const durationSec = (w - runStart) * winSec;
      if (durationSec >= minSec - 1e-9) gaps.push({ startSec: runStart * winSec, endSec: w * winSec, durationSec });
      runStart = -1;
    }
    seenSound = true;
  }
  return gaps;
}

/**
 * Onset offset (signed ms) of the steepest 10ms RMS rise within
 * `windowSec` of `markAtSec` — positive means the sound lands after the
 * mark (sound.md: "the steepest 10 ms rise within its window").
 * Returns null if the window has no measurable rise.
 */
export function findOnsetOffsetMs(samples, sampleRate, markAtSec, windowSec) {
  const win = windowSec == null ? 0.15 : windowSec;
  const winLen = Math.max(1, Math.round(sampleRate * 0.01));
  const centerIdx = Math.round(markAtSec * sampleRate);
  const searchStart = Math.max(0, centerIdx - Math.round(win * sampleRate));
  const searchEnd = Math.min(samples.length, centerIdx + Math.round(win * sampleRate));
  const RISE_EPSILON = 1e-6; // ignore near-zero "rises" in silence — that's noise floor, not an onset
  let bestRise = RISE_EPSILON;
  let bestIdx = null;
  // A window that reaches before the buffer's first sample (a stem that
  // starts on its own event, a mark at t=0) compares its first 10ms against
  // silence; otherwise a sound peaking in that first window shows no rise.
  const startsAtBufferHead = centerIdx - Math.round(win * sampleRate) <= 0;
  let prevRms = startsAtBufferHead ? 0 : rmsWindow(samples, searchStart, winLen);
  for (let i = startsAtBufferHead ? searchStart : searchStart + winLen; i + winLen <= searchEnd; i += winLen) {
    const r = rmsWindow(samples, i, winLen);
    if (r - prevRms > bestRise) {
      bestRise = r - prevRms;
      bestIdx = i;
    }
    prevRms = r;
  }
  if (bestIdx === null) return null;
  return Math.round((bestIdx / sampleRate - markAtSec) * 1000);
}

const dbOf = (rms) => 20 * Math.log10(Math.max(rms, 1e-6));
/** A window quieter than this is not audible speech, so its edges are not judged. */
export const CUT_AUDIBLE_DB = -40;
/** A span edge within this many dB of the span's loudest 10 ms still has the voice going: it was cut. */
export const CUT_EDGE_BELOW_BODY_DB = 20;
/** Without spans: a level step of at least this many dB between two 5 ms windows is a cut. */
export const CUT_STEP_DB = 30;

function spanCuts(samples, sampleRate, spans, edgeLen) {
  const winLen = Math.max(1, Math.round(sampleRate * 0.01));
  const cuts = [];
  for (const s of spans) {
    const from = Math.round(s.start * sampleRate);
    const to = Math.min(samples.length, Math.round(s.end * sampleRate));
    let bodyDb = -120;
    for (let i = from; i + winLen <= to; i += winLen) bodyDb = Math.max(bodyDb, dbOf(rmsWindow(samples, i, winLen)));
    if (bodyDb < CUT_AUDIBLE_DB) continue;
    for (const [edge, idx] of [["start", from], ["end", to - edgeLen]]) {
      const edgeDb = dbOf(rmsWindow(samples, idx, edgeLen));
      if (edgeDb > bodyDb - CUT_EDGE_BELOW_BODY_DB) cuts.push({ id: s.id ?? null, edge, atSec: (edge === "start" ? from : to) / sampleRate, edgeDb, bodyDb });
    }
  }
  return cuts;
}

/** A step only counts when the loud side is already at full level: a fast fade-in or fade-out is not a cut. */
const CUT_FULL_LEVEL_DB = 12;
const CUT_NEIGHBOUR_WINDOWS = 10;

function stepCuts(samples, sampleRate, edgeLen, stepDb) {
  const levels = [];
  for (let i = 0; i + edgeLen <= samples.length; i += edgeLen) levels.push(dbOf(rmsWindow(samples, i, edgeLen)));
  const loudest = (from, to) => Math.max(...levels.slice(Math.max(0, from), Math.min(levels.length, to)));
  const cuts = [];
  for (let w = 1; w < levels.length; w++) {
    const prev = levels[w - 1];
    const db = levels[w];
    const atSec = (w * edgeLen) / sampleRate;
    if (prev > CUT_AUDIBLE_DB && db < prev - stepDb && prev >= loudest(w - CUT_NEIGHBOUR_WINDOWS, w) - CUT_FULL_LEVEL_DB) {
      cuts.push({ id: null, edge: "end", atSec, edgeDb: prev, bodyDb: prev });
    } else if (db > CUT_AUDIBLE_DB && prev < db - stepDb && db >= loudest(w, w + CUT_NEIGHBOUR_WINDOWS) - CUT_FULL_LEVEL_DB) {
      cuts.push({ id: null, edge: "start", atSec, edgeDb: db, bodyDb: db });
    }
  }
  return cuts;
}

/**
 * Spots where audio stops or starts unnaturally: the waveform is still loud at
 * the edge instead of fading through the head and tail room a trimmed clip has.
 * With `spans` ({id,start,end} seconds, e.g. the placed lines) each span's first
 * and last 5 ms are compared with its loudest 10 ms; without spans the whole
 * track is scanned for 5 ms level steps. Reports only; the model judges by ear.
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{spans?: {id?:string,start:number,end:number}[], edgeMs?:number, stepDb?:number}} [opts]
 * @returns {{id:string|null, edge:"start"|"end", atSec:number, edgeDb:number, bodyDb:number}[]}
 */
export function findWaveformCuts(samples, sampleRate, opts = {}) {
  const edgeLen = Math.max(1, Math.round((sampleRate * (opts.edgeMs ?? 5)) / 1000));
  return opts.spans ? spanCuts(samples, sampleRate, opts.spans, edgeLen) : stepCuts(samples, sampleRate, edgeLen, opts.stepDb ?? CUT_STEP_DB);
}

/** Decode `wavPath` and run findWaveformCuts over the placed lines. */
export async function measureNarrationCuts(wavPath, lines) {
  const sampleRate = 48000;
  const samples = await decodeMonoPcm(wavPath, sampleRate);
  return findWaveformCuts(samples, sampleRate, { spans: (lines || []).map((l) => ({ id: l.id, start: l.start, end: l.end })) });
}

/** The text dub.mjs / fit-track.mjs print for findWaveformCuts. */
export function formatCutReport(cuts) {
  if (!cuts.length) return "waveform cut check: no abrupt start or end in the placed lines\n";
  const rows = cuts.map((c) => `  ${c.id == null ? "track" : `line "${c.id}"`} ${c.edge} at ${c.atSec.toFixed(2)}s: ${c.edgeDb.toFixed(0)} dB at the edge, ${c.bodyDb.toFixed(0)} dB in the body`);
  return `WARN: ${cuts.length} abrupt cut(s) in the placed audio (the voice is still loud at the edge):\n${rows.join("\n")}\nhint: listen at those times; a cut at an end usually means the take was trimmed or sped past its own tail — re-make the line\n`;
}
