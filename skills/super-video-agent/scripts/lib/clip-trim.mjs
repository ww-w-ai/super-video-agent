// Edge trim for one line's clip, shared by voice.mjs (every synthesized line),
// dub.mjs and fit-track.mjs: cut to the voiced span plus a short head and tail.
// Per-line synthesis leaves 0.1-0.5 s of dead air at a clip's edges; summed
// over a film that is the long voice silence review.mjs catches too late.
// Voiced = above the same threshold the silence gate uses (SILENCE_THRESHOLD_DB).
// Only the two edges are cut; a pause inside the clip is never touched.
import { ffmpeg, probeDuration } from "./ffmpeg.mjs";
import { decodeMonoPcm, rmsWindow, SILENCE_THRESHOLD_DB } from "./audio-analysis.mjs";
import { trimEdgeSilence } from "./dub-timing.mjs";
import { FADE_IN_SEC, FADE_OUT_SEC } from "./line-split.mjs";

export const CLIP_HEAD_PAD_SEC = 0.05;
export const CLIP_TAIL_PAD_SEC = 0.3;
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

/** The voiced span of a clip plus the head/tail pads, from its envelope. Pure. */
export function voicedSpanWithPads(windows, clipDurationSec, opts = {}) {
  return trimEdgeSilence(windows, clipDurationSec, {
    thresholdDb: opts.thresholdDb ?? SILENCE_THRESHOLD_DB,
    headPadSec: opts.headPadSec ?? CLIP_HEAD_PAD_SEC,
    tailPadSec: opts.tailPadSec ?? CLIP_TAIL_PAD_SEC,
  });
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
  // Output-side -ss/-to (after -i): slower than input-side seeking, but sample-accurate.
  await ffmpeg(["-y", "-i", srcPath, "-ss", String(range.trimmedStartSec), "-to", String(range.trimmedEndSec), ...edgeFadeArgs(trimmedDurationSec), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  return {
    leadTrimSec: range.leadTrimSec,
    tailTrimSec: range.tailTrimSec,
    trimmedDurationSec,
    sourceDurationSec,
  };
}

/** ffmpeg args for a short fade-in at the head and fade-out at the end of a trimmed clip, so the cut never clicks. */
export function edgeFadeArgs(durationSec) {
  if (!(durationSec > FADE_IN_SEC + FADE_OUT_SEC)) return [];
  const out = (durationSec - FADE_OUT_SEC).toFixed(6);
  return ["-af", `afade=t=in:st=0:d=${FADE_IN_SEC},afade=t=out:st=${out}:d=${FADE_OUT_SEC}`];
}
