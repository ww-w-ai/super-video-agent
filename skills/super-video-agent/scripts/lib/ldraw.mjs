// Reader for the LDraw text format (MPD / LDR): sub-model files, steps, line types 1-4, colour inheritance,
// library lookup in a parts folder the user gives, and the colour table. Pure functions plus a small
// library object; the model's own tree and step order are kept exactly as the file states them
// (references/assembly.md "Step order from the part hierarchy").
import fs from "node:fs";
import path from "node:path";

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** A reference name as the file system and the MPD index see it: trimmed, lower case, forward slashes. */
export const norm = (name) => name.trim().toLowerCase().replace(/\\/g, "/");

const lines = (text) => text.split(/\r?\n/);

// ---------------------------------------------------------------- matrices (3x4, row-major)

/** A (parent) composed with B (child): the child's points in the parent's frame. */
export function mul(A, B) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c]);
    out.push(A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3]);
  }
  return out;
}

export const apply = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]];
export const applyDir = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];

/** Min and max corner [x0,y0,z0,x1,y1,z1] of flat xyz arrays. */
export function boundsOf(arrays) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (arr[i + k] < b[k]) b[k] = arr[i + k];
        if (arr[i + k] > b[k + 3]) b[k + 3] = arr[i + k];
      }
    }
  }
  return b;
}

/** The box that holds box `b` after it moves by M (from its 8 corners). */
export function transformBounds(M, b) {
  const pts = [];
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) pts.push(...apply(M, x, y, z));
  return boundsOf([pts]);
}

// ---------------------------------------------------------------- the model file

/**
 * A type-1 line: `1 <colour> x y z a b c d e f g h i <file>` -> {color, m, file}; null for any other line.
 * `m` is the 3x4 row-major matrix [a b c x, d e f y, g h i z].
 */
export function parseRef(raw) {
  const m = raw.match(/^\s*1\s+(\S+)\s+((?:\S+\s+){12})(.+?)\s*$/);
  if (!m) return null;
  const [x, y, z, a, b, c, d, e, f, g, h, i] = m[2].trim().split(/\s+/).map(Number);
  if ([x, y, z, a, b, c, d, e, f, g, h, i].some((v) => !Number.isFinite(v))) return null;
  return { color: m[1], m: [a, b, c, x, d, e, f, y, g, h, i, z], file: m[3] };
}

/**
 * An MPD (or a single LDR with no FILE line) -> {models: Map(key -> {name, lines}), main, order}.
 * The first FILE is the main model; sub-models keep file order.
 * @param {string} text
 * @param {string} [fallbackName] the name of the one model when the text has no FILE line
 */
export function parseMpd(text, fallbackName = "main.ldr") {
  const models = new Map();
  const order = [];
  let current = null;
  for (const raw of lines(text)) {
    const f = raw.match(/^\s*0\s+FILE\s+(.+?)\s*$/);
    if (f) {
      current = norm(f[1]);
      if (models.has(current)) throw new Error(`the file defines "${f[1].trim()}" twice`);
      models.set(current, { name: f[1].trim(), lines: [] });
      order.push(current);
    } else if (/^\s*0\s+NOFILE\b/.test(raw)) {
      current = null;
    } else if (current) {
      models.get(current).lines.push(raw);
    } else if (!order.length && raw.trim()) {
      current = norm(fallbackName);
      models.set(current, { name: fallbackName, lines: [raw] });
      order.push(current);
    }
  }
  if (!order.length) throw new Error("the model file has no lines");
  return { models, main: order[0], order };
}

const isStepLine = (raw) => /^\s*0\s+(STEP|ROTSTEP)\b/.test(raw);

/**
 * A model's type-1 references split into steps by its `0 STEP` / `0 ROTSTEP` lines; steps with no reference
 * are dropped, the rest are numbered from 1 in file order.
 * @returns {{n:number, refs:{color:string, m:number[], file:string}[]}[]}
 */
export function stepsOf(mpd, key) {
  const model = mpd.models.get(norm(key));
  if (!model) throw new Error(`sub-model not in the file: ${key}`);
  const groups = [[]];
  for (const raw of model.lines) {
    if (isStepLine(raw)) {
      groups.push([]);
      continue;
    }
    const ref = parseRef(raw);
    if (ref) groups[groups.length - 1].push(ref);
  }
  return groups.filter((g) => g.length).map((refs, i) => ({ n: i + 1, refs }));
}

export const isSubModel = (mpd, file) => mpd.models.has(norm(file));

/**
 * The model to build: `main` itself, or the one model it only wraps (one reference, no other lines), followed
 * down while that holds. `buildMatrix` composes the wrappers' matrices.
 */
export function findBuildModel(mpd) {
  let key = mpd.main;
  let matrix = IDENTITY;
  for (let depth = 0; depth < 16; depth++) {
    const steps = stepsOf(mpd, key);
    const refs = steps.flatMap((s) => s.refs);
    if (refs.length !== 1 || !isSubModel(mpd, refs[0].file)) break;
    matrix = mul(matrix, refs[0].m);
    key = norm(refs[0].file);
  }
  return { key, name: mpd.models.get(key).name, matrix };
}

/**
 * The tree as indented text lines, in file order: which step of which model references which sub-model.
 * A sub-model referenced again is listed again but not expanded again.
 */
export function treeLines(mpd, key, depth = 0, seen = new Set([norm(key)])) {
  const out = [];
  for (const step of stepsOf(mpd, key)) {
    for (const ref of step.refs) {
      if (!isSubModel(mpd, ref.file)) continue;
      const again = seen.has(norm(ref.file));
      out.push(`${"  ".repeat(depth + 1)}step ${step.n}: ${ref.file}${again ? " (again)" : ""}`);
      if (!again) {
        seen.add(norm(ref.file));
        out.push(...treeLines(mpd, ref.file, depth + 1, seen));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- library, colours, flattening

/**
 * A parts library the user points at: the folder that holds `parts/` and `p/` (an LDraw library root),
 * or a flat folder of part files. Lookup order: parts, p, models, the folder itself.
 * @param {string} root
 */
export function openLibrary(root) {
  const dirs = ["parts", "p", "models", ""].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  if (!dirs.length) throw new Error(`parts folder not found: ${root}`);
  const text = new Map();
  const readPart = (name) => {
    const rel = norm(name);
    if (text.has(rel)) return text.get(rel);
    for (const dir of dirs) {
      const p = path.join(dir, rel);
      // A model file names its sub-files; a name that climbs out of the library is refused, never read.
      const inside = path.relative(dir, p);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
        throw new Error(`library file name leaves the library: ${name}`);
      }
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        text.set(rel, fs.readFileSync(p, "utf8"));
        return text.get(rel);
      }
    }
    throw new Error(`library file not found: ${name} (looked in ${dirs.join(", ")})`);
  };
  return { root, dirs, readPart, flat: new Map(), busy: new Set() };
}

// A colour key is relative to the reference that draws it: "M" the main colour (16), "E" its edge (24),
// "c:<code>" / "e:<code>" a fixed colour and its edge.
function remapKey(k, refColor) {
  if (refColor === "16") return k;
  if (refColor === "24") return k === "M" ? "E" : k;
  if (k === "M") return `c:${refColor}`;
  if (k === "E") return `e:${refColor}`;
  return k;
}

function keyOf(color) {
  if (color === "16") return "M";
  if (color === "24") return "E";
  return `c:${color}`;
}

const push = (map, k, vals) => {
  if (!map.has(k)) map.set(k, []);
  const arr = map.get(k);
  for (const v of vals) arr.push(v);
};

function addChild(out, child, ref) {
  for (const kind of ["tris", "lines"]) {
    for (const [k, arr] of child[kind]) {
      const moved = [];
      for (let i = 0; i < arr.length; i += 3) moved.push(...apply(ref.m, arr[i], arr[i + 1], arr[i + 2]));
      push(out[kind], remapKey(k, ref.color), moved);
    }
  }
}

function addPrimitive(out, t) {
  const n = (a, b) => t.slice(a, b).map(Number);
  if (t[0] === "2") push(out.lines, keyOf(t[1]), n(2, 8));
  else if (t[0] === "3") push(out.tris, keyOf(t[1]), n(2, 11));
  else if (t[0] === "4") {
    const v = n(2, 14);
    push(out.tris, keyOf(t[1]), [...v.slice(0, 9), ...v.slice(0, 3), ...v.slice(6, 12)]);
  }
}

/**
 * A library file with every sub-file folded in, in its own frame: triangles (type 3, and type 4 split in two)
 * and edge lines (type 2) grouped by colour key. A mirroring matrix flips winding; the surface check and a
 * flat double-sided shading do not depend on it.
 * @returns {{tris: Map<string, number[]>, lines: Map<string, number[]>}}
 */
export function flattenPart(lib, name) {
  const id = norm(name);
  if (lib.flat.has(id)) return lib.flat.get(id);
  if (lib.busy.has(id)) throw new Error(`library file ${name} references itself`);
  lib.busy.add(id);
  const out = { tris: new Map(), lines: new Map() };
  for (const raw of lines(lib.readPart(name))) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === "1") {
      const ref = parseRef(raw);
      if (ref) addChild(out, flattenPart(lib, ref.file), ref);
    } else if (t[0] === "2" || t[0] === "3" || t[0] === "4") addPrimitive(out, t);
  }
  lib.busy.delete(id);
  lib.flat.set(id, out);
  return out;
}

/** The title line of a part file (`0 <title>`), following a `~Moved to <part>` redirect. */
export function partTitle(lib, name) {
  const first = lib.readPart(name).split(/\r?\n/)[0].replace(/^\s*0\s+/, "").trim();
  const moved = first.match(/^~Moved to (\S+)/);
  return moved ? partTitle(lib, `${moved[1]}.dat`) : first;
}

/**
 * The colour table from LDConfig.ldr in the library folder: code -> {name, value, edge, alpha}.
 * Empty when the folder has none (the baked data then has no colour values for the codes it uses).
 */
export function readColours(lib) {
  const file = [path.join(lib.root, "LDConfig.ldr"), ...lib.dirs.map((d) => path.join(d, "LDConfig.ldr"))].find((p) => fs.existsSync(p));
  const colours = {};
  if (!file) return colours;
  for (const raw of lines(fs.readFileSync(file, "utf8"))) {
    const m = raw.match(/^\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[0-9A-Fa-f]{6})\s+EDGE\s+(#[0-9A-Fa-f]{6})(.*)$/);
    if (!m) continue;
    const alpha = m[5].match(/ALPHA\s+(\d+)/);
    colours[m[2]] = { name: m[1], value: m[3], edge: m[4], alpha: alpha ? Number(alpha[1]) : 255 };
  }
  return colours;
}

/** A colour code's entry: the table's, or for a direct colour (0x2RRGGBB) its own value; null when unknown. */
export function colourOf(colours, code) {
  if (colours[code]) return colours[code];
  const direct = /^0x2([0-9A-Fa-f]{6})$/.exec(code);
  return direct ? { name: `direct ${direct[1]}`, value: `#${direct[1]}`, edge: "#000000", alpha: 255 } : null;
}
