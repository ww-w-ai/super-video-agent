import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkOrderFiles, writeStamp, stampPathFor, checkOrderStamp, orderGate, assertOrderChecked, createModel, createBuild, fromLdraw } from "../scripts/lib/ldraw-order-check.mjs";
import { bakeModel } from "../scripts/lib/ldraw-bake.mjs";
import { boxDat } from "./ldraw-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "scripts", "ldraw-order-check.mjs");
const I = "1 0 0 0 1 0 0 0 1";

// A small library: real stud primitives on solid boxes. LDraw -Y is up; a brick's top is y=0, its bottom y=24.
function makeLib() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-order-"));
  for (const d of ["parts", "p"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const put = (rel, text) => fs.writeFileSync(path.join(root, rel), text);
  put("p/stud.dat", boxDat("Stud", [-6, 6, -4, 0, -6, 6]));
  put("p/stug-1x2.dat", ["0 Stud Group  1 x  2", `1 16 0 0 -10 ${I} stud.dat`, `1 16 0 0 10 ${I} stud.dat`, ""].join("\n"));
  put("parts/b1.dat", boxDat("Brick  1 x  1", [-10, 10, 0, 24, -10, 10], [`1 16 0 0 0 ${I} stud.dat`]));
  put("parts/p1.dat", boxDat("Plate  1 x  1", [-10, 10, 0, 8, -10, 10], [`1 16 0 0 0 ${I} stud.dat`]));
  // a stud on the -Z side, 12 LDU down: the stud's -Y axis turned to -Z
  put("parts/snot.dat", boxDat("Brick  1 x  1 with Stud on Side", [-10, 10, 0, 24, -10, 10], [`1 16 0 0 0 ${I} stud.dat`, "1 16 0 12 -10 1 0 0 0 0 -1 0 1 0 stud.dat"]));
  const studs = [];
  for (const x of [-30, -10, 10, 30]) studs.push(`1 16 ${x} 0 0 ${I} stug-1x2.dat`, `1 16 ${x} 0 30 ${I} stud.dat`, `1 16 ${x} 0 -30 ${I} stud.dat`);
  put("parts/base.dat", boxDat("Plate  4 x  4", [-40, 40, 0, 8, -40, 40], studs));
  // a part with a square hole of +-4 along X, built from four boxes around it
  const ring = (title, [x0, x1], [yc, zc], outer, extra = []) => {
    const boxes = [[x0, x1, yc - outer, yc - 4, zc - outer, zc + outer], [x0, x1, yc + 4, yc + outer, zc - outer, zc + outer], [x0, x1, yc - 4, yc + 4, zc - outer, zc - 4], [x0, x1, yc - 4, yc + 4, zc + 4, zc + outer]];
    return [`0 ${title}`, ...boxes.map((b, k) => boxDat(`~${title} part ${k}`, b).split("\n").slice(1, 7).join("\n")), ...extra, ""].join("\n");
  };
  put("parts/holder.dat", ring("Technic Brick  1 x  1 with Hole", [-10, 10], [12, 0], 12, [`1 16 0 0 0 ${I} stud.dat`]));
  put("parts/drum.dat", ring("Technic Wedge Belt Wheel", [-4, 4], [0, 0], 10));
  put("parts/axle.dat", boxDat("Technic Axle  4", [-40, 40, -3, 3, -3, 3]));
  return root;
}

const lib = makeLib();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sva-order-case-"));
const ref = (x, y, z, file, rot = I) => `1 4 ${x} ${y} ${z} ${rot} ${file}`;

/** Writes model.ldr (one step per line) and, if given, order.json into a fresh folder; runs the gate. */
function run(lines, order = null, extra = {}) {
  const dir = tmp();
  const model = path.join(dir, "model.ldr");
  fs.writeFileSync(model, ["0 FILE model.ldr", ...lines.flatMap((l) => [l, "0 STEP"]), ""].join("\n"));
  let orderFile = null;
  if (order) {
    orderFile = path.join(dir, "order.json");
    fs.writeFileSync(orderFile, JSON.stringify(order));
  }
  // structural cases run without a camera track (structure only); visibility cases pass cameras
  const r = checkOrderFiles({ input: model, libraryDir: lib, order: orderFile, structureOnly: !extra.cameras, ...extra });
  return { ...r, dir, model, orderFile };
}

const COLUMN = [ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat"), ref(10, -48, 10, "b1.dat"), ref(10, -72, 10, "b1.dat")];
const uid = (n) => `model.ldr#${n}.1`;

/** A camera file in front of the model (from -Z, a little above), looking at the column at x 10, z 10. */
function camFile(dir, cam = { eye: [10, -150, -400], target: [10, -36, 10], fov: 40, aspect: 1 }) {
  const f = path.join(dir, "cams.json");
  fs.writeFileSync(f, JSON.stringify({ cameras: [{ k0: 0, k1: 9999, ...cam }] }));
  return f;
}

test("stud primitives (and stud groups) are found and each brick on the base is held by a real stud joint", () => {
  const base = fromLdraw(["0 FILE model.ldr", ...COLUMN, ""].join("\n"));
  const model = createModel({ libraryDir: lib, placements: base.placements });
  assert.equal(model.P[0].part.studs.length, 16, "4 groups of 2 + 8 single studs");
  const b = createBuild(model);
  const s0 = b.supportOf([0]);
  assert.equal(s0.how, "on the ground");
  b.place([0]);
  const s1 = b.supportOf([1]);
  assert.equal(s1.ok, true);
  assert.equal(s1.how, "anti-stud");
  assert.deepEqual(s1.from, [0, -1, 0], "held from below, so it comes from above");
});

test("a stacked column built bottom-up passes", () => {
  const { report } = run(COLUMN);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  assert.deepEqual([report.counts.support, report.counts.crossing, report.counts.order], [0, 0, 0]);
});

test("the same column built top-first fails: the top floats and the lower bricks go in under it", () => {
  const order = [uid(1), { id: uid(4), from: "above", travel: 72 }, { id: uid(3), from: "above", travel: 72 }, { id: uid(2), from: "above", travel: 72 }];
  const { report } = run(COLUMN, order);
  assert.equal(report.pass, false);
  assert.equal(report.violations.support.length, 1);
  assert.equal(report.violations.support[0].label, uid(4));
  assert.deepEqual(report.violations.order.map((o) => o.label), [uid(3), uid(2)]);
  assert.ok(report.violations.crossing.some((c) => c.label === uid(3)), "the brick dropped onto the column passes through the one above it");
});

test("a floating brick fails SUPPORT", () => {
  const { report } = run([ref(0, 0, 0, "base.dat"), ref(10, -100, 10, "b1.dat")]);
  assert.equal(report.pass, false);
  assert.deepEqual(report.violations.support.map((s) => s.label), [uid(2)]);
});

test("a plate pressed sideways onto a SNOT stud with a clear path passes, and its direction comes from the joint", () => {
  // base, a brick, the side-stud brick on it (side stud at world (10,-36,0) pointing -Z), a plate stood up on that stud
  const lines = [ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat"), ref(10, -48, 10, "snot.dat"), ref(10, -36, -8, "p1.dat", "1 0 0 0 0 -1 0 1 0")];
  const auto = run(lines);
  assert.equal(auto.report.pass, true, JSON.stringify(auto.report.violations));
  const order = [uid(1), uid(2), uid(3), { id: uid(4), from: "-z", travel: 40 }];
  const { report } = run(lines, order);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
  // the same plate dropped from above drives its end wall through the side stud
  const bad = run(lines, [uid(1), uid(2), uid(3), { id: uid(4), from: "above", travel: 60 }]);
  assert.equal(bad.report.pass, false);
  assert.equal(bad.report.violations.crossing[0].hits[0].with, uid(3));
});

test("a brick slid sideways through a brick already placed fails CROSSING (flush faces included)", () => {
  const lines = [ref(0, 0, 0, "base.dat"), ref(-10, -24, 10, "b1.dat"), ref(10, -24, 10, "b1.dat")];
  const { report } = run(lines, [uid(1), uid(2), { id: uid(3), from: "-x", travel: 60 }]);
  assert.equal(report.pass, false);
  assert.equal(report.violations.crossing.length, 1);
  assert.ok(report.violations.crossing[0].hits.some((h) => h.with === uid(2)), JSON.stringify(report.violations.crossing));
  assert.equal(report.violations.order.length, 0, "a sideways arrival is judged by its path, not by the column rule");
  // from the open side it misses the brick, but sliding sideways over the base drags it through the base's studs
  const open = run(lines, [uid(1), uid(2), { id: uid(3), from: "+x", travel: 60 }]).report;
  assert.deepEqual(open.violations.crossing[0].hits.map((h) => h.with), [uid(1)]);
  // pressed down from above it is fine
  assert.equal(run(lines, [uid(1), uid(2), { id: uid(3), from: "above" }]).report.pass, true);
});

test("a sub-assembly is built on its own (first part free) and lands as one piece", () => {
  const good = run(COLUMN, [uid(1), uid(2), { ids: [uid(3), uid(4)], from: "above" }]);
  assert.equal(good.report.pass, true, JSON.stringify(good.report.violations));
  const topFirst = run(COLUMN, [uid(1), uid(2), { ids: [uid(4), uid(3)], from: "above", build: [{ id: uid(4) }, { id: uid(3), from: "above" }] }]);
  assert.equal(topFirst.report.pass, false);
  assert.match(topFirst.report.violations.order[0].scope, /^main > /, "the fault is inside the sub-assembly's own build");
  const floating = run(COLUMN, [uid(1), { ids: [uid(3), uid(4)], from: "above" }, uid(2)]);
  assert.equal(floating.report.violations.support[0].label.startsWith(uid(3)), true, "the piece joins nothing when it lands");
});

test("parts left out of the order and parts placed twice are caught", () => {
  const { report } = run(COLUMN, [uid(1), uid(2), uid(3)]);
  assert.deepEqual(report.violations.unplaced, [uid(4)]);
  assert.throws(() => run(COLUMN, [uid(1), uid(2), uid(2), uid(3)]), /placed twice/);
});

test("a bake's build.json is read with its own join directions", () => {
  const text = ["0 FILE model.ldr", ...COLUMN.flatMap((l) => [l, "0 STEP"]), ""].join("\n");
  const r = bakeModel({ text, name: "model.ldr", libraryDir: lib });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify(r.build));
  const out = checkOrderFiles({ input: path.join(dir, "build.json"), libraryDir: lib, structureOnly: true });
  assert.equal(out.report.pass, true, JSON.stringify(out.report.violations));
  // reorder the steps top-first, keep the bake's "from above"
  const b = JSON.parse(JSON.stringify(r.build));
  const m = b.models[b.buildKey];
  m.steps = [m.steps[0], m.steps[3], m.steps[2], m.steps[1]];
  fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify(b));
  const bad = checkOrderFiles({ input: path.join(dir, "build.json"), libraryDir: lib, structureOnly: true });
  assert.equal(bad.report.pass, false);
  assert.ok(bad.report.counts.support >= 1 && bad.report.counts.order >= 1);
});

// a wall (two bricks high at z -30) in front of a brick at z 10, seen from -Z at the brick's height
const WALL = [ref(0, 0, 0, "base.dat"), ref(10, -24, -30, "b1.dat"), ref(10, -48, -30, "b1.dat"), ref(10, -24, 10, "b1.dat")];
const LOW = { eye: [10, -20, -400], target: [10, -20, 10], fov: 30, aspect: 1 };

function wallBuild() {
  const base = fromLdraw(["0 FILE model.ldr", ...WALL, ""].join("\n"));
  const b = createBuild(createModel({ libraryDir: lib, placements: base.placements }));
  b.place([0]);
  b.place([1]);
  b.place([2]);
  return b;
}

test("VISIBILITY: a brick landing behind a wall from the camera fails; after a camera turn it passes", () => {
  const hidden = run(WALL, null, { cameras: camFile(tmp(), LOW) }).report;
  assert.equal(hidden.pass, false);
  assert.equal(hidden.counts.hidden, 1);
  assert.equal(hidden.visibility.hidden[0].index, 3);
  assert.ok(hidden.visibility.hidden[0].blockers.length >= 1, JSON.stringify(hidden.visibility.hidden[0]));
  const b = wallBuild();
  assert.equal(b.visibleOf([3], LOW).visible, false);
  const turn = b.proposeCamera([3], LOW);
  assert.ok(turn && turn.turn > 0, "a turn exists");
  assert.equal(b.visibleOf([3], turn.camera).visible, true);
  const after = run(WALL, null, { cameras: camFile(tmp(), turn.camera) }).report;
  assert.equal(after.counts.hidden, 0, JSON.stringify(after.visibility.hidden));
  assert.equal(after.pass, true, JSON.stringify(after.violations));
});

test("VISIBILITY: the planner helper never returns a hidden candidate", () => {
  const b = wallBuild();
  // candidates: the brick behind the wall (hidden) and, as a fresh build, the top wall brick (seen)
  assert.deepEqual(b.visibleCandidates([3], LOW), []);
  const base = fromLdraw(["0 FILE model.ldr", ...WALL, ""].join("\n"));
  const b2 = createBuild(createModel({ libraryDir: lib, placements: base.placements }));
  b2.place([0]);
  b2.place([1]);
  const vis = b2.visibleCandidates([2, 3], LOW);
  assert.ok(vis.includes(2), "the top wall brick is seen");
  for (const c of vis) assert.equal(b2.visibleOf([].concat(c), LOW).visible, true);
  const many = b.visibleCandidates([3, [3]], LOW);
  assert.deepEqual(many, []);
});

test("VISIBILITY: no camera track fails, a landing with no camera fails, an internal part seen through an opening is excepted", () => {
  const none = run(WALL, null, { structureOnly: false }).report;
  assert.equal(none.pass, false);
  assert.equal(none.visibility.missingCameras, true);
  const dir = tmp();
  const partial = path.join(dir, "cams.json");
  fs.writeFileSync(partial, JSON.stringify({ cameras: [{ k0: 0, k1: 2, ...LOW }] }));
  const gap = run(WALL, null, { cameras: partial }).report;
  assert.deepEqual(gap.visibility.noCamera.map((h) => h.index), [2, 3]);
  assert.equal(gap.pass, false);
  const open = path.join(dir, "open.json");
  fs.writeFileSync(open, JSON.stringify({ cameras: [{ k0: 0, k1: 99, opening: true, ...LOW }] }));
  const exc = run(WALL, null, { cameras: open, internal: /^model\.ldr#4\.1$/ }).report;
  assert.equal(exc.counts.hidden, 0);
  assert.equal(exc.counts.excepted, 1);
  assert.equal(exc.pass, true);
});

test("stamp and gate: render/verify refuse an unchecked or changed order; an override needs a reason and is logged", () => {
  const reel = tmp();
  const data = path.join(reel, "data");
  fs.mkdirSync(data);
  const text = ["0 FILE model.ldr", ...COLUMN.flatMap((l) => [l, "0 STEP"]), ""].join("\n");
  const build = path.join(data, "build.json");
  fs.writeFileSync(build, JSON.stringify(bakeModel({ text, name: "model.ldr", libraryDir: lib }).build));
  assert.equal(orderGate(reel).ok, false);
  assert.match(orderGate(reel).lines.join("\n"), /never checked/);
  assert.throws(() => assertOrderChecked(build), /not cleared/);
  // a structure-only stamp (no camera track) opens nothing
  writeStamp(stampPathFor({ input: build }), checkOrderFiles({ input: build, libraryDir: lib, structureOnly: true }));
  assert.equal(checkOrderStamp(build).ok, false);
  assert.match(checkOrderStamp(build).reason, /no VISIBILITY check/);
  const result = checkOrderFiles({ input: build, libraryDir: lib, cameras: camFile(data) });
  assert.equal(result.report.pass, true, JSON.stringify(result.report.visibility));
  writeStamp(stampPathFor({ input: build }), result);
  assert.equal(checkOrderStamp(build).ok, true);
  assert.equal(orderGate(reel).ok, true);
  fs.appendFileSync(build, "\n");
  assert.equal(orderGate(reel).ok, false, "a changed order needs a new check");
  assert.match(checkOrderStamp(build).reason, /changed after/);
  assert.equal(orderGate(reel, { skipReason: true }).ok, false, "a bare --skip-order-check is refused");
  const skipped = orderGate(reel, { skipReason: "probe still for lighting" });
  assert.equal(skipped.ok, true);
  assert.match(fs.readFileSync(path.join(reel, "out", "order-check-override.log"), "utf8"), /probe still for lighting/);
  // a failing check writes a stamp that does not open the gate
  const bad = run(COLUMN, [uid(1), uid(4), uid(3), uid(2)], { cameras: camFile(tmp()) });
  writeStamp(stampPathFor({ input: bad.model, order: bad.orderFile }), bad);
  assert.equal(checkOrderStamp(bad.orderFile).ok, false);
  assert.match(checkOrderStamp(bad.orderFile).reason, /FAILED/);
});

test("a reel with no LDraw order is not touched by the gate", () => {
  const reel = tmp();
  assert.deepEqual(orderGate(reel), { ok: true, lines: [] });
});

test("CLI: exit 0 and a passing stamp for a good order, exit 1 for a bad one, exit 2 for bad input", () => {
  const good = run(COLUMN);
  const r0 = spawnSync(process.execPath, [CLI, good.model, "--lib", lib, "--cameras", camFile(good.dir)], { encoding: "utf8" });
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  assert.match(r0.stdout, /PASS/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(good.dir, "order-check.json"), "utf8")).pass, true);
  const bad = run(COLUMN, [uid(1), uid(4), uid(3), uid(2)]);
  const json = path.join(bad.dir, "report.json");
  const r1 = spawnSync(process.execPath, [CLI, bad.model, "--lib", lib, "--order", bad.orderFile, "--json", json], { encoding: "utf8" });
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /SUPPORT/);
  assert.equal(JSON.parse(fs.readFileSync(json, "utf8")).pass, false);
  const r2 = spawnSync(process.execPath, [CLI, path.join(bad.dir, "missing.ldr"), "--lib", lib], { encoding: "utf8" });
  assert.equal(r2.status, 2);
  // no camera track: VISIBILITY fails with a clear message; --structure-only passes but its stamp opens no gate
  const r3 = spawnSync(process.execPath, [CLI, good.model, "--lib", lib], { encoding: "utf8" });
  assert.equal(r3.status, 1);
  assert.match(r3.stdout, /VISIBILITY required: pass --cameras/);
  const r4 = spawnSync(process.execPath, [CLI, good.model, "--lib", lib, "--structure-only"], { encoding: "utf8" });
  assert.equal(r4.status, 0, r4.stdout);
  assert.match(r4.stdout, /structure only: opens no gate/);
});

test("render.mjs and verify.mjs refuse a reel whose LDraw order has no passing stamp; --skip-order-check needs a reason", () => {
  const reel = tmp();
  fs.mkdirSync(path.join(reel, "data"));
  fs.writeFileSync(path.join(reel, "reel.html"), "<!doctype html><title>t</title>\n");
  const text = ["0 FILE model.ldr", ...COLUMN.flatMap((l) => [l, "0 STEP"]), ""].join("\n");
  fs.writeFileSync(path.join(reel, "data", "build.json"), JSON.stringify(bakeModel({ text, name: "model.ldr", libraryDir: lib }).build));
  const script = (name) => path.join(HERE, "..", "scripts", name);
  const v = spawnSync(process.execPath, [script("verify.mjs"), reel], { encoding: "utf8" });
  assert.equal(v.status, 1);
  assert.match(v.stderr, /LDraw build order not cleared/);
  const r = spawnSync(process.execPath, [script("render.mjs"), reel, "--stub", "2"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never checked/);
  assert.match(r.stderr, /LDraw build order not cleared/);
  const bare = spawnSync(process.execPath, [script("verify.mjs"), reel, "--skip-order-check"], { encoding: "utf8" });
  assert.match(bare.stdout + bare.stderr, /needs a reason/);
  const skip = spawnSync(process.execPath, [script("verify.mjs"), reel, "--skip-order-check", "lighting probe only"], { encoding: "utf8" });
  assert.match(skip.stdout, /ORDER CHECK SKIPPED \(lighting probe only\)/);
  assert.doesNotMatch(skip.stderr, /LDraw build order not cleared/, "past the gate (it then stops on the dummy page)");
  // after a passing check the gate opens
  const ok = spawnSync(process.execPath, [CLI, path.join(reel, "data", "build.json"), "--lib", lib, "--cameras", camFile(path.join(reel, "data"))], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const v2 = spawnSync(process.execPath, [script("verify.mjs"), reel], { encoding: "utf8" });
  assert.match(v2.stdout, /order check: data.build\.json passed/);
});

// base, a holder brick with a hole along X (hole centre at world y -12, z 10), an axle through it, a drum on the axle
const AXLE = [ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "holder.dat"), ref(10, -12, 10, "axle.dat"), ref(40, -12, 10, "drum.dat")];

test("DIRECTION: a drum dropped from above onto a horizontal axle fails; slid along the axle it passes", () => {
  const drop = run(AXLE, [uid(1), uid(2), { id: uid(3), from: "+x", travel: 90 }, { id: uid(4), from: "above", travel: 60 }]).report;
  assert.equal(drop.pass, false);
  assert.deepEqual(drop.violations.direction.map((d) => d.label), [uid(4)]);
  assert.equal(drop.violations.direction[0].need[0].kind, "axle");
  assert.deepEqual(drop.violations.direction[0].need[0].axis.map(Math.abs), [1, 0, 0]);
  const slide = run(AXLE, [uid(1), uid(2), { id: uid(3), from: "+x", travel: 90 }, { id: uid(4), from: "+x", travel: 40 }]).report;
  assert.equal(slide.pass, true, JSON.stringify(slide.violations));
  // the axle itself must go in along its own axis, not dropped across the holder
  const axleDrop = run(AXLE, [uid(1), uid(2), { id: uid(3), from: "above", travel: 60 }, { id: uid(4), from: "+x", travel: 40 }]).report;
  assert.ok(axleDrop.violations.direction.some((d) => d.label === uid(3)));
});

test("DIRECTION: a brick pressed from above passes; the same brick pushed in from the side across studs fails", () => {
  const lines = [ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat")];
  assert.equal(run(lines, [uid(1), { id: uid(2), from: "above" }]).report.violations.direction.length, 0);
  const side = run(lines, [uid(1), { id: uid(2), from: "+x", travel: 60 }]).report;
  assert.equal(side.violations.direction.length, 1);
  assert.equal(side.violations.direction[0].need[0].kind, "anti-stud");
  assert.deepEqual(side.violations.direction[0].need[0].axis, [0, -1, 0]);
});

test("DIRECTION: auto picks the joint's axis, and the planner API offers only joint directions, clear ones first", () => {
  assert.equal(run(AXLE).report.pass, true, "the file's own order with from=auto");
  const base = fromLdraw(["0 FILE model.ldr", ...AXLE, ""].join("\n"));
  const model = createModel({ libraryDir: lib, placements: base.placements });
  const b = createBuild(model);
  b.place([0]);
  b.place([1]);
  b.place([2]);
  const opts = b.arrivalOptions([3]);
  assert.ok(opts.every((o) => Math.abs(o.from[0]) > 0.99), JSON.stringify(opts.map((o) => o.from)));
  assert.equal(opts[0].clear, true);
  assert.deepEqual(b.bestArrival([3]).from, [1, 0, 0], "the open end of the axle");
  assert.equal(b.directionOf([0, -1, 0], b.jointsOf([3])).ok, false);
});
