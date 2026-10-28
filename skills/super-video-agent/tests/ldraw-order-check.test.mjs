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
  // EV-30 articulated parts. Pivot primitives carry no geometry here; the gate reads where they are placed.
  put("p/4-4cylo.dat", "0 Cylinder Open 1.0\n");
  put("p/joint8ball.dat", "0 Joint-8 Ball\n");
  put("p/joint8socket1.dat", "0 Joint-8 Socket\n");
  const multi = (title, boxes, extra = []) => [`0 ${title}`, ...boxes.map((b, k) => boxDat(`~${title} ${k}`, b).split("\n").slice(1, 7).join("\n")), ...extra, ""].join("\n");
  const pin = (x) => `1 16 ${x} -4 14 0 4 0 4 0 0 0 0 4 4-4cylo.dat`; // a knuckle circle on the pin line y -4, z 14, along X
  // hinge halves (co-origin at rest, like 73983 = 2429 + 2430): the pin runs along X at y -4, z 14
  put("parts/hbase.dat", multi("Hinge Plate  1 x  2 Base", [[-20, 20, 0, 8, -10, 18], [-20, -12, -8, 0, 10, 18], [12, 20, -8, 0, 10, 18]], [`1 16 -10 0 0 ${I} stud.dat`, `1 16 10 0 0 ${I} stud.dat`, pin(-16), pin(-12), pin(12), pin(16)]));
  put("parts/htop.dat", multi("Hinge Plate  1 x  2 Top", [[-20, 20, -16, -8, -10, 10], [-12, 12, -16, 0, 10, 18]], [`1 16 -10 -16 0 ${I} stud.dat`, `1 16 10 -16 0 ${I} stud.dat`, pin(-12), pin(12)]));
  // ball joint: the ball's centre at (0, 4, -20) of the ball plate; the socket's centre at (0, 4, 0) of the limb
  put("parts/ballp.dat", multi("Plate  1 x  2 with Ball Joint-8 on Side", [[-20, 20, 0, 8, -10, 10], [-2, 2, 2, 6, -16, -10], [-4, 4, 0, 8, -24, -16]], [`1 16 -10 0 0 ${I} stud.dat`, `1 16 10 0 0 ${I} stud.dat`, `1 16 0 4 -20 ${I} joint8ball.dat`]));
  put("parts/sockp.dat", multi("Plate  1 x  2 with Socket Joint-8", [[-6, 6, -2, 10, -6, 6], [-10, 10, 0, 8, -30, -6]], [`1 16 0 4 0 ${I} joint8socket1.dat`]));
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

// ---------------------------------------------------------------- EV-30: hinges, ball joints, turned parts

/** 3x4 row-major matrices: compose, translate, turn by deg about X (y' = y cos + z sin) through a point. */
const M = {
  mul: (A, B) => {
    const r = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
      r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
    }
    return r;
  },
  t: (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z],
  rx: (deg, [cy, cz] = [0, 0]) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, cy - c * cy - s * cz, 0, -s, c, cz + s * cy - c * cz];
  },
  ry: (deg) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
  },
};
const line = (m, file) => `1 4 ${[m[3], m[7], m[11], m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]].map((v) => Math.round(v * 1e6) / 1e6).join(" ")} ${file}`;
const HB = M.t(0, -8, -10); // the hinge base on the base plate's studs at z -10
const PIN = [-4, 14]; // the pin line (y, z) in the hinge's own frame

/** base plate, hinge base, hinge top swung deg about its pin, two 1x1 plates on the swung top's studs. */
function hinged(deg, top = M.mul(HB, M.rx(deg, PIN))) {
  return [ref(0, 0, 0, "base.dat"), line(HB, "hbase.dat"), line(top, "htop.dat"), line(M.mul(top, M.t(-10, -24, 0)), "p1.dat"), line(M.mul(top, M.t(10, -24, 0)), "p1.dat")];
}

test("HINGE: a hinge pair at 0/20/45/90 deg with plates built on the swung half passes; the joint is found on the pin", () => {
  for (const deg of [0, 20, 45, 90]) {
    const { report } = run(hinged(deg));
    assert.equal(report.pass, true, `${deg} deg: ${JSON.stringify(report.violations)}`);
  }
  const base = fromLdraw(["0 FILE model.ldr", ...hinged(45), ""].join("\n"));
  const model = createModel({ libraryDir: lib, placements: base.placements });
  const b = createBuild(model);
  b.place([0]);
  b.place([1]);
  const j = b.jointsOf([2]).find((x) => x.kind === "hinge");
  assert.ok(j, "hinge joint");
  assert.deepEqual(j.pin.map((v) => Math.round(v * 1000) / 1000), [1, 0, 0]);
  assert.equal(b.supportOf([2]).how, "hinge joint");
  b.place([2]);
  // the plate on the swung half seats on the turned stud, and arrives along that stud's own axis
  const best = b.bestArrival([3]);
  const a = (45 * Math.PI) / 180;
  assert.ok(Math.abs(best.from[1] + Math.cos(a)) < 0.01 && Math.abs(best.from[2] - Math.sin(a)) < 0.01, JSON.stringify(best.from));
});

test("HINGE: a plate floating at an angle next to a hinge fails; a hinge top turned about the wrong point fails", () => {
  const lines = hinged(20).slice(0, 3);
  const top = M.mul(HB, M.rx(20, PIN));
  const floating = run([...lines, line(M.mul(top, M.t(-10, -27, 0)), "p1.dat")]).report;
  assert.deepEqual(floating.violations.support.map((s) => s.label), [uid(4)]);
  // swung 20 deg about a line 6 LDU off the pin: the halves still overlap, but no knuckle circles line up
  const wrong = run(hinged(20, M.mul(HB, M.rx(20, [PIN[0], PIN[1] - 6]))).slice(0, 3)).report;
  assert.deepEqual(wrong.violations.support.map((s) => s.label), [uid(3)], JSON.stringify(wrong.violations));
});

test("HINGE: place then swing is checked as one step (arrival at rest, then the turn); a swing through the base fails", () => {
  const lines = hinged(90);
  const order = (swingFrom) => [uid(1), uid(2), { id: uid(3), arrive: "swing", ...(swingFrom != null ? { swingFrom } : {}) }, uid(4), uid(5)];
  const good = run(lines, order()).report;
  assert.equal(good.pass, true, JSON.stringify(good.violations));
  assert.equal(good.swings.length, 1);
  assert.equal(good.swings[0].swingFrom, 90, "back to the rest pose (right-hand about +X; M.rx turns the other way)");
  assert.equal(good.unchecked.length, 0, "a swing on a pin is checked, not listed as unchecked");
  // the long way round (-270 to the same rest pose) drives the flap down through the base plate
  const bad = run(lines, order(-270)).report;
  assert.equal(bad.pass, false);
  assert.ok(bad.violations.crossing.some((c) => c.from === "swing" && c.hits.some((h) => h.with === uid(1))), JSON.stringify(bad.violations.crossing));
});

test("BALL: a limb turned freely about its ball passes; a socket off the ball fails", () => {
  const BP = M.t(0, -8, -30); // ball plate on the base plate's studs at z -30: its ball centre at (0, -4, -50), past the base edge
  const c = [0, -4, -50];
  const limb = (R, off = [0, 0, 0]) => M.mul(M.t(c[0] + off[0], c[1] + off[1], c[2] + off[2]), M.mul(R, M.t(0, -4, 0)));
  const R = M.mul(M.ry(35), M.rx(25));
  const good = run([ref(0, 0, 0, "base.dat"), line(BP, "ballp.dat"), line(limb(R), "sockp.dat")]).report;
  assert.equal(good.pass, true, JSON.stringify(good.violations));
  const off = run([ref(0, 0, 0, "base.dat"), line(BP, "ballp.dat"), line(limb(R, [3, 0, 0]), "sockp.dat")]).report;
  assert.deepEqual(off.violations.support.map((s) => s.label), [uid(3)], JSON.stringify(off.violations));
});

test("TURNED PARTS: stud joints are judged in the parts' own frames, so a stack turned as a whole holds together", () => {
  const T = M.mul(M.ry(30), M.rx(30));
  const { report } = run([line(T, "p1.dat"), line(M.mul(T, M.t(0, -8, 0)), "p1.dat"), line(M.mul(T, M.t(0, -16, 0)), "p1.dat")]);
  assert.equal(report.pass, true, JSON.stringify(report.violations));
});

// ---------------------------------------------------------------- EV-40 STABILITY, EV-41 FIGURE, EV-42 PRECISION
fs.writeFileSync(path.join(lib, "parts", "p14.dat"), boxDat("Plate  1 x  4", [-40, 40, 0, 8, -10, 10], [-30, -10, 10, 30].map((x) => `1 16 ${x} 0 0 ${I} stud.dat`)));
fs.writeFileSync(path.join(lib, "parts", "mtorso.dat"), boxDat("Minifig Torso", [-10, 10, -32, 0, -6, 6]));
fs.writeFileSync(path.join(lib, "parts", "mhand.dat"), boxDat("Minifig Hand", [-3, 3, -14, -8, -12, -6]));
fs.writeFileSync(path.join(lib, "parts", "mhair.dat"), boxDat("Minifig Hair Short", [-8, 8, -60, -44, -8, 8]));

const othersPass = (r) => !["support", "crossing", "order", "direction", "unplaced"].some((k) => r.violations[k].length);
test("STABILITY: a plate held by one stud at its end is listed (a FAIL with strict) when the order can fix it, and is listed as a cantilever when nothing can", () => {
  const left = ref(-30, -24, 30, "b1.dat"), right = ref(30, -24, 30, "b1.dat");
  // the 1x4 plate spans x -40..40 at z 30, resting on both 1x1 bricks once they stand
  const plate = ref(0, -32, 30, "p14.dat");
  const late = run([ref(0, 0, 0, "base.dat"), right, plate, left]).report; // plate lands on one brick, the other comes after
  assert.equal(late.violations.stability.length, 1, JSON.stringify(late.violations.stability));
  assert.equal(late.violations.stability[0].label, uid(3));
  assert.equal(late.pass, othersPass(late), "advisory by default: STABILITY alone never fails");
  assert.equal(run([ref(0, 0, 0, "base.dat"), right, plate, left], null, { strict: true }).report.pass, false, "--strict fails it");
  const good = run([ref(0, 0, 0, "base.dat"), right, left, plate]).report;
  assert.equal(good.violations.stability.length, 0, JSON.stringify(good.violations.stability));
  assert.equal(good.pass, true, JSON.stringify(good.violations));
  // the same plate on one brick only, sticking out past it: an overhang by design, listed, not failed
  const over = run([ref(0, 0, 0, "base.dat"), right, ref(60, -32, 30, "p14.dat")]).report;
  assert.equal(over.violations.stability.length, 0);
  assert.equal(over.cantilevers.length, 1, JSON.stringify(over.cantilevers));
  assert.equal(over.counts.cantilevers, 1);
  // a 1x1 brick on one stud is centred over it: stable
  assert.equal(run([ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat")]).report.counts.stability, 0);
});

test("FIGURE: a hand or hair landing apart from its torso or head fails; a whole upper body passes; figureUnits folds the runs", async () => {
  const lines = [ref(0, 0, 0, "base.dat"), ref(10, 0, 10, "mtorso.dat"), ref(10, 0, 10, "mhand.dat"), ref(10, 0, 10, "mhair.dat")];
  const apart = run(lines, [uid(1), uid(3), uid(2), uid(4)]).report;
  assert.deepEqual(apart.violations.figure.map((f) => [f.label, f.missing]), [[uid(3), "torso"], [uid(4), "head"]]);
  const whole = run(lines, [uid(1), { ids: [uid(2), uid(3)] }, uid(4)]).report;
  assert.deepEqual(whole.violations.figure.map((f) => f.label), [uid(4)], "the hair still has no head");
  const ignored = run(lines, [uid(1), uid(3), uid(2), uid(4)], { ignore: /Minifig/ }).report;
  assert.equal(ignored.counts.figure, 2, "an --ignore landing is still a figure landing");
  assert.equal(apart.pass, othersPass(apart), "advisory by default: FIGURE alone never fails");
  assert.equal(run(lines, [uid(1), uid(3), uid(2), uid(4)], { strict: true }).report.pass, false, "--strict fails it");
  const { figureUnits, figureClassOf } = await import("../scripts/lib/ldraw-order-check.mjs");
  assert.equal(figureClassOf("Minifig Hips and Legs"), "legs");
  assert.equal(figureClassOf("~Minifig Arm Left"), "arm");
  assert.equal(figureClassOf("Minifig Camera with Side Sight"), null, "a held item is not a body part");
  const titles = ["Brick  2 x  4", "Minifig Hips", "Minifig Leg Left", "Minifig Leg Right", "Minifig Torso", "Minifig Arm Left", "Minifig Arm Right", "Minifig Hand", "Minifig Hand", "Bar  4L", "Minifig Head", "Minifig Hair Short", "Minifig Hips", "Minifig Leg Left"];
  const units = figureUnits(titles, { held: (k) => k === 9 });
  assert.deepEqual(units.map((u) => [u.k0, u.k1, u.name]), [[1, 4, "minifig 1 lower body"], [4, 10, "minifig 1 upper body"], [10, 12, "minifig 1 head"], [12, 14, "minifig 2 lower body"]]);
});

test("PRECISION: a rotation written with 3 decimals is listed; with 6 it is not", () => {
  const r3 = "0.707 0 0.707 0 1 0 -0.707 0 0.707", r6 = "0.707107 0 0.707107 0 1 0 -0.707107 0 0.707107";
  const a = run([ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat", r3)]).report;
  assert.equal(a.counts.imprecise, 1);
  assert.equal(a.precision.first[0].uid, uid(2));
  const b = run([ref(0, 0, 0, "base.dat"), ref(10, -24, 10, "b1.dat", r6)]).report;
  assert.equal(b.counts.imprecise, 0);
});
