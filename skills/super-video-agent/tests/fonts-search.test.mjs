// fonts.mjs descends into family subfolders (Linux layout) and honors
// $SVA_FONT_DIR; new-reel.mjs warns on stderr when Pretendard is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fontDirs, findPretendard, listFontFamilies } from "../scripts/lib/fonts.mjs";
import { scaffold } from "../scripts/new-reel.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

test("findPretendard: finds files in a nested family subfolder", () => {
  const root = tmp("sva-fonts-");
  const regular = path.join(root, "Pretendard", "Pretendard-Regular.otf");
  const bold = path.join(root, "truetype", "Pretendard", "Pretendard-Bold.otf");
  touch(regular);
  touch(bold);
  const found = findPretendard({ dirs: [root] });
  assert.equal(found.regular, regular);
  assert.equal(found.bold, bold);
  assert.deepEqual(found.searched, [root]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("findPretendard: does not descend past the depth cap", () => {
  const root = tmp("sva-fonts-deep-");
  touch(path.join(root, "a", "b", "c", "d", "e", "f", "Pretendard-Regular.otf"));
  assert.equal(findPretendard({ dirs: [root] }).regular, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

// A minimal sfnt face: a name table (Windows UTF-16BE records) and a format 4
// cmap mapping each given codepoint to glyph 1. Table offsets are absolute,
// so `base` places the face inside a .ttc.
function nameTable(names) {
  const strings = names.map((n) => Buffer.from(n.text, "utf16le").swap16());
  const head = Buffer.alloc(6 + names.length * 12);
  head.writeUInt16BE(names.length, 2);
  head.writeUInt16BE(head.length, 4);
  let at = 0;
  names.forEach((n, i) => {
    const r = 6 + i * 12;
    head.writeUInt16BE(3, r);
    head.writeUInt16BE(1, r + 2);
    head.writeUInt16BE(n.lang || 0x0409, r + 4);
    head.writeUInt16BE(n.id, r + 6);
    head.writeUInt16BE(strings[i].length, r + 8);
    head.writeUInt16BE(at, r + 10);
    at += strings[i].length;
  });
  return Buffer.concat([head, ...strings]);
}

function cmapTable(codepoints) {
  const segs = [...codepoints].sort((a, b) => a - b).map((cp) => [cp, cp, (1 - cp) & 0xffff]);
  segs.push([0xffff, 0xffff, 1]);
  const n = segs.length;
  const sub = Buffer.alloc(16 + n * 8);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(n * 2, 6);
  segs.forEach(([start, end, delta], i) => {
    sub.writeUInt16BE(end, 14 + i * 2);
    sub.writeUInt16BE(start, 16 + n * 2 + i * 2);
    sub.writeUInt16BE(delta, 16 + n * 4 + i * 2);
  });
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(3, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(12, 8);
  return Buffer.concat([head, sub]);
}

function sfnt({ names, codepoints = [] }, base = 0) {
  const tables = [["cmap", cmapTable(codepoints)], ["name", nameTable(names)]];
  const dir = Buffer.alloc(12 + tables.length * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(tables.length, 4);
  let at = base + dir.length;
  tables.forEach(([tag, data], i) => {
    dir.write(tag, 12 + i * 16, "latin1");
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(data.length, 12 + i * 16 + 12);
    at += data.length;
  });
  return Buffer.concat([dir, ...tables.map(([, data]) => data)]);
}

function ttc(faces) {
  const head = Buffer.alloc(12 + faces.length * 4);
  head.write("ttcf", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(faces.length, 8);
  const parts = [];
  let at = head.length;
  faces.forEach((f, i) => {
    head.writeUInt32BE(at, 12 + i * 4);
    const bytes = sfnt(f, at);
    parts.push(bytes);
    at += bytes.length;
  });
  return Buffer.concat([head, ...parts]);
}

const HANGUL = [..."가나다"].map((c) => c.codePointAt(0));
const LATIN = [..."Abc"].map((c) => c.codePointAt(0));

test("listFontFamilies: reads family, style and localized names from .ttf and .ttc", () => {
  const root = tmp("sva-fontnames-");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "jua.ttf"), sfnt({
    names: [{ id: 1, text: "BM Jua" }, { id: 2, text: "Regular" }, { id: 1, text: "배민 주아체", lang: 0x0412 }],
    codepoints: HANGUL,
  }));
  fs.writeFileSync(path.join(root, "pack.ttc"), ttc([
    { names: [{ id: 16, text: "Serif Pack" }, { id: 17, text: "Bold" }, { id: 1, text: "Serif Pack Bold" }], codepoints: LATIN },
    { names: [{ id: 16, text: "Serif Pack" }, { id: 17, text: "Italic" }], codepoints: LATIN },
  ]));
  fs.writeFileSync(path.join(root, "broken.otf"), Buffer.from("not a font"));
  const { families, unreadable } = listFontFamilies({ dirs: [root] });
  assert.equal(unreadable, 1);
  assert.deepEqual(families.map((f) => f.family), ["BM Jua", "Serif Pack"]);
  assert.deepEqual(families[0].localNames, ["배민 주아체"]);
  assert.deepEqual(families[0].faces, [{ style: "Regular", file: path.join(root, "sub", "jua.ttf") }]);
  assert.deepEqual(families[1].faces.map((x) => x.style), ["Bold", "Italic"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("listFontFamilies: --text keeps only faces that have every character", () => {
  const root = tmp("sva-fontcover-");
  fs.writeFileSync(path.join(root, "ko.ttf"), sfnt({ names: [{ id: 1, text: "Ko Face" }], codepoints: [...HANGUL, ...LATIN] }));
  fs.writeFileSync(path.join(root, "latin.ttf"), sfnt({ names: [{ id: 1, text: "Latin Face" }], codepoints: LATIN }));
  const names = (text) => listFontFamilies({ dirs: [root], text }).families.map((f) => f.family);
  assert.deepEqual(names("가나 Abc"), ["Ko Face"]);
  assert.deepEqual(names("Abc"), ["Ko Face", "Latin Face"]);
  assert.deepEqual(names("가라"), [], "a character outside every map drops every face");
  fs.rmSync(root, { recursive: true, force: true });
});

test("fontDirs: each OS lists its system and per-user font folders", () => {
  assert.deepEqual(fontDirs("darwin", "/Users/u", {}), ["/Library/Fonts", path.join("/Users/u", "Library", "Fonts"), "/System/Library/Fonts"]);
  const win = fontDirs("win32", "C:\\Users\\u", { WINDIR: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
  assert.deepEqual(win, [path.join("C:\\Windows", "Fonts"), path.join("C:\\Users\\u\\AppData\\Local", "Microsoft", "Windows", "Fonts")]);
});

test("fontDirs: $SVA_FONT_DIR comes first, ahead of the OS folders", () => {
  const dirs = fontDirs("linux", "/home/u", { SVA_FONT_DIR: ["/x", "/y"].join(path.delimiter) });
  assert.deepEqual(dirs.slice(0, 2), ["/x", "/y"]);
  assert.ok(dirs.includes("/usr/share/fonts"));
  assert.ok(dirs.includes(path.join("/home/u", ".local", "share", "fonts")));
});

test("scaffold: warns on stderr, without failing, when Pretendard is not found", async () => {
  const dir = tmp("sva-nofont-");
  const empty = tmp("sva-emptyfonts-");
  const lines = [];
  const origError = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await scaffold({ dir, width: 1080, height: 1920, fps: 30, title: "T", ratio: "9:16", fontSearchDirs: [empty] });
  } finally {
    console.error = origError;
  }
  const out = lines.join("\n");
  assert.match(out, /WARNING: Pretendard not found/);
  assert.ok(out.includes(empty), "warning lists the searched folders");
  assert.ok(out.includes("SVA_FONT_DIR"));
  assert.ok(fs.existsSync(path.join(dir, "reel.html")), "scaffold still completes");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("scaffold: no warning and fonts copied when Pretendard is in a nested folder", async () => {
  const dir = tmp("sva-font-ok-");
  const root = tmp("sva-fontsrc-");
  touch(path.join(root, "Pretendard", "Pretendard-Regular.otf"));
  touch(path.join(root, "Pretendard", "Pretendard-Bold.otf"));
  const lines = [];
  const origError = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await scaffold({ dir, width: 1080, height: 1920, fps: 30, title: "T", ratio: "9:16", fontSearchDirs: [root] });
  } finally {
    console.error = origError;
  }
  assert.ok(!lines.join("\n").includes("Pretendard not found"));
  assert.ok(fs.existsSync(path.join(dir, "assets", "fonts", "Pretendard-Regular.otf")));
  assert.ok(fs.existsSync(path.join(dir, "assets", "fonts", "Pretendard-Bold.otf")));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
