// Pure helpers for review.mjs's sync-mark check. The old check measured
// every mark's onset in the full rendered mix — an effect that lands on a
// spoken word then measures the voice's onset instead of the effect's (two
// film sessions moved effects just to pass this: sound.md, qa.md "Sync
// marks"). window.__reel.sfxStems() renders each kit/custom cue alone (no
// bed, no other cues, no narration), so a mark's own onset can be measured
// there instead; this only falls back to the full mix when no stem exists
// for a mark (an older page, or a mark whose kind sfxStems() could not
// generate).
import { findOnsetOffsetMs } from "./audio-analysis.mjs";

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
