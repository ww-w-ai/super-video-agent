// Edge trim for one line's clip, shared by voice.mjs (every synthesized line),
// dub.mjs and fit-track.mjs: cut to the voiced span plus a short head and tail.
// Per-line synthesis leaves 0.1-0.5 s of dead air at a clip's edges; summed
// over a film that is the long voice silence review.mjs catches too late.
// Voiced = above the same threshold the silence gate uses (SILENCE_THRESHOLD_DB).
// The end also follows the last syllable's decay under that threshold: the clip never
// stops (or starts its fade-out) before the decay reaches END_DECAY_BELOW_LEVEL_DB.
// Only the two edges are cut; a pause inside the clip is never touched.
import { ffmpeg, probeDuration } from "./ffmpeg.mjs";
import { decodeMonoPcm, rmsWindow, SILENCE_THRESHOLD_DB } from "./audio-analysis.mjs";
import { trimEdgeSilence } from "./dub-timing.mjs";
import { FADE_IN_SEC, FADE_OUT_SEC } from "./line-split.mjs";

export const CLIP_HEAD_PAD_SEC = 0.05;
export const CLIP_TAIL_PAD_SEC = 0.3;
/** The last syllable's decay is followed until it falls this far under the line's loud level. */
export const END_DECAY_BELOW_LEVEL_DB = 45;
/** Kept after the decay ends, before the fade-out starts. */
const END_DECAY_MARGIN_SEC = 0.05;
const ENVELOPE_WINDOW_SEC = 0.01;

/**
 * 10ms RMS-in-dBFS windows across `wavPath`, in order — the envelope
 * trimEdgeSilence reads to find a take's leading/trailing silence.
 * @returns {Promise<{startSec:number, endSec:number, rmsDb:number}[]>}
 */
export async function measureEdgeEnvelope(wavPath, opts = {}) {
  const sampleRate = opts.sampleRate ?? 48000;
  const samples = await decodeMonoPcm(wavPath, sampleRate);
  const winLen = Math.max(1, Math.round(sampleRate * ENVELOPE_WINDOW_SEC));
  const windows = [];
  for (let i = 0; i < samples.length; i += winLen) {
    const rms = rmsWindow(samples, i, winLen);
    windows.push({
      startSec: i / sampleRate,
      endSec: Math.min(samples.length, i + winLen) / sampleRate,
      rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    });
  }
  return windows;
}

/**
 * The voiced span of a clip plus the head/tail pads, from its envelope. Pure. The end is never
 * earlier than the last syllable's decay (lastSyllableDecayEndSec) plus a margin and the fade-out.
 */
export function voicedSpanWithPads(windows, clipDurationSec, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? SILENCE_THRESHOLD_DB;
  const range = trimEdgeSilence(windows, clipDurationSec, {
    thresholdDb,
    headPadSec: opts.headPadSec ?? CLIP_HEAD_PAD_SEC,
    tailPadSec: opts.tailPadSec ?? CLIP_TAIL_PAD_SEC,
  });
  const decayEndSec = lastSyllableDecayEndSec(windows, thresholdDb);
  if (decayEndSec == null) return range;
  const trimmedEndSec = Math.min(clipDurationSec, Math.max(range.trimmedEndSec, decayEndSec + END_DECAY_MARGIN_SEC + FADE_OUT_SEC));
  return { ...range, trimmedEndSec, tailTrimSec: Math.max(0, clipDurationSec - trimmedEndSec) };
}

/**
 * Where the last syllable's decay ends: from the last window above `gateDb`, the first point after
 * which three windows (30 ms) stay under max(level − END_DECAY_BELOW_LEVEL_DB, noise floor + 6 dB).
 * Level = 90th percentile of the windows, floor = 10th. Null when nothing is above `gateDb`. Pure.
 * @param {{startSec:number, endSec:number, rmsDb:number}[]} windows
 */
export function lastSyllableDecayEndSec(windows, gateDb = SILENCE_THRESHOLD_DB) {
  let last = -1;
  for (let i = windows.length - 1; i >= 0; i--) if (windows[i].rmsDb > gateDb) { last = i; break; }
  if (last < 0) return null;
  const sorted = windows.map((w) => (Number.isFinite(w.rmsDb) ? w.rmsDb : -200)).sort((a, b) => a - b);
  const level = sorted[Math.floor(0.9 * (sorted.length - 1))];
  const floor = sorted[Math.floor(0.1 * (sorted.length - 1))];
  const endDb = Math.max(level - END_DECAY_BELOW_LEVEL_DB, floor + 6);
  let i = last + 1;
  while (i < windows.length) {
    if (windows.slice(i, i + 3).every((w) => !(w.rmsDb > endDb))) return windows[i].startSec;
    i++;
  }
  return windows[windows.length - 1].endSec;
}

/**
 * Write `srcPath` trimmed to its voiced span (plus pads) at `outPath`
 * (48 kHz mono 16-bit). `outPath` must differ from `srcPath`.
 * @returns {Promise<{leadTrimSec:number, tailTrimSec:number, trimmedDurationSec:number, sourceDurationSec:number}>}
 */
export async function trimClipToVoice(srcPath, outPath, opts = {}) {
  const sourceDurationSec = await probeDuration(srcPath);
  const range = voicedSpanWithPads(await measureEdgeEnvelope(srcPath), sourceDurationSec, opts);
  const trimmedDurationSec = range.trimmedEndSec - range.trimmedStartSec;
  await ffmpeg(["-y", "-i", srcPath, "-af", trimAndFadeFilter(range.trimmedStartSec, range.trimmedEndSec), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  return {
    leadTrimSec: range.leadTrimSec,
    tailTrimSec: range.tailTrimSec,
    trimmedDurationSec,
    sourceDurationSec,
  };
}

/**
 * One filter chain that cuts [startSec, endSec] and fades its two edges. atrim + asetpts restamp the
 * cut from zero, so the fades' times are on the cut clip's own clock. (Output-side -ss/-to keeps the
 * input's timestamps in the filter: a fade placed on the cut clip's clock then lands startSec early
 * and zeroes the end of the last syllable.)
 */
export function trimAndFadeFilter(startSec, endSec) {
  const cut = `atrim=start=${startSec.toFixed(6)}:end=${endSec.toFixed(6)},asetpts=PTS-STARTPTS`;
  const fades = edgeFades(endSec - startSec);
  return fades ? `${cut},${fades}` : cut;
}

/** Short fade-in at the head and fade-out at the end of a clip `durationSec` long (its own clock), so the cut never clicks; null when too short. */
export function edgeFades(durationSec) {
  if (!(durationSec > FADE_IN_SEC + FADE_OUT_SEC)) return null;
  const out = (durationSec - FADE_OUT_SEC).toFixed(6);
  return `afade=t=in:st=0:d=${FADE_IN_SEC},afade=t=out:st=${out}:d=${FADE_OUT_SEC}`;
}
