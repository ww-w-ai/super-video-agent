// Shot framing check (EV-43, owner 2026-10-28 on a Gwanghwamun test clip that cut off the statues' heads: "오히려 얼굴과
// 상체가 더 중요한데! … 전체가 보여야지!"). A subject that must be seen whole (a statue, a hero figure, the model in a
// finishing shot) is framed whole in every shot that shows it: every point of it (the 8 corners of its box, plus any
// named points such as the head and the hands) projects inside the frame, at least `margin` of the frame from each edge.
// Cameras use the order gate's format: {eye, target, up?=[0,-1,0], fov (vertical deg)=40, aspect=16/9}; LDraw frame, -Y up.
// Centring (recurrence 2026-10-31, Gwanghwamun Short B: "쇼츠에 중앙이 제일 중요한거야"; Sejong came out right of
// centre): with `center` set, a featured subject's projected box centre must sit within that share of the frame width of
// the frame centre (0.05 = ±5 %, ±54 px on a 1080-wide Short). x is screen RIGHT (a mirrored right axis once made a
// photo-angle check pick the wrong side twice; tests pin it).
// Pure functions; no library or renderer needed.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The 8 corners of a box [x0, y0, z0, x1, y1, z1]. */
export function boxCorners(b) {
  const out = [];
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push([x, y, z]);
  return out;
}

/**
 * Projects a world point through the camera. @returns {{x:number, y:number, depth:number}} x, y in [-1, 1] across the
 * frame when inside it (x right, y up); depth along the view direction (<= 0: behind the camera).
 */
export function project(pt, camera) {
  const eye = camera.eye;
  const fwd = unit(sub(camera.target, eye));
  const up0 = camera.up || [0, -1, 0];
  const right = unit(cross(fwd, up0));
  const up = cross(right, fwd);
  const ty = Math.tan(((camera.fov ?? 40) * Math.PI) / 360);
  const tx = ty * (camera.aspect ?? 16 / 9);
  const v = sub(pt, eye);
  const depth = dot(v, fwd);
  if (depth <= 1e-9) return { x: Infinity, y: Infinity, depth };
  return { x: dot(v, right) / depth / tx, y: dot(v, up) / depth / ty, depth };
}

/**
 * Is the whole subject in frame with a margin? `margin` is a share of the frame size (0.05 = 5 % of the width from the
 * left and right edges, 5 % of the height from the top and bottom).
 * @param {number[][]} points world points of the subject (boxCorners(box), plus head / hand points)
 * @returns {{ok:boolean, worst:number, out:{i:number, x:number, y:number, side:string}[]}} worst = the smallest distance
 *   of any point to an edge, as a share of the frame (negative = outside)
 */
export function framingOf(points, camera, { margin = 0.05, center = null } = {}) {
  const out = [];
  let worst = Infinity;
  let xMin = Infinity, xMax = -Infinity;
  points.forEach((p, i) => {
    const q = project(p, camera);
    if (!(q.depth > 0)) {
      out.push({ i, x: q.x, y: q.y, side: "behind" });
      worst = -Infinity;
      return;
    }
    xMin = Math.min(xMin, q.x);
    xMax = Math.max(xMax, q.x);
    // distance to each edge as a share of the frame: (1 - |x|) / 2
    const dl = (1 + q.x) / 2, dr = (1 - q.x) / 2, db = (1 + q.y) / 2, dt = (1 - q.y) / 2;
    const d = Math.min(dl, dr, db, dt);
    worst = Math.min(worst, d);
    if (d < margin) out.push({ i, x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000, side: d === dt ? "top" : d === db ? "bottom" : d === dl ? "left" : "right" });
  });
  // centre offset: the projected box's horizontal middle against the frame centre, as a share of the frame width
  // (x spans 2 across the frame, so the share is x / 2; + = right of centre)
  const offset = Number.isFinite(xMin) ? Math.round(((xMin + xMax) / 4) * 1000) / 1000 : null;
  const centred = center == null || (offset !== null && Math.abs(offset) <= center);
  return { ok: out.length === 0 && centred, worst: Math.round(worst * 1000) / 1000, out, offset, centred };
}

/**
 * Checks a list of shots: [{t?, camera, subjects: [{name, box?, points?}]}]. Every subject of a shot must be framed whole.
 * `allowBottom: true` on a subject lets its lowest points (a pedestal's foot) leave the frame at the bottom only.
 * `center` (option, or `center` on a subject, which wins; null = not checked) fails a subject whose projected box centre
 * is more than that share of the frame width off the frame centre (featured subjects in vertical Shorts: 0.05).
 * @returns {{checked:number, fails:{t:any, name:string, worst:number, out:object[], offset:number|null, offCentre:boolean}[]}}
 */
export function checkFraming(shots, { margin = 0.05, center = null } = {}) {
  const fails = [];
  let checked = 0;
  for (const s of shots) {
    for (const subj of s.subjects || []) {
      const pts = [...(subj.box ? boxCorners(subj.box) : []), ...(subj.points || [])];
      if (!pts.length) continue;
      checked++;
      const c = subj.center !== undefined ? subj.center : center;
      const r = framingOf(pts, s.camera, { margin, center: c });
      const out = subj.allowBottom ? r.out.filter((o) => o.side !== "bottom") : r.out;
      if (out.length || !r.centred) fails.push({ t: s.t ?? null, name: subj.name || "subject", worst: r.worst, out: out.slice(0, 8), offset: r.offset, offCentre: !r.centred });
    }
  }
  return { checked, fails };
}

/**
 * Pulls a camera back along its view line until the subject is framed whole (keeps its direction, target and fov).
 * @returns {{camera:object, scale:number}|null} null when no distance up to `maxScale` times the current one frames it
 */
export function fitCamera(points, camera, { margin = 0.05, maxScale = 8, step = 1.05 } = {}) {
  const dir = sub(camera.eye, camera.target);
  for (let s = 1; s <= maxScale; s *= step) {
    const cam = { ...camera, eye: [camera.target[0] + dir[0] * s, camera.target[1] + dir[1] * s, camera.target[2] + dir[2] * s] };
    if (framingOf(points, cam, { margin }).ok) return { camera: cam, scale: Math.round(s * 1000) / 1000 };
  }
  return null;
}
