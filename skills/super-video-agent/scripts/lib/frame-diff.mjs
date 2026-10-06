// Pixel-diff analysis over a decoded mp4: 64px greyscale frame diffs used
// by review.mjs for dead-air detection.
import { ffmpeg, ffprobe } from "./ffmpeg.mjs";
import { splitIntendedHolds } from "./dead-air.mjs";

/** Width of the greyscale frames the freeze test reads: at 64 px a slow push-in changes under 0.2% of pixels and read as frozen. */
export const FREEZE_SCAN_WIDTH = 320;

const CHANGE_THRESHOLD = 6; // 0-255 greyscale delta counted as "changed"
const DEAD_AIR_FRACTION = 0.002; // 0.2% of pixels
const DEAD_AIR_RUN_SEC = 0.8;

/** Probe the video's pixel dimensions (for computing the scaled height). */
async function probeDims(mp4Path) {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    mp4Path,
  ]);
  const [w, h] = stdout.toString().trim().split("x").map(Number);
  return { width: w, height: h };
}

/**
 * Decode `mp4Path` to greyscale raw frames at `fps`, scaled to `width` px
 * wide (default 64, used for the cheap dead-air scan). Pass `width: null`
 * to analyse at the video's native resolution instead of downscaling.
 * @returns {Promise<{frames: Buffer[], w:number, h:number}>}
 */
export async function extractGrayFrames(mp4Path, fps, { width = 64 } = {}) {
  const dims = await probeDims(mp4Path);
  const w = width == null ? dims.width : Math.min(width, dims.width);
  const h = Math.max(2, Math.round((w * dims.height) / dims.width / 2) * 2);
  const { stdout } = await ffmpeg([
    "-i",
    mp4Path,
    "-vf",
    `fps=${fps},scale=${w}:${h}:flags=neighbor,format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  const frameSize = w * h;
  const frameCount = Math.floor(stdout.length / frameSize);
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(stdout.subarray(i * frameSize, (i + 1) * frameSize));
  }
  return { frames, w, h };
}

/** Fraction of pixels (0-1) that changed by more than CHANGE_THRESHOLD. */
export function changedFraction(a, b) {
  let changed = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > CHANGE_THRESHOLD) changed++;
  }
  return n ? changed / n : 0;
}

/**
 * @param {Buffer[]} frames greyscale frames, one per rendered fps tick
 * @param {number} fps
 * @param {{holds?: {from:number, to:number}[]}} [opts] holds = intended slow-motion / hold spans (seconds)
 * @returns {{fractions:number[], deadAirRuns:{startSec:number,durationSec:number}[], intendedHoldRuns:{startSec:number,durationSec:number}[], frameCount:number}}
 */
export function analyzeMotion(frames, fps, { holds } = {}) {
  const fractions = [];
  for (let i = 1; i < frames.length; i++) {
    fractions.push(changedFraction(frames[i - 1], frames[i]));
  }
  const found = [];
  let runStart = null;
  const close = (end) => {
    if (runStart !== null && (end - runStart) / fps >= DEAD_AIR_RUN_SEC) {
      found.push({ startSec: runStart / fps, durationSec: (end - runStart) / fps });
    }
    runStart = null;
  };
  for (let i = 0; i < fractions.length; i++) {
    if (fractions[i] < DEAD_AIR_FRACTION) {
      if (runStart === null) runStart = i;
    } else {
      close(i);
    }
  }
  close(fractions.length);
  // Spans the page declared as intended slow motion / hold are reported apart, never flagged.
  const split = splitIntendedHolds(found, holds, DEAD_AIR_RUN_SEC);
  return { fractions, deadAirRuns: split.runs, intendedHoldRuns: split.intendedHolds, frameCount: frames.length };
}

export const DEAD_AIR_FRACTION_THRESHOLD = DEAD_AIR_FRACTION;
export const DEAD_AIR_RUN_SEC_THRESHOLD = DEAD_AIR_RUN_SEC;
