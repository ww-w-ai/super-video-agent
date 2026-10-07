import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bakeModel } from "../scripts/lib/ldraw-bake.mjs";
import { connectionClass } from "../scripts/lib/ldraw-connect.mjs";
import { makeLibrary, TREE_MPD, BELOW_MPD, AXLE_MPD } from "./ldraw-fixture.mjs";

const lib = makeLibrary();
const bake = (text, extra = {}) => bakeModel({ text, libraryDir: lib, ...extra });
const items = (r, key) => r.build.models[key].steps.flatMap((s) => s.items);

test("the tree, the build order and the steps come from the file's own hierarchy", () => {
  const r = bake(TREE_MPD);
  assert.deepEqual(r.build.tree, ["main.ldr", "  -> model.ldr (3 steps)", "    step 2: sub.ldr"]);
  assert.deepEqual(r.build.order.map((o) => `${o.model}:${o.step}`), ["model.ldr:1", "sub.ldr:1", "sub.ldr:2", "model.ldr:2", "model.ldr:3"]);
  assert.equal(r.build.order[1].via, "model.ldr#2.1", "a sub-model's steps name the item that joins it");
  assert.equal(r.build.order[0].via, null);
  assert.equal(r.build.models["model.ldr"].steps.length, 3);
  assert.equal(r.build.models["sub.ldr"].steps.length, 2);
  assert.equal(r.report.models, 2);
});

test("placements keep the file's matrix and colour; the sub-model is one item with the box of its parts", () => {
  const r = bake(TREE_MPD);
  const [plate, sub, top] = items(r, "model.ldr");
  assert.equal(plate.color, "4");
  assert.equal(sub.kind, "model");
  assert.equal(sub.model, "sub.ldr");
  assert.deepEqual(sub.bounds, [-20, -48, -20, 20, 0, 20]);
  assert.equal(top.part, "brick");
  assert.equal(top.m[7], -72);
});

test("stud parts come from above when a part under them carries them, a sub-assembly too", () => {
  const r = bake(TREE_MPD);
  const [plate, sub, top] = items(r, "model.ldr");
  assert.equal(plate.join.reason, "first part");
  assert.deepEqual(sub.join.from, [0, -1, 0]);
  assert.match(sub.join.reason, /rests on a part below/);
  assert.deepEqual(top.join.from, [0, -1, 0]);
});

test("a stud part that only a part above holds comes from below", () => {
  const r = bake(BELOW_MPD);
  const [brick, plate] = items(r, "main.ldr");
  assert.equal(brick.join.reason, "first part");
  assert.deepEqual(plate.join.from, [0, 1, 0]);
  assert.match(plate.join.reason, /underside of a part above/);
});

test("an axle comes in along its own axis from the end whose path crosses fewer triangles", () => {
  const r = bake(AXLE_MPD);
  const [, axle] = items(r, "main.ldr");
  assert.equal(axle.class, "axis");
  assert.equal(axle.join.axis, "x");
  assert.deepEqual(axle.join.from, [-1, 0, 0]);
  assert.match(axle.join.reason, /other end crossed [1-9]\d* triangle pairs, this end 0/);
  const check = r.build.models["main.ldr"].pathCheck.find((c) => c.uid === axle.uid);
  assert.equal(check.hits, 0);
});

test("every path of the stacked model crosses nothing", () => {
  const r = bake(TREE_MPD);
  for (const m of Object.values(r.build.models)) assert.ok(m.pathCheck.every((c) => c.hits === 0), JSON.stringify(m.pathCheck));
});

test("a class override changes how a part joins", () => {
  const r = bake(AXLE_MPD, { classes: { axle: "stud" } });
  const [, axle] = items(r, "main.ldr");
  assert.equal(axle.class, "stud");
  assert.equal(axle.join.axis, "y");
});

test("--until bakes only the first steps of the built model", () => {
  const r = bake(TREE_MPD, { until: 1 });
  assert.equal(r.build.models["model.ldr"].steps.length, 1);
  assert.equal(r.build.models["sub.ldr"], undefined);
  assert.deepEqual(r.build.order.map((o) => o.model), ["model.ldr"]);
});

test("parts.json data: geometry by colour key as base64 floats, titles and the colours used with values", () => {
  const r = bake(TREE_MPD);
  const plate = r.partsData.parts.plate;
  assert.equal(plate.title, "Plate 2 x 2");
  assert.deepEqual(Object.keys(plate.tris).sort(), ["M", "c:1"]);
  const buf = Buffer.from(plate.tris.M, "base64");
  const floats = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.equal(floats.length / 9, plate.triCount - 12);
  assert.equal(r.partsData.colours["4"].value, "#C91A09");
  assert.equal(r.partsData.colours["1"].alpha, 128);
  assert.deepEqual(r.report.unknownColours, ["2"]);
});

test("a part missing from the library, or a model that contains itself, stops the bake and names it", () => {
  assert.throws(() => bake("0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 missing.dat\n"), /library file not found: missing\.dat/);
  assert.throws(() => bake("0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 loop.ldr\n0 FILE loop.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 loop.ldr\n"), /contains itself/);
});

test("connection class comes from the title; a part id in the overrides wins", () => {
  assert.equal(connectionClass("Technic Axle 4", "3705"), "axis");
  assert.equal(connectionClass("Technic Pin with Friction", "2780"), "axis");
  assert.equal(connectionClass("Technic Brick 1 x 6 with Holes", "3894"), "hole");
  assert.equal(connectionClass("Brick 2 x 4", "3001"), "stud");
  assert.equal(connectionClass("Brick 2 x 4", "3001", { 3001: "axis" }), "axis");
});

test("ldraw-bake.mjs writes build.json and parts.json and prints the tree, the joins and the path check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-bake-"));
  const mpd = path.join(dir, "model.mpd");
  fs.writeFileSync(mpd, TREE_MPD);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/ldraw-bake.mjs");
  const run = spawnSync(process.execPath, [script, mpd, "--lib", lib, "--out", path.join(dir, "data")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /step 2: sub\.ldr/);
  assert.match(run.stdout, /path check model\.ldr: 3 of 3 paths cross nothing/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "data/build.json"), "utf8")).order.length === 5);
  assert.ok(fs.existsSync(path.join(dir, "data/parts.json")));
  const bad = spawnSync(process.execPath, [script, mpd, "--lib", "/nonexistent-lib-for-test", "--out", path.join(dir, "d2")], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /parts folder not found/);
});
