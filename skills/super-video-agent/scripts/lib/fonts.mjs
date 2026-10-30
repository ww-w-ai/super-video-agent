// Locates installed fonts: Pretendard for new-reel.mjs, and every family for
// fonts-list.mjs. Never hot-links fonts — a face a reel uses gets copied into
// its assets/fonts/ so @font-face can use relative URLs on any machine.
//
// Linux installs fonts in family subfolders (~/.local/share/fonts/Pretendard/,
// /usr/share/fonts/truetype/nanum/), so each folder is walked a few levels
// deep; a single-level listing misses them and the reel silently falls back
// to another face.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DEPTH = 4;
const FONT_EXT = /\.(otf|ttf|ttc)$/i;

/**
 * Font folders to search: $SVA_FONT_DIR first (one folder, or several joined
 * by path.delimiter), then the system and per-user folders of this OS.
 */
export function fontDirs(platform = process.platform, home = os.homedir(), env = process.env) {
  const override = (env.SVA_FONT_DIR || "").split(path.delimiter).filter(Boolean);
  return [...override, ...osFontDirs(platform, home, env)];
}

function osFontDirs(platform, home, env) {
  if (platform === "darwin") return ["/Library/Fonts", path.join(home, "Library", "Fonts"), "/System/Library/Fonts"];
  if (platform === "win32") {
    const win = env.WINDIR || env.SystemRoot || "C:\\Windows";
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(win, "Fonts"), path.join(local, "Microsoft", "Windows", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local", "share", "fonts"), path.join(home, ".fonts")];
}

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (FONT_EXT.test(e.name) && !e.isDirectory()) {
      out.push(p);
    } else if (depth < MAX_DEPTH && isDirectory(e, p)) {
      walk(p, depth + 1, out);
    }
  }
}

// Distro font packages often symlink family folders, so follow symlinks.
function isDirectory(entry, p) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFontFiles(dirs) {
  const files = [];
  for (const dir of dirs) walk(dir, 0, files);
  return files;
}

/**
 * Pretendard files we want, in priority order (Regular + Bold minimum).
 * `searched` lists the folders looked in, for the not-found warning.
 */
export function findPretendard({ dirs = fontDirs() } = {}) {
  const files = listFontFiles(dirs);
  const byName = (needle) =>
    files.find((f) => path.basename(f).toLowerCase() === needle.toLowerCase());
  const regular = byName("Pretendard-Regular.otf") || files.find((f) => /pretendard-regular/i.test(path.basename(f)));
  const bold = byName("Pretendard-Bold.otf") || files.find((f) => /pretendard-bold/i.test(path.basename(f)));
  return { regular, bold, searched: dirs };
}

/**
 * Every installed font family, read from each file's own `name` table so the
 * same code runs on every OS (no fontconfig, CoreText or DirectWrite).
 * With `text`, keeps only faces whose character map has every character in
 * it. Returns [{ family, localNames, faces: [{ style, file }] }] sorted by
 * family, plus the count of files that could not be read. Families whose
 * name starts with "." are OS-internal faces and are left out.
 */
export function listFontFamilies({ dirs = fontDirs(), text = "" } = {}) {
  const codepoints = [...new Set([...text].filter((c) => c.trim()).map((c) => c.codePointAt(0)))];
  const byFamily = new Map();
  let unreadable = 0;
  for (const file of listFontFiles(dirs)) {
    let faces;
    try {
      faces = readFontNames(file, codepoints);
    } catch {
      unreadable++;
      continue;
    }
    for (const face of faces) {
      if (!face.family || face.family.startsWith(".") || face.covers === false) continue;
      const entry = byFamily.get(face.family) || { family: face.family, localNames: [], faces: [] };
      for (const n of face.localNames) if (!entry.localNames.includes(n)) entry.localNames.push(n);
      entry.faces.push({ style: face.style || "Regular", file });
      byFamily.set(face.family, entry);
    }
  }
  const families = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
  return { families, unreadable };
}

const NAME_FAMILY = 1;
const NAME_STYLE = 2;
const NAME_TYPO_FAMILY = 16;
const NAME_TYPO_STYLE = 17;
const LANG_EN_US = 0x0409;

/**
 * The family/style names of each face in a .ttf/.otf, or of every face in a
 * .ttc. With `codepoints`, each face also gets `covers`: true when its
 * character map has all of them.
 */
export function readFontNames(file, codepoints = []) {
  const fd = fs.openSync(file, "r");
  try {
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      if (fs.readSync(fd, buf, 0, len, pos) < len) throw new Error("truncated font");
      return buf;
    };
    const head = read(0, 12);
    if (head.toString("latin1", 0, 4) !== "ttcf") return [readFace(read, 0, codepoints)];
    const count = head.readUInt32BE(8);
    const offsets = read(12, count * 4);
    const faces = [];
    for (let i = 0; i < count; i++) faces.push(readFace(read, offsets.readUInt32BE(i * 4), codepoints));
    return faces;
  } finally {
    fs.closeSync(fd);
  }
}

function readFace(read, faceOffset, codepoints) {
  const numTables = read(faceOffset + 4, 2).readUInt16BE(0);
  const dir = read(faceOffset + 12, numTables * 16);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    tables[dir.toString("latin1", i * 16, i * 16 + 4)] = { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) };
  }
  if (!tables.name) throw new Error("font has no name table");
  const face = parseNameTable(read(tables.name.offset, tables.name.length));
  if (codepoints.length) {
    const lookup = tables.cmap ? cmapLookup(read(tables.cmap.offset, tables.cmap.length)) : null;
    face.covers = lookup ? codepoints.every(lookup) : false;
  }
  return face;
}

// Preferred character-map subtables: full Unicode (format 12) first, then BMP (format 4).
const CMAP_PREFERENCE = [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3]];

/** A codepoint -> has-glyph test from a cmap table, or null when it has no format 4/12 Unicode subtable. */
function cmapLookup(t) {
  const n = t.readUInt16BE(2);
  const subtables = [];
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8;
    subtables.push({ platform: t.readUInt16BE(r), encoding: t.readUInt16BE(r + 2), offset: t.readUInt32BE(r + 4) });
  }
  for (const [platform, encoding] of CMAP_PREFERENCE) {
    const s = subtables.find((x) => x.platform === platform && x.encoding === encoding);
    if (!s) continue;
    const format = t.readUInt16BE(s.offset);
    if (format === 12) return format12(t, s.offset);
    if (format === 4) return format4(t, s.offset);
  }
  return null;
}

function format12(t, o) {
  const groups = t.readUInt32BE(o + 12);
  return (cp) => {
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = o + 16 + mid * 12;
      if (cp < t.readUInt32BE(g)) hi = mid - 1;
      else if (cp > t.readUInt32BE(g + 4)) lo = mid + 1;
      else return t.readUInt32BE(g + 8) + (cp - t.readUInt32BE(g)) !== 0;
    }
    return false;
  };
}

function format4(t, o) {
  const segs = t.readUInt16BE(o + 6) / 2;
  const ends = o + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  return (cp) => {
    if (cp > 0xffff) return false;
    let lo = 0;
    let hi = segs - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.readUInt16BE(ends + mid * 2) < cp) lo = mid + 1;
      else hi = mid;
    }
    const start = t.readUInt16BE(starts + lo * 2);
    if (cp < start || cp > t.readUInt16BE(ends + lo * 2)) return false;
    const delta = t.readUInt16BE(deltas + lo * 2);
    const rangeAt = ranges + lo * 2;
    const range = t.readUInt16BE(rangeAt);
    if (range === 0) return ((cp + delta) & 0xffff) !== 0;
    const at = rangeAt + range + (cp - start) * 2;
    if (at + 2 > t.length) return false;
    const glyph = t.readUInt16BE(at);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  };
}

function parseNameTable(t) {
  const count = t.readUInt16BE(2);
  const storage = t.readUInt16BE(4);
  const records = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = t.readUInt16BE(r);
    const text = decodeName(t, platform, t.readUInt16BE(r + 2), storage + t.readUInt16BE(r + 10), t.readUInt16BE(r + 8));
    if (text != null) records.push({ platform, lang: t.readUInt16BE(r + 4), id: t.readUInt16BE(r + 6), text });
  }
  const pick = (ids) => {
    for (const id of ids) {
      const named = records.filter((x) => x.id === id);
      const en = named.find((x) => x.platform === 3 && x.lang === LANG_EN_US) || named.find((x) => x.platform === 1 && x.lang === 0) || named[0];
      if (en) return en.text;
    }
    return null;
  };
  const family = pick([NAME_TYPO_FAMILY, NAME_FAMILY]);
  // Localized family names come from the same name ID as the family; ID 1
  // records can carry the style in the name ("나눔고딕 ExtraBold"), so drop those.
  const localId = records.some((x) => x.id === NAME_TYPO_FAMILY) ? NAME_TYPO_FAMILY : NAME_FAMILY;
  const local = records.filter((x) => x.id === localId && x.platform === 3 && x.lang !== LANG_EN_US).map((x) => x.text);
  const localNames = [...new Set(local)].filter((n) => n !== family && !local.some((o) => o !== n && n.startsWith(o + " ")));
  return { family, style: pick([NAME_TYPO_STYLE, NAME_STYLE]), localNames };
}

// Unicode and Windows records are UTF-16BE; Mac Roman (platform 1, encoding 0)
// is read as Latin-1, exact for the ASCII names fonts use. Other encodings are skipped.
function decodeName(t, platform, encoding, start, length) {
  if (start + length > t.length) return null;
  if (platform === 0 || platform === 3) {
    if (length % 2) return null;
    return Buffer.from(t.subarray(start, start + length)).swap16().toString("utf16le").trim() || null;
  }
  if (platform === 1 && encoding === 0) return t.toString("latin1", start, start + length).trim() || null;
  return null;
}

/** Warning printed when Pretendard is missing from the scaffolded reel. */
export function pretendardRemedy(fontsDir, searched) {
  return [
    `WARNING: Pretendard not found — ${fontsDir} has no Pretendard-Regular.otf / Pretendard-Bold.otf,`,
    `but reel.html's @font-face points there, so the page would draw in a fallback face.`,
    `Searched: ${searched.join(", ")}`,
    `Fix (either):`,
    `  1. Copy Pretendard-Regular.otf and Pretendard-Bold.otf into ${fontsDir}.`,
    `  2. Install Pretendard, or set SVA_FONT_DIR to the folder holding the .otf files, and re-run`,
    `     new-reel.mjs — only before editing reel.html: a re-run rewrites it.`,
  ].join("\n");
}
