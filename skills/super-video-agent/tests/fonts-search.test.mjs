// fonts.mjs descends into family subfolders (Linux layout) and honors
// $SVA_FONT_DIR; new-reel.mjs warns on stderr when Pretendard is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fontDirs, findPretendard, findHandwritingFont } from "../scripts/lib/fonts.mjs";
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

test("findHandwritingFont: matches NanumPen but not OpenSans", () => {
  const root = tmp("sva-fonts-hw-");
  touch(path.join(root, "OpenSans-Regular.ttf"));
  const pen = path.join(root, "nanum", "NanumPen.ttf");
  touch(pen);
  assert.equal(findHandwritingFont({ dirs: [root] }), pen);
  fs.rmSync(root, { recursive: true, force: true });
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
