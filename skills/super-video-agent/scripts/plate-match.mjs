#!/usr/bin/env node
// Camera match for a photographic background plate (references/3d-plates.md). The camera model lives in
// scripts/engine/reel-plate.js and is loaded from there, so the grid drawn here is the camera the page
// renders with. Image work runs on skia-canvas in Node: no browser, no Python.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import skia from "skia-canvas";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { isMain } from "./lib/is-main.mjs";

const { Canvas, loadImage } = skia;
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "engine", "reel-plate.js")).href);
const RP = globalThis.ReelPlate;
const D2R = Math.PI / 180;

const HELP = `usage: plate-match.mjs <command> ...

Camera match for a photo plate. A plates file is JSON {name: {file, fov, horizon, roll, h, spot}, ...};
file is relative to the plates file. fov = vertical field of view of the whole image (deg); horizon =
horizon row as a fraction of the height from the top; roll (deg, + = clockwise); h = camera height above
the table in object units; spot = [x, y] fractions where the object's foot stands (the world origin).

  auto <image> [--rows y0,y1] [--out <png|jpg>]
      vanishing point of the receding table lines (edge Hough + RANSAC inside rows y0..y1, fractions of
      the height, default 0.5,0.98); prints the horizon fraction; --out draws the lines used
  vp <image> x1,y1,x2,y2 x3,y3,x4,y4 [...]
      vanishing point of two or more image lines that are parallel on the table (least squares)
  fov <W>x<H> --vp1 x,y --vp2 x,y
      vertical fov and roll from the vanishing points of two table directions at right angles
  scale <plates.json> <name> --foot x,y --top x,y --size <s>
      camera height in object units from an object in the plate: its foot and top pixel and its true
      height s in the same units (for example its height in your object's heights)
  grid <plates.json> <name>[,<name>...] [--out <png|jpg>] [--cell <px>] [--step <units>] [--far <units>]
       [--object <radius>,<height>]
      the matched table plane as a grid every --step units (default 2), the horizon, and an object proxy
      cylinder at the origin (default radius 0.43, height 1); look at it to judge the match
  ruler <image> [--out <png|jpg>]
      the image with a labelled pixel grid every 100 px, to read line end points off
  set <plates.json> <name>[,<name>...] key=<json> [...]
      change match fields, for example h=2.2 spot=[0.5,0.7]

Outputs default to <image dir>/match/<command>-<name>.jpg. Exit 1 on bad input; numbers are printed.
`;

// ---- geometry ---------------------------------------------------------------------------------

/** Normalised line {a, b, c} (a² + b² = 1) through two points: a x + b y + c = 0. */
export function lineThrough([x1, y1], [x2, y2]) {
  const a = y1 - y2, b = x2 - x1, c = x1 * y2 - x2 * y1;
  const n = Math.hypot(a, b);
  if (n < 1e-12) throw new Error("a line needs two different points");
  return { a: a / n, b: b / n, c: c / n };
}

/** Weighted least-squares point closest to all lines; null when they are (near) parallel. */
export function vanishingPoint(lines) {
  let saa = 0, sab = 0, sbb = 0, sac = 0, sbc = 0;
  for (const { a, b, c, w = 1 } of lines) {
    saa += w * a * a; sab += w * a * b; sbb += w * b * b; sac += w * a * c; sbc += w * b * c;
  }
  const det = saa * sbb - sab * sab;
  if (Math.abs(det) < 1e-9 * Math.max(1, saa * sbb)) return null;
  return [(-sac * sbb + sbc * sab) / det, (-sbc * saa + sac * sab) / det];
}

/** Vertical fov (deg) and roll (deg) from the vanishing points of two orthogonal table directions. */
export function fovFromVanishingPoints(v1, v2, W, H) {
  const cx = W / 2, cy = H / 2;
  const f2 = -((v1[0] - cx) * (v2[0] - cx) + (v1[1] - cy) * (v2[1] - cy));
  if (!(f2 > 0)) throw new Error("these vanishing points cannot come from two directions at right angles seen by a centred lens");
  const f = Math.sqrt(f2);
  const roll = Math.atan2(v2[1] - v1[1], v2[0] - v1[0]) / D2R;
  const r = ((roll + 90) % 180 + 180) % 180 - 90; // the horizon has no direction
  return { fov: (2 * Math.atan(H / 2 / f)) / D2R, roll: r, focalPx: f };
}

/** Camera height (object units) that puts the top of an object of true height `size` at pixel `top`. */
export function heightFromObject(P, W, H, foot, top, size) {
  const spot = [foot[0] / W, foot[1] / H];
  const err = (h) => {
    const cam = RP.matchCamera(Object.assign({}, P, { h, spot }), W, H);
    const p = RP.project(cam, [0, size, 0], W, H);
    return p.ok ? Math.hypot(p.x - foot[0], p.y - foot[1]) - Math.hypot(top[0] - foot[0], top[1] - foot[1]) : Infinity;
  };
  // the top behind the lens counts as too big; a higher camera stands farther along the same ray, so the object looks shorter: err falls as h rises
  let lo = 1e-3, hi = 1e4;
  if (err(lo) < 0 || err(hi) > 0) throw new Error("no camera height on this spot ray gives that object size");
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (err(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// ---- line detection (Sobel + Hough + RANSAC) ---------------------------------------------------

/** Luma of RGBA pixels. */
export function toGray(rgba, W, H) {
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
  return g;
}

/**
 * Straight lines in rows y0..y1 (fractions) that are not near-horizontal (receding table lines are not):
 * {a, b, c, w} in pixel coordinates, w = Hough votes.
 */
export function detectLines(gray, W, H, { rows = [0.5, 0.98], maxLines = 40, minAngle = 14 } = {}) {
  const ya = Math.max(1, Math.floor(rows[0] * H)), yb = Math.min(H - 2, Math.ceil(rows[1] * H));
  const mags = [], pts = [];
  for (let y = ya; y <= yb; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1] - gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1];
      const gy = gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1] - gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1];
      const m = Math.hypot(gx, gy);
      if (m > 40) { mags.push(m); pts.push(x, y, Math.atan2(gy, gx)); }
    }
  }
  if (!mags.length) return [];
  const sorted = Float32Array.from(mags).sort();
  const cut = sorted[Math.floor(sorted.length * 0.6)];
  const NT = 360, dTheta = Math.PI / NT, R = Math.ceil(Math.hypot(W, H)), NR = 2 * R + 1;
  const acc = new Float32Array(NT * NR);
  const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
  for (let k = 0; k < NT; k++) { cosT[k] = Math.cos(k * dTheta); sinT[k] = Math.sin(k * dTheta); }
  const near90 = (k) => Math.abs(k * dTheta - Math.PI / 2) < minAngle * D2R;
  for (let j = 0; j < mags.length; j++) {
    if (mags[j] < cut) continue;
    const x = pts[3 * j], y = pts[3 * j + 1];
    let th = pts[3 * j + 2];
    if (th < 0) th += Math.PI;
    if (th >= Math.PI) th -= Math.PI;
    const k0 = Math.round(th / dTheta);
    // vote only near the gradient's own normal direction: far fewer false peaks than a full sweep
    for (let dk = -4; dk <= 4; dk++) {
      let k = k0 + dk, flip = 1;
      if (k < 0) { k += NT; flip = -1; } else if (k >= NT) { k -= NT; flip = -1; }
      if (near90(k)) continue;
      const r = Math.round(flip * (x * cosT[k] + y * sinT[k])) + R;
      if (r >= 0 && r < NR) acc[k * NR + r] += 1;
    }
  }
  const minVotes = Math.max(12, 0.15 * (yb - ya));
  const lines = [];
  for (let n = 0; n < maxLines; n++) {
    let best = -1, bv = minVotes;
    for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; best = i; }
    if (best < 0) break;
    const k = Math.floor(best / NR), r = (best % NR) - R;
    lines.push({ a: cosT[k], b: sinT[k], c: -r, w: bv });
    for (let dk = -6; dk <= 6; dk++) {
      const kk = (k + dk + NT) % NT, sgn = k + dk < 0 || k + dk >= NT ? -1 : 1;
      for (let dr = -10; dr <= 10; dr++) {
        const rr = sgn * r + dr + R;
        if (rr >= 0 && rr < NR) acc[kk * NR + rr] = 0;
      }
    }
  }
  return lines;
}

/** Angle (deg) between a line and the direction from its point at row yMid toward v. */
function angleToward(l, v, yMid) {
  if (Math.abs(l.a) < 1e-9) return 90;
  const x = -(l.b * yMid + l.c) / l.a;
  const d1 = Math.atan2(l.a, -l.b), d2 = Math.atan2(v[1] - yMid, v[0] - x);
  return Math.abs(((((d1 - d2) / D2R + 90) % 180) + 180) % 180 - 90);
}

/**
 * Vanishing point of the receding table lines: RANSAC over pairwise intersections (above the rows),
 * score = votes of lines pointing at it within tolAngle, then least squares over the inliers.
 */
export function autoVanishing(gray, W, H, { rows = [0.5, 0.98], tolAngle = 1.2 } = {}) {
  const lines = detectLines(gray, W, H, { rows });
  const yMid = ((rows[0] + rows[1]) / 2) * H;
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const v = vanishingPoint([lines[i], lines[j]]);
      if (!v || v[1] > rows[0] * H) continue;
      let score = 0;
      const ins = [];
      for (const l of lines) if (angleToward(l, v, yMid) < tolAngle) { score += l.w; ins.push(l); }
      if (!best || score > best.score) best = { score, ins };
    }
  }
  if (!best || best.ins.length < 2) return { vp: null, horizon: null, inliers: [], outliers: lines };
  const vp = vanishingPoint(best.ins);
  return { vp, horizon: vp[1] / H, inliers: best.ins, outliers: lines.filter((l) => !best.ins.includes(l)) };
}

// ---- drawing ----------------------------------------------------------------------------------

function polyline(g, cam, pts, W, H) {
  let run = [];
  const flush = () => {
    if (run.length > 1) { g.beginPath(); g.moveTo(...run[0]); for (const p of run.slice(1)) g.lineTo(...p); g.stroke(); }
    run = [];
  };
  for (const p of pts) {
    const q = RP.project(cam, p, W, H);
    if (q.ok && Math.abs(q.x) < 4 * W && Math.abs(q.y) < 4 * H) run.push([q.x, q.y]); else flush();
  }
  flush();
}

const range = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/**
 * Draw the matched table grid, horizon and object proxy over a plate image. Returns the canvas.
 * opts: {step (grid spacing, units), far (grid depth), object: [radius, height], label}.
 */
export function drawGrid(img, P, { step = 2, far = 16, object = [0.43, 1], label = "" } = {}) {
  const W = img.width, H = img.height;
  const cv = new Canvas(W, H), g = cv.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  const cam = RP.matchCamera(P, W, H);
  const lw = Math.max(1, Math.round(H / 470));
  const zs = range(-far, cam.pos[2] - 0.3, 200), xs = range(-6 * step, 6 * step, 200);
  for (let i = -6; i <= 6; i++) {
    const x = i * step;
    g.strokeStyle = i ? "rgba(0,255,255,0.67)" : "rgba(255,60,60,0.9)";
    g.lineWidth = i ? lw : lw * 1.5;
    polyline(g, cam, zs.map((z) => [x, 0, z]), W, H);
  }
  for (let z = -Math.floor(far / step) * step; z < cam.pos[2]; z += step) {
    g.strokeStyle = z ? "rgba(0,255,255,0.67)" : "rgba(255,60,60,0.9)";
    g.lineWidth = z ? lw : lw * 1.5;
    polyline(g, cam, xs.map((x) => [x, 0, z]), W, H);
  }
  // the horizon: points far straight ahead of the lens
  g.strokeStyle = "rgb(255,220,0)";
  g.lineWidth = lw;
  polyline(g, cam, range(-2e4, 2e4, 9).map((x) => [cam.pos[0] + x, 0, cam.pos[2] - 5000]), W, H);
  const [r, oh] = object, ang = range(0, 2 * Math.PI, 120);
  g.strokeStyle = "rgb(255,120,0)";
  g.lineWidth = lw * 1.5;
  for (const y of [0, oh]) polyline(g, cam, ang.map((t) => [r * Math.cos(t), y, r * Math.sin(t)]), W, H);
  g.strokeStyle = "rgba(255,120,0,0.5)";
  g.lineWidth = lw * 0.5;
  for (const t of range(0, 2 * Math.PI, 13).slice(0, -1)) polyline(g, cam, [[r * Math.cos(t), 0, r * Math.sin(t)], [r * Math.cos(t), oh, r * Math.sin(t)]], W, H);
  const fs_ = Math.max(12, Math.round(H / 40));
  g.fillStyle = "rgba(0,0,0,0.66)";
  g.fillRect(0, 0, W, fs_ * 1.6);
  g.fillStyle = "#fff";
  g.font = `${fs_}px sans-serif`;
  g.fillText(`${label} fov ${P.fov} hz ${P.horizon} roll ${P.roll || 0} h ${P.h} pitch ${cam.pitch.toFixed(1)} dist ${cam.dist.toFixed(1)}`, 8, fs_ * 1.15);
  return cv;
}

/** The image with a labelled pixel grid every 100 px. */
export function drawRuler(img) {
  const W = img.width, H = img.height, cv = new Canvas(W, H), g = cv.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  g.font = "18px sans-serif";
  for (let x = 0; x < W; x += 100) {
    g.strokeStyle = x % 500 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.7)";
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
    g.fillStyle = "#ff0"; g.fillText(String(x), x + 3, 18);
  }
  for (let y = 0; y < H; y += 100) {
    g.strokeStyle = y % 500 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.7)";
    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
    g.fillStyle = "#ff0"; g.fillText(String(y), 3, y + 18);
  }
  return cv;
}

/** The detected lines over the image: inliers green, others red, the horizon yellow. */
export function drawLines(img, res, rows) {
  const W = img.width, H = img.height, cv = new Canvas(W, H), g = cv.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  const seg = (l) => {
    if (Math.abs(l.a) < 1e-9) return;
    const xAt = (y) => -(l.b * y + l.c) / l.a;
    g.beginPath(); g.moveTo(xAt(rows[0] * H), rows[0] * H); g.lineTo(xAt(rows[1] * H), rows[1] * H); g.stroke();
  };
  g.lineWidth = 2; g.strokeStyle = "rgb(255,60,60)"; res.outliers.forEach(seg);
  g.lineWidth = 3; g.strokeStyle = "rgb(60,255,60)"; res.inliers.forEach(seg);
  if (res.vp) { g.strokeStyle = "rgb(255,220,0)"; g.beginPath(); g.moveTo(0, res.vp[1]); g.lineTo(W, res.vp[1]); g.stroke(); }
  return cv;
}

/** Tile canvases into one sheet `cell` px wide per tile. */
export function sheet(canvases, cell) {
  const cols = Math.min(canvases.length, canvases[0].width > canvases[0].height ? 3 : 4);
  const ch = Math.max(...canvases.map((c) => Math.round((cell * c.height) / c.width)));
  const S = new Canvas(cols * cell, Math.ceil(canvases.length / cols) * ch), g = S.getContext("2d");
  g.fillStyle = "#141414"; g.fillRect(0, 0, S.width, S.height);
  canvases.forEach((c, i) => g.drawImage(c, (i % cols) * cell, Math.floor(i / cols) * ch, cell, Math.round((cell * c.height) / c.width)));
  return S;
}

export async function writeImage(cv, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fmt = /\.png$/i.test(out) ? "png" : "jpg";
  fs.writeFileSync(out, await cv.toBuffer(fmt, fmt === "jpg" ? { quality: 0.88 } : undefined));
  return out;
}

// ---- CLI --------------------------------------------------------------------------------------

const pair = (s, what) => {
  const v = String(s).split(",").map(Number);
  if (v.length < 2 || v.some((n) => !Number.isFinite(n))) throw new Error(`${what} takes numbers "a,b" (got "${s}")`);
  return v;
};

function loadPlates(file) {
  const plates = JSON.parse(fs.readFileSync(file, "utf8"));
  return { plates, dir: path.dirname(file) };
}

function plateOf(plates, name) {
  const P = plates[name];
  if (!P) throw new Error(`no plate "${name}" in the plates file (has: ${Object.keys(plates).join(", ")})`);
  for (const k of ["file", "fov", "horizon", "h"]) if (P[k] === undefined) throw new Error(`plate "${name}" has no "${k}"`);
  return P;
}

const defaultOut = (imgPath, cmd, name) => path.join(path.dirname(imgPath), "match", `${cmd}-${name}.jpg`);

async function grayOf(img) {
  const cv = new Canvas(img.width, img.height), g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  return toGray(g.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
}

async function run(cmd, positional, flags) {
  const say = (s) => process.stdout.write(s + "\n");
  if (cmd === "auto") {
    const file = abs(positional[0]);
    const img = await loadImage(file);
    const rows = flags.rows ? pair(flags.rows, "--rows") : [0.5, 0.98];
    const res = autoVanishing(await grayOf(img), img.width, img.height, { rows });
    if (res.vp) say(`vanishing point ${res.vp[0].toFixed(1)}, ${res.vp[1].toFixed(1)}; horizon fraction ${res.horizon.toFixed(4)} (${res.inliers.length} of ${res.inliers.length + res.outliers.length} lines)`);
    else say(`no vanishing point (${res.outliers.length} lines): read line ends off \`ruler\` and use \`vp\``);
    if (flags.out) say("-> " + (await writeImage(drawLines(img, res, rows), abs(flags.out))));
    return;
  }
  if (cmd === "vp") {
    const file = abs(positional[0]);
    const img = await loadImage(file);
    const lines = positional.slice(1).map((s) => { const v = pair(s, "a line"); return lineThrough([v[0], v[1]], [v[2], v[3]]); });
    if (lines.length < 2) throw new Error("vp needs at least two lines x1,y1,x2,y2");
    const v = vanishingPoint(lines);
    if (!v) throw new Error("the lines are parallel in the image: their vanishing point is at infinity");
    say(`vanishing point ${v[0].toFixed(1)}, ${v[1].toFixed(1)}; horizon fraction ${(v[1] / img.height).toFixed(4)}`);
    return;
  }
  if (cmd === "fov") {
    const [W, H] = String(positional[0] || "").split("x").map(Number);
    if (!(W > 0 && H > 0)) throw new Error('fov takes the image size as "<W>x<H>"');
    const r = fovFromVanishingPoints(pair(flags.vp1, "--vp1"), pair(flags.vp2, "--vp2"), W, H);
    say(`vertical fov ${r.fov.toFixed(2)} deg, roll ${r.roll.toFixed(2)} deg, focal ${r.focalPx.toFixed(1)} px`);
    return;
  }
  const plFile = abs(positional[0] || "");
  if (!fs.existsSync(plFile)) throw new Error(`no plates file ${plFile}`);
  const { plates, dir } = loadPlates(plFile);
  const names = String(positional[1] || "").split(",").filter(Boolean);
  if (!names.length) throw new Error(`${cmd} needs a plate name`);
  if (cmd === "set") {
    for (const n of names) {
      plateOf(plates, n);
      for (const kv of positional.slice(2)) {
        const at = kv.indexOf("=");
        if (at < 1) throw new Error(`"${kv}" is not key=<json>`);
        plates[n][kv.slice(0, at)] = JSON.parse(kv.slice(at + 1));
      }
      say(`${n} ${JSON.stringify({ fov: plates[n].fov, horizon: plates[n].horizon, roll: plates[n].roll, h: plates[n].h, spot: plates[n].spot })}`);
    }
    fs.writeFileSync(plFile, "{\n" + Object.entries(plates).map(([n, P]) => ` ${JSON.stringify(n)}: ${JSON.stringify(P)}`).join(",\n") + "\n}\n");
    return;
  }
  if (cmd === "scale") {
    const P = plateOf(plates, names[0]);
    const img = await loadImage(path.resolve(dir, P.file));
    const size = Number(flags.size);
    if (!(size > 0)) throw new Error("scale needs --size <true height of the object in object units>");
    const h = heightFromObject(P, img.width, img.height, pair(flags.foot, "--foot"), pair(flags.top, "--top"), size);
    say(`camera height h ${h.toFixed(3)} (object units), with the foot as the spot`);
    return;
  }
  if (cmd === "grid") {
    const canvases = [];
    let first = null;
    for (const n of names) {
      const P = plateOf(plates, n);
      const file = path.resolve(dir, P.file);
      first = first || file;
      const img = await loadImage(file);
      canvases.push(drawGrid(img, P, {
        step: flags.step ? Number(flags.step) : 2,
        far: flags.far ? Number(flags.far) : P.gridFar || 16,
        object: flags.object ? pair(flags.object, "--object") : [0.43, 1],
        label: n,
      }));
    }
    const out = flags.out ? abs(flags.out) : defaultOut(first, cmd, names.join("+"));
    const cv = canvases.length === 1 && !flags.cell ? canvases[0] : sheet(canvases, flags.cell ? Number(flags.cell) : 640);
    say("-> " + (await writeImage(cv, out)));
    return;
  }
  throw new Error(`unknown command "${cmd}"`);
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length < 2) return printHelpAndExit(HELP, 1);
  // ruler takes an image, not a plates file
  if (positional[0] === "ruler") {
    const img = abs(positional[1]);
    try {
      const im = await loadImage(img);
      const out = flags.out ? abs(flags.out) : defaultOut(img, "ruler", path.basename(img).replace(/\.\w+$/, ""));
      process.stdout.write("-> " + (await writeImage(drawRuler(im), out)) + "\n");
    } catch (e) {
      fail(e.message);
    }
    return;
  }
  try {
    await run(positional[0], positional.slice(1), flags);
  } catch (e) {
    fail(e.message);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
