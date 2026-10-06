// Mouth schedule: when a character's mouth is open, per voice line. Language-independent: the
// amplitude mode reads only how loud the line's audio is (no phonemes, no language model); the
// steady mode ignores the sound and opens and closes at a fixed rate while the line is spoken.
// Facts for the model: it decides whether a schedule suits the film (references/characters.md "Mouth shapes").
import fs from "node:fs";
import path from "node:path";
import { readWav } from "./wav-read.mjs";

export const STEP_SEC_DEFAULT = 0.04;
export const THRESHOLD_DEFAULT = 0.15;
export const RATE_HZ_DEFAULT = 5;
const MIN_OPEN_SEC = 0.06;
const MIN_CLOSED_SEC = 0.05;

/** RMS of each `stepSec` window of the samples. */
export function rmsEnvelope(samples, sampleRate, stepSec) {
  const win = Math.max(1, Math.round(sampleRate * stepSec));
  const out = [];
  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(samples.length, i + win);
    let sum = 0;
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / (end - i)));
  }
  return out;
}

/** The level a line's loud parts reach: the 95th percentile, so one click does not set the scale. */
function reference(env) {
  const sorted = [...env].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
}

/** Runs of consecutive windows that are open (true) or closed (false): [{open, from, to}] in window indices. */
function runsOf(flags) {
  const runs = [];
  for (let i = 0; i < flags.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.open === flags[i]) last.to = i + 1;
    else runs.push({ open: flags[i], from: i, to: i + 1 });
  }
  return runs;
}

/**
 * Open spans (seconds from the clip start) from an RMS envelope. A window is open when its level, as a
 * share of the line's own loud level, reaches `threshold`; a closed gap shorter than 50 ms between two
 * open runs is bridged and an open run shorter than 60 ms is dropped, so the mouth does not flutter.
 * `open` is the span's mean level, 0..1.
 */
export function amplitudeSpans(env, stepSec, threshold = THRESHOLD_DEFAULT) {
  const ref = reference(env);
  if (!(ref > 0)) return [];
  const level = env.map((v) => Math.min(1, v / ref));
  const runs = runsOf(level.map((v) => v >= threshold));
  const bridged = runs.map((r, i) => (!r.open && r.to - r.from < MIN_CLOSED_SEC / stepSec && i > 0 && i < runs.length - 1 ? { ...r, open: true } : r));
  const merged = [];
  for (const r of bridged) {
    const last = merged[merged.length - 1];
    if (last && last.open === r.open) last.to = r.to;
    else merged.push({ ...r });
  }
  return merged
    .filter((r) => r.open && (r.to - r.from) * stepSec >= MIN_OPEN_SEC)
    .map((r) => {
      let sum = 0;
      for (let i = r.from; i < r.to; i++) sum += level[i];
      return { from: round(r.from * stepSec), to: round(r.to * stepSec), open: round(sum / (r.to - r.from)) };
    });
}

/** Open for the first half of each period, closed for the second, from `startSec` to `endSec`. Ignores the sound. */
export function steadySpans(startSec, endSec, rateHz = RATE_HZ_DEFAULT) {
  const period = 1 / rateHz;
  const spans = [];
  for (let t = startSec; t < endSec - 1e-9; t += period) spans.push({ from: round(t), to: round(Math.min(endSec, t + period / 2)), open: 1 });
  return spans;
}

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * One schedule from a timings object. Times are film seconds: a line's clip starts at its `start`.
 * amplitude mode reads `<voiceDir>/line-<id>.wav`; a line with no readable clip is listed in `skipped`
 * and gets no spans. steady mode needs no audio.
 * @returns {{mode:string, params:object, lines:{id:string,start:number,end:number,clipSec?:number,spans:object[]}[], skipped:{id:string,reason:string}[]}}
 */
export function buildSchedule({ timings, voiceDir, mode = "amplitude", stepSec = STEP_SEC_DEFAULT, threshold = THRESHOLD_DEFAULT, rateHz = RATE_HZ_DEFAULT }) {
  const lines = [];
  const skipped = [];
  for (const l of timings.lines || []) {
    if (mode === "steady") {
      lines.push({ id: l.id, start: l.start, end: l.end, spans: steadySpans(l.start, l.end, rateHz) });
      continue;
    }
    const wav = path.join(voiceDir, `line-${l.id}.wav`);
    let clip;
    try {
      clip = readWav(wav);
    } catch (e) {
      skipped.push({ id: l.id, reason: fs.existsSync(wav) ? e.message : `no ${path.basename(wav)}` });
      continue;
    }
    const spans = amplitudeSpans(rmsEnvelope(clip.samples, clip.sampleRate, stepSec), stepSec, threshold)
      .map((s) => ({ ...s, from: round(l.start + s.from), to: round(l.start + s.to) }));
    lines.push({ id: l.id, start: l.start, end: l.end, clipSec: round(clip.samples.length / clip.sampleRate), spans });
  }
  const params = mode === "steady" ? { rateHz } : { stepSec, threshold };
  return { mode, params, lines, skipped };
}

/** Plain report lines: per line the span count and open share, then lines with no clip. */
export function scheduleLines(schedule) {
  const out = [`mouth schedule (${schedule.mode}): ${schedule.lines.length} line(s)`];
  for (const l of schedule.lines) {
    const open = l.spans.reduce((t, s) => t + (s.to - s.from), 0);
    out.push(`${l.id}: ${l.spans.length} open span(s), open ${open.toFixed(2)} s of ${(l.end - l.start).toFixed(2)} s`);
  }
  for (const s of schedule.skipped) out.push(`${s.id}: skipped (${s.reason})`);
  return out;
}
