import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMpd, parseRef, stepsOf, findBuildModel, treeLines, openLibrary, flattenPart, partTitle, readColours, colourOf, mul, transformBounds,
} from "../scripts/lib/ldraw.mjs";
import { makeLibrary, TREE_MPD } from "./ldraw-fixture.mjs";

test("parseRef reads a type-1 line into colour, 3x4 matrix and file; other lines give null", () => {
  const r = parseRef("1 4 10 -24 5 1 0 0 0 1 0 0 0 1 3001.dat");
  assert.equal(r.color, "4");
  assert.equal(r.file, "3001.dat");
  assert.deepEqual(r.m, [1, 0, 0, 10, 0, 1, 0, -24, 0, 0, 1, 5]);
  assert.equal(parseRef("0 STEP"), null);
  assert.equal(parseRef("3 16 0 0 0 1 0 0 0 1 0"), null);
});

test("parseMpd keeps FILE order; the first FILE is the main model; a file with no FILE line is one model", () => {
  const mpd = parseMpd(TREE_MPD);
  assert.deepEqual(mpd.order, ["main.ldr", "model.ldr", "sub.ldr"]);
  assert.equal(mpd.main, "main.ldr");
  const single = parseMpd("1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n", "thing.ldr");
  assert.deepEqual(single.order, ["thing.ldr"]);
  assert.throws(() => parseMpd("0 FILE a.ldr\n0 FILE A.ldr\n"), /twice/);
});

test("stepsOf splits at STEP and ROTSTEP, drops empty steps and numbers the rest from 1", () => {
  const mpd = parseMpd("0 FILE m.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n0 STEP\n0 STEP\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n0 ROTSTEP 0 90 0 REL\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 c.dat\n");
  assert.deepEqual(stepsOf(mpd, "m.ldr").map((s) => [s.n, s.refs.map((r) => r.file)]), [[1, ["a.dat"]], [2, ["b.dat"]], [3, ["c.dat"]]]);
  assert.throws(() => stepsOf(mpd, "nope.ldr"), /sub-model not in the file/);
});

test("the build model is the one main only wraps; the tree lists sub-models in file order", () => {
  const mpd = parseMpd(TREE_MPD);
  const build = findBuildModel(mpd);
  assert.equal(build.name, "model.ldr");
  assert.deepEqual(treeLines(mpd, build.key), ["  step 2: sub.ldr"]);
});

test("a model that is not wrapped is built as it is", () => {
  const mpd = parseMpd("0 FILE m.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n");
  assert.equal(findBuildModel(mpd).key, "m.ldr");
});

test("library lookup finds parts/, p/ and sub-folders by the reference's own name, and names a missing part", () => {
  const lib = openLibrary(makeLibrary());
  assert.match(lib.readPart("PLATE.DAT"), /Plate 2 x 2/);
  assert.match(lib.readPart("stud.dat"), /Stud/);
  assert.throws(() => lib.readPart("nope.dat"), /library file not found: nope\.dat/);
  assert.throws(() => openLibrary("/nonexistent-parts-folder-for-test"), /parts folder not found/);
  assert.equal(partTitle(lib, "old.dat"), "Brick 2 x 2");
});

test("flattening keeps colour inheritance: 16 follows the reference, a fixed colour stays, 24 is the edge", () => {
  const lib = openLibrary(makeLibrary());
  const flat = flattenPart(lib, "plate.dat");
  // the plate's own faces and its first stud (ref colour 16) are main-colour; the second stud (ref colour 1) is colour 1
  assert.deepEqual([...flat.tris.keys()].sort(), ["M", "c:1"]);
  assert.deepEqual([...flat.lines.keys()].sort(), ["E", "e:1"]);
  assert.equal(flat.tris.get("c:1").length / 9, 12, "one stud box is 6 quads = 12 triangles");
  const stud = flat.tris.get("c:1");
  const xs = stud.filter((_, i) => i % 3 === 0);
  assert.ok(Math.min(...xs) >= 4 - 1e-9 && Math.max(...xs) <= 16 + 1e-9, "the stud moved to x = 10 +- 6");
});

test("the colour table gives value, edge and alpha; a direct colour carries its own value", () => {
  const lib = openLibrary(makeLibrary());
  const colours = readColours(lib);
  assert.equal(colours["4"].value, "#C91A09");
  assert.equal(colours["1"].alpha, 128);
  assert.equal(colourOf(colours, "0x2FF8800").value, "#FF8800");
  assert.equal(colourOf(colours, "999"), null);
});

test("matrix helpers: mul composes parent and child, transformBounds moves a box", () => {
  const T = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0];
  const R = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0];
  assert.deepEqual(mul(T, R).slice(3, 4), [5]);
  assert.deepEqual(transformBounds(T, [0, 0, 0, 1, 1, 1]), [5, 0, 0, 6, 1, 1]);
});
