// Minifig hand-hold check: an item "in" a minifig hand must be gripped on a 3.18 mm bar
// (references/assembly.md "Minifig hands hold bars only"; CLI: scripts/ldraw-handhold.mjs).
// Reads the LDraw library directly, no bake: well under a second on a 6,000-part model.
// Same core as ww-w-kids tools/handhold.mjs (the project's build audit), where the lesson was found (ledger EV-26).
//
// Facts encoded (owner 2026-10-23, Niagara: a fishing rod and then a camera were put "in" hands without a grippable bar):
// - A minifig hand (LDraw 3820, formerly 983, and every hand inside a composite arm/torso, found by walking the part's
//   sub-files) is a C-clip. Its grip, from 3820.dat's own geometry and !HELP: centre (0, -0.8229, -9.8948), axis
//   (0, -10.64966, -2.75422) (the hand's 14.5 deg tilt), length 11 LDU, inner radius 4 LDU (= 8 LDU = 3.18 mm bar).
// - It grips only a 3.18 mm bar: bar elements, antennas, lightsaber hilts, tool handles, the handle of camera 30089b,
//   binoculars' bar, oar/paddle shafts, fishing rod 2614's handle. It does NOT grip a stud, brick body, plate edge or tile.
// - A part counts as "in the hand" when its geometry enters the grip cylinder (within 4.6 LDU of the grip axis along the
//   grip length). It PASSES only when one of its bars (cylinder primitives of radius 4 LDU covering at least half the
//   circle, outside stud primitives; or a curated entry in BAR_TABLE) has its axis within ANGLE_TOL of the grip axis,
//   offset at most OFFSET_TOL from it, and covers at least half the grip length.
// - With a moving.json: a held item must move only with its hand and arm. FAIL when an animation entry moves the item
//   without the hand (or the hand without the item), when the entry's pivot is not at the arm's shoulder / the figure's
//   body (the item turning about its own pivot), or when an entry named like a held item (rod, camera, tool, ...) moves
//   parts that no minifig hand grips.
import fs from "node:fs";
import path from "node:path";

const ANGLE_TOL = 8; // degrees between bar axis and grip axis
const OFFSET_TOL = 1.2; // LDU between the bar axis and the grip axis (both grip ends)
const COVER_MIN = 0.5; // share of the 11 LDU grip length the bar must fill
const UPSIDE_DOWN = 0.5; // the item's own up (-Y) with a world-down component above this (more than 120 deg from up) is listed
const IN_CLIP = 4.6; // LDU from the grip axis: geometry this close is inside the clip
const GRIP = { p0: [0, 4.502, -8.518], p1: [0, -6.1478, -11.2716] }; // 3820.dat 2-4cylo r=4, the grip
const HAND_FILES = new Set(["3820.dat", "983.dat"]);
// Parts whose bar is not modelled with cylinder primitives: local bar segment(s) [p0, p1] (LDU, part space).
// Add an entry when a known bar-bearing part reports "no bar" (check its .dat for the shaft first).
const BAR_TABLE = {};
// Minifig body parts are never "held items" (they sit next to the hand by design).
const BODY_RE = /^~?Minifig (Arm|Torso|Hand|Head|Hips|Leg|Hair|Neck|Headdress|Cap|Hat|Helmet)/i;
const HELD_KEYS = /^(rod|held|item|tool|camera|binoculars|paddle|oar|prop)$/i;

// ---------- LDraw loading ----------
export function makeLib(lib, modelDir) {
  const dirs = [path.join(lib, "parts"), path.join(lib, "p"), path.join(lib, "models"), modelDir].filter(Boolean);
  const cache = new Map();
  const find = (name) => {
    const n = name.replace(/\\/g, "/");
    for (const d of dirs) { const f = path.join(d, n); if (fs.existsSync(f)) return f; const l = path.join(d, n.toLowerCase()); if (fs.existsSync(l)) return l; }
    return null;
  };
  const load = (name, inline) => {
    const key = name.toLowerCase().replace(/\\/g, "/");
    if (cache.has(key)) return cache.get(key);
    let text = inline?.get(key);
    if (text == null) { const f = find(name); text = f ? fs.readFileSync(f, "utf8") : null; }
    const rec = text == null ? null : parseFile(text);
    cache.set(key, rec);
    return rec;
  };
  return { load };
}
function parseFile(text) {
  const lines = text.split(/\r?\n/);
  const desc = (lines.find((l) => l.trim()) || "").replace(/^0\s*/, "").trim();
  const refs = [], tris = [];
  let invertNext = false; // BFC INVERTNEXT: the next sub-file is inside-out (a hole or a clip's inner face, never a bar)
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === "0" && t[1] === "BFC" && t[2] === "INVERTNEXT") { invertNext = true; continue; }
    if (t[0] === "1" && t.length >= 15) { refs.push({ t: [+t[2], +t[3], +t[4]], m: t.slice(5, 14).map(Number), name: t.slice(14).join(" "), inv: invertNext }); invertNext = false; }
    else if (t[0] === "3" && t.length >= 11) tris.push(t.slice(2, 11).map(Number));
    else if (t[0] === "4" && t.length >= 14) { const q = t.slice(2, 14).map(Number); tris.push([...q.slice(0, 9)], [...q.slice(0, 3), ...q.slice(6, 12)]); }
  }
  return { desc, refs, tris };
}
const base = (n) => n.replace(/\\/g, "/").split("/").pop().toLowerCase();
const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
const app = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const compose = (P, C) => ({ m: mul(P.m, C.m), t: add(app(P.m, C.t), P.t) });
const xf = (T, v) => add(app(T.m, v), T.t);
const inv = (T) => { // general 3x3 inverse (LDraw matrices may be scaled/mirrored)
  const [a, b, c, d, e, f, g, h, i] = T.m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const m = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
  return { m, t: scl(app(m, T.t), -1) };
};
const ID = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

// Per part type (cached): hands (grip segments), bars, bbox, triangles.
function analyzer(L) {
  const memo = new Map();
  const info = (name) => {
    const key = base(name);
    if (memo.has(name.toLowerCase())) return memo.get(name.toLowerCase());
    const rec = L.load(name);
    const out = { desc: rec?.desc || "", hands: [], bars: [], box: null, missing: !rec };
    memo.set(name.toLowerCase(), out);
    if (!rec) return out;
    if (HAND_FILES.has(key)) out.hands.push({ p0: GRIP.p0, p1: GRIP.p1 });
    const grow = (v) => { if (!out.box) out.box = [...v, ...v]; for (let k = 0; k < 3; k++) { out.box[k] = Math.min(out.box[k], v[k]); out.box[k + 3] = Math.max(out.box[k + 3], v[k]); } };
    for (const t of rec.tris) for (let k = 0; k < 9; k += 3) grow(t.slice(k, k + 3));
    for (const r of rec.refs) {
      const T = { m: r.m, t: r.t }, rb = base(r.name);
      const cyl = rb.match(/^(\d+)-(\d+)(cyli|cylo|cylc|cyls|cyli2|cylc2|cylo2)\.dat$/);
      if (cyl) {
        const frac = +cyl[1] / +cyl[2];
        const c1 = len([r.m[0], r.m[3], r.m[6]]), c3 = len([r.m[2], r.m[5], r.m[8]]);
        if (frac >= 0.5 && Math.abs(c1 - c3) < 0.3 && c1 > 3.5 && c1 < 4.5 && !r.inv) out.bars.push({ p0: r.t, p1: xf(T, [0, 1, 0]), r: c1, src: rb });
      }
      if (/^stud/.test(rb)) { const sb = info(r.name).box; if (sb) for (const c of corners(sb)) grow(xf(T, c)); continue; } // studs are never bars
      const sub = info(r.name);
      for (const h of sub.hands) out.hands.push({ p0: xf(T, h.p0), p1: xf(T, h.p1) });
      if (!cyl && !r.inv) for (const b of sub.bars) out.bars.push({ ...b, p0: xf(T, b.p0), p1: xf(T, b.p1) });
      if (sub.box) for (const c of corners(sub.box)) grow(xf(T, c));
    }
    for (const seg of BAR_TABLE[key.replace(/\.dat$/, "")] || []) out.bars.push({ p0: seg[0], p1: seg[1], r: 4, src: "BAR_TABLE" });
    return out;
  };
  const triMemo = new Map();
  const tris = (name) => { // flattened triangles in part space
    const k = name.toLowerCase();
    if (triMemo.has(k)) return triMemo.get(k);
    const rec = L.load(name), outT = [];
    if (rec) {
      for (const t of rec.tris) outT.push(t);
      for (const r of rec.refs) { const T = { m: r.m, t: r.t }; for (const t of tris(r.name)) outT.push([...xf(T, t.slice(0, 3)), ...xf(T, t.slice(3, 6)), ...xf(T, t.slice(6, 9))]); }
    }
    triMemo.set(k, outT);
    return outT;
  };
  return { info, tris };
}
function corners(b) { const o = []; for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) o.push([x, y, z]); return o; }

// ---------- model flattening ----------
export function flatten(modelFile, L) {
  const text = fs.readFileSync(modelFile, "utf8");
  const inline = new Map(); // MPD sub-files
  let first = null, cur = null;
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^0\s+FILE\s+(.+)$/i);
    if (m) { cur = m[1].trim().toLowerCase(); first ??= cur; inline.set(cur, ""); continue; }
    if (cur) inline.set(cur, inline.get(cur) + l + "\n");
  }
  const mainText = first ? inline.get(first) : text;
  const isModel = (n) => inline.has(n.toLowerCase()) || (/\.(ldr|mpd)$/i.test(n) && fs.existsSync(path.join(path.dirname(modelFile), n)));
  const out = [];
  const walk = (txt, T, step0, depth) => {
    let step = 1, line = 0;
    for (const l of txt.split(/\r?\n/)) {
      line++;
      const t = l.trim().split(/\s+/);
      if (t[0] === "0" && /^STEP$/i.test(t[1] || "")) { step++; continue; }
      if (t[0] !== "1" || t.length < 15) continue;
      const name = t.slice(14).join(" ");
      const W = compose(T, { t: [+t[2], +t[3], +t[4]], m: t.slice(5, 14).map(Number) });
      const s = step0 ?? step;
      if (depth < 8 && isModel(name)) {
        const sub = inline.get(name.toLowerCase()) ?? fs.readFileSync(path.join(path.dirname(modelFile), name), "utf8");
        walk(sub, W, s, depth + 1);
      } else out.push({ step: s, line: step0 == null ? line : null, part: name.replace(/\.dat$/i, ""), file: name, color: +t[1], T: W });
    }
  };
  walk(mainText, ID, null, 0);
  return out;
}

// ---------- geometry helpers ----------
function closestOnTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scl(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scl(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scl(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(scl(ab, vb * den), scl(ac, vc * den)));
}
const segBoxDist = (p0, p1, b) => { // sampled distance segment -> box
  let best = Infinity;
  for (let i = 0; i <= 8; i++) {
    const p = add(p0, scl(sub(p1, p0), i / 8));
    const d = [0, 1, 2].map((k) => Math.max(b[k] - p[k], 0, p[k] - b[k + 3]));
    best = Math.min(best, len(d));
  }
  return best;
};
const lineDist = (p, a, u) => { const ap = sub(p, a); return len(sub(ap, scl(u, dot(ap, u)))); };
const fmt = (v) => `(${v.map((x) => x.toFixed(1)).join(", ")})`;

// ---------- the check ----------
export function handhold(modelFile, { lib, moving } = {}) {
  if (!lib) throw new Error("handhold needs the parts library folder (lib)");
  const L = makeLib(lib, path.dirname(modelFile));
  const A = analyzer(L);
  const parts = flatten(modelFile, L);
  const hands = []; // {idx, grip:{p0,p1} world}
  parts.forEach((p, idx) => { for (const h of A.info(p.file).hands) hands.push({ idx, p0: xf(p.T, h.p0), p1: xf(p.T, h.p1) }); });
  const problems = [], passes = [], held = [], checks = [];
  for (const h of hands) {
    const hp = parts[h.idx], gl = len(sub(h.p1, h.p0)), gu = scl(sub(h.p1, h.p0), 1 / gl), gc = scl(add(h.p0, h.p1), 0.5);
    for (let j = 0; j < parts.length; j++) {
      if (j === h.idx) continue;
      const q = parts[j];
      if (len(sub(q.T.t, gc)) > 400) continue; // nothing minifig-held is that big
      const qi = A.info(q.file);
      if (!qi.box || qi.hands.length || BODY_RE.test(qi.desc)) continue;
      const Ti = inv(q.T), l0 = xf(Ti, h.p0), l1 = xf(Ti, h.p1);
      if (segBoxDist(l0, l1, qi.box) > IN_CLIP) continue;
      // exact: does the part's surface come inside the clip?
      let dmin = Infinity;
      const T = A.tris(q.file);
      for (let i = 1; i < 8 && dmin > 0.05; i++) {
        const p = add(l0, scl(sub(l1, l0), i / 8));
        for (const t of T) { const d = len(sub(p, closestOnTri(p, t.slice(0, 3), t.slice(3, 6), t.slice(6, 9)))); if (d < dmin) dmin = d; }
      }
      // local lengths equal world lengths for unscaled LDraw placements
      if (dmin > IN_CLIP) continue;
      // bar test
      let best = null, cover = [];
      for (const b of qi.bars) {
        const b0 = xf(q.T, b.p0), b1 = xf(q.T, b.p1), bl = len(sub(b1, b0)), bu = scl(sub(b1, b0), 1 / bl);
        const ang = (Math.acos(Math.min(1, Math.abs(dot(bu, gu)))) * 180) / Math.PI;
        const off = Math.max(lineDist(h.p0, b0, bu), lineDist(h.p1, b0, bu));
        const s0 = dot(sub(h.p0, b0), bu), s1 = dot(sub(h.p1, b0), bu);
        const lo = Math.max(Math.min(s0, s1), 0), hi = Math.min(Math.max(s0, s1), bl);
        const ov = Math.max(0, hi - lo);
        const cand = { ang, off, ov, src: b.src, mid: scl(add(b0, b1), 0.5) };
        if (!best || ang + off * 5 - ov < best.ang + best.off * 5 - best.ov) best = cand;
        if (ang <= ANGLE_TOL && off <= OFFSET_TOL && ov > 0 && Math.abs(s1 - s0) > 1e-6) { // covered part of the grip, in grip length units
          const ta = ((0 - s0) / (s1 - s0)) * gl, tb = ((bl - s0) / (s1 - s0)) * gl;
          cover.push([Math.max(0, Math.min(ta, tb)), Math.min(gl, Math.max(ta, tb))]);
        }
      }
      cover.sort((a, b) => a[0] - b[0]);
      let covered = 0, end = -Infinity;
      for (const [a, b] of cover) { const s = Math.max(a, end); if (b > s) covered += b - s; end = Math.max(end, b); }
      const where = `${q.part} (colour ${q.color}, step ${q.step}${q.line ? `, line ${q.line}` : ""}) at ${fmt(q.T.t)} in hand ${hp.part} (step ${hp.step}) grip ${fmt(gc)}`;
      const rec = { item: q.part, itemStep: q.step, itemIdx: j, hand: hp.part, handStep: hp.step, handIdx: h.idx, grip: gc };
      // ORIENTATION (EV-44, Gwanghwamun: a tourist's camera held upside down passed the grip test): the item's own up
      // (its part frame's -Y) pointing down is listed for a look at a close-up sheet; a prop may also be held reversed
      // on purpose (a sword pointing down), so this is a CHECK line, not a FAIL
      const upY = -q.T.m[4] / (Math.hypot(q.T.m[1], q.T.m[4], q.T.m[7]) || 1);
      if (upY > UPSIDE_DOWN) checks.push(`CHECK ${where}: its own up points ${Math.round((Math.acos(Math.max(-1, Math.min(1, -upY))) * 180) / Math.PI)} deg from up (upside down?); turn it about the grip or use the other bar end, keep its front where the figure looks, and compare a close-up sheet with a photo of a real minifig`);
      if (covered >= COVER_MIN * gl) { passes.push(`PASS ${where}: bar axis on the clip axis, fills ${covered.toFixed(1)}/${gl.toFixed(1)} LDU`); held.push({ ...rec, ok: true }); }
      else {
        const why = !qi.bars.length ? `presents no 3.18 mm bar (a body/stud/brick/plate/tile is in the clip, ${dmin.toFixed(1)} LDU from the clip axis)`
          : `nearest bar (${best.src}) is ${best.ang.toFixed(0)} deg off the clip axis, ${best.off.toFixed(1)} LDU off-centre, fills ${best.ov.toFixed(1)}/${gl.toFixed(1)} LDU (need <= ${ANGLE_TOL} deg, <= ${OFFSET_TOL} LDU, >= ${(COVER_MIN * gl).toFixed(1)} LDU)`;
        problems.push(`FAIL ${where}: ${why}`); held.push({ ...rec, ok: false });
      }
    }
  }
  // ---------- moving.json ----------
  let movingNote = null;
  if (moving && fs.existsSync(moving)) {
    const mv = JSON.parse(fs.readFileSync(moving, "utf8"));
    const entries = [];
    const walk = (o, p) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o.steps) && (o.pivot || o.point || o.axis)) entries.push({ name: p, key: p.split(".").pop(), steps: new Set(o.steps), pivot: o.pivot || o.point || null });
      for (const [k, v] of Object.entries(o)) {
        if (k === "groups" && v && typeof v === "object") {
          for (const [g, arr] of Object.entries(v)) if (Array.isArray(arr)) entries.push({ name: `groups.${g}`, key: g, steps: new Set(arr), pivot: mv[g]?.point || mv[g]?.pivot || null, group: true });
        } else if (k !== "steps") walk(v, p ? `${p}.${k}` : k);
      }
    };
    walk(mv, "");
    // steps in moving.json are main-model step numbers
    const stepOf = (i) => parts[i].step;
    // A good pivot is on a shoulder axis (an arm's origin + its local x axis, the axis 3818/3819 swing about, up to the
    // torso's width) or at a torso (the whole figure turns). Item-centred pivots fail.
    const body = parts.filter((p) => /^~?Minifig (Arm|Torso)/i.test(A.info(p.file).desc));
    const bodyNear = (e, pivot) => body.some((p) => {
      if (/Torso/i.test(A.info(p.file).desc)) return len(sub(p.T.t, pivot)) < 12;
      const ax = [p.T.m[0], p.T.m[3], p.T.m[6]], u = scl(ax, 1 / len(ax));
      return lineDist(pivot, p.T.t, u) < 2 && Math.abs(dot(sub(pivot, p.T.t), u)) < 20;
    });
    for (const hd of held) {
      const S = stepOf(hd.itemIdx), H = stepOf(hd.handIdx);
      for (const e of entries) {
        const hasS = e.steps.has(S), hasH = e.steps.has(H);
        if (hasS && !hasH) problems.push(`FAIL moving: ${e.name} moves held ${hd.item} (step ${S}) without its hand ${hd.hand} (step ${H})${e.pivot ? ` about its own pivot ${fmt(e.pivot)}` : ""}`);
        else if (hasH && !hasS && !e.group) problems.push(`FAIL moving: ${e.name} moves hand ${hd.hand} (step ${H}) without the item it holds, ${hd.item} (step ${S})`);
        else if (hasS && hasH && e.pivot && !e.group && !bodyNear(e, e.pivot)) problems.push(`FAIL moving: ${e.name} turns held ${hd.item} and its hand about ${fmt(e.pivot)}, which is not the arm's shoulder or the figure's body`);
      }
    }
    const heldSteps = new Set(held.flatMap((hd) => [stepOf(hd.itemIdx), stepOf(hd.handIdx)]));
    for (const e of entries) if (HELD_KEYS.test(e.key) && ![...e.steps].some((s) => heldSteps.has(s)))
      problems.push(`FAIL moving: ${e.name} animates ${[...e.steps].map((s) => parts.find((p) => p.step === s)?.part || `step ${s}`).join(", ")} as a held item about its own pivot${e.pivot ? ` ${fmt(e.pivot)}` : ""}, but no minifig hand grips it`);
    movingNote = `moving: ${path.basename(moving)} (${entries.length} animation entries)`;
  }
  const info = `${hands.length} minifig hand(s), ${held.length} item(s) in a hand (${held.filter((h) => h.ok).length} on a bar)${movingNote ? `; ${movingNote}` : ""}`;
  return { ok: problems.length === 0, problems, passes, checks, info, held };
}

