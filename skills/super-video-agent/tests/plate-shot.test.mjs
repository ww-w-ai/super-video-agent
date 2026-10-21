// Photo-plate shot helper: edge coverage flags a frame that sees past the photo, the fitted zoom fixes
// it, and the inverse tone curve gives the photo's pixels back through the Neutral tone mapper.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "..", "scripts", "engine", "reel-plate.js")).href);
const RP = globalThis.ReelPlate;
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

const W = 1672, H = 941;
const P = { fov: 22.9, horizon: 0.25, roll: 0, h: 1.75, spot: [0.5, 0.72] };
const base = RP.matchCamera(P, W, H);
const proxy = { wallZ: -8 };

test("the plate's own frame is covered; a 9:16 crop of a 16:9 plate is covered too", () => {
  assert.equal(RP.coverage(base, RP.shotCamera(base, {}), proxy), 0);
  assert.equal(RP.coverage(base, RP.shotCamera(base, { aspect: 9 / 16 }), proxy), 0);
});

test("zoom and pan/tilt turn about the lens point: the lens never moves", () => {
  const s = RP.shotCamera(base, { zoom: 1.3, pan: 4, tilt: -2 });
  s.pos.forEach((v, i) => near(v, base.pos[i], 1e-12));
  const o = RP.project(base, [0, 0, 0], W, H);
  near(o.x, 0.5 * W, 1e-6);
});

test("edge coverage flags a pan past the photo and records a plate-edge issue", () => {
  const issues = [];
  globalThis.Reel = { recordIssue: (i) => issues.push(i) };
  try {
    const shot = RP.shotCamera(base, { pan: 8 });
    const over = RP.check(base, shot, { ...proxy, shotId: "s1", t: 1.234 });
    assert.ok(over > 0.05, `pan 8 deg covered (${over})`);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].type, "plate-edge");
    assert.equal(issues[0].shot, "s1");
    assert.equal(issues[0].t, 1.23);
    RP.check(base, RP.shotCamera(base, {}), { ...proxy, shotId: "s1", t: 0 });
    assert.equal(issues.length, 1, "a covered frame recorded an issue");
  } finally {
    delete globalThis.Reel;
  }
});

test("fitZoom finds the smallest zoom that covers a pan, a tilt and a lens dolly", () => {
  for (const opts of [{ pan: 5 }, { tilt: 4 }, { dolly: [0.2, 0, 0] }, { dolly: [0, 0.1, 0.3] }]) {
    assert.ok(RP.coverage(base, RP.shotCamera(base, opts), proxy) > 0.001, `${JSON.stringify(opts)} was covered at zoom 1`);
    const z = RP.fitZoom(base, opts, proxy);
    assert.ok(z > 1 && z < 1.6, `zoom ${z}`);
    assert.ok(RP.coverage(base, RP.shotCamera(base, { ...opts, zoom: z }), proxy) <= 0.001);
    assert.ok(RP.coverage(base, RP.shotCamera(base, { ...opts, zoom: z * 0.97 }), proxy) > 0.001, "not the smallest zoom");
  }
  assert.equal(RP.fitZoom(base, { pan: 40 }, proxy), null, "a 40 deg pan cannot be covered by zoom");
});

test("a lens tilted up past the wall top looks behind the set", () => {
  assert.equal(RP.coverage(base, RP.shotCamera(base, { tilt: 89 }), proxy), Infinity);
});

test("invNeutral undoes Neutral tone mapping: exact below the shoulder, close above it", () => {
  for (const c of [[0.02, 0.03, 0.05], [0.2, 0.3, 0.1], [0.5, 0.6, 0.7], [0.75, 0.7, 0.6]]) {
    const back = RP.neutral(RP.invNeutral(c));
    c.forEach((v, i) => near(back[i], v, 1e-6));
  }
  for (const c of [[0.85, 0.82, 0.8], [0.95, 0.9, 0.88]]) {
    const back = RP.neutral(RP.invNeutral(c));
    c.forEach((v, i) => near(back[i], v, 0.02));
  }
});

test("keyDir: az 0 points back at the lens, az 90 to the right, el 90 straight up", () => {
  const k0 = RP.keyDir(0, 0), k90 = RP.keyDir(90, 0), up = RP.keyDir(30, 90);
  near(k0[2], 1, 1e-12);
  near(k90[0], 1, 1e-12);
  near(up[1], 1, 1e-12);
});
