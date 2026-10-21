// How many frames a film of a given length has. render.mjs draws frames
// 0..N-1 (frame k at k/fps), every check samples the same N frames, and the
// join, dub and A/V gates expect N, so they all take N from here.

/**
 * Frames in a film of `duration` seconds at `fps`: round(duration * fps).
 * A last partial frame is drawn when it covers at least half a frame period
 * and dropped when it covers less; the audio is cut to N / fps.
 * @param {number} duration seconds
 * @param {number} fps
 */
export function filmFrameCount(duration, fps) {
  return Math.round(duration * fps);
}

/**
 * Index of the film's last frame (filmFrameCount - 1), never below 0.
 * @param {number} duration seconds
 * @param {number} fps
 */
export function lastFilmFrame(duration, fps) {
  return Math.max(0, filmFrameCount(duration, fps) - 1);
}
