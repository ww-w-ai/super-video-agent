// Insertion direction for each placed item of one model (references/assembly.md "Press direction from the
// connection"). Stud parts arrive from above when something under them carries them and from below when only
// a part above holds them; pin and axle parts arrive along their own axis, from the end whose path crosses
// fewer triangles. The numbers are estimates from boxes and triangles: the surface check
// (scripts/engine/reel-crossing.js) is the judge, and the report lists what it found.
import { applyDir } from "./ldraw.mjs";
import { pathCrossings, bestEnd } from "./surface-crossing.mjs";

const STUD_HEIGHT = 4;
const TOUCH = 0.5;
const STUD_SEAT = 8; // the stud joint's length; not sampled by the check
const AXIS_PATH_SAMPLES = 24;
const REPORT_PATH_SAMPLES = 40;

/**
 * The connection class of a part, from its title line. `stud` joins along the stud axis (local Y; LDraw's -Y is
 * up). `axis` is a pin, axle or bush: it joins along its own axis. `hole` is a brick or beam with holes through
 * it: the hole axis is local Z. A part id listed in `overrides` takes that class. A guess for the rest: a stud part.
 * @param {string} title
 * @param {string} partId
 * @param {Record<string,string>} [overrides]
 * @returns {"stud"|"axis"|"hole"}
 */
export function connectionClass(title, partId, overrides = {}) {
  if (overrides[partId]) return overrides[partId];
  if (/\b(Axle|Pin|Bush|Bushing|Peg)\b/i.test(title)) return "axis";
  if (/^Technic (Brick|Beam|Plate)/i.test(title) || /\bLiftarm\b/i.test(title)) return "hole";
  return "stud";
}

const xzOverlap = (A, B, eps = TOUCH) => A[0] < B[3] - eps && B[0] < A[3] - eps && A[2] < B[5] - eps && B[2] < A[5] - eps;
// a body surface may sit at the box's face or STUD_HEIGHT inside it, where studs stand above it
const meets = (bottom, top) => Math.abs(bottom - top) < TOUCH || Math.abs(bottom - (top + STUD_HEIGHT)) < TOUCH;

/** Stud items: from above when a part under them carries them, from below when only a part above holds them. */
function studSide(p, placed) {
  const others = placed.filter((q) => q.cls !== "axis" && xzOverlap(p.wb, q.wb));
  if (others.some((q) => meets(p.wb[4], q.wb[1]))) return { dir: [0, -1, 0], reason: "rests on a part below" };
  if (others.some((q) => meets(q.wb[4], p.wb[1]))) return { dir: [0, 1, 0], reason: "holds onto the underside of a part above" };
  return { dir: [0, -1, 0], reason: placed.length ? "no contact found; dropped from above" : "first part" };
}

/** Distance along dir until the item's box clears every placed box, plus a margin. */
function clearDistance(p, dir, placed, margin) {
  for (let d = 0; d < 2000; d += 2) {
    const box = p.wb.map((v, i) => v + dir[i % 3] * d);
    const hit = placed.some((q) => box[0] < q.wb[3] && q.wb[0] < box[3] && box[1] < q.wb[4] && q.wb[1] < box[4] && box[2] < q.wb[5] && q.wb[2] < box[5]);
    if (!hit) return d + margin;
  }
  throw new Error(`no clear start for ${p.uid}`);
}

const unit = (v) => {
  const len = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / len) * 1e6) / 1e6 + 0);
};
const axisName = (dir) => ["x", "y", "z"][dir.map(Math.abs).indexOf(Math.max(...dir.map(Math.abs)))];

/** The local axis a pin, axle or hole part joins along, from its own geometry. */
function localAxis(part, cls) {
  if (cls === "hole") return [0, 0, 1];
  const b = part.bounds;
  const ext = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  const pick = /Bush/i.test(part.title) ? Math.min(...ext) : Math.max(...ext); // a bush is short along its axle
  const k = ext.indexOf(pick);
  return [0, 1, 2].map((i) => (i === k ? 1 : 0));
}

/** How far the item overlaps, along the axis, the parts it joins at rest (at least 4). */
function seatLength(p, axis, placed) {
  const k = axisName(axis) === "x" ? 0 : axisName(axis) === "y" ? 1 : 2;
  let seat = 0;
  for (const q of placed) {
    const lateral = [0, 1, 2].filter((a) => a !== k).every((a) => p.wb[a] < q.wb[a + 3] - TOUCH && q.wb[a] < p.wb[a + 3] - TOUCH);
    if (lateral) seat = Math.max(seat, Math.min(p.wb[k + 3], q.wb[k + 3]) - Math.max(p.wb[k], q.wb[k]));
  }
  return Math.max(4, Math.round(seat));
}

function studJoin(p, placed) {
  const side = studSide(p, placed);
  return { axis: "y", from: side.dir, reason: side.reason, seatLen: STUD_SEAT, travel: Math.max(72, clearDistance(p, side.dir, placed, 24)) };
}

function axisJoin(p, env, placed, placedSurfaces) {
  const part = env.partOf(p);
  const axis = unit(applyDir(p.m, ...localAxis(part, p.cls)));
  const moving = env.surfacesOf(p)[0].surface;
  const best = bestEnd({ moving, placed: placedSurfaces, dirs: [axis, axis.map((v) => -v + 0)], travelOf: (dir) => clearDistance(p, dir, placed, 20), seatLen: 2, samples: AXIS_PATH_SAMPLES });
  const other = best.trials.find((t) => t.dir !== best.dir);
  const seatLen = seatLength(p, axis, placed);
  const what = p.cls === "hole" ? "hole" : "axle";
  const trial = best.trials.find((t) => t.dir === best.dir);
  return {
    axis: axisName(axis),
    from: best.dir,
    reason: `slides along its ${what} axis; other end crossed ${other.hits} triangle pairs, this end ${best.hits}`,
    seatLen,
    travel: Math.max(trial.travel, seatLen + 24),
  };
}

/**
 * Sets `cls` and `join` on each item, in build order. An item needs `uid`, `kind` ("part"|"model"), `m` and `wb`
 * (its box in the model's frame). `env` gives `partOf(item)` ({title, bounds, id}), `surfacesOf(item)`
 * ([{id, surface}] in the model's frame) and `overrides`.
 * @param {object[]} items
 * @param {{partOf:Function, surfacesOf:Function, overrides?:object}} env
 * @returns {object[]} the same items
 */
export function planJoins(items, env) {
  const placed = [];
  const placedSurfaces = [];
  for (const p of items) {
    const part = p.kind === "part" ? env.partOf(p) : null;
    p.cls = part ? connectionClass(part.title, part.id, env.overrides) : "stud";
    p.join = p.cls === "stud" || !placed.length ? studJoin(p, placed) : axisJoin(p, env, placed, placedSurfaces);
    placed.push(p);
    placedSurfaces.push(...env.surfacesOf(p));
  }
  return items;
}

/**
 * The surface check of every chosen path, in build order: per item the number of triangle pairs that cross
 * before the seat, when the path first crosses (0..1) and, per crossing sample, the pairs.
 * @returns {{uid:string, hits:number, firstHitAt:number|null, detail:string[]}[]}
 */
export function checkPaths(items, env) {
  const placedSurfaces = [];
  const rows = [];
  for (const p of items) {
    const mine = env.surfacesOf(p);
    const row = { uid: p.uid, hits: 0, firstHitAt: null, detail: [] };
    for (const m of mine) {
      const r = pathCrossings({ moving: m.surface, placed: placedSurfaces, dir: p.join.from, travel: p.join.travel, seatLen: p.join.seatLen, samples: REPORT_PATH_SAMPLES });
      row.hits += r.hits;
      if (r.firstHitAt != null && (row.firstHitAt == null || r.firstHitAt < row.firstHitAt)) row.firstHitAt = r.firstHitAt;
      row.detail.push(...r.detail.map((d) => `${d.d.toFixed(1)}: ${d.pairs.map((x) => `${m.id} x ${x.with} ${x.count}`).join(", ")}`));
    }
    rows.push(row);
    placedSurfaces.push(...mine);
  }
  return rows;
}
