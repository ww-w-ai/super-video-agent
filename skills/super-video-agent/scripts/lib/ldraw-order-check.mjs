// Build-order gate for LDraw models (references/assembly.md "Required before any render of an LDraw build").
// Renderer-independent: it reads the model (an MPD/LDR or a bake's build.json) and a build order, and judges, for each
// landing in that order:
//   SUPPORT   the landing joins a part placed earlier (stud into an underside, axle/pin, clip/bar, hinge or turntable on its
//             pin line and ball on its socket at any angle (EV-30), minifig) or the
//             ground; a sub-assembly's first part is free (it is built on its own), the rest join earlier members;
//   CROSSING  the arrival sweep (from `travel` away along `from` to `seatLen` away) crosses no triangle of a placed part;
//   ORDER     a part arriving from above has no placed part above it in its column (from below: none below it);
//   VISIBILITY (with a camera list) the landing is not hidden from the camera of its shot.
// Boxes and a spatial hash pick the candidates; the decision is on the parts' own geometry (stud primitives, triangles).
// Units: LDU, LDraw frame (-Y is up). Placement matrices are 3x4 row-major [a b c x, d e f y, g h i z].
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseMpd, parseRef, stepsOf, findBuildModel, isSubModel, norm, openLibrary, flattenPart, partTitle, mul, apply, applyDir, boundsOf, transformBounds } from "./ldraw.mjs";
import { crossingsAt, surfaceOf, CELL as SURFACE_CELL } from "./surface-crossing.mjs";
import { connectionClass } from "./ldraw-connect.mjs";

export const TOOL = "ldraw-order-check";
export const VERSION = 4; // 2: DIRECTION check, 3: VISIBILITY required (EV-29), 4: hinge/ball joints on their pin (EV-30); STABILITY (EV-40) and FIGURE (EV-41) are advisory (listed) unless options.strict, so they need no new version and existing stamps stay valid; a stamp of an older version no longer opens the gate
export const STAMP_NAME = "order-check.json";

const GRID = 40; // spatial hash cell for part boxes (LDU)
const STUD_GRID = 20;
const STUD_MARGIN = 3; // a stud's axis lies at least this far inside the receiving part's box
const STUD_REACH = 8.5; // half width of the zone around a stud where the receiving part's walls or tubes stand
const OVERLAP = 0.5; // box overlap that counts as interpenetration
const MAX_SAMPLES = 160;
const DEFAULT_SEAT = 8;
const PRECISION_TOL = 2e-5; // |R·Rᵀ − I| of a placement matrix: 6 decimals stay ~1e-6, 3 decimals reach ~1e-3
const STUD_CELL = 10; // half a stud pitch: the footprint one seated stud holds
const UPRIGHT = 0.9; // a stud axis this close to vertical holds against gravity (STABILITY)

const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l + 0, v[1] / l + 0, v[2] / l + 0];
};

/** Inverse of a 3x4 affine matrix. */
export function invert(M) {
  const [a, b, c, x, d, e, f, y, g, h, i, z] = M;
  const C00 = e * i - f * h, C01 = -(d * i - f * g), C02 = d * h - e * g;
  const det = a * C00 + b * C01 + c * C02;
  if (Math.abs(det) < 1e-12) throw new Error("a placement matrix is singular");
  const r = 1 / det;
  const m = [C00 * r, -(b * i - c * h) * r, (b * f - c * e) * r, C01 * r, (a * i - c * g) * r, -(a * f - c * d) * r, C02 * r, -(a * h - b * g) * r, (a * e - b * d) * r];
  return [m[0], m[1], m[2], -(m[0] * x + m[1] * y + m[2] * z), m[3], m[4], m[5], -(m[3] * x + m[4] * y + m[5] * z), m[6], m[7], m[8], -(m[6] * x + m[7] * y + m[8] * z)];
}

/** Named arrival directions (where the part comes from; LDraw -Y is up). */
export function parseFrom(v) {
  if (v == null || v === "auto") return "auto";
  if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return unit(v);
  const named = { above: [0, -1, 0], top: [0, -1, 0], below: [0, 1, 0], bottom: [0, 1, 0], "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };
  if (typeof v === "string" && named[v.toLowerCase()]) return named[v.toLowerCase()];
  throw new Error(`arrival direction must be [x,y,z], "auto" or one of ${Object.keys(named).join(", ")} (got ${JSON.stringify(v)})`);
}

// ---------------------------------------------------------------- spatial hash

class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  key(x, y, z) {
    return ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);
  }
  cells(b, fn) {
    const c = this.cell;
    const x1 = Math.floor(b[3] / c), y1 = Math.floor(b[4] / c), z1 = Math.floor(b[5] / c);
    for (let x = Math.floor(b[0] / c); x <= x1; x++) for (let y = Math.floor(b[1] / c); y <= y1; y++) for (let z = Math.floor(b[2] / c); z <= z1; z++) fn(this.key(x, y, z));
  }
  insert(id, b) {
    this.cells(b, (k) => {
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(id);
    });
  }
  /** Calls fn(id) once per id whose cells meet box b (`seen` is a stamp array and `tag` this query's number). */
  query(b, seen, tag, fn) {
    this.cells(b, (k) => {
      const a = this.map.get(k);
      if (!a) return;
      for (const id of a) {
        if (seen[id] === tag) continue;
        seen[id] = tag;
        fn(id);
      }
    });
  }
}

const grow = (b, e) => [b[0] - e, b[1] - e, b[2] - e, b[3] + e, b[4] + e, b[5] + e];
const overlaps = (A, B, e) => A[0] < B[3] - e && B[0] < A[3] - e && A[1] < B[4] - e && B[1] < A[4] - e && A[2] < B[5] - e && B[2] < A[5] - e;
const xzOverlap = (A, B, e) => A[0] < B[3] - e && B[0] < A[3] - e && A[2] < B[5] - e && B[2] < A[5] - e;
const inBox = (p, b, e) => p[0] >= b[0] - e && p[0] <= b[3] + e && p[1] >= b[1] - e && p[1] <= b[4] + e && p[2] >= b[2] - e && p[2] <= b[5] + e;

// ---------------------------------------------------------------- triangle / box overlap (separating axes)

function triTouchesBox(v, o, c, h) {
  const a0 = v[o] - c[0], a1 = v[o + 1] - c[1], a2 = v[o + 2] - c[2];
  const b0 = v[o + 3] - c[0], b1 = v[o + 4] - c[1], b2 = v[o + 5] - c[2];
  const d0 = v[o + 6] - c[0], d1 = v[o + 7] - c[1], d2 = v[o + 8] - c[2];
  const P = [[a0, a1, a2], [b0, b1, b2], [d0, d1, d2]];
  for (let k = 0; k < 3; k++) {
    if (Math.min(P[0][k], P[1][k], P[2][k]) > h[k] || Math.max(P[0][k], P[1][k], P[2][k]) < -h[k]) return false;
  }
  const E = [[b0 - a0, b1 - a1, b2 - a2], [d0 - b0, d1 - b1, d2 - b2], [a0 - d0, a1 - d1, a2 - d2]];
  const n = [E[0][1] * E[1][2] - E[0][2] * E[1][1], E[0][2] * E[1][0] - E[0][0] * E[1][2], E[0][0] * E[1][1] - E[0][1] * E[1][0]];
  const s = n[0] * a0 + n[1] * a1 + n[2] * a2;
  if (Math.abs(s) > h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2])) return false;
  for (const e of E) {
    for (let k = 0; k < 3; k++) {
      const ax = [0, 0, 0];
      // unit axis k x e
      if (k === 0) { ax[1] = -e[2]; ax[2] = e[1]; }
      else if (k === 1) { ax[0] = e[2]; ax[2] = -e[0]; }
      else { ax[0] = -e[1]; ax[1] = e[0]; }
      const p0 = ax[0] * P[0][0] + ax[1] * P[0][1] + ax[2] * P[0][2];
      const p1 = ax[0] * P[1][0] + ax[1] * P[1][1] + ax[2] * P[1][2];
      const p2 = ax[0] * P[2][0] + ax[1] * P[2][1] + ax[2] * P[2][2];
      const r = h[0] * Math.abs(ax[0]) + h[1] * Math.abs(ax[1]) + h[2] * Math.abs(ax[2]);
      if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
    }
  }
  return true;
}

/** Does any triangle of a surface (surfaceOf) meet the box lo..hi? */
function surfaceTouchesBox(surf, lo, hi) {
  if (hi[0] < surf.box[0] || lo[0] > surf.box[3] || hi[1] < surf.box[1] || lo[1] > surf.box[4] || hi[2] < surf.box[2] || lo[2] > surf.box[5]) return false;
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const h = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const seen = new Set();
  const C = SURFACE_CELL;
  for (let x = Math.floor(lo[0] / C); x <= Math.floor(hi[0] / C); x++)
    for (let y = Math.floor(lo[1] / C); y <= Math.floor(hi[1] / C); y++)
      for (let z = Math.floor(lo[2] / C); z <= Math.floor(hi[2] / C); z++) {
        const cell = surf.grid.get(x + "," + y + "," + z);
        if (!cell) continue;
        for (const i of cell) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (triTouchesBox(surf.v, i * 9, c, h)) return true;
        }
      }
  return false;
}

/** Does segment p->q pass strictly through the inside of triangle o of v (Moller-Trumbore, endpoints and edges excluded)? */
function segPierces(p, q, v, o) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const e1x = v[o + 3] - v[o], e1y = v[o + 4] - v[o + 1], e1z = v[o + 5] - v[o + 2];
  const e2x = v[o + 6] - v[o], e2y = v[o + 7] - v[o + 1], e2z = v[o + 8] - v[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  const len2 = (dx * dx + dy * dy + dz * dz) * (e1x * e1x + e1y * e1y + e1z * e1z);
  if (det * det < 1e-12 * len2 || det === 0) return false; // the segment runs along the triangle's plane
  const inv = 1 / det;
  const tx = p[0] - v[o], ty = p[1] - v[o + 1], tz = p[2] - v[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u <= 1e-4 || u >= 1 - 1e-4) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w <= 1e-4 || u + w >= 1 - 1e-4) return false;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s > 1e-4 && s < 1 - 1e-4;
}

/** Does segment p->q pierce any triangle of a surface (surfaceOf, with its grid)? */
function segmentHitsSurface(surf, p, q) {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  const steps = Math.max(1, Math.ceil(len / SURFACE_CELL));
  const C = SURFACE_CELL;
  const seen = new Set();
  for (let s = 0; s < steps; s++) {
    const a = [0, 1, 2].map((k) => p[k] + ((q[k] - p[k]) * s) / steps);
    const b = [0, 1, 2].map((k) => p[k] + ((q[k] - p[k]) * (s + 1)) / steps);
    const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k])), hi = [0, 1, 2].map((k) => Math.max(a[k], b[k]));
    if (hi[0] < surf.box[0] || lo[0] > surf.box[3] || hi[1] < surf.box[1] || lo[1] > surf.box[4] || hi[2] < surf.box[2] || lo[2] > surf.box[5]) continue;
    for (let x = Math.floor(lo[0] / C); x <= Math.floor(hi[0] / C); x++)
      for (let y = Math.floor(lo[1] / C); y <= Math.floor(hi[1] / C); y++)
        for (let z = Math.floor(lo[2] / C); z <= Math.floor(hi[2] / C); z++) {
          const cell = surf.grid.get(x + "," + y + "," + z);
          if (!cell) continue;
          for (const i of cell) {
            if (seen.has(i)) continue;
            seen.add(i);
            if (segPierces(p, q, surf.v, i * 9)) return true;
          }
        }
  }
  return false;
}

/**
 * The corners of the triangles that meet the motion head-on (|normal . dir| >= PARALLEL), each moved 0.3 LDU toward its
 * own triangle's centre: swept along the motion they find a part passing through another even when every face of the two
 * lies flush (same-size bricks in one course), and they stay clear of a tight hole an axle runs through.
 */
function headOnCorners(tris, dir) {
  const out = [];
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const ax = tris[o + 3] - tris[o], ay = tris[o + 4] - tris[o + 1], az = tris[o + 5] - tris[o + 2];
    const bx = tris[o + 6] - tris[o], by = tris[o + 7] - tris[o + 1], bz = tris[o + 8] - tris[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz);
    if (!nl || Math.abs((nx * dir[0] + ny * dir[1] + nz * dir[2]) / nl) < 0.08) continue;
    const c = [(tris[o] + tris[o + 3] + tris[o + 6]) / 3, (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3, (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3];
    for (let k = 0; k < 3; k++) {
      const v = [tris[o + k * 3], tris[o + k * 3 + 1], tris[o + k * 3 + 2]];
      const dist = Math.hypot(c[0] - v[0], c[1] - v[1], c[2] - v[2]);
      if (!dist) continue;
      const f = Math.min(0.3 / dist, 0.5);
      out.push([v[0] + (c[0] - v[0]) * f, v[1] + (c[1] - v[1]) * f, v[2] + (c[2] - v[2]) * f]);
    }
  }
  return out;
}

/** The moving side of a crossing test: triangles with normals (no grid; reel-crossing reads only v, nrm, n). */
function movingSurface(tris) {
  const n = Math.floor(tris.length / 9);
  const v = Float64Array.from(tris);
  const nrm = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = v[o + 3] - v[o], ay = v[o + 4] - v[o + 1], az = v[o + 5] - v[o + 2];
    const bx = v[o + 6] - v[o], by = v[o + 7] - v[o + 1], bz = v[o + 8] - v[o + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const len = Math.hypot(cx, cy, cz) || 1;
    nrm[i * 3] = cx / len;
    nrm[i * 3 + 1] = cy / len;
    nrm[i * 3 + 2] = cz / len;
  }
  return { v, nrm, n };
}

// ---------------------------------------------------------------- parts

// A stud primitive (p/stud*.dat): its title starts with "Stud". Stud groups (stug-*.dat) are walked into, tubes and
// underside primitives are the receiving side and are left to the receiving-part test.
const MALE_STUD = (title) => /^Stud\b/i.test(title) && !/Group|Tube|Underside|Placeholder|Extension/i.test(title);
const firstTitle = (lib, name) => lib.readPart(name).split(/\r?\n/, 1)[0].replace(/^\s*0\s+/, "").trim();

/** Male studs of a library file in its own frame: [{p: base centre, a: unit axis pointing out of the stud}]. */
function studsOf(lib, name, cache) {
  const id = norm(name);
  if (cache.has(id)) return cache.get(id);
  const out = [];
  cache.set(id, out);
  for (const raw of lib.readPart(name).split(/\r?\n/)) {
    const ref = parseRef(raw);
    if (!ref) continue;
    if (MALE_STUD(firstTitle(lib, ref.file))) {
      out.push({ p: [ref.m[3], ref.m[7], ref.m[11]], a: unit(applyDir(ref.m, 0, -1, 0)) });
      continue;
    }
    for (const s of studsOf(lib, ref.file, cache)) out.push({ p: apply(ref.m, ...s.p), a: unit(applyDir(ref.m, ...s.a)) });
  }
  return out;
}

const TAG_RULES = [
  ["minifig", /^Minifig/i],
  ["axis", /\b(Axle|Pin|Peg|Bush|Bushing)\b/i],
  ["hole", /^Technic\b|\b(Liftarm|Beam|Hole|Holes|Hub|Gear|Bush)\b/i],
  ["clip", /\b(Clip|Clips|Hinge|Finger|Fingers|Click|Handle|Bar|Lightsaber|Antenna|Ladder|Hose|Whip|Rod|Tow Ball|Ball|Socket|Turntable|Fishing)\b/i],
  ["wheel", /\b(Wheel|Tyre|Tire|Rim)\b/i],
];
const TAG_PAIRS = new Set(["axis:hole", "axis:axis", "axis:wheel", "hole:wheel", "wheel:wheel", "clip:clip", "clip:minifig", "minifig:minifig", "axis:clip"]);
const pairOk = (A, B) => {
  if (A.has("loose") || B.has("loose")) return true;
  for (const a of A) for (const b of B) if (TAG_PAIRS.has(`${a}:${b}`) || TAG_PAIRS.has(`${b}:${a}`)) return true;
  return false;
};

const DIR_COS = 0.94; // an arrival within ~20 degrees of the joint axis matches
const DIR_PERP = 0.34; // "perpendicular" = within ~20 degrees of square to the bar
const BAR_TITLE = /\b(Bar|Handle|Antenna|Lightsaber|Rod|Whip|Fishing|Hose|Tow Ball)\b/i;

/**
 * Bar segments of a library file in its own frame: radius-4 cylinder primitives (a 3.18 mm bar, 8 LDU across), as
 * [{p: one end, a: unit axis, len}]. Holes (radius 4 cylinders after BFC INVERTNEXT) are not told apart here; a clip
 * joint only uses the bar of the part that has one.
 */
function barsOf(lib, name, cache) {
  const id = norm(name);
  if (cache.has(id)) return cache.get(id);
  const out = [];
  cache.set(id, out);
  for (const raw of lib.readPart(name).split(/\r?\n/)) {
    const ref = parseRef(raw);
    if (!ref) continue;
    const base = norm(ref.file).split("/").pop();
    if (/^\d+-\d+cyl\w*\.dat$/.test(base)) {
      const m = ref.m;
      const r0 = Math.hypot(m[0], m[4], m[8]), r2 = Math.hypot(m[2], m[6], m[10]);
      const ax = [m[1], m[5], m[9]];
      const len = Math.hypot(...ax);
      if (Math.abs(r0 - 4) < 0.3 && Math.abs(r2 - 4) < 0.3 && len > 1) out.push({ p: [m[3], m[7], m[11]], a: unit(ax), len });
      continue;
    }
    if (/^\d+-\d+\w*\.dat$/.test(base) || /^(stud|stug|box|rect|disc|edge|ring|ndis|con)/.test(base)) continue;
    for (const s of barsOf(lib, ref.file, cache)) out.push({ p: apply(ref.m, ...s.p), a: unit(applyDir(ref.m, ...s.a)), len: s.len * Math.hypot(...applyDir(ref.m, ...s.a)) });
  }
  return out;
}

// ---------------------------------------------------------------- minifig placement units (EV-41)

/**
 * A minifig body part's class from its library title: "torso", "arm", "hand", "hips", "legs" (hips and legs in one
 * part), "leg", "head", "headwear" (hair, hat, helmet, cap, headdress ...), or null (not a minifig body part; a held
 * item, a tool or a brick).
 */
export function figureClassOf(title0) {
  const t = String(title0).replace(/^[~_=]+/, "");
  if (!/^Minifig\b/i.test(t)) return null;
  if (/^Minifig Torso/i.test(t)) return "torso";
  if (/^Minifig Arm/i.test(t)) return "arm";
  if (/^Minifig Hand\b/i.test(t)) return "hand";
  if (/^Minifig Hips and Legs/i.test(t)) return "legs";
  if (/^Minifig Hips\b/i.test(t)) return "hips";
  if (/^Minifig Legs?\b/i.test(t)) return "leg";
  if (/^Minifig Head\b/i.test(t)) return "head";
  if (/^Minifig (Hair|Hat|Helmet|Cap|Headdress|Headgear|Crown|Hood|Visor|Bandana|Turban|Beanie|Wig)/i.test(t)) return "headwear";
  return null;
}
/** The placement a body class belongs to (owner 2026-10-28): lower body, upper body, head. */
export const FIGURE_UNIT = { hips: "lower", legs: "lower", leg: "lower", torso: "upper", arm: "upper", hand: "upper", head: "head", headwear: "head" };
// a landing with one of these must also hold the part it hangs on: never a hand or arm before (or apart from) its torso
const FIGURE_NEEDS = { arm: ["torso"], hand: ["torso"], leg: ["hips", "legs"], headwear: ["head"] };

/**
 * FIGURE check of one landing's member titles: an arm or hand lands only with its torso, a leg only with the hips, hair or
 * a hat only with the head. @returns {null | {missing:string, classes:string[]}}
 */
export function figureLanding(titles) {
  const cls = new Set(titles.map(figureClassOf).filter(Boolean));
  for (const c of cls) {
    const need = FIGURE_NEEDS[c];
    if (need && !need.some((n) => cls.has(n))) return { missing: need[0], classes: [...cls] };
  }
  return null;
}

/**
 * Planner helper: the minifig units of a build order, from each landing's part title in order. A unit is a run of
 * consecutive landings of one placement (lower body, upper body, head); runs of 2 or more become
 * {k0, k1 (exclusive), kind: "figure", name, rigid: true, from: [0,-1,0]}, the `--groups` / stage.json format. A held
 * item that lands right after its hand joins the upper body when `held(k)` says so.
 */
export function figureUnits(titles, { held = () => false } = {}) {
  const out = [];
  let run = null, fig = 0, lastRank = -1;
  const rank = { lower: 0, upper: 1, head: 2 };
  const close = () => {
    if (run && run.k1 - run.k0 >= 2) out.push({ k0: run.k0, k1: run.k1, kind: "figure", rigid: true, name: `minifig ${run.fig} ${run.unit === "lower" ? "lower body" : run.unit === "upper" ? "upper body" : "head"}`, from: [0, -1, 0] });
    run = null;
  };
  titles.forEach((t, k) => {
    const c = figureClassOf(t);
    const u = c ? FIGURE_UNIT[c] : run && run.unit === "upper" && held(k) ? "upper" : null;
    if (run && u === run.unit && run.k1 === k) { run.k1 = k + 1; return; }
    close();
    if (!u) return;
    if (rank[u] <= lastRank || fig === 0) fig++;
    lastRank = rank[u];
    run = { k0: k, k1: k + 1, unit: u, fig };
  });
  close();
  return out;
}

// ---------------------------------------------------------------- articulated joints (EV-30): hinge, click hinge, turntable, ball

/** The articulated family of a part from its title: "hinge" (hinge plates/bricks/tiles, finger and click hinges), "turntable", "ball" (ball joint, socket, tow ball), or null. */
export function articOf(title0) {
  const title = String(title0).replace(/^[~_=]+/, "");
  if (/\bTurntable\b/i.test(title)) return "turntable";
  if (/\b(Ball|Socket)\b/i.test(title)) return "ball";
  if (/\b(Hinge|Finger|Fingers|Click)\b/i.test(title)) return "hinge";
  return null;
}

const CIRCLE_PRIM = /^\d+-\d+(cyl\w*|ring\w*|disc|ndis|con\w*|edge|chrd|tang)\.dat$/;
const SPHERE_PRIM = /^\d+-\d+sph\w*\.dat$/;
const JOINT_PRIM = /^joint\d*(ball|socket)\w*\.dat$/;
const HINGE_COS = 0.996; // pin axes within ~5 degrees
const HINGE_OFF = 0.75; // pin lines within 0.75 LDU of each other
const HINGE_GAP = 12; // knuckles of the two halves sit within 12 LDU along the pin
const BALL_OFF = 1.5; // ball centre within 1.5 LDU of the socket centre

/**
 * Pivot features of a library file in its own frame: circles (cylinder, ring, disc, cone and edge primitives of radius
 * 1.5..12: knuckles, pins, turntable rings) as {c, a, r}, and ball/socket centres (joint ball/socket primitives, sphere
 * primitives) as {c, kind}. Studs, tubes and boxes are not walked into.
 */
function pivotsOf(lib, name, cache) {
  const id = norm(name);
  if (cache.has(id)) return cache.get(id);
  const out = { circles: [], centers: [] };
  cache.set(id, out);
  for (const raw of lib.readPart(name).split(/\r?\n/)) {
    const ref = parseRef(raw);
    if (!ref) continue;
    const base = norm(ref.file).split("/").pop();
    const m = ref.m;
    if (CIRCLE_PRIM.test(base)) {
      const c0 = [m[0], m[4], m[8]], c2 = [m[2], m[6], m[10]];
      const r0 = Math.hypot(...c0), r2 = Math.hypot(...c2);
      if (r0 >= 1.5 && r0 <= 12 && Math.abs(r0 - r2) < 0.1 * r0) out.circles.push({ c: [m[3], m[7], m[11]], a: unit([c0[1] * c2[2] - c0[2] * c2[1], c0[2] * c2[0] - c0[0] * c2[2], c0[0] * c2[1] - c0[1] * c2[0]]), r: r0 });
      continue;
    }
    if (JOINT_PRIM.test(base) || SPHERE_PRIM.test(base)) {
      out.centers.push({ c: [m[3], m[7], m[11]], kind: /socket/.test(base) ? "socket" : "ball" });
      continue;
    }
    if (/^(stud|stug|box|rect|tri|axle|axl|peghole|connhole|beamhole|npeghol|\d+-\d+)/.test(base)) continue;
    const sub = pivotsOf(lib, ref.file, cache);
    for (const s of sub.circles) out.circles.push({ c: apply(m, ...s.c), a: unit(applyDir(m, ...s.a)), r: s.r });
    for (const s of sub.centers) out.centers.push({ c: apply(m, ...s.c), kind: s.kind });
  }
  return out;
}

/** An axis with its largest component positive (so a swing angle has one sign convention). */
const canonAxis = (a) => {
  let k = 0;
  if (Math.abs(a[1]) > Math.abs(a[k])) k = 1;
  if (Math.abs(a[2]) > Math.abs(a[k])) k = 2;
  return a[k] < 0 ? a.map((x) => -x + 0) : a.slice();
};

/** 3x3 rotation (row-major, 9 numbers) by deg about unit axis a (right-hand rule). */
function rotation(a, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const [x, y, z] = a;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Placement matrix m turned by rotation R (3x3) about the line through point c. */
function turnAbout(m, R, c) {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = R[i * 3] * m[j] + R[i * 3 + 1] * m[4 + j] + R[i * 3 + 2] * m[8 + j];
    const d = [m[3] - c[0], m[7] - c[1], m[11] - c[2]];
    out[i * 4 + 3] = c[i] + R[i * 3] * d[0] + R[i * 3 + 1] * d[1] + R[i * 3 + 2] * d[2];
  }
  return out;
}

/** The world axis of a placement's bar: its longest radius-4 cylinder run, else its longest extent. */
function barAxis(pl) {
  const bars = pl.part.bars;
  if (bars && bars.length) {
    const best = bars.reduce((x, y) => (y.len > x.len ? y : x));
    return unit(applyDir(pl.m, ...best.a));
  }
  return partAxis(pl, "long");
}

/** A placement's own long (or short) axis in the world: an axle runs along its longest extent, a wheel or bush turns on its shortest. */
function partAxis(pl, which) {
  const b = pl.part.bounds;
  const ext = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  const pick = which === "short" ? Math.min(...ext) : Math.max(...ext);
  const k = ext.indexOf(pick);
  return unit(applyDir(pl.m, k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0));
}

/** The kind and allowed arrival of a box-found joint between moving p and placed Q (see jointsOf). */
function tagJoint(p, Q) {
  const A = p.part.tags, B = Q.part.tags;
  if (A.has("loose") || B.has("loose")) return { kind: "loose", rule: "any" };
  const axleish = (t) => t.has("axis") || t.has("hole") || t.has("wheel");
  if (axleish(A) && axleish(B) && pairOk(new Set([...A].filter((t) => t !== "clip" && t !== "minifig")), new Set([...B].filter((t) => t !== "clip" && t !== "minifig")))) {
    // the axle is whichever side is an axle/pin; with none (wheel on a hub, tyre on a rim) the wheel's turning axis
    const axle = B.has("axis") ? { pl: Q, which: /Bush/i.test(Q.part.title) ? "short" : "long" }
      : A.has("axis") ? { pl: p, which: /Bush/i.test(p.part.title) ? "short" : "long" }
      : { pl: B.has("wheel") ? Q : p, which: "short" };
    return { kind: "axle", rule: "axis", v: partAxis(axle.pl, axle.which) };
  }
  if (A.has("minifig") && B.has("minifig")) return { kind: "minifig", rule: "any" };
  if (/Hinge/i.test(p.part.title) || /Hinge/i.test(Q.part.title)) return { kind: "hinge", rule: "any" };
  const bar = BAR_TITLE.test(Q.part.title) ? Q : BAR_TITLE.test(p.part.title) ? p : B.has("axis") ? Q : A.has("axis") ? p : null;
  if (bar) return { kind: "clip", rule: "perp", v: barAxis(bar) };
  return { kind: A.has("minifig") || B.has("minifig") ? "minifig" : "clip", rule: "any" };
}

/** Joint tags of a part from its title (and the overrides), beyond the stud test that every part gets. */
export function jointTags(title0, id, classes = {}, loose = null) {
  const title = String(title0).replace(/^[~_=]+/, ""); // "~Minifig Hips (Obsolete)", "_Brick ..." keep their kind
  const tags = new Set();
  const over = classes[id];
  if (over) for (const t of [].concat(over)) tags.add(t === "stud" ? "stud" : t);
  else {
    for (const [tag, re] of TAG_RULES) if (re.test(title)) tags.add(tag);
    if (connectionClass(title, id) === "axis") tags.add("axis");
  }
  if (loose && (loose.test(title) || loose.test(id))) tags.add("loose");
  tags.delete("stud");
  return tags;
}

/**
 * A model context: the placements with their world boxes, studs and tags, read once from the parts library.
 * @param {{libraryDir?:string, library?:object, placements:{uid:string, part:string, m:number[]}[], classes?:object, loose?:RegExp|null}} args
 *   `part` is the library file without ".dat" (as a bake's build.json writes it), or with it.
 */
export function createModel({ libraryDir, library, placements, classes = {}, loose = null }) {
  const lib = library || openLibrary(libraryDir);
  const studCache = new Map();
  const barCache = new Map();
  const pivotCache = new Map();
  const parts = new Map();
  const partOf = (id) => {
    let p = parts.get(id);
    if (p) return p;
    const file = /\.dat$/i.test(id) ? id : `${id}.dat`;
    const flat = flattenPart(lib, file);
    const tris = [];
    for (const arr of flat.tris.values()) for (const x of arr) tris.push(x);
    const bounds = tris.length ? boundsOf([tris]) : [0, 0, 0, 0, 0, 0];
    const title = partTitle(lib, file);
    const tags = jointTags(title, norm(id).replace(/\.dat$/, ""), classes, loose);
    const artic = tags.has("clip") || tags.size === 0 ? articOf(title) : null;
    p = { id, file, title, tris, bounds, studs: studsOf(lib, file, studCache), bars: barsOf(lib, file, barCache), tags, artic, pivots: artic ? pivotsOf(lib, file, pivotCache) : null, _surf: null, _corners: null };
    parts.set(id, p);
    return p;
  };
  const surfaceOfPart = (p) => p._surf || (p._surf = surfaceOf(p.tris));
  const cornersOf = (p, dirLocal) => {
    const key = dirLocal.map((x) => Math.round(x * 1000)).join(",");
    if (!p._corners) p._corners = new Map();
    if (!p._corners.has(key)) p._corners.set(key, headOnCorners(p.tris, dirLocal));
    return p._corners.get(key);
  };
  /** Up to 32 points on a part's surface (centroids of its larger triangles, spread over the list), in its own frame. */
  const samplesOf = (p) => {
    if (p._samples) return p._samples;
    const t = p.tris;
    const all = [];
    for (let o = 0; o + 8 < t.length; o += 9) {
      const ax = t[o + 3] - t[o], ay = t[o + 4] - t[o + 1], az = t[o + 5] - t[o + 2];
      const bx = t[o + 6] - t[o], by = t[o + 7] - t[o + 1], bz = t[o + 8] - t[o + 2];
      const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
      if (area >= 1) all.push([(t[o] + t[o + 3] + t[o + 6]) / 3, (t[o + 1] + t[o + 4] + t[o + 7]) / 3, (t[o + 2] + t[o + 5] + t[o + 8]) / 3]);
    }
    const n = Math.min(32, all.length);
    const out = [];
    for (let k = 0; k < n; k++) out.push(all[Math.floor((k * all.length) / n)]);
    return (p._samples = out);
  };
  /** Placement pl's triangles in another part's frame (rel = inverse of that part's matrix x pl.m). */
  const trisIn = (pl, _inv, rel) => {
    const t = pl.part.tris;
    const out = new Array(t.length);
    for (let i = 0; i < t.length; i += 3) {
      const w = apply(rel, t[i], t[i + 1], t[i + 2]);
      out[i] = w[0];
      out[i + 1] = w[1];
      out[i + 2] = w[2];
    }
    return movingSurface(out);
  };
  const P = placements.map((pl, idx) => {
    if (!pl || typeof pl.uid !== "string" || !Array.isArray(pl.m) || pl.m.length !== 12) throw new Error(`placement ${idx} needs uid, part and a 12-number matrix m`);
    const part = partOf(String(pl.part));
    return { idx, uid: pl.uid, part, m: pl.m, box: transformBounds(pl.m, part.bounds), _inv: null, _studs: null };
  });
  const byUid = new Map(P.map((p) => [p.uid, p.idx]));
  if (byUid.size !== P.length) throw new Error("two placements share a uid");
  // PRECISION (EV-42): a rotation written with too few decimals is no longer a rotation; tilted parts then sit a fraction
  // of an LDU inside their neighbours and show up as false CROSSING. Listed, not failed.
  const imprecise = [];
  for (const p of P) {
    const r = [p.m[0], p.m[1], p.m[2], p.m[4], p.m[5], p.m[6], p.m[8], p.m[9], p.m[10]];
    let err = 0;
    for (let a = 0; a < 3; a++)
      for (let b = a; b < 3; b++) {
        const d = r[3 * a] * r[3 * b] + r[3 * a + 1] * r[3 * b + 1] + r[3 * a + 2] * r[3 * b + 2];
        err = Math.max(err, Math.abs(d - (a === b ? 1 : 0)));
      }
    if (err > PRECISION_TOL) imprecise.push({ uid: p.uid, part: p.part.id, error: Number(err.toExponential(2)) });
  }
  const invOf = (p) => p._inv || (p._inv = invert(p.m));
  const studsW = (p) => p._studs || (p._studs = p.part.studs.map((s) => ({ p: apply(p.m, ...s.p), a: unit(applyDir(p.m, ...s.a)), owner: p.idx })));
  let groundY = -Infinity;
  for (const p of P) groundY = Math.max(groundY, p.box[4]);
  const hasLoose = P.some((p) => p.part.tags.has("loose"));

  /** A placement-like object for a pose that is not in the model (a hinge half at its rest angle, mid-swing). */
  const posed = (pl, m) => ({ idx: -1, uid: pl.uid, part: pl.part, m, box: transformBounds(m, pl.part.bounds), _inv: null, _studs: null });
  const pivotsW = (pl) => {
    if (pl._piv) return pl._piv;
    const pv = pl.part.pivots || { circles: [], centers: [] };
    return (pl._piv = { circles: pv.circles.map((s) => ({ c: apply(pl.m, ...s.c), a: unit(applyDir(pl.m, ...s.a)) })), centers: pv.centers.map((s) => ({ c: apply(pl.m, ...s.c), kind: s.kind })) });
  };
  const jointCache = new Map();
  /**
   * The articulated joint between placements p and q, at any angle about it: {kind:"hinge"|"turntable", axis, point}
   * when a pin circle of each lies on one line (axes parallel, lines within HINGE_OFF, knuckles within HINGE_GAP along
   * it), {kind:"ball", point} when a ball centre of one sits on a socket centre of the other, or {kind, legacy:true}
   * when one of the parts has no pivot primitive (then box overlap decides, as before). null = they do not join.
   */
  const articJoint = (p, q) => {
    const A = p.part.artic, B = q.part.artic;
    if (!A || !B) return null;
    const key = p.idx >= 0 && q.idx >= 0 ? (p.idx < q.idx ? `${p.idx}|${q.idx}` : `${q.idx}|${p.idx}`) : null;
    if (key && jointCache.has(key)) return jointCache.get(key);
    let r = null;
    if (overlaps(p.box, q.box, OVERLAP)) {
      const ball = A === "ball" || B === "ball";
      const kind = ball ? "ball" : A === "turntable" || B === "turntable" ? "turntable" : "hinge";
      if (ball && A !== B) r = null;
      else if (ball) {
        const ca = pivotsW(p).centers, cb = pivotsW(q).centers;
        if (!ca.length || !cb.length) r = { kind, legacy: true };
        else
          for (const x of ca) {
            for (const y of cb) if (Math.hypot(x.c[0] - y.c[0], x.c[1] - y.c[1], x.c[2] - y.c[2]) <= BALL_OFF) { r = { kind, point: x.c.slice() }; break; }
            if (r) break;
          }
      } else {
        const ca = pivotsW(p).circles, cb = pivotsW(q).circles;
        if (!ca.length || !cb.length) r = { kind, legacy: true };
        else
          outer: for (const x of ca)
            for (const y of cb) {
              const d = x.a[0] * y.a[0] + x.a[1] * y.a[1] + x.a[2] * y.a[2];
              if (Math.abs(d) < HINGE_COS) continue;
              const w = [y.c[0] - x.c[0], y.c[1] - x.c[1], y.c[2] - x.c[2]];
              const along = w[0] * x.a[0] + w[1] * x.a[1] + w[2] * x.a[2];
              if (Math.abs(along) > HINGE_GAP) continue;
              if (Math.hypot(w[0] - along * x.a[0], w[1] - along * x.a[1], w[2] - along * x.a[2]) > HINGE_OFF) continue;
              r = { kind, axis: canonAxis(x.a), point: x.c.slice() };
              break outer;
            }
      }
    }
    if (key) jointCache.set(key, r);
    return r;
  };
  return { lib, P, byUid, partOf, surfaceOfPart, cornersOf, trisIn, samplesOf, invOf, studsW, groundY, hasLoose, posed, articJoint, imprecise };
}

/**
 * Does stud s (world {p, a}) of one placement seat in placement r? In r's own frame: the stud axis runs along one of r's
 * axes, the stud lies inside r's box with a margin, and r has walls, tubes or a face within the stud's zone.
 */
function studInto(model, s, r) {
  const inv = model.invOf(r);
  const p = apply(inv, ...s.p);
  const a = unit(applyDir(inv, ...s.a));
  let k = 0;
  if (Math.abs(a[1]) > Math.abs(a[k])) k = 1;
  if (Math.abs(a[2]) > Math.abs(a[k])) k = 2;
  if (Math.abs(a[k]) < 0.95) return false;
  const b = r.part.bounds;
  for (let o = 0; o < 3; o++) {
    if (o === k) continue;
    if (p[o] <= b[o] + STUD_MARGIN || p[o] >= b[o + 3] - STUD_MARGIN) return false;
  }
  if (p[k] < b[k] - 1 || p[k] > b[k + 3] + 1) return false;
  const sg = Math.sign(a[k]);
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let o = 0; o < 3; o++) {
    if (o === k) {
      const e1 = p[k] - 0.5 * sg, e2 = p[k] + 3.5 * sg;
      lo[o] = Math.min(e1, e2);
      hi[o] = Math.max(e1, e2);
    } else {
      lo[o] = p[o] - STUD_REACH;
      hi[o] = p[o] + STUD_REACH;
    }
  }
  return surfaceTouchesBox(model.surfaceOfPart(r.part), lo, hi);
}

// ---------------------------------------------------------------- one build (the main model, or a sub-assembly built on its own)

/**
 * The incremental state of one build: what is placed, and the three checks against it. A planner can use it directly:
 * ask `supportOf`, `blockersOf` and `crossingsOf` for a candidate, then `place` it.
 * @param {object} model createModel(...)
 * @param {{ground?: number|null}} [opts] the table height (LDraw y of the lowest part bottom); null = no ground (a sub-assembly)
 */
export function createBuild(model, { ground = model.groundY } = {}) {
  const N = model.P.length;
  const placed = new Uint8Array(N);
  const boxes = new Grid(GRID);
  const columns = new Grid(GRID); // x-z only (y cell 0)
  const studs = new Grid(STUD_GRID);
  const studList = [];
  const seen = new Int32Array(N).fill(-1);
  const seenStud = [];
  let tag = 0;
  let count = 0;

  /** How each member is held: {ok, how, with, from} (from = the arrival direction this join implies). */
  function supportOf(members, { first = false } = {}) {
    if (first) return { ok: true, how: "first part of its build", with: null, from: [0, -1, 0] };
    let fallback = null;
    const pick = (r) => {
      if (r.from[1] < -0.5) return r;
      if (!fallback) fallback = r;
      return null;
    };
    for (const i of members) {
      const p = model.P[i];
      if (ground != null && Number.isFinite(ground) && p.box[4] >= ground - 0.5) {
        const r = pick({ ok: true, how: "on the ground", with: null, from: [0, -1, 0] });
        if (r) return r;
      }
      // its studs into a placed part
      for (const s of model.studsW(p)) {
        tag++;
        let hit = null;
        boxes.query(grow([s.p[0], s.p[1], s.p[2], s.p[0], s.p[1], s.p[2]], 1), seen, tag, (q) => {
          if (hit || !inBox(s.p, model.P[q].box, 1)) return;
          if (studInto(model, s, model.P[q])) hit = q;
        });
        if (hit != null) {
          const r = pick({ ok: true, how: "stud", with: model.P[hit].uid, from: s.a.map((x) => -x + 0) });
          if (r) return r;
        }
      }
      // placed studs into it
      tag++;
      const near = [];
      studs.cells(grow(p.box, 1), (k) => {
        const a = studs.map.get(k);
        if (!a) return;
        for (const si of a) {
          if (seenStud[si] === tag) continue;
          seenStud[si] = tag;
          if (inBox(studList[si].p, p.box, 1)) near.push(studList[si]);
        }
      });
      for (const s of near) {
        if (!studInto(model, s, p)) continue;
        const r = pick({ ok: true, how: "anti-stud", with: model.P[s.owner].uid, from: s.a.slice() });
        if (r) return r;
        break;
      }
      // joint tags (axle/pin, clip/bar, hinge, wheel, minifig, loose)
      if (p.part.tags.size || model.hasLoose) {
        tag++;
        let j = null;
        const A = p.part.tags;
        let jk = null;
        boxes.query(grow(p.box, 1), seen, tag, (q) => {
          if (j != null) return;
          const Q = model.P[q];
          const B = Q.part.tags;
          if ((!A.size && !B.size) || !pairOk(A, B)) return;
          // two articulated parts (hinge halves, ball and socket, turntable) join only on their pin line or ball centre
          if (p.part.artic && Q.part.artic && !A.has("loose") && !B.has("loose")) {
            const aj = model.articJoint(p, Q);
            if (aj) { j = q; jk = aj.kind; }
            return;
          }
          if (overlaps(p.box, Q.box, A.has("loose") || B.has("loose") ? -OVERLAP : OVERLAP)) j = q;
        });
        if (j != null) {
          const r = pick({ ok: true, how: jk ? `${jk} joint` : [...p.part.tags].join("+") + " joint", with: model.P[j].uid, from: [0, -1, 0] });
          if (r) return r;
        }
      }
    }
    return fallback || { ok: false, how: null, with: null, from: null };
  }

  /**
   * Every joint the members seat on at landing (against placed parts), each with the arrival it allows:
   *   {kind, member, with, rule: "exact"|"axis"|"perp"|"any", v?: unit vector}
   * stud: from = the side the stud points away from (exact); anti-stud: from = the stud's tip side (exact);
   * axle (axle/pin in a hole, wheel/drum/rim on an axle): along the axle axis, either end ("axis");
   * clip on a bar: perpendicular to the bar ("perp"); hinge, minifig, loose, a clip with no bar part: "any".
   * Ground counts only for a part with no other joint (from above).
   */
  function jointsOf(members) {
    const out = [];
    for (const i of members) {
      const p = model.P[i];
      const mine = [];
      for (const s of model.studsW(p)) {
        tag++;
        boxes.query(grow([s.p[0], s.p[1], s.p[2], s.p[0], s.p[1], s.p[2]], 1), seen, tag, (q) => {
          if (inBox(s.p, model.P[q].box, 1) && studInto(model, s, model.P[q])) mine.push({ kind: "stud", member: p.uid, with: model.P[q].uid, rule: "exact", v: s.a.map((x) => -x + 0) });
        });
      }
      tag++;
      studs.cells(grow(p.box, 1), (k) => {
        const a = studs.map.get(k);
        if (!a) return;
        for (const si of a) {
          if (seenStud[si] === tag) continue;
          seenStud[si] = tag;
          const s = studList[si];
          if (inBox(s.p, p.box, 1) && studInto(model, s, p)) mine.push({ kind: "anti-stud", member: p.uid, with: model.P[s.owner].uid, rule: "exact", v: s.a.slice() });
        }
      });
      if (p.part.tags.size || model.hasLoose) {
        tag++;
        const A = p.part.tags;
        boxes.query(grow(p.box, 1), seen, tag, (q) => {
          const Q = model.P[q];
          const B = Q.part.tags;
          if ((!A.size && !B.size) || !pairOk(A, B)) return;
          if (p.part.artic && Q.part.artic && !A.has("loose") && !B.has("loose")) {
            const aj = model.articJoint(p, Q);
            if (aj) mine.push({ member: p.uid, with: Q.uid, kind: aj.kind, rule: "any", ...(aj.axis ? { pin: aj.axis, point: aj.point } : aj.point ? { point: aj.point } : {}) });
            return;
          }
          if (!overlaps(p.box, Q.box, A.has("loose") || B.has("loose") ? -OVERLAP : OVERLAP)) return;
          mine.push({ member: p.uid, with: Q.uid, ...tagJoint(p, Q) });
        });
      }
      if (!mine.length && ground != null && Number.isFinite(ground) && p.box[4] >= ground - 0.5) mine.push({ kind: "ground", member: p.uid, with: null, rule: "exact", v: [0, -1, 0] });
      out.push(...mine);
    }
    const seenKey = new Set();
    return out.filter((j) => {
      const key = `${j.member}|${j.with}|${j.kind}|${j.v ? j.v.map((x) => Math.round(x * 100)).join(",") : ""}`;
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
  }

  /** Does arrival `from` match a joint? Constrained joints decide; "any" joints count only when there is no constrained one. */
  function directionOf(from, joints) {
    const constrained = joints.filter((j) => j.rule !== "any");
    if (!constrained.length) return { ok: true, matched: joints[0] || null, constrained };
    for (const j of constrained) {
      const d = from[0] * j.v[0] + from[1] * j.v[1] + from[2] * j.v[2];
      if ((j.rule === "exact" && d >= DIR_COS) || (j.rule === "axis" && Math.abs(d) >= DIR_COS) || (j.rule === "perp" && Math.abs(d) <= DIR_PERP)) return { ok: true, matched: j, constrained };
    }
    return { ok: false, matched: null, constrained };
  }

  /**
   * The arrivals the members' joints allow, each judged against what is placed: [{from, kind, with, travel, blockers,
   * crossings, clear}], clear ones first, then from-above first. A planner takes the first clear one.
   */
  function arrivalOptions(members, { travel = "auto", seatLen = DEFAULT_SEAT } = {}) {
    const joints = jointsOf(members);
    const cands = [];
    const add = (v, j) => {
      const u = unit(v);
      if (!cands.some((c) => c.from[0] * u[0] + c.from[1] * u[1] + c.from[2] * u[2] > 0.999)) cands.push({ from: u, kind: j ? j.kind : "none", with: j ? j.with : null });
    };
    for (const j of joints) {
      if (j.rule === "exact") add(j.v, j);
      else if (j.rule === "axis") { add(j.v, j); add(j.v.map((x) => -x + 0), j); }
      else if (j.rule === "perp") for (const w of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) if (Math.abs(w[0] * j.v[0] + w[1] * j.v[1] + w[2] * j.v[2]) <= DIR_PERP) add(w, j);
    }
    // a hinge half with no stud joint: from above, or along its pin (a swivel hinge's halves stack along the pin)
    if (!cands.length && joints.some((j) => j.pin)) {
      add([0, -1, 0], joints.find((j) => j.pin));
      for (const j of joints) if (j.pin) { add(j.pin, j); add(j.pin.map((x) => -x + 0), j); }
    }
    if (!cands.length) add([0, -1, 0], joints[0]);
    for (const c of cands) {
      c.travel = travel === "auto" ? autoTravel(members, c.from) : travel;
      c.blockers = blockersOf(members, c.from).length;
      c.crossings = crossingsOf(members, c.from, c.travel, seatLen).length;
      c.clear = !c.blockers && !c.crossings;
    }
    return cands.sort((a, b) => Number(b.clear) - Number(a.clear) || Number(b.from[1] < -0.5) - Number(a.from[1] < -0.5));
  }

  /** The arrival a planner should use: the first clear joint direction, else the least bad one. */
  function bestArrival(members, opts) {
    const o = arrivalOptions(members, opts);
    if (o[0].clear) return o[0];
    return o.slice().sort((a, b) => a.blockers + a.crossings - (b.blockers + b.crossings))[0];
  }

  // ------------------------------------------------ visibility of a landing from a camera (placed parts occlude)

  /** Calls fn(id) for each placed part whose grid cell the segment a->b passes (3D DDA); fn returns true to stop. */
  function alongSegment(a, b, fn) {
    const C = GRID;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const cell = a.map((x) => Math.floor(x / C));
    const end = b.map((x) => Math.floor(x / C));
    const stepv = d.map((x) => (x > 0 ? 1 : x < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => (d[k] === 0 ? Infinity : ((stepv[k] > 0 ? (cell[k] + 1) * C : cell[k] * C) - a[k]) / d[k]));
    const tDelta = [0, 1, 2].map((k) => (d[k] === 0 ? Infinity : Math.abs(C / d[k])));
    for (let guard = 0; guard < 100000; guard++) {
      const list = boxes.map.get(boxes.key(cell[0], cell[1], cell[2]));
      if (list) for (const id of list) if (fn(id)) return;
      if (cell[0] === end[0] && cell[1] === end[1] && cell[2] === end[2]) return;
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      if (tMax[k] > 1) return;
      cell[k] += stepv[k];
      tMax[k] += tDelta[k];
    }
  }

  const segBox = (a, b, B) => {
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      const d = b[k] - a[k];
      if (Math.abs(d) < 1e-12) {
        if (a[k] < B[k] || a[k] > B[k + 3]) return false;
        continue;
      }
      let u = (B[k] - a[k]) / d, w = (B[k + 3] - a[k]) / d;
      if (u > w) [u, w] = [w, u];
      t0 = Math.max(t0, u);
      t1 = Math.min(t1, w);
      if (t0 > t1) return false;
    }
    return true;
  };

  /** Does the segment eye->pt pierce placement q's triangles (tested in q's own frame)? */
  const pierces = (q, eye, pt) => {
    const inv = model.invOf(q);
    return segmentHitsSurface(model.surfaceOfPart(q.part), apply(inv, ...eye), apply(inv, ...pt));
  };

  /**
   * Is the landing seen from `camera` ({eye, target, up?=[0,-1,0], fov (vertical deg)=40, aspect=16/9})? Sample points on
   * the members' own triangles are cast to the eye against the placed parts and the members themselves (their far side).
   * @returns {{visible:boolean, fraction:number, seen:number, samples:number, inFrame:number, blockers:string[]}}
   *   visible = at least `minFraction` (default 0.1) of the sample points are in frame and unblocked. `full` counts every
   *   sample (for a fraction); otherwise it stops once the landing is known visible.
   */
  function visibleOf(members, camera, { minFraction = 0.1, full = false } = {}) {
    const eye = camera.eye;
    const fwd = unit([camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2]]);
    const up0 = camera.up || [0, -1, 0];
    const right = unit([fwd[1] * up0[2] - fwd[2] * up0[1], fwd[2] * up0[0] - fwd[0] * up0[2], fwd[0] * up0[1] - fwd[1] * up0[0]]);
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const ty = Math.tan(((camera.fov ?? 40) * Math.PI) / 360), tx = ty * (camera.aspect ?? 16 / 9);
    const mineSet = new Set(members);
    const pts = [];
    for (const i of members) for (const c of model.samplesOf(model.P[i].part)) pts.push(apply(model.P[i].m, ...c));
    const need = Math.max(1, Math.ceil(pts.length * minFraction));
    const blockers = new Set();
    let seenN = 0, inFrame = 0;
    for (const pt of pts) {
      const v = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
      const z = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
      if (z <= 1) continue;
      if (Math.abs((v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / z) > tx || Math.abs((v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / z) > ty) continue;
      inFrame++;
      let hit = null;
      for (const i of members) if (pierces(model.P[i], eye, pt)) { hit = i; break; }
      if (hit == null) {
        const tested = new Set();
        alongSegment(eye, pt, (q) => {
          if (tested.has(q) || mineSet.has(q)) return false;
          tested.add(q);
          if (!segBox(eye, pt, model.P[q].box)) return false;
          if (pierces(model.P[q], eye, pt)) { hit = q; return true; }
          return false;
        });
      }
      if (hit == null) {
        seenN++;
        if (!full && seenN >= need) break;
      } else if (!mineSet.has(hit)) blockers.add(model.P[hit].uid);
    }
    return { visible: seenN >= need, fraction: pts.length ? seenN / pts.length : 0, seen: seenN, samples: pts.length, inFrame, blockers: [...blockers] };
  }

  /** The candidates (placement indices, or arrays of them for a sub-assembly) that are visible from the camera now. */
  function visibleCandidates(cands, camera, opts) {
    return cands.filter((c) => visibleOf(Array.isArray(c) ? c : [c], camera, opts).visible);
  }

  /**
   * A camera turn that shows the landing: the eye orbits the target (same distance), azimuth within +-maxTurn degrees of
   * now and elevation within [elevation[0], elevation[1]] degrees above the table; the smallest turn that makes it
   * visible. @returns {{camera, azimuthDelta, elevation, turn}|null}
   */
  function proposeCamera(members, camera, { maxTurn = 90, elevation = [5, 75], step = 5, minFraction = 0.1 } = {}) {
    const t = camera.target;
    const rel = [camera.eye[0] - t[0], camera.eye[1] - t[1], camera.eye[2] - t[2]];
    const dist = Math.hypot(...rel);
    const az0 = Math.atan2(rel[0], rel[2]);
    const el0 = (Math.asin(-rel[1] / dist) * 180) / Math.PI;
    const tries = [];
    for (let da = -maxTurn; da <= maxTurn + 1e-9; da += step) for (let el = elevation[0]; el <= elevation[1] + 1e-9; el += step) tries.push({ da, el, turn: Math.abs(da) + Math.abs(el - el0) });
    tries.sort((a, b) => a.turn - b.turn);
    for (const tr of tries) {
      const az = az0 + (tr.da * Math.PI) / 180, e = (tr.el * Math.PI) / 180;
      const eye = [t[0] + dist * Math.cos(e) * Math.sin(az), t[1] - dist * Math.sin(e), t[2] + dist * Math.cos(e) * Math.cos(az)];
      const cam = { ...camera, eye };
      if (visibleOf(members, cam, { minFraction }).visible) return { camera: cam, azimuthDelta: tr.da, elevation: tr.el, turn: tr.turn };
    }
    return null;
  }

  /** Placed parts in the column a vertical arrival passes through (ORDER). */
  function blockersOf(members, from) {
    if (Math.abs(from[1]) < 0.5) return [];
    const out = [];
    tag++;
    for (const i of members) {
      const b = model.P[i].box;
      columns.query([b[0], 0, b[2], b[3], 0, b[5]], seen, tag, (q) => {
        const Q = model.P[q].box;
        if (!xzOverlap(b, Q, 1)) return;
        if (from[1] < 0 ? Q[4] <= b[1] + 4.5 : Q[1] >= b[4] - 4.5) out.push({ member: model.P[i].uid, blocker: model.P[q].uid });
      });
      tag++;
    }
    return out;
  }

  /** Distance along `from` until the members' boxes clear every placed box, plus a margin (at least 72). */
  function autoTravel(members, from) {
    for (let d = 0; d < 4000; d += 2) {
      let hit = false;
      tag++;
      for (const i of members) {
        const b = model.P[i].box.map((v, k) => v + from[k % 3] * d);
        boxes.query(b, seen, tag, (q) => {
          if (!hit && overlaps(b, model.P[q].box, OVERLAP)) hit = true;
        });
        if (hit) break;
      }
      if (!hit) return Math.max(72, d + 24);
    }
    return 4000;
  }

  /** The range of d (seatLen..travel) over which box b moved by from*d overlaps box Q by more than OVERLAP. */
  function interval(b, Q, from, lo, hi) {
    let dmin = lo, dmax = hi;
    for (let a = 0; a < 3; a++) {
      const u = Q[a + 3] - OVERLAP - b[a], l = Q[a] + OVERLAP - b[a + 3];
      if (Math.abs(from[a]) < 1e-9) {
        if (!(u > 0 && l < 0)) return null;
        continue;
      }
      let d1 = l / from[a], d2 = u / from[a];
      if (from[a] < 0) [d1, d2] = [d2, d1];
      dmin = Math.max(dmin, d1);
      dmax = Math.min(dmax, d2);
    }
    return dmin <= dmax ? [dmin, dmax] : null;
  }

  /**
   * Does moving part p, travelling from d = iv[1] to d = iv[0] (position = seated + from * d), pass through placed part Q?
   * 1) p's head-on corners swept along the path pierce Q's triangles; 2) Q's head-on corners, seen from p, pierce p's;
   * 3) the sampled surface test of reel-crossing.js (an edge of one through the inside of the other).
   */
  function pairCrossing(p, Q, from, iv) {
    const invQ = model.invOf(Q), invP = model.invOf(p);
    const span = [iv[1], iv[0]];
    // 1) in Q's frame
    const relPQ = mul(invQ, p.m);
    const dirQ = applyDir(invQ, ...from);
    for (const c of model.cornersOf(p.part, unit(applyDir(invP, ...from)))) {
      const w = apply(relPQ, ...c);
      const a = [w[0] + dirQ[0] * span[0], w[1] + dirQ[1] * span[0], w[2] + dirQ[2] * span[0]];
      const z = [w[0] + dirQ[0] * span[1], w[1] + dirQ[1] * span[1], w[2] + dirQ[2] * span[1]];
      if (segmentHitsSurface(model.surfaceOfPart(Q.part), a, z)) return { at: Math.round(iv[1] * 10) / 10, how: "corner of the moving part through a placed face" };
    }
    // 2) in p's frame (Q moves the other way)
    const relQP = mul(invP, Q.m);
    const dirP = applyDir(invP, ...from);
    for (const c of model.cornersOf(Q.part, unit(applyDir(invQ, ...from)))) {
      const w = apply(relQP, ...c);
      const a = [w[0] - dirP[0] * span[0], w[1] - dirP[1] * span[0], w[2] - dirP[2] * span[0]];
      const z = [w[0] - dirP[0] * span[1], w[1] - dirP[1] * span[1], w[2] - dirP[2] * span[1]];
      if (segmentHitsSurface(model.surfaceOfPart(p.part), a, z)) return { at: Math.round(iv[1] * 10) / 10, how: "corner of a placed part through a moving face" };
    }
    // 3) sampled surfaces
    const local = model.trisIn(p, invQ, relPQ);
    const qs = [{ id: Q.uid, surface: model.surfaceOfPart(Q.part) }];
    const dirL = unit(dirQ);
    const n = Math.min(MAX_SAMPLES, Math.ceil(iv[1] - iv[0]) + 1);
    for (let s = 0; s <= n; s++) {
      const d = n === 0 ? iv[1] : iv[1] - ((iv[1] - iv[0]) * s) / n;
      const r = crossingsAt(local, qs, [dirQ[0] * d, dirQ[1] * d, dirQ[2] * d], dirL);
      if (r.hits) return { at: Math.round(d * 10) / 10, pairs: r.hits, how: "edge through a face" };
    }
    return null;
  }

  /** Triangle crossings along each member's arrival sweep, against placed parts only. */
  function crossingsOf(members, from, travel, seatLen = DEFAULT_SEAT) {
    return crossingsOfPl(members.map((i) => model.P[i]), from, travel, seatLen);
  }

  /** crossingsOf for placement objects (model placements or posed ones). The articulated partner is not swept against. */
  function crossingsOfPl(pls, from, travel, seatLen = DEFAULT_SEAT) {
    const out = [];
    for (const p of pls) {
      const b = p.box;
      const swept = [0, 1, 2, 3, 4, 5].map((k) => (k < 3 ? Math.min(b[k], b[k] + from[k] * travel) : Math.max(b[k], b[k] + from[k % 3] * travel)));
      tag++;
      const cands = [];
      boxes.query(swept, seen, tag, (q) => cands.push(q));
      for (const q of cands) {
        const Q = model.P[q];
        // minifig joints (hips/legs, arm/torso, hand/arm, held item) interlock deeper than any stud seat; a figure is
        // assembled as its own piece, so its parts are not swept against each other
        if (p.part.tags.has("minifig") && Q.part.tags.has("minifig")) continue;
        // hinge knuckles, a ball in its socket and turntable rings interlock by design: the partner of an articulated
        // joint is not swept against (any other part still is)
        if (p.part.artic && Q.part.artic && model.articJoint(p, Q)) continue;
        const iv = interval(b, Q.box, from, seatLen, travel);
        if (!iv) continue;
        const hit = pairCrossing(p, Q, from, iv);
        if (hit) out.push({ member: p.uid, with: Q.uid, ...hit });
      }
    }
    return out;
  }

  // ------------------------------------------------ place, then swing on a hinge (EV-30)

  /** The hinge or turntable the members turn on against a placed part: {kind, axis, point, member, with} or null. */
  function hingeOf(members) {
    for (const i of members) {
      const p = model.P[i];
      if (!p.part.artic) continue;
      let found = null;
      tag++;
      boxes.query(grow(p.box, 1), seen, tag, (q) => {
        if (found) return;
        const j = model.articJoint(p, model.P[q]);
        if (j && j.axis) found = { ...j, member: i, with: q };
      });
      if (found) return found;
    }
    return null;
  }

  /**
   * The angle (degrees about hinge.axis, right-hand) that turns the members back to the hinge's rest pose: the pose where
   * the hinge half and its partner are square to each other again (same orientation first, else the nearest square one).
   * null when no square pose lies on the swing.
   */
  function restAngle(hinge) {
    const p = model.P[hinge.member], q = model.P[hinge.with];
    const Rq = [q.m[0], q.m[1], q.m[2], q.m[4], q.m[5], q.m[6], q.m[8], q.m[9], q.m[10]];
    let best = null;
    for (let deg = -180; deg < 180; deg += 1) {
      const R = rotation(hinge.axis, deg);
      const t = turnAbout(p.m, R, hinge.point);
      // relative rotation Rq^T * Rp'
      let err = 0, trace = 0;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const v = Rq[i] * t[j] + Rq[3 + i] * t[4 + j] + Rq[6 + i] * t[8 + j];
          err = Math.max(err, Math.abs(v - Math.round(v)));
          if (i === j) trace += v;
        }
      if (err > 0.03) continue;
      const cand = { deg, same: trace > 2.9 };
      if (!best || (cand.same && !best.same) || (cand.same === best.same && Math.abs(deg) < Math.abs(best.deg))) best = cand;
    }
    if (!best) return null;
    // refine to 0.05 degree
    let d0 = best.deg;
    for (const step of [0.5, 0.1, 0.05]) {
      let bestErr = Infinity, bestD = d0;
      for (let k = -10; k <= 10; k++) {
        const d = d0 + k * step;
        const t = turnAbout(p.m, rotation(hinge.axis, d), hinge.point);
        let err = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const v = Rq[i] * t[j] + Rq[3 + i] * t[4 + j] + Rq[6 + i] * t[8 + j]; err += (v - Math.round(v)) ** 2; }
        if (err < bestErr) { bestErr = err; bestD = d; }
      }
      d0 = bestD;
    }
    return Math.abs(d0) < 0.05 ? 0 : Math.round(d0 * 100) / 100;
  }

  /** Shrunken triangle edges of a part (6 numbers each), cached: an edge of one part through a face of another is interpenetration. */
  const edgesOf = (part) => {
    if (part._edges) return part._edges;
    const t = part.tris, out = [];
    for (let o = 0; o + 8 < t.length; o += 9) {
      const c = [(t[o] + t[o + 3] + t[o + 6]) / 3, (t[o + 1] + t[o + 4] + t[o + 7]) / 3, (t[o + 2] + t[o + 5] + t[o + 8]) / 3];
      const v = [0, 1, 2].map((k) => {
        const w = [t[o + k * 3], t[o + k * 3 + 1], t[o + k * 3 + 2]];
        const dist = Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2]);
        const f = dist ? Math.min(0.3 / dist, 0.5) : 0;
        return [w[0] + (c[0] - w[0]) * f, w[1] + (c[1] - w[1]) * f, w[2] + (c[2] - w[2]) * f];
      });
      for (let k = 0; k < 3; k++) out.push(...v[k], ...v[(k + 1) % 3]);
    }
    return (part._edges = out);
  };

  /** Do placements a and b pass through each other where they stand (an edge of one through a face of the other)? */
  function interpenetrate(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const rel = mul(model.invOf(y), x.m);
      const surf = model.surfaceOfPart(y.part);
      const e = edgesOf(x.part);
      for (let o = 0; o + 5 < e.length; o += 6) {
        const p = apply(rel, e[o], e[o + 1], e[o + 2]), q = apply(rel, e[o + 3], e[o + 4], e[o + 5]);
        if (segmentHitsSurface(surf, p, q)) return true;
      }
    }
    return false;
  }

  /**
   * "Place, then swing": the members arrive at the hinge's rest pose and then turn on the pin to where they stand. The
   * arrival comes along `from`, or (from = null) the first clear of: from above, along the pin, against the pin. Checks
   * the arrival at rest (CROSSING, the hinge partner excepted) and the swing itself, sampled every `step` degrees,
   * against every placed part but the partner.
   * @returns {{hinge:object|null, swingFrom:number|null, from:number[]|null, crossings:object[], reason?:string}}
   */
  function swingCheck(members, { from = null, swingFrom = null, travel = "auto", seatLen = DEFAULT_SEAT, step = 3 } = {}) {
    const hinge = hingeOf(members);
    if (!hinge) return { hinge: null, swingFrom: null, from: null, crossings: [], reason: "no hinge or turntable pin against a placed part" };
    const start = swingFrom ?? restAngle(hinge);
    if (start == null) return { hinge, swingFrom: null, from: null, crossings: [], reason: "no square rest pose on this pin: give swingFrom (degrees)" };
    const at = (deg) => members.map((i) => model.posed(model.P[i], turnAbout(model.P[i].m, rotation(hinge.axis, deg), hinge.point)));
    const crossings = [];
    // 1) the arrival at the rest pose
    const rest = at(start);
    const travelFor = (fromU) => {
      if (travel !== "auto") return travel;
      for (let d = 0; d < 4000; d += 2) {
        let hit = false;
        tag++;
        for (const p of rest) {
          const b = p.box.map((v, k) => v + fromU[k % 3] * d);
          boxes.query(b, seen, tag, (q) => { if (!hit && !model.articJoint(p, model.P[q]) && overlaps(b, model.P[q].box, OVERLAP)) hit = true; });
          if (hit) break;
        }
        if (!hit) return Math.max(72, d + 24);
      }
      return 4000;
    };
    const tries = from ? [unit(from)] : [[0, -1, 0], hinge.axis.slice(), hinge.axis.map((x) => -x + 0)];
    let fromU = null, arrival = null;
    for (const f of tries) {
      const cr = crossingsOfPl(rest, f, travelFor(f), seatLen);
      if (!arrival || cr.length < arrival.length) { fromU = f; arrival = cr; }
      if (!cr.length) break;
    }
    for (const c of arrival) crossings.push({ ...c, how: `arrival at the rest pose (${start} deg) from ${JSON.stringify(fromU.map((x) => Math.round(x * 1000) / 1000))}: ${c.how}` });
    // 2) the swing from the rest pose to the final one
    if (Math.abs(start) > 1e-6) {
      const n = Math.max(1, Math.ceil(Math.abs(start) / step));
      const hitPairs = new Set();
      for (let s = 0; s < n; s++) {
        const deg = start * (1 - s / n);
        for (const p of at(deg)) {
          tag++;
          boxes.query(p.box, seen, tag, (q) => {
            const Q = model.P[q];
            const key = `${p.uid}|${Q.uid}`;
            if (hitPairs.has(key) || !overlaps(p.box, Q.box, OVERLAP)) return;
            if (p.part.artic && Q.part.artic && model.articJoint(p, Q)) return;
            if (interpenetrate(p, Q)) {
              hitPairs.add(key);
              crossings.push({ member: p.uid, with: Q.uid, at: Math.round(deg * 10) / 10, how: `swing on the ${hinge.kind} pin passes through a placed part at ${Math.round(deg * 10) / 10} deg from the final pose` });
            }
          });
        }
      }
    }
    return { hinge: { kind: hinge.kind, axis: hinge.axis, point: hinge.point, member: model.P[hinge.member].uid, with: model.P[hinge.with].uid }, swingFrom: start, from: fromU, crossings };
  }

  /**
   * STABILITY (EV-40, owner 2026-10-28: "다리가 한쪽에만 있는데 불안정하게 허공에 꽂히는 경우"): does the landing rest with
   * its centre of mass over what holds it against gravity? Holding contacts = seated studs with a near-vertical axis
   * between the members and placed non-member parts below them (and, for a part arriving from below, the part it hangs
   * under), each standing for its stud cell (±10 LDU); the table holds a member's whole footprint. The centre of mass
   * (members' boxes, by volume) must lie inside the box of those contacts with a margin of min(4 LDU, 25 % of its width),
   * so a part on one stud at its end, or a bridge with one end held, fails; a part held only sideways (side studs, axles,
   * hinges, clips) is not judged here (judged: false).
   * @param {number[]} members
   * @param {{from?: number[]}} [opts] the arrival (from below: contacts above count too)
   * @returns {{judged:boolean, ok:boolean, com:number[], box:number[]|null, contacts:number}}
   */
  function stabilityOf(members, { from = [0, -1, 0] } = {}) {
    const mine = new Set(members);
    const hang = Array.isArray(from) && from[1] > 0.5;
    const rects = [];
    let vol = 0, cx = 0, cz = 0, lowest = -Infinity;
    for (const i of members) {
      const b = model.P[i].box;
      lowest = Math.max(lowest, b[4]);
      const v = Math.max(1, (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]));
      vol += v;
      cx += (v * (b[0] + b[3])) / 2;
      cz += (v * (b[2] + b[5])) / 2;
    }
    for (const i of members) {
      const p = model.P[i];
      const b = p.box;
      if (ground != null && Number.isFinite(ground) && b[4] >= ground - 0.5) rects.push([b[0], b[2], b[3], b[5]]);
      // its own studs into a placed part: pointing down (an inverted part) they rest on it; pointing up into a part above
      // they hold only a part hung under that part (arriving from below)
      for (const s of model.studsW(p)) {
          if (Math.abs(s.a[1]) < UPRIGHT || (s.a[1] < 0 && !hang)) continue;
          tag++;
          let hit = false;
          boxes.query(grow([s.p[0], s.p[1], s.p[2], s.p[0], s.p[1], s.p[2]], 1), seen, tag, (q) => {
            if (hit || mine.has(q) || !inBox(s.p, model.P[q].box, 1)) return;
            if (studInto(model, s, model.P[q])) hit = true;
          });
          if (hit) rects.push([s.p[0] - STUD_CELL, s.p[2] - STUD_CELL, s.p[0] + STUD_CELL, s.p[2] + STUD_CELL]);
        }
      // studs of placed parts below seated in it
      tag++;
      studs.cells(grow(b, 1), (k) => {
        const a = studs.map.get(k);
        if (!a) return;
        for (const si of a) {
          if (seenStud[si] === tag) continue;
          seenStud[si] = tag;
          const s = studList[si];
          if (mine.has(s.owner) || Math.abs(s.a[1]) < UPRIGHT || !inBox(s.p, b, 1)) continue;
          if (s.a[1] > 0 && !hang) continue; // a stud pointing down holds only a part hung under it
          if (studInto(model, s, p)) rects.push([s.p[0] - STUD_CELL, s.p[2] - STUD_CELL, s.p[0] + STUD_CELL, s.p[2] + STUD_CELL]);
        }
      });
    }
    const com = [cx / vol, cz / vol];
    if (!rects.length) return { judged: false, ok: true, com, box: null, contacts: 0 };
    const x0 = Math.min(...rects.map((r) => r[0])), z0 = Math.min(...rects.map((r) => r[1]));
    const x1 = Math.max(...rects.map((r) => r[2])), z1 = Math.max(...rects.map((r) => r[3]));
    const ex = Math.min(4, 0.25 * (x1 - x0)), ez = Math.min(4, 0.25 * (z1 - z0));
    const ok = com[0] >= x0 + ex && com[0] <= x1 - ex && com[1] >= z0 + ez && com[1] <= z1 - ez;
    return { judged: true, ok, com: com.map((v) => Math.round(v * 10) / 10), box: [x0, z0, x1, z1].map((v) => Math.round(v * 10) / 10), contacts: rects.length };
  }

  function place(members) {
    for (const i of members) {
      if (placed[i]) throw new Error(`${model.P[i].uid} is placed twice`);
      placed[i] = 1;
      count++;
      const b = model.P[i].box;
      boxes.insert(i, b);
      columns.insert(i, [b[0], 0, b[2], b[3], 0, b[5]]);
      for (const s of model.studsW(model.P[i])) {
        studList.push(s);
        studs.insert(studList.length - 1, [s.p[0], s.p[1], s.p[2], s.p[0], s.p[1], s.p[2]]);
      }
    }
  }

  return { supportOf, jointsOf, directionOf, arrivalOptions, bestArrival, visibleOf, visibleCandidates, proposeCamera, blockersOf, crossingsOf, crossingsOfPl, hingeOf, restAngle, swingCheck, stabilityOf, autoTravel, place, isPlaced: (i) => !!placed[i], get count() { return count; } };
}

// ---------------------------------------------------------------- running an order

/**
 * An event is one landing: {label, members:[placement idx], from:[x,y,z]|"auto", travel:number|"auto", seatLen,
 * group?:string, arrive?:"slide"|"swing", internal?:event[] (a sub-assembly's own build), ignore?:boolean}.
 */
function runEvents(model, events, scope, report, opts) {
  const build = createBuild(model, { ground: opts.ground });
  events.forEach((ev, k) => {
    if (ev.internal && ev.internal.length) runEvents(model, ev.internal, `${scope} > ${ev.label}`, report, { ...opts, ground: null, firstFree: true, cameras: null, main: false });
    const sup = build.supportOf(ev.members, { first: opts.firstFree && k === 0 });
    let from = ev.from;
    if (from === "auto") from = sup.ok && !ev.ignore && ev.arrive !== "swing" && !(opts.firstFree && k === 0) ? build.bestArrival(ev.members, { seatLen: ev.seatLen ?? DEFAULT_SEAT }).from : sup.ok ? sup.from : [0, -1, 0];
    if (opts.forceTravel != null) ev = { ...ev, travel: opts.forceTravel };
    const travel = ev.travel === "auto" ? build.autoTravel(ev.members, from) : ev.travel;
    const where = { scope, index: k, label: ev.label, parts: ev.members.length };
    if (opts.main) report.landings++;
    if (!sup.ok && !ev.ignore) report.violations.support.push({ ...where, uid: model.P[ev.members[0]].uid, title: model.P[ev.members[0]].part.title });
    if (ev.ignore) {
      /* skipped on request (--ignore / --ignore-tail / "ignore": true); counted in the report */
    } else if (ev.arrive === "swing") {
      // on a hinge or turntable pin: the arrival at the rest pose and the swing are checked; otherwise (a panel swung in
      // with no pin primitive) support only, listed as unchecked
      const sw = sup.ok && !(opts.firstFree && k === 0) ? build.swingCheck(ev.members, { from: Array.isArray(ev.from) ? ev.from : null, swingFrom: Number.isFinite(ev.swingFrom) ? ev.swingFrom : null, travel: ev.travel, seatLen: ev.seatLen ?? DEFAULT_SEAT }) : { hinge: null, reason: "not held" };
      if (!sw.hinge || sw.swingFrom == null) report.unchecked.push({ ...where, reason: `swing arrival: support checked; path and column not checked (${sw.reason})` });
      else {
        report.swings.push({ ...where, kind: sw.hinge.kind, with: sw.hinge.with, swingFrom: sw.swingFrom, from: sw.from, axis: sw.hinge.axis.map((x) => Math.round(x * 1000) / 1000) });
        if (sw.crossings.length) report.violations.crossing.push({ ...where, from: "swing", swingFrom: sw.swingFrom, hits: sw.crossings.slice(0, 8), count: sw.crossings.length });
      }
    } else {
      const bl = build.blockersOf(ev.members, from);
      if (bl.length) report.violations.order.push({ ...where, from, above: from[1] < 0, blockers: bl.slice(0, 8), count: bl.length });
      const cr = build.crossingsOf(ev.members, from, travel, ev.seatLen ?? DEFAULT_SEAT);
      if (cr.length) report.violations.crossing.push({ ...where, from, travel, hits: cr.slice(0, 8), count: cr.length });
      // DIRECTION: the arrival must be how one of the joints it seats on is actually made (a sub-assembly's first part is free)
      if (sup.ok && !(opts.firstFree && k === 0)) {
        const dir = build.directionOf(from, build.jointsOf(ev.members));
        if (!dir.ok) {
          const need = dir.constrained.slice(0, 6).map((j) => ({ kind: j.kind, member: j.member, with: j.with, rule: j.rule, axis: j.v.map((x) => Math.round(x * 1000) / 1000) }));
          report.violations.direction.push({ ...where, from, need, kinds: [...new Set(dir.constrained.map((j) => j.kind))] });
        }
      }
    }
    if (ev.ignore) report.ignored++;
    // FIGURE (EV-41, main landings, regex-ignored ones too; not the ignored tail): a minifig lands as lower body, upper
    // body, head; never a hand or arm before or apart from its torso, a leg apart from the hips, hair apart from the head
    if (opts.main && !ev.ignoreTail) {
      const fig = figureLanding(ev.members.map((i) => model.P[i].part.title));
      if (fig) report.violations.figure.push({ ...where, missing: fig.missing, classes: fig.classes, uid: model.P[ev.members[0]].uid, title: model.P[ev.members[0]].part.title });
    }
    // STABILITY (EV-40, main landings): judged now; one that would rest with everything below it placed is an ORDER fault
    // (a violation), one that does not even in the finished model is a designed overhang, listed for the owner
    if (opts.main && opts.stability !== false && !ev.ignore && ev.arrive !== "swing" && sup.ok) {
      const st = build.stabilityOf(ev.members, { from: Array.isArray(from) ? from : [0, -1, 0] });
      if (st.judged && !st.ok) opts.unstable.push({ where, members: ev.members, from: Array.isArray(from) ? from : [0, -1, 0], st });
    }
    // VISIBILITY (main landings): seen from the camera of its moment, with what is placed before it
    if (opts.main && opts.cameraFor && !ev.ignore) {
      const vis = report.visibility;
      const cam = opts.cameraFor(k);
      if (!cam) vis.noCamera.push({ ...where });
      else {
        vis.checked++;
        const r = build.visibleOf(ev.members, cam, { minFraction: opts.minVisible });
        if (!r.visible) {
          const row = { ...where, fraction: Math.round(r.fraction * 1000) / 1000, inFrame: r.inFrame, samples: r.samples, blockers: r.blockers.slice(0, 6) };
          const internal = opts.internal && ev.members.every((i) => opts.internal.test(model.P[i].uid) || opts.internal.test(model.P[i].part.id) || opts.internal.test(model.P[i].part.title));
          if (internal && cam.opening) vis.excepted.push({ ...row, reason: "internal by design, shown through an opening" });
          else vis.hidden.push(row);
        }
      }
    }
    build.place(ev.members);
  });
  if (opts.main && opts.unstable)
    for (const u of opts.unstable) {
      const fin = build.stabilityOf(u.members, { from: u.from });
      const row = { ...u.where, uid: model.P[u.members[0]].uid, title: model.P[u.members[0]].part.title, com: u.st.com, contactBox: u.st.box, finished: fin.ok ? "rests once the parts under it are placed" : "overhangs even in the finished model" };
      (fin.ok ? report.violations.stability : report.cantilevers).push(row);
    }
}

/**
 * The camera of each main landing, from {cameras:[{k0,k1 | t0,t1, eye, target, up?, fov?, aspect?, opening?}], landingTimes?:[sec],
 * perLanding?:[camera]} or a bare camera list. k = landing index; t = seconds on the film clock (needs landingTimes).
 * @returns {(k:number) => object|null}
 */
export function cameraResolver(spec, landings) {
  if (!spec) return null;
  const list = Array.isArray(spec) ? spec : Array.isArray(spec.cameras) ? spec.cameras : [];
  const per = !Array.isArray(spec) && Array.isArray(spec.perLanding) ? spec.perLanding : null;
  const times = !Array.isArray(spec) && Array.isArray(spec.landingTimes) ? spec.landingTimes : null;
  if (times && times.length !== landings) throw new Error(`cameras: landingTimes has ${times.length} entries for ${landings} landings`);
  if (list.some((c) => c.t0 !== undefined) && !times) throw new Error("cameras: entries with t0/t1 need landingTimes (seconds of each landing)");
  for (const c of [...list, ...(per || [])]) if (c && (!Array.isArray(c.eye) || !Array.isArray(c.target))) throw new Error("cameras: every camera needs eye and target");
  return (k) => {
    if (per && per[k]) return per[k];
    const t = times ? times[k] : null;
    return list.find((c) => (c.k0 !== undefined || c.k1 !== undefined ? k >= (c.k0 ?? 0) && k < (c.k1 ?? Infinity) : c.t0 !== undefined ? t >= c.t0 && t < (c.t1 ?? Infinity) : true)) || null;
  };
}

/**
 * Runs the checks over a build order.
 * @param {{model:object, events:object[], options?:{ground?:number|null, cameras?:object|null, structureOnly?:boolean,
 *   maxHidden?:number, minVisible?:number, internal?:RegExp|null, travel?:number|null, unplaced?:string[]}}} args
 *   Visibility is required: without `cameras` the report fails unless `structureOnly` (a planning run; its stamp opens no gate).
 * @returns {object} the report ({pass, counts, violations, visibility, ...})
 */
export function checkOrder({ model, events, options = {} }) {
  const t0 = process.hrtime.bigint();
  const report = { tool: TOOL, version: VERSION, pass: false, structureOnly: !!options.structureOnly, landings: 0, ignored: 0, violations: { support: [], crossing: [], order: [], direction: [], stability: [], figure: [], unplaced: options.unplaced || [] }, cantilevers: [], unchecked: [], swings: [], visibility: null, precision: { tolerance: PRECISION_TOL, count: model.imprecise ? model.imprecise.length : 0, first: (model.imprecise || []).slice(0, 20) } };
  const ground = options.ground === undefined ? model.groundY : options.ground;
  const cameraFor = options.structureOnly ? null : cameraResolver(options.cameras, events.length);
  if (!options.structureOnly) report.visibility = { required: true, missingCameras: !cameraFor, checked: 0, hidden: [], noCamera: [], excepted: [], maxHidden: options.maxHidden ?? 0, minVisible: options.minVisible ?? 0.1 };
  runEvents(model, events, "main", report, { ground, firstFree: false, main: true, forceTravel: options.travel ?? null, cameraFor, minVisible: options.minVisible ?? 0.1, internal: options.internal || null, stability: options.stability !== false, unstable: [] });
  const vis = report.visibility;
  if (vis) {
    vis.hiddenCount = vis.hidden.length;
    vis.pct = vis.checked ? Math.round((vis.hiddenCount / vis.checked) * 1000) / 10 : 0;
    vis.pass = !vis.missingCameras && !vis.noCamera.length && (vis.maxHidden > 0 ? vis.pct <= vis.maxHidden : vis.hiddenCount === 0);
    vis.hidden = vis.hidden.slice(0, 500);
  }
  const v = report.violations;
  report.counts = { parts: model.P.length, landings: report.landings, support: v.support.length, crossing: v.crossing.length, order: v.order.length, direction: v.direction.length, stability: v.stability.length, figure: v.figure.length, unplaced: v.unplaced.length, hidden: vis ? (vis.missingCameras ? null : vis.hiddenCount) : null, noCamera: vis ? vis.noCamera.length : null, excepted: vis ? vis.excepted.length : null, cantilevers: report.cantilevers.length, imprecise: report.precision.count, unchecked: report.unchecked.length, ignored: report.ignored };
  report.strict = !!options.strict;
  report.pass = !v.support.length && !v.crossing.length && !v.order.length && !v.direction.length && (!options.strict || (!v.stability.length && !v.figure.length)) && !v.unplaced.length && (!vis || vis.pass);
  report.groundY = ground;
  report.ms = Number((process.hrtime.bigint() - t0) / 1000000n);
  return report;
}

// ---------------------------------------------------------------- inputs: a bake's build.json, an LDraw file, a simple order

const joinOf = (it) => ({
  from: it.join && Array.isArray(it.join.from) ? unit(it.join.from) : "auto",
  travel: it.join && Number.isFinite(it.join.travel) ? it.join.travel : "auto",
  seatLen: it.join && Number.isFinite(it.join.seatLen) ? it.join.seatLen : DEFAULT_SEAT,
  ...(it.join && it.join.arrive === "swing" ? { arrive: "swing", swingFrom: Number.isFinite(it.join.swingFrom) ? it.join.swingFrom : undefined } : {}),
});

/**
 * Placements and events from a bake's build.json (ldraw-bake.mjs, or a planner that rewrote its step order). The build
 * model's items in step order are the landings; an item of kind "model" lands as one rigid piece after its own steps
 * are checked as a separate build.
 */
export function fromBuildJson(build) {
  if (!build || typeof build.models !== "object") throw new Error("not a bake build.json (no models)");
  const key = build.buildKey && build.models[build.buildKey] ? build.buildKey : Object.keys(build.models)[0];
  const placements = [];
  const expand = (modelKey, M, prefix, depth) => {
    if (depth > 32) throw new Error(`sub-model nesting too deep at ${modelKey}`);
    const model = build.models[modelKey];
    if (!model) throw new Error(`build.json names sub-model ${modelKey} but has no entry for it`);
    return model.steps.flatMap((s) => s.items).map((it) => itemEvent(it, M, prefix, depth));
  };
  const itemEvent = (it, M, prefix, depth) => {
    const uid = prefix ? `${prefix}/${it.uid}` : it.uid;
    const m = M ? mul(M, it.m) : it.m;
    const j = joinOf(it);
    if (it.kind === "model") {
      const internal = expand(it.model, m, uid, depth + 1);
      const members = internal.flatMap((e) => e.members);
      return { label: uid, members, ...j, group: it.model, internal };
    }
    placements.push({ uid, part: it.part, m });
    return { label: uid, members: [placements.length - 1], ...j };
  };
  const events = expand(key, null, "", 0);
  return { placements, events, buildModel: build.models[key].name || key };
}

/**
 * Placements and the file's own order from an MPD/LDR: the build model's step items, sub-models as rigid pieces
 * (uids as ldraw-bake.mjs writes them: "<model>#<step>.<n>", a sub-model's parts "<item uid>/<their uid>").
 */
export function fromLdraw(text, name = "model.ldr") {
  const mpd = parseMpd(text, name);
  const target = findBuildModel(mpd);
  const placements = [];
  const walk = (key, M, prefix, depth, stack) => {
    if (stack.includes(norm(key))) throw new Error(`sub-model ${key} contains itself`);
    if (depth > 32) throw new Error(`sub-model nesting too deep at ${key}`);
    const mname = mpd.models.get(norm(key)).name;
    const out = [];
    for (const s of stepsOf(mpd, key)) {
      s.refs.forEach((ref, order) => {
        const uid0 = `${mname}#${s.n}.${order + 1}`;
        const uid = prefix ? `${prefix}/${uid0}` : uid0;
        const m = M ? mul(M, ref.m) : ref.m;
        if (isSubModel(mpd, ref.file)) {
          const internal = walk(ref.file, m, uid, depth + 1, [...stack, norm(key)]);
          out.push({ label: uid, members: internal.flatMap((e) => e.members), from: "auto", travel: "auto", seatLen: DEFAULT_SEAT, group: ref.file, internal });
        } else {
          placements.push({ uid, part: norm(ref.file).replace(/\.dat$/, ""), m });
          out.push({ label: uid, members: [placements.length - 1], from: "auto", travel: "auto", seatLen: DEFAULT_SEAT });
        }
      });
    }
    return out;
  };
  const events = walk(target.key, null, "", 0, []);
  return { placements, events, buildModel: target.name };
}

/**
 * Events from a simple order file (references/assembly.md "The order file"): a list of steps, each
 * {id | ids, from?, travel?, seatLen?, group?, arrive?, build?}. `id` names a placement uid, a 0-based index into the
 * placements, or a sub-model item uid of the file's own order (the whole sub-model, with its own steps as its build).
 * @returns {{events:object[], unplaced:string[]}}
 */
export function fromOrderSpec(spec, base) {
  const steps = Array.isArray(spec) ? spec : spec && Array.isArray(spec.steps) ? spec.steps : null;
  if (!steps) throw new Error("an order file is a list of steps or {steps:[...]}");
  const defaults = (!Array.isArray(spec) && spec.defaults) || {};
  const byUid = new Map(base.placements.map((p, i) => [p.uid, i]));
  const groups = new Map();
  const index = (evs) => evs.forEach((e) => { if (e.internal) { groups.set(e.label, e); index(e.internal); } });
  index(base.events);
  const used = new Uint8Array(base.placements.length);
  const resolve = (id) => {
    if (typeof id === "number" || /^\d+$/.test(String(id))) {
      const i = Number(id);
      if (!(i >= 0 && i < base.placements.length)) throw new Error(`order: index ${id} is out of range (0..${base.placements.length - 1})`);
      return { members: [i] };
    }
    if (byUid.has(id)) return { members: [byUid.get(id)] };
    if (groups.has(id)) return { members: groups.get(id).members, group: groups.get(id) };
    throw new Error(`order: no part or sub-model with id "${id}"`);
  };
  const mk = (st, k) => {
    if (typeof st === "string" || typeof st === "number") st = { id: st };
    const ids = st.ids || (st.id !== undefined ? [st.id] : null);
    if (!ids || !ids.length) throw new Error(`order step ${k} has no id or ids`);
    const res = ids.map(resolve);
    const members = res.flatMap((r) => r.members);
    const from = parseFrom(st.from ?? defaults.from ?? "auto");
    const travel = st.travel ?? defaults.travel ?? "auto";
    if (travel !== "auto" && !Number.isFinite(travel)) throw new Error(`order step ${k}: travel must be a number of LDU or "auto"`);
    const seatLen = st.seatLen ?? defaults.seatLen ?? DEFAULT_SEAT;
    let internal = null;
    if (Array.isArray(st.build)) internal = st.build.map((x, j) => mk(x, `${k}.${j}`));
    else if (members.length > 1) internal = res.length === 1 && res[0].group ? res[0].group.internal : members.map((i) => ({ label: base.placements[i].uid, members: [i], from: "auto", travel: "auto", seatLen: DEFAULT_SEAT }));
    const label = st.label || (ids.length === 1 ? String(ids[0]) : `${ids[0]}..(${members.length})`);
    return { label, members, from, travel, seatLen, group: st.group || (members.length > 1 ? label : undefined), arrive: st.arrive === "swing" ? "swing" : "slide", swingFrom: Number.isFinite(st.swingFrom) ? st.swingFrom : undefined, internal, ignore: !!st.ignore };
  };
  const events = steps.map((st, k) => mk(st, k));
  for (const e of events) for (const i of e.members) {
    if (used[i]) throw new Error(`order: ${base.placements[i].uid} is placed twice`);
    used[i] = 1;
  }
  const unplaced = [];
  used.forEach((u, i) => { if (!u) unplaced.push(base.placements[i].uid); });
  return { events, unplaced };
}

/**
 * Folds sub-assembly ranges into the event list: {units:[{k0, k1, kind, name, from?, travel?, arrive?}]} (k1 exclusive, as a
 * staged planner's stage.json writes) or [{k0,k1,...}]. Events k0..k1-1 become one rigid landing whose own build is
 * those events; kind "panel" or "swing" arrives by a swing (path not checked), the rest slide in from `from` (default above).
 */
export function applyGroups(events, spec) {
  const units = (Array.isArray(spec) ? spec : spec && Array.isArray(spec.units) ? spec.units : []).filter((u) => Number.isInteger(u.k0) && Number.isInteger(u.k1) && u.k1 > u.k0);
  units.sort((a, b) => a.k0 - b.k0);
  const out = [];
  let k = 0;
  for (const u of units) {
    if (u.k0 < k) throw new Error(`groups overlap at ${u.k0}`);
    if (u.k1 > events.length) throw new Error(`group ${u.name || u.k0} ends past the order (${u.k1} > ${events.length})`);
    while (k < u.k0) out.push(events[k++]);
    const internal = events.slice(u.k0, u.k1);
    const swing = u.arrive === "swing" || u.kind === "panel" || u.kind === "swing" || u.hinge;
    out.push({ label: `${u.kind || "group"} ${u.name || u.k0}`, members: internal.flatMap((e) => e.members), from: parseFrom(u.from ?? [0, -1, 0]), travel: u.travel ?? "auto", seatLen: u.seatLen ?? DEFAULT_SEAT, group: u.name || `${u.k0}`, arrive: swing ? "swing" : "slide", swingFrom: Number.isFinite(u.swingFrom) ? u.swingFrom : undefined, internal });
    k = u.k1;
  }
  while (k < events.length) out.push(events[k++]);
  return out;
}

/** Marks events ignored by a regex on uid / part id / title, and the last `tail` main events. */
function applyIgnore(events, model, re, tail) {
  const hit = (i) => re && (re.test(model.P[i].uid) || re.test(model.P[i].part.id) || re.test(model.P[i].part.title));
  const walk = (evs) => evs.forEach((e) => {
    if (re && e.members.every(hit)) e.ignore = true;
    if (e.internal) walk(e.internal);
  });
  walk(events);
  if (tail > 0) for (let k = Math.max(0, events.length - tail); k < events.length; k++) { events[k].ignore = true; events[k].ignoreTail = true; }
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileEntry = (p) => (p ? { path: path.resolve(p), sha256: sha256(fs.readFileSync(p)) } : null);

/**
 * The whole gate from files, as the CLI runs it. `input` is a bake build.json or an MPD/LDR; `order` a simple order file
 * (needed only to change the order of an MPD/LDR); `groups` sub-assembly ranges; `cameras` {cameras:[{k0,k1,eye,target,up?,fov,aspect}]}.
 * @returns {{report:object, inputs:object}}
 */
export function checkOrderFiles({ input, libraryDir, order = null, groups = null, cameras = null, ground = "auto", classes = {}, loose = null, ignore = null, ignoreTail = 0, travel = null, maxHidden = 0, minVisible = 0.1, internal = null, structureOnly = false, strict = false }) {
  const isJson = /\.json$/i.test(input);
  const text = fs.readFileSync(input, "utf8");
  const base = isJson ? fromBuildJson(JSON.parse(text)) : fromLdraw(text, path.basename(input));
  let events = base.events;
  let unplaced = [];
  if (order) ({ events, unplaced } = fromOrderSpec(JSON.parse(fs.readFileSync(order, "utf8")), base));
  if (groups) events = applyGroups(events, JSON.parse(fs.readFileSync(groups, "utf8")));
  const model = createModel({ libraryDir, placements: base.placements, classes, loose });
  applyIgnore(events, model, ignore, ignoreTail);
  const cams = cameras ? JSON.parse(fs.readFileSync(cameras, "utf8")) : null;
  const g = ground === "auto" ? model.groundY : ground === "none" ? null : Number(ground);
  const report = checkOrder({ model, events, options: { ground: g, cameras: cams, maxHidden, minVisible, internal, structureOnly, travel, unplaced, strict } });
  report.buildModel = base.buildModel;
  const inputs = { input: fileEntry(input), order: fileEntry(order), groups: fileEntry(groups), cameras: fileEntry(cameras), libraryDir: path.resolve(libraryDir), options: { ground, ignore: ignore ? String(ignore) : null, ignoreTail, loose: loose ? String(loose) : null, travel, maxHidden, minVisible, internal: internal ? String(internal) : null, structureOnly, classes } };
  return { report, inputs };
}

// ---------------------------------------------------------------- the stamp, and the gate render/verify run

/** Where the stamp for an order goes: beside the order file, else beside the input. */
export function stampPathFor({ input, order }) {
  return path.join(path.dirname(path.resolve(order || input)), STAMP_NAME);
}

export function writeStamp(file, { report, inputs }) {
  const stamp = { tool: TOOL, version: VERSION, pass: report.pass, structureOnly: !!report.structureOnly, visibilityChecked: !!(report.visibility && !report.visibility.missingCameras), checkedAt: new Date().toISOString(), inputs, counts: report.counts };
  fs.writeFileSync(file, JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

/**
 * Is the stamp current and passing for this order file? The order (and every other file the stamp lists) must hash the
 * same as when the check ran.
 * @param {string} orderFile the build.json (or order file) a renderer is about to use
 * @returns {{ok:boolean, reason:string, stamp:string}}
 */
export function checkOrderStamp(orderFile) {
  const stampFile = path.join(path.dirname(path.resolve(orderFile)), STAMP_NAME);
  if (!fs.existsSync(stampFile)) return { ok: false, stamp: stampFile, reason: `no ${STAMP_NAME} beside ${orderFile}: the build order was never checked` };
  let s;
  try {
    s = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch (e) {
    return { ok: false, stamp: stampFile, reason: `${stampFile} is not readable JSON (${e.message})` };
  }
  const want = path.resolve(orderFile);
  const listed = [s.inputs?.input, s.inputs?.order].filter(Boolean).map((e) => e.path);
  if (!listed.includes(want)) return { ok: false, stamp: stampFile, reason: `${stampFile} was written for ${listed.join(", ") || "another file"}, not ${want}` };
  for (const k of ["input", "order", "groups", "cameras"]) {
    const e = s.inputs?.[k];
    if (!e) continue;
    if (!fs.existsSync(e.path)) return { ok: false, stamp: stampFile, reason: `${e.path} (checked as ${k}) is gone` };
    if (sha256(fs.readFileSync(e.path)) !== e.sha256) return { ok: false, stamp: stampFile, reason: `${e.path} changed after the order check` };
  }
  if (!(s.version >= VERSION)) return { ok: false, stamp: stampFile, reason: `${stampFile} is from check version ${s.version ?? "?"}, before the checks of version ${VERSION} (DIRECTION, VISIBILITY, HINGES): run the check again` };
  if (s.structureOnly || !s.visibilityChecked) return { ok: false, stamp: stampFile, reason: `${stampFile} has no VISIBILITY check: run the check with --cameras <the film's camera track> (a --structure-only run opens no gate)` };
  if (!s.pass) return { ok: false, stamp: stampFile, reason: `the last order check FAILED (support ${s.counts?.support}, crossing ${s.counts?.crossing}, order ${s.counts?.order}, direction ${s.counts?.direction}, stability ${s.counts?.stability}, figure ${s.counts?.figure}, hidden ${s.counts?.hidden}, no camera ${s.counts?.noCamera}, unplaced ${s.counts?.unplaced})` };
  return { ok: true, stamp: stampFile, reason: "passed" };
}

/** Throws unless the order file has a current passing stamp. For custom renderers and planners. */
export function assertOrderChecked(orderFile) {
  const r = checkOrderStamp(orderFile);
  if (!r.ok) throw new Error(`LDraw build order not cleared: ${r.reason}. Run: node <skill>/scripts/ldraw-order-check.mjs ${orderFile} --lib <parts-folder>`);
  return r;
}

/** The LDraw build orders a reel uses: <reel>/data/build.json and <reel>/data/<dir>/build.json that hold bake models. */
export function findReelOrders(reelDir) {
  const data = path.join(reelDir, "data");
  const out = [];
  const consider = (f) => {
    if (!fs.existsSync(f)) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && typeof j.models === "object" && j.units === "LDU") out.push(f);
    } catch {
      /* not JSON: not a bake order */
    }
  };
  if (!fs.existsSync(data) || !fs.statSync(data).isDirectory()) return out;
  consider(path.join(data, "build.json"));
  for (const d of fs.readdirSync(data, { withFileTypes: true })) if (d.isDirectory()) consider(path.join(data, d.name, "build.json"));
  return out;
}

/**
 * The gate render.mjs and verify.mjs run: every LDraw build order in the reel needs a current passing stamp.
 * `skipReason` (from --skip-order-check "<reason>") lets it through and logs the reason to out/order-check-override.log.
 * @returns {{ok:boolean, lines:string[]}}
 */
export function orderGate(reelDir, { skipReason } = {}) {
  const orders = findReelOrders(reelDir);
  if (!orders.length) return { ok: true, lines: [] };
  const lines = [];
  const bad = [];
  for (const f of orders) {
    const r = checkOrderStamp(f);
    if (r.ok) lines.push(`order check: ${path.relative(reelDir, f)} passed (${path.relative(reelDir, r.stamp)})`);
    else bad.push(`${path.relative(reelDir, f)}: ${r.reason}`);
  }
  if (!bad.length) return { ok: true, lines };
  if (skipReason === true || skipReason === "") return { ok: false, lines: [...lines, "--skip-order-check needs a reason: --skip-order-check \"<why this render may show an unchecked order>\""] };
  if (typeof skipReason === "string") {
    const log = path.join(reelDir, "out", "order-check-override.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `${new Date().toISOString()}\t${skipReason}\t${bad.join(" | ")}\n`);
    return { ok: true, lines: [...lines, ...bad.map((b) => `ORDER CHECK SKIPPED (${skipReason}): ${b}`), `override logged to ${log}`] };
  }
  return {
    ok: false,
    lines: [...lines, ...bad.map((b) => `order check: ${b}`), "An LDraw build may not be rendered before its order passes: node scripts/ldraw-order-check.mjs <build.json> --lib <parts-folder> (references/assembly.md \"Required before any render of an LDraw build\"). Override only with --skip-order-check \"<reason>\" (logged)."],
  };
}
