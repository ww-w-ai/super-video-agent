// Part-palette share of an LDraw model (EV-45; owner 2026-10-28 on a mega build made of plain bricks after the all-lines
// rule had been given: "닌자고나 스피드 차 이런 블록 써도 된다니까 왜 한번도 안 써?"). A rule nothing checks is skipped:
// this counts how much of a freely designed model is specialty parts (curves, SNOT, line-specific shapes) from a palette
// the project curates, against plain rectangular bricks, plates and tiles.
// Same core as ww-w-kids tools/part-palette-check.mjs (where it was found), with the palette file as an argument.
import fs from "node:fs";
import path from "node:path";

/** Plain rectangular bricks, plates and tiles, by library title. */
export const BASIC = /^(Brick|Plate|Tile) +\d+ +x +\d+( +x +[\d.]+)?( with Groove| without (Understud|Centre Stud)| with Underside Ribs)?$/i;
const PRINTED_TILE = /^(3068b|3069b|3070b|87079|2431|63864|6636|4162|26603)p[0-9a-z]+$/i;

/** Reads a palette file: {groups: [{key, title, parts: [{id}]}]}. @returns {{group: Map<string,string>, titles: object}} */
export function loadPalette(file) {
  const pal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!pal || !Array.isArray(pal.groups)) throw new Error(`${file}: a palette is {"groups": [{"key", "title", "parts": [{"id"}]}]}`);
  const group = new Map();
  for (const g of pal.groups) for (const p of g.parts || []) if (!group.has(String(p.id).toLowerCase())) group.set(String(p.id).toLowerCase(), g.key);
  return { group, titles: Object.fromEntries(pal.groups.map((g) => [g.key, g.title || g.key])) };
}

function titleReader(lib) {
  const cache = new Map();
  const titleOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    let t = null;
    for (const d of ["parts", "p"]) {
      const f = path.join(lib, d, id + ".dat");
      if (fs.existsSync(f)) {
        t = fs.readFileSync(f, "utf8").split(/\r?\n/, 1)[0].replace(/^0\s+/, "").replace(/\s+/g, " ").trim();
        break;
      }
    }
    const mv = t && t.match(/^~Moved to (\S+)/i);
    cache.set(id, null);
    if (mv) t = titleOf(mv[1].toLowerCase().replace(/\.dat$/, ""));
    cache.set(id, t);
    return t;
  };
  return titleOf;
}

/** basic | specialty (with its palette group) | other, for one part file name. */
export function classifyPart(raw, palette, titleOf) {
  const id = raw.toLowerCase().replace(/\\/g, "/").replace(/^.*\//, "").replace(/\.dat$/, "");
  if (palette.group.has(id)) return { id, kind: "specialty", group: palette.group.get(id) };
  if (PRINTED_TILE.test(id)) return { id, kind: "specialty", group: "details" };
  for (const b of [id.replace(/(p|d)[0-9a-z]+$/i, ""), id.replace(/c\d\d$/i, ""), id.replace(/(p|d)[0-9a-z]+(c\d\d)?$/i, "")]) if (b !== id && palette.group.has(b)) return { id: b, kind: "specialty", group: palette.group.get(b) };
  const t = titleOf(id);
  if (t && BASIC.test(t)) return { id, kind: "basic" };
  return { id, kind: "other", title: t };
}

/** Part file -> count over the model (MPD blocks and sibling .ldr files followed, with multiplicity), inside `region` when given. */
export function countParts(modelPath, { region = "" } = {}) {
  const text = fs.readFileSync(modelPath, "utf8").split(/\r?\n/);
  const blocks = new Map();
  let first = null, cur = null;
  for (const l of text) {
    const m = l.match(/^0\s+FILE\s+(.+?)\s*$/i);
    if (m) {
      cur = m[1].toLowerCase().replace(/\\/g, "/");
      blocks.set(cur, []);
      if (!first) first = cur;
      continue;
    }
    if (cur) blocks.get(cur).push(l);
  }
  if (!first) blocks.set((first = "__main__"), text);
  const external = new Map();
  const getBlock = (name) => {
    const n = name.toLowerCase().replace(/\\/g, "/");
    if (blocks.has(n)) return { key: n, lines: blocks.get(n) };
    const sib = path.join(path.dirname(modelPath), name.replace(/\\/g, "/"));
    if (/\.(ldr|mpd)$/i.test(n) && fs.existsSync(sib)) {
      if (!external.has(n)) external.set(n, fs.readFileSync(sib, "utf8").split(/\r?\n/));
      return { key: "ext:" + n, lines: external.get(n) };
    }
    return null;
  };
  const R = region.toLowerCase();
  const memo = new Map();
  const count = (key, lines, inRegion, stack) => {
    const mk = key + "|" + inRegion;
    if (memo.has(mk)) return memo.get(mk);
    const res = new Map();
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      if (t[0] !== "1" || t.length < 15) continue;
      const name = t.slice(14).join(" ");
      const sub = getBlock(name);
      if (sub) {
        if (stack.includes(sub.key)) continue;
        const r = count(sub.key, sub.lines, inRegion || (R && name.toLowerCase().includes(R)), [...stack, sub.key]);
        for (const [k, v] of r) res.set(k, (res.get(k) || 0) + v);
      } else if (inRegion || !R) res.set(name.toLowerCase(), (res.get(name.toLowerCase()) || 0) + 1);
    }
    memo.set(mk, res);
    return res;
  };
  return { counts: count(first, blocks.get(first), false, [first]), submodels: [...blocks.keys()] };
}

/**
 * The palette report. @returns {{total, basic, specialty, other, share, byGroup, distinctSpecialty:[id,n][], topOther:[id,n][], min, pass}}
 */
export function paletteShare({ model, lib, palette, region = "", min = 0.25 }) {
  const pal = typeof palette === "string" ? loadPalette(palette) : palette;
  const titleOf = titleReader(lib);
  const { counts, submodels } = countParts(model, { region });
  let total = 0, basic = 0, spec = 0, other = 0;
  const byGroup = {}, ids = new Map(), others = new Map();
  for (const [name, n] of counts) {
    const c = classifyPart(name, pal, titleOf);
    total += n;
    if (c.kind === "basic") basic += n;
    else if (c.kind === "specialty") {
      spec += n;
      byGroup[c.group] = (byGroup[c.group] || 0) + n;
      ids.set(c.id, (ids.get(c.id) || 0) + n);
    } else {
      other += n;
      others.set(c.id, (others.get(c.id) || 0) + n);
    }
  }
  const share = total ? spec / total : 0;
  return { total, basic, specialty: spec, other, share, byGroup, groupTitles: pal.titles, distinctSpecialty: [...ids].sort((a, b) => b[1] - a[1]), topOther: [...others].sort((a, b) => b[1] - a[1]).slice(0, 15), min, region: region || null, submodels, pass: total > 0 && share >= min };
}
