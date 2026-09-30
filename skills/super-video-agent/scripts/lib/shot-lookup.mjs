// Pure mirror of assets/template/reel.html's activeShotIndex(t), kept here
// so the gap-tiling lookup is unit-testable without a browser (the scaffold
// itself has no import/export — it is inlined verbatim into reel.html by
// new-reel.mjs). Keep this in sync with the copy in reel.html by hand; the
// algorithm is small and the shape of `shots` is the same contract review.mjs
// and render.mjs already share (references/pipeline.md's shots tiling).
//
// `shots` spans line i's start to line i+1's start (one shot per line, the
// last shot to the film's end), so a gap between one line's spoken end and
// the next line's start still belongs to the shot before it — this must
// never fall through to -1 once `shots` is non-empty, or a scene picker
// keyed off it wraps to its first scene during every gap.

/**
 * @param {{start:number, end:number}[]} shots tiled, non-overlapping, in order
 * @param {number} t seconds
 * @returns {number} the index of the shot containing `t`, or -1 if `shots` is empty
 */
export function activeShotIndex(shots, t) {
  if (!shots || !shots.length) return -1;
  for (let i = 0; i < shots.length; i++) {
    if (t >= shots[i].start && t < shots[i].end) return i;
  }
  return shots.length - 1; // at or after the film's end: hold the last shot
}
