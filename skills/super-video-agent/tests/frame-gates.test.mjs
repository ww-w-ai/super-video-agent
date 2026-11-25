import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { plannedMask, plateStill, roadFlicker } from "../scripts/lib/frame-gates.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "frame-gates.mjs");
const cam = (az = 0, el = 0.5) => [0, 0, 0, az, el, 0];
// 60 frames, still camera, plate fixed at (540, 960)
const still = () => Array.from({ length: 60 }, (_, i) => ({ i, px: 540, py: 960, vis: true, cam: cam() }));

test("plateStill (EV-74): a plate that stays put passes", () => {
  const r = plateStill(still(), 30);
  assert.equal(r.pass, true);
  assert.equal(r.max.stillPx, 0);
});

test("plateStill (EV-74): a plate that re-centres 10 px in a still camera fails; 1 px passes", () => {
  const f = still();
  for (let i = 30; i < 60; i++) f[i].py += 10;
  const r = plateStill(f, 30);
  assert.equal(r.pass, false);
  assert.equal(r.first[0].kind, "still");
  const g = still();
  for (let i = 30; i < 60; i++) g[i].py += 1;
  assert.ok(plateStill(g, 30).pass);
});

test("plateStill: a planned turn may move the plate up to 45 px/frame, but a 300 deg/s turn fails", () => {
  const f = still();
  for (let i = 20; i < 30; i++) { f[i].cam = cam((i - 19) * 0.1); f[i].px += (i - 19) * 20; }
  for (let i = 30; i < 60; i++) { f[i].cam = cam(1.0); f[i].px += 200; }
  const r = plateStill(f, 30);
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.ok(r.frames.planned > 0);
  assert.equal(plannedMask(f)[25], true);
  const fast = still();
  for (let i = 20; i < 22; i++) fast[i].cam = cam((i - 19) * 10);
  for (let i = 22; i < 60; i++) fast[i].cam = cam(20);
  const r2 = plateStill(fast, 30);
  assert.equal(r2.pass, false);
  assert.ok(r2.first.some((b) => b.kind === "turn-speed"));
});

test("plateStill: a turn over 90 deg/s but under 270 passes with a warning value", () => {
  const f = still();
  for (let i = 20; i < 30; i++) f[i].cam = cam((i - 19) * 0.1);
  for (let i = 30; i < 60; i++) f[i].cam = cam(1.0);
  const r = plateStill(f, 30); // 0.1 per frame * 30 fps = 3 deg/s
  assert.equal(r.warnTurn, null);
  const r2 = plateStill(f, 1500); // 150 deg/s: over the 90 target, under the 270 limit
  assert.equal(r2.pass, true);
  assert.ok(r2.warnTurn > 90);
});

test("roadFlicker (EV-73): a constant ground colour passes; one frame off by 13/255 fails D1 and D2", () => {
  const frames = still();
  const flat = frames.map(() => [252, 253, 235]);
  const ok = roadFlicker(flat, frames);
  assert.equal(ok.pass, true);
  assert.equal(ok.D1.max, 0);
  const bad = flat.map((m) => m.slice());
  bad[30] = [252 - 13, 253, 235];
  const r = roadFlicker(bad, frames);
  assert.equal(r.pass, false);
  assert.ok(r.first.some((v) => v.kind === "D1") && r.first.some((v) => v.kind === "D2"));
});

test("roadFlicker: a slow drift of 0.1/255 per frame passes; no measured frames does not pass", () => {
  const frames = still();
  const drift = frames.map((_, i) => [252 + i * 0.1, 253, 235]);
  assert.equal(roadFlicker(drift, frames).pass, true);
  assert.equal(roadFlicker(frames.map(() => null), frames).pass, false);
});

test("frame-gates CLI: plate FAIL exits 1, PASS exits 0, missing file exits 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-"));
  const f = still();
  const good = path.join(dir, "good.json"), badp = path.join(dir, "bad.json");
  fs.writeFileSync(good, JSON.stringify({ fps: 30, frames: f }));
  const b = still(); for (let i = 30; i < 60; i++) b[i].py += 20;
  fs.writeFileSync(badp, JSON.stringify({ fps: 30, frames: b }));
  assert.equal(spawnSync(process.execPath, [CLI, "plate", good]).status, 0);
  const r = spawnSync(process.execPath, [CLI, "plate", badp], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL/);
  assert.equal(spawnSync(process.execPath, [CLI, "plate", path.join(dir, "none.json")]).status, 2);
});
