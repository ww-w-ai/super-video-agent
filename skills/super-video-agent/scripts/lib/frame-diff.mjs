// Pixel-diff analysis over a decoded mp4: 64px greyscale frame diffs used
// by review.mjs for dead-air detection and boil-cadence estimation
// (design.md §2.4).
import { ffmpeg, ffprobe } from "./ffmpeg.mjs";

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
 * to analyse at the video's native resolution instead of downscaling —
 * boil cadence needs this: sub-pixel boil motion in a half-resolution
 * --preview render can vanish entirely once downscaled again to 64px.
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
 * @returns {{fractions:number[], deadAirRuns:{startSec:number,durationSec:number}[]}}
 */
export function analyzeMotion(frames, fps) {
  const fractions = [];
  for (let i = 1; i < frames.length; i++) {
    fractions.push(changedFraction(frames[i - 1], frames[i]));
  }
  const deadAirRuns = [];
  let runStart = null;
  let runLen = 0;
  for (let i = 0; i < fractions.length; i++) {
    if (fractions[i] < DEAD_AIR_FRACTION) {
      if (runStart === null) runStart = i;
      runLen++;
    } else {
      if (runStart !== null) {
        const durationSec = runLen / fps;
        if (durationSec >= DEAD_AIR_RUN_SEC) {
          deadAirRuns.push({ startSec: runStart / fps, durationSec });
        }
      }
      runStart = null;
      runLen = 0;
    }
  }
  if (runStart !== null) {
    const durationSec = runLen / fps;
    if (durationSec >= DEAD_AIR_RUN_SEC) {
      deadAirRuns.push({ startSec: runStart / fps, durationSec });
    }
  }
  return { fractions, deadAirRuns };
}

/**
 * Estimate the interval (seconds) between motion "spikes" — frames whose
 * changed-pixel fraction is meaningfully above the dead-air floor — as a
 * proxy for boil cadence.
 * @param {number[]} fractions
 * @param {number} fps
 */
export function estimateBoilCadence(fractions, fps) {
  const spikeThreshold = Math.max(DEAD_AIR_FRACTION * 2, median(fractions) * 2 || DEAD_AIR_FRACTION * 2);
  // Count rising edges (onsets), not every frame above threshold, so a
  // pose-hold that stays "changed" for 1-2 sampled frames after a reseed
  // (fps and boil hz rarely divide evenly) is counted once per reseed
  // rather than once per frame.
  const onsets = [];
  for (let i = 0; i < fractions.length; i++) {
    const prev = i === 0 ? 0 : fractions[i - 1];
    if (fractions[i] > spikeThreshold && prev <= spikeThreshold) onsets.push(i);
  }
  if (onsets.length < 2) return { cadenceSec: null, spikeCount: onsets.length };
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push((onsets[i] - onsets[i - 1]) / fps);
  }
  // Median, not mean: different shots have different baseline noise, so a
  // single global adaptive threshold under- or over-fires in some shots,
  // producing a few outlier gaps/doubles. The median interval is robust to
  // those outliers while still reflecting the dominant reseed cadence.
  return { cadenceSec: median(intervals), spikeCount: onsets.length };
}

/**
 * Turn a raw cadence estimate into review.mjs's boilCadence check, aware of
 * whether the analysed mp4 is a --preview render. A preview is already
 * half-resolution before this module downscales it again for analysis, so
 * sub-pixel boil motion routinely vanishes and the cadence read is
 * unreliable — that must not fail the gate; it's reported as "info" instead
 * (design.md §2.4 boil cadence, fixed 2026-09).
 * @param {{cadenceSec:number|null, spikeCount:number, plannedHz:number,
 *   toleranceSec:number, isPreview:boolean, analyzedWidthPx?:number}} args
 */
export function evaluateBoilCadence({
  cadenceSec,
  spikeCount,
  plannedHz,
  toleranceSec,
  isPreview,
  analyzedWidthPx,
}) {
  const plannedIntervalSec = 1 / plannedHz;
  const measured =
    cadenceSec != null && Math.abs(cadenceSec - plannedIntervalSec) <= toleranceSec;
  const status = isPreview ? "info" : measured ? "pass" : "fail";
  return {
    plannedHz,
    plannedIntervalSec,
    estimatedIntervalSec: cadenceSec,
    spikeCount,
    analyzedWidthPx,
    isPreview,
    status,
    // `pass` stays boolean for existing consumers of the overall gate:
    // an "info" preview result never blocks it.
    pass: isPreview ? true : measured,
  };
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const DEAD_AIR_FRACTION_THRESHOLD = DEAD_AIR_FRACTION;
export const DEAD_AIR_RUN_SEC_THRESHOLD = DEAD_AIR_RUN_SEC;
