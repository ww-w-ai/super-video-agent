// Photo-plate camera match: the solver recovers a synthetic plate's horizon, fov, roll and camera height,
// and the grid writer draws the matched plane over the image.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import skia from "skia-canvas";
import {
  lineThrough, vanishingPoint, fovFromVanishingPoints, heightFromObject, autoVanishing, toGray, drawGrid, writeImage,
} from "../scripts/plate-match.mjs";

const { Canvas, loadImage } = skia;
const RP = globalThis.ReelPlate;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "plate-"));
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

const W = 960, H = 540;
const TRUTH = { fov: 30, horizon: 0.3, roll: 0, h: 2, spot: [0.5, 0.75] };

/** A synthetic plate: a wall, a light table with dark plank seams receding from the camera. */
function syntheticPlate(P = TRUTH, { yaw = 0 } = {}) {
  const cam = RP.matchCamera(P, W, H);
  const cv = new Canvas(W, H), g = cv.getContext("2d");
  g.fillStyle = "#6b7280"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#d8c3a0"; g.fillRect(0, P.horizon * H, W, H);
  g.strokeStyle = "#3b2a1a"; g.lineWidth = 3;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let i = -14; i <= 14; i++) {
    const a = RP.project(cam, [i * 0.8 * c - 400 * s, 0, -i * 0.8 * s - 400 * c], W, H);
    const b = RP.project(cam, [i * 0.8 * c - -1 * s, 0, -i * 0.8 * s - -1 * c], W, H);
    if (!a.ok || !b.ok) continue;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  return { cv, cam };
}

test("matched camera: the spot is the origin and far points sit on the horizon row", () => {
  const cam = RP.matchCamera(TRUTH, W, H);
  const o = RP.project(cam, [0, 0, 0], W, H);
  near(o.x, 0.5 * W, 1e-6);
  near(o.y, 0.75 * H, 1e-6);
  const far = RP.project(cam, [cam.pos[0] + 300, 0, cam.pos[2] - 1e7], W, H);
  near(far.y, TRUTH.horizon * H, 0.01);
  near(cam.pos[1], TRUTH.h, 1e-9);
  assert.throws(() => RP.matchCamera({ ...TRUTH, spot: [0.5, 0.2] }, W, H), /above the horizon/);
});

test("auto vanishing point recovers the horizon of a synthetic plate within 0.005 of the height", () => {
  const { cv } = syntheticPlate();
  const g = cv.getContext("2d");
  const res = autoVanishing(toGray(g.getImageData(0, 0, W, H).data, W, H), W, H, { rows: [0.4, 0.98] });
  assert.ok(res.vp, "no vanishing point found");
  assert.ok(res.inliers.length >= 6, `only ${res.inliers.length} inlier lines`);
  near(res.horizon, TRUTH.horizon, 0.005);
});

test("least-squares vanishing point: two lines meet, parallel lines give null", () => {
  const v = vanishingPoint([lineThrough([0, 100], [100, 0]), lineThrough([200, 100], [100, 0])]);
  near(v[0], 100, 1e-9);
  near(v[1], 0, 1e-9);
  assert.equal(vanishingPoint([lineThrough([0, 0], [10, 10]), lineThrough([5, 0], [15, 10])]), null);
});

/** Image vanishing point of world direction d on the table, from two projected lines rounded to pixels. */
function vpOf(cam, d) {
  const lines = [-3, 3].map((x0) => {
    const off = [d[2] * x0, 0, -d[0] * x0];
    const a = RP.project(cam, [off[0] - 2 * d[0], 0, off[2] - 2 * d[2]], W, H);
    const b = RP.project(cam, [off[0] + 6 * d[0], 0, off[2] + 6 * d[2]], W, H);
    return lineThrough([Math.round(a.x), Math.round(a.y)], [Math.round(b.x), Math.round(b.y)]);
  });
  return vanishingPoint(lines);
}

test("fov and roll from two table directions at right angles", () => {
  for (const P of [{ ...TRUTH, fov: 35 }, { ...TRUTH, fov: 50, roll: 3 }]) {
    const cam = RP.matchCamera(P, W, H);
    const yaw = 0.6;
    const v1 = vpOf(cam, [-Math.sin(yaw), 0, -Math.cos(yaw)]);
    const v2 = vpOf(cam, [Math.cos(yaw), 0, -Math.sin(yaw)]);
    const r = fovFromVanishingPoints(v1, v2, W, H);
    near(r.fov, P.fov, 0.6);
    near(r.roll, P.roll || 0, 0.3);
  }
});

test("camera height from an object of known size in the plate", () => {
  const P = { ...TRUTH, h: 2.3, spot: [0.62, 0.8] };
  const cam = RP.matchCamera(P, W, H);
  const foot = RP.project(cam, [0, 0, 0], W, H), top = RP.project(cam, [0, 1.4, 0], W, H);
  const h = heightFromObject({ ...P, h: 1 }, W, H, [foot.x, foot.y], [top.x, top.y], 1.4);
  near(h, 2.3, 1e-3);
});

test("grid writer draws the matched plane and a yellow horizon over the plate", async () => {
  const dir = tmp();
  const { cv } = syntheticPlate();
  const platePng = path.join(dir, "plate.png");
  fs.writeFileSync(platePng, await cv.toBuffer("png"));
  const img = await loadImage(platePng);
  const out = await writeImage(drawGrid(img, TRUTH, { label: "synthetic" }), path.join(dir, "match", "grid.png"));
  const got = await loadImage(out);
  assert.equal(got.width, W);
  assert.equal(got.height, H);
  const c2 = new Canvas(W, H), g = c2.getContext("2d");
  g.drawImage(got, 0, 0);
  const row = Math.round(TRUTH.horizon * H);
  const px = [-1, 0, 1].map((d) => Array.from(g.getImageData(Math.round(W * 0.15), row + d, 1, 1).data));
  assert.ok(px.some(([r, gg, b]) => r > 200 && gg > 170 && b < 110), `no yellow horizon at row ${row}: ${JSON.stringify(px)}`);
  const before = cv.getContext("2d").getImageData(0, 0, W, H).data, after = g.getImageData(0, 0, W, H).data;
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) > 30) changed++;
  assert.ok(changed > W * 10, `the grid changed only ${changed} pixels`);
});

test("plate-match.mjs --help prints usage and exits 0; bad input exits 1", () => {
  const script = path.join(here, "..", "scripts", "plate-match.mjs");
  const ok = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /usage: plate-match\.mjs/);
  const bad = spawnSync(process.execPath, [script, "fov", "100x"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /W>x<H/);
});
