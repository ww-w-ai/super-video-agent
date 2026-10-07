// Pure helpers for review.mjs's sync-mark check. The old check measured
// every mark's onset in the full rendered mix — an effect that lands on a
// spoken word then measures the voice's onset instead of the effect's (two
// film sessions moved effects just to pass this: sound.md, qa.md "Sync
// marks"). window.__reel.sfxStems() renders each kit/custom cue alone (no
// bed, no other cues, no narration), so a mark's own onset can be measured
// there instead; this only falls back to the full mix when no stem exists
// for a mark (an older page, or a mark whose kind sfxStems() could not
// generate).
//
// What the stem measures, and what it cannot: the stem is the cue itself,
// placed at the mark's own `at`, so its onset only says how soon the sound
// starts inside its own buffer (a few ms of attack). It reads ~0 ms for a cue
// drawn well off its picture beat, because the mark and the cue share one
// `at` by construction. Whether the sound lands on the picture is checked by
// pictureBeat() below: the frame-to-frame change of the page's own canvas
// around the mark, compared with the sound's onset.
import { findOnsetOffsetMs } from "./audio-analysis.mjs";
import { changedFraction } from "./frame-diff.mjs";

/** Seconds searched on each side of a mark for its picture beat. */
export const PICTURE_WINDOW_SEC = 0.3;
/** Width (px) of the greyscale frames compared; 64 px blurs a small object (a droplet) into noise. */
export const PICTURE_FRAME_WIDTH = 256;
/** A beat must change at least this fraction of the frame (as the dead-air check). */
export const PICTURE_MIN_FRACTION = 0.002;
/** ...and at least this many times the window's quiet level (its lower-quartile frame change), so steady motion is not read as a beat. */
export const PICTURE_MIN_CONTRAST = 2;

/**
 * The stem in `stems` whose `at` is closest to `at`, within `toleranceSec`,
 * or null if none is close enough. Marks and sfxStems() entries both come
 * from the same SFX_CUES list in the page, in the same order, but matching
 * by `at` (rather than assuming index alignment) is robust to a stem the
 * page could not generate for one cue.
 * @param {{at:number}[]} stems
 * @param {number} at
 * @param {number} [toleranceSec]
 * @returns {object|null}
 */
export function nearestStemByAt(stems, at, toleranceSec = 0.1) {
  let best = null;
  let bestDelta = Infinity;
  for (const s of stems || []) {
    const delta = Math.abs(s.at - at);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return bestDelta <= toleranceSec ? best : null;
}

/**
 * A sync mark's onset offset (ms). When a stem matches (source: "stems"),
 * the stem's own buffer starts at its own t=0 — render.mjs places it
 * verbatim at the mark's `at` — so the search window is centered on 0
 * within the stem, not on the mark's timeline `at`. With no matching stem
 * (source: "mix"), falls back to searching the full mix at the mark's `at`,
 * same as before this fix.
 * @param {{at:number, kind:string}} mark
 * @param {{stems: {at:number, L:number[]}[], mixPcm: Float32Array, sampleRate: number, windowSec?: number, toleranceSec?: number}} args
 * @returns {{offsetMs: number|null, source: "stems"|"mix"}}
 */
export function markOnsetOffset(mark, { stems, mixPcm, sampleRate, windowSec = 0.15, toleranceSec = 0.1 }) {
  const stem = nearestStemByAt(stems, mark.at, toleranceSec);
  if (stem) {
    const mono = Float32Array.from(stem.L);
    const offsetMs = findOnsetOffsetMs(mono, sampleRate, 0, windowSec);
    return { offsetMs, source: "stems" };
  }
  const offsetMs = findOnsetOffsetMs(mixPcm, sampleRate, mark.at, windowSec);
  return { offsetMs, source: "mix" };
}

/**
 * Frame-aligned seek times (k / fps) covering `at` ± `windowSec`, never
 * before 0 and never past `duration` when given.
 * @returns {number[]}
 */
export function pictureSampleTimes(at, fps, { windowSec = PICTURE_WINDOW_SEC, duration } = {}) {
  const k0 = Math.max(0, Math.floor((at - windowSec) * fps));
  let k1 = Math.ceil((at + windowSec) * fps);
  if (duration != null) k1 = Math.min(k1, Math.floor(duration * fps));
  const times = [];
  for (let k = k0; k <= k1; k++) times.push(k / fps);
  return times;
}

/**
 * The picture beat near a mark: where the largest burst of frame-to-frame
 * change in the window starts. From the largest change, walk back while the
 * change stays above a quarter of the way from the window's quiet level to
 * that peak, so a hit that sets off a reaction (a drop landing, then a
 * ripple growing) is timed at the landing, not at the ripple's peak. The
 * change happened between that frame and the one before it, so the beat's
 * time is their midpoint (± half a frame). Returns null with a reason when
 * nothing stands out: no change at all, or every frame changes about as
 * much (a camera push, drifting particles) and no frame is a hit.
 * @param {number[]} times seek times, one per frame
 * @param {ArrayLike<number>[]} frames greyscale frames, same length as times
 * @returns {{beat: {atSec:number, fraction:number, contrast:number}|null, reason: string|null}}
 */
export function pictureBeat(times, frames, { minFraction = PICTURE_MIN_FRACTION, minContrast = PICTURE_MIN_CONTRAST } = {}) {
  const diffs = []; // diffs[i] = change from frame i to frame i + 1
  for (let i = 1; i < frames.length; i++) diffs.push(changedFraction(frames[i - 1], frames[i]));
  if (!diffs.length) return { beat: null, reason: "no frames around the mark" };
  let peakIdx = 0;
  for (let i = 1; i < diffs.length; i++) if (diffs[i] > diffs[peakIdx]) peakIdx = i;
  const peak = diffs[peakIdx];
  if (peak < minFraction) return { beat: null, reason: "the picture does not change near the mark" };
  const sorted = diffs.slice().sort((a, b) => a - b);
  const quiet = sorted[Math.floor((sorted.length - 1) / 4)];
  const contrast = quiet > 0 ? peak / quiet : Infinity;
  if (contrast < minContrast) {
    return {
      beat: null,
      reason: `no frame stands out (largest change ${(peak * 100).toFixed(2)}% vs quiet ${(quiet * 100).toFixed(2)}%)`,
    };
  }
  const rise = quiet + 0.25 * (peak - quiet);
  let start = peakIdx;
  while (start > 0 && diffs[start - 1] > rise) start--;
  return { beat: { atSec: (times[start] + times[start + 1]) / 2, fraction: peak, contrast }, reason: null };
}

/**
 * The sync verdict for one mark: the sound's onset (mark.at + soundOnsetMs)
 * minus the picture beat. Not measured (pass: null) when either side is
 * missing — never a passing 0 ms.
 * @param {{at:number, sync?:boolean}} mark
 * @param {{soundOnsetMs:number|null, beat:{atSec:number}|null, reason?:string|null, minMs:number, maxMs:number}} args
 * @returns {{offsetMs:number|null, pictureAt:number|null, measured:boolean, notMeasured:string|null, pass:boolean|null}}
 */
export function syncVerdict(mark, { soundOnsetMs, beat, reason = null, minMs, maxMs }) {
  if (soundOnsetMs == null) {
    return { offsetMs: null, pictureAt: beat ? beat.atSec : null, measured: false, notMeasured: "no sound onset found at the mark", pass: mark.sync ? null : true };
  }
  if (!beat) {
    return { offsetMs: null, pictureAt: null, measured: false, notMeasured: reason || "no picture beat found", pass: mark.sync ? null : true };
  }
  const offsetMs = Math.round((mark.at + soundOnsetMs / 1000 - beat.atSec) * 1000);
  const inRange = offsetMs >= minMs && offsetMs <= maxMs;
  return { offsetMs, pictureAt: beat.atSec, measured: true, notMeasured: null, pass: mark.sync ? inRange : true };
}
