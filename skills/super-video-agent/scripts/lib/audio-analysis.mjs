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

/**
 * Longest run of near-silence (RMS <= thresholdDb) after the first sound in
 * `samples`, scanned in 10ms windows (review.mjs's audio gate: "longest
 * silence >= 1 beat after first sound").
 * @returns {{longestSilenceSec:number, firstSoundSec:number|null}}
 */
export function longestSilenceAfterFirstSound(samples, sampleRate, opts) {
  const o = opts || {};
  const thresholdLin = Math.pow(10, (o.thresholdDb == null ? -50 : o.thresholdDb) / 20);
  const winLen = Math.max(1, Math.round(sampleRate * 0.01));
  const rmsSeries = [];
  let firstSoundIdx = null;
  for (let i = 0; i < samples.length; i += winLen) {
    const r = rmsWindow(samples, i, winLen);
    rmsSeries.push(r);
    if (firstSoundIdx === null && r > thresholdLin) firstSoundIdx = i;
  }
  if (firstSoundIdx === null) return { longestSilenceSec: 0, firstSoundSec: null };
  const startWin = Math.floor(firstSoundIdx / winLen);
  let longestRun = 0;
  let curRun = 0;
  for (let w = startWin; w < rmsSeries.length; w++) {
    if (rmsSeries[w] <= thresholdLin) curRun++;
    else {
      if (curRun > longestRun) longestRun = curRun;
      curRun = 0;
    }
  }
  if (curRun > longestRun) longestRun = curRun;
  return {
    longestSilenceSec: (longestRun * winLen) / sampleRate,
    firstSoundSec: firstSoundIdx / sampleRate,
  };
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
