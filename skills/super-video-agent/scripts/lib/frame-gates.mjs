// Frame-to-frame stability gates for 3D step-build films (references/3d.md "Stable frame in step builds"; EV-73, EV-74).
// Pure functions over per-frame data, so they run on a page probe or on synthetic data; no media is read here.
//
// A frame record: {px, py, vis, cam: [..., azimuth, elevation, ...] (cam[3], cam[4] are the view angles, as the
// reel testbed's debug probe reports), fa: flip angle (optional)}.

// planned camera move = frames where the view angles (cam[3], cam[4]) or the flip angle change, dilated by `dil` frames each side
export function plannedMask(frames, dil = 1, eps = 0.005) {
  const n = frames.length, m = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    const a = frames[i - 1].cam, b = frames[i].cam;
    const turn = Math.abs(b[3] - a[3]) > eps || Math.abs(b[4] - a[4]) > eps;
    const flip = Math.abs((frames[i].fa || 0) - (frames[i - 1].fa || 0)) > 1e-4;
    if (turn || flip) for (let k = i - dil; k <= i + dil; k++) if (k >= 0 && k < n) m[k] = true;
  }
  return m;
}

// Plate-still gate: the base plate (or the model) stays put on screen outside planned turns.
//   still frames: motion <= stillPx (2 px/frame); planned frames: <= movePx (45 px/frame) and camera turn <= turnDegS (270 deg/s).
//   turnWarn (90 deg/s, the owner-facing target for Shorts) is reported, not failed; pass turnFail: turnWarn to enforce it.
// opts.span = [i0, i1] limits the frames judged (the build span); default all.
export function plateStill(frames, fps, opts = {}) {
  const stillPx = opts.stillPx ?? 2, movePx = opts.movePx ?? 45, turnDegS = opts.turnDegS ?? 270, turnWarn = opts.turnWarn ?? 90;
  const planned = plannedMask(frames);
  const [i0, i1] = opts.span || [0, frames.length - 1];
  let maxStill = 0, maxMove = 0, maxTurn = 0, nStill = 0, nMove = 0;
  const bad = [];
  for (let i = Math.max(1, i0 + 1); i <= Math.min(i1, frames.length - 1); i++) {
    const A = frames[i - 1], B = frames[i];
    if (!A.vis || !B.vis) continue;
    const d = Math.hypot(B.px - A.px, B.py - A.py);
    const turn = Math.max(Math.abs(B.cam[3] - A.cam[3]), Math.abs(B.cam[4] - A.cam[4])) * fps;
    maxTurn = Math.max(maxTurn, turn);
    if (planned[i]) { nMove++; maxMove = Math.max(maxMove, d); if (d > movePx) bad.push({ i, kind: "move", px: +d.toFixed(2) }); }
    else { nStill++; maxStill = Math.max(maxStill, d); if (d > stillPx) bad.push({ i, kind: "still", px: +d.toFixed(2) }); }
  }
  if (maxTurn > turnDegS) bad.push({ kind: "turn-speed", degPerS: +maxTurn.toFixed(1) });
  return {
    gate: "plate-still", pass: bad.length === 0, frames: { still: nStill, planned: nMove },
    limits: { stillPx, movePxPerFrame: movePx, turnDegPerS: turnDegS },
    max: { stillPx: +maxStill.toFixed(3), movePx: +maxMove.toFixed(3), turnDegPerS: +maxTurn.toFixed(1) },
    warnTurn: maxTurn > turnWarn ? +maxTurn.toFixed(1) : null, violations: bad.length, first: bad.slice(0, 12),
  };
}

// Road-flicker gate: the ground colour must not change from frame to frame in a static camera.
// `means[i]` = [r, g, b] mean (0-255) of the ground pixels in frame i (ground pixels present in all compared frames), or null.
//   D1 = max channel |mean[i] - mean[i-1]| on pairs with an identical camera vector            <= limit (0.5 / 255)
//   D2 = max channel |mean[i] - (mean[i-1] + mean[i+1]) / 2| outside planned turns (+-2 frames)  <= limit
export function roadFlicker(means, frames, opts = {}) {
  const limit = opts.limit ?? 0.5;
  const planned = plannedMask(frames, 2);
  const [i0, i1] = opts.span || [0, frames.length - 1];
  const lo = Math.max(1, i0), hi = Math.min(means.length - 2, i1, frames.length - 2);
  let d1max = 0, d2max = 0, d1n = 0, d2n = 0;
  const viol = [];
  for (let i = lo; i <= hi; i++) {
    const A = means[i - 1], B = means[i], C = means[i + 1];
    const same = frames[i].cam.every((v, k) => Math.abs(v - frames[i - 1].cam[k]) < 1e-7) && Math.abs((frames[i].fa || 0) - (frames[i - 1].fa || 0)) < 1e-9;
    if (same && A && B) {
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(B[k] - A[k])));
      d1n++; d1max = Math.max(d1max, d);
      if (d > limit) viol.push({ i, kind: "D1", v: +d.toFixed(3) });
    }
    if (!planned[i] && A && B && C) {
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(B[k] - (A[k] + C[k]) / 2)));
      d2n++; d2max = Math.max(d2max, d);
      if (d > limit) viol.push({ i, kind: "D2", v: +d.toFixed(3) });
    }
  }
  return { gate: "road-flicker", pass: viol.length === 0 && d1n + d2n > 0, limit, D1: { pairs: d1n, max: +d1max.toFixed(3) }, D2: { frames: d2n, max: +d2max.toFixed(3) }, violations: viol.length, first: viol.slice(0, 15) };
}
