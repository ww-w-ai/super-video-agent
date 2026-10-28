import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boxCorners, project, framingOf, checkFraming, fitCamera } from "../scripts/lib/shot-framing.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "shot-framing.mjs");
// a statue 40 wide, 120 tall (LDraw -Y up: y from -120 to 0), seen from the front (-Z)
const STATUE = [-20, -120, -10, 20, 0, 10];
const cam = (dist, ty = -60) => ({ eye: [0, ty, -dist], target: [0, ty, 0], fov: 30, aspect: 16 / 9 });

test("project: the target is the frame centre; up in LDraw (-Y) is up in the frame", () => {
  const c = cam(300);
  const mid = project([0, -60, 0], c);
  assert.ok(Math.abs(mid.x) < 1e-9 && Math.abs(mid.y) < 1e-9);
  assert.ok(project([0, -100, 0], c).y > 0, "a higher point is higher in the frame");
  assert.ok(project([10, -60, 0], c).x > 0 !== project([-10, -60, 0], c).x > 0);
});

test("framingOf: a close camera that cuts the head fails at the top; pulled back it passes with the margin", () => {
  const close = framingOf(boxCorners(STATUE), cam(150, -40));
  assert.equal(close.ok, false);
  assert.ok(close.out.some((o) => o.side === "top"), JSON.stringify(close.out));
  const far = framingOf(boxCorners(STATUE), cam(400));
  assert.equal(far.ok, true, JSON.stringify(far));
  assert.ok(far.worst >= 0.05);
  const fit = fitCamera(boxCorners(STATUE), cam(150, -40));
  assert.ok(fit && fit.scale > 1 && framingOf(boxCorners(STATUE), fit.camera).ok);
});

test("checkFraming: lists each cropped shot; allowBottom lets only a pedestal's foot leave the frame", () => {
  const low = { eye: [0, -70, -250], target: [0, -70, 0], fov: 30, aspect: 16 / 9 }; // aims at the upper body; the foot leaves at the bottom
  const shots = [
    { t: 1, camera: cam(400), subjects: [{ name: "yi", box: STATUE }] },
    { t: 2, camera: low, subjects: [{ name: "yi", box: STATUE, allowBottom: true }] },
    { t: 3, camera: cam(150, -40), subjects: [{ name: "yi", box: STATUE, points: [[0, -118, 0]] }] },
  ];
  const r = checkFraming(shots);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.fails.map((f) => f.t), [3], JSON.stringify(r.fails));
});

test("CLI: exit 1 with the crop listed, 0 when framed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-frame-"));
  const f = path.join(dir, "shots.json");
  fs.writeFileSync(f, JSON.stringify({ shots: [{ t: 3, camera: cam(150, -40), subjects: [{ name: "yi", box: STATUE }] }] }));
  const bad = spawnSync(process.execPath, [CLI, f], { encoding: "utf8" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /CROP t 3 yi/);
  fs.writeFileSync(f, JSON.stringify([{ t: 1, camera: cam(400), subjects: [{ name: "yi", box: STATUE }] }]));
  assert.equal(spawnSync(process.execPath, [CLI, f], { encoding: "utf8" }).status, 0);
});
