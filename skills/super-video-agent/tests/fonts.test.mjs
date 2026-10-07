// scripts/lib/fonts.mjs + new-reel.mjs fonts: Pretendard is found in Linux-style
// nested font folders (~/.local/share/fonts/Pretendard/), and a scaffold with
// no Pretendard installed reports a warning with the fix instead of leaving
// assets/fonts/ silently empty under a reel.html that points there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fontDirs, findPretendard, findHandwritingFont } from "../scripts/lib/fonts.mjs";
import { scaffold } from "../scripts/new-reel.mjs";

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "font");
}

test("fontDirs: Linux searches the XDG user folder, ~/.fonts and the system folders; SVA_FONT_DIR comes first", () => {
  const dirs = fontDirs({ HOME: "/home/u", SVA_FONT_DIR: "/opt/f" }, "linux");
  assert.deepEqual(dirs, ["/opt/f", "/home/u/.local/share/fonts", "/home/u/.fonts", "/usr/local/share/fonts", "/usr/share/fonts"]);
  assert.ok(fontDirs({ HOME: "/Users/u" }, "darwin").includes("/Library/Fonts"));
});

test("findPretendard: finds Regular and Bold one family folder deep (Linux install layout)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fonts-"));
  touch(path.join(root, "Pretendard", "Pretendard-Regular.otf"));
  touch(path.join(root, "Pretendard", "Pretendard-Bold.otf"));
  touch(path.join(root, "Pretendard", "Pretendard-ExtraBold.otf"));
  const { regular, bold } = findPretendard({ dirs: [root] });
  assert.equal(path.basename(regular), "Pretendard-Regular.otf");
  assert.equal(path.basename(bold), "Pretendard-Bold.otf");
  fs.rmSync(root, { recursive: true, force: true });
});

test("findHandwritingFont: NanumPen matches; OpenSans and ...Sompeng do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-hand-"));
  touch(path.join(root, "a", "OpenSans-Regular.ttf"));
  touch(path.join(root, "a", "NotoSansSoraSompeng-Regular.ttf"));
  assert.equal(findHandwritingFont({ dirs: [root] }), null);
  touch(path.join(root, "nanum", "NanumPen.ttf"));
  assert.equal(path.basename(findHandwritingFont({ dirs: [root] })), "NanumPen.ttf");
  fs.rmSync(root, { recursive: true, force: true });
});

test("scaffold: copies Pretendard from a nested folder; with none installed it returns a warning naming the fix", async () => {
  const fontRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fontroot-"));
  touch(path.join(fontRoot, "Pretendard", "Pretendard-Regular.otf"));
  touch(path.join(fontRoot, "Pretendard", "Pretendard-Bold.otf"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-newfont-"));
  const ok = await scaffold({ dir, width: 1920, height: 1080, fps: 30, title: "F", ratio: "16:9", fontDirs: [fontRoot] });
  assert.equal(ok.fontStatus.pretendard, true);
  assert.equal(ok.fontStatus.warning, null);
  assert.ok(fs.existsSync(path.join(dir, "assets", "fonts", "Pretendard-Regular.otf")));
  assert.ok(fs.existsSync(path.join(dir, "assets", "fonts", "Pretendard-Bold.otf")));

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sva-nofont-"));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sva-newfont2-"));
  const missing = await scaffold({ dir: dir2, width: 1920, height: 1080, fps: 30, title: "F", ratio: "16:9", fontDirs: [empty] });
  assert.equal(missing.fontStatus.pretendard, false);
  assert.match(missing.fontStatus.warning, /Pretendard not found/);
  assert.match(missing.fontStatus.warning, /SVA_FONT_DIR/);
  assert.ok(missing.fontStatus.warning.includes(path.join(dir2, "assets", "fonts")));
  for (const d of [fontRoot, dir, empty, dir2]) fs.rmSync(d, { recursive: true, force: true });
});
