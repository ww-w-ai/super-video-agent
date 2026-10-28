import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paletteShare, BASIC } from "../scripts/lib/ldraw-part-palette.mjs";
import { boxDat } from "./ldraw-fixture.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ldraw-part-palette.mjs");
const I = "1 0 0 0 1 0 0 0 1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-palette-"));
for (const d of ["parts", "p"]) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, "parts/3001.dat"), boxDat("Brick  2 x  4", [-40, 40, 0, 24, -20, 20]));
fs.writeFileSync(path.join(root, "parts/3024.dat"), boxDat("Plate  1 x  1", [-10, 10, 0, 8, -10, 10]));
fs.writeFileSync(path.join(root, "parts/11477.dat"), boxDat("Slope Brick Curved  2 x  1", [-20, 20, 0, 16, -10, 10]));
fs.writeFileSync(path.join(root, "parts/87087.dat"), boxDat("Brick  1 x  1 with Stud on Side", [-10, 10, 0, 24, -10, 10]));
const palette = path.join(root, "palette.json");
fs.writeFileSync(palette, JSON.stringify({ groups: [{ key: "curves", title: "Curved slopes", parts: [{ id: "11477" }] }, { key: "snot", title: "SNOT", parts: [{ id: "87087" }] }] }));
// main: 2 bricks + the statue sub-model twice; statue: 2 curves, 1 SNOT, 1 plate
const model = path.join(root, "scene.mpd");
fs.writeFileSync(model, ["0 FILE scene.ldr", `1 4 0 0 0 ${I} 3001.dat`, `1 4 0 -24 0 ${I} 3001.dat`, `1 16 0 -48 0 ${I} statue.ldr`, `1 16 100 -48 0 ${I} statue.ldr`, "0 FILE statue.ldr", `1 4 0 0 0 ${I} 11477.dat`, `1 4 0 -16 0 ${I} 11477.dat`, `1 4 0 -32 0 ${I} 87087.dat`, `1 4 0 -40 0 ${I} 3024.dat`, ""].join("\n"));

test("BASIC: plain bricks, plates and tiles only", () => {
  assert.ok(BASIC.test("Brick  2 x  4") && BASIC.test("Plate  1 x  1") && BASIC.test("Tile  2 x  2 with Groove"));
  assert.ok(!BASIC.test("Slope Brick Curved  2 x  1") && !BASIC.test("Brick  1 x  1 with Stud on Side"));
});

test("paletteShare counts sub-models with multiplicity; a region counts only inside it", () => {
  const all = paletteShare({ model, lib: root, palette });
  assert.equal(all.total, 10);
  assert.equal(all.specialty, 6);
  assert.equal(all.basic, 4);
  assert.deepEqual(all.byGroup, { curves: 4, snot: 2 });
  assert.equal(all.pass, true);
  const statue = paletteShare({ model, lib: root, palette, region: "statue", min: 0.8 });
  assert.equal(statue.total, 8);
  assert.equal(statue.share, 0.75);
  assert.equal(statue.pass, false);
});

test("CLI: exit 1 below the minimum, 0 above it", () => {
  const ok = spawnSync(process.execPath, [CLI, model, "--lib", root, "--palette", palette], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS specialty 60\.0%/);
  const low = spawnSync(process.execPath, [CLI, model, "--lib", root, "--palette", palette, "--min-specialty", "0.7"], { encoding: "utf8" });
  assert.equal(low.status, 1);
});
