// Pure unit tests for scripts/lib/duck.mjs — the gain-envelope math shared
// by render.mjs (library cues) and dub.mjs (the whole picture bed), and by
// review.mjs's isDuringNarration note on sync marks. No ffmpeg involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dbToLinear, mergeDuckWindows, isDuringNarration, buildDuckVolumeExpr } from "../scripts/lib/duck.mjs";

test("dbToLinear: 0dB is unity, -6dB is about half amplitude", () => {
  assert.equal(dbToLinear(0), 1);
  assert.ok(Math.abs(dbToLinear(-6) - 0.5012) < 0.001);
});

test("mergeDuckWindows: sorts and leaves separate windows apart", () => {
  const merged = mergeDuckWindows([{ start: 5, end: 6 }, { start: 0, end: 1 }], 0.08);
  assert.deepEqual(merged, [{ start: 0, end: 1 }, { start: 5, end: 6 }]);
});

test("mergeDuckWindows: merges windows whose ramps would overlap", () => {
  // gap between windows is 0.1s; rampSec 0.08 on each side -> ramps touch (0.16 >= 0.1).
  const merged = mergeDuckWindows([{ start: 0, end: 1 }, { start: 1.1, end: 2 }], 0.08);
  assert.deepEqual(merged, [{ start: 0, end: 2 }]);
});

test("mergeDuckWindows: keeps windows with a real gap apart", () => {
  const merged = mergeDuckWindows([{ start: 0, end: 1 }, { start: 2, end: 3 }], 0.08);
  assert.deepEqual(merged, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
});

test("mergeDuckWindows: drops malformed windows (end <= start, non-finite)", () => {
  const merged = mergeDuckWindows([{ start: 1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 0.5 }], 0.08);
  assert.deepEqual(merged, [{ start: 0, end: 0.5 }]);
});

test("isDuringNarration: true inside a window (inclusive of edges), false outside", () => {
  const windows = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  assert.equal(isDuringNarration(1.5, windows), true);
  assert.equal(isDuringNarration(1, windows), true);
  assert.equal(isDuringNarration(2, windows), true);
  assert.equal(isDuringNarration(3, windows), false);
  assert.equal(isDuringNarration(5.9, windows), true);
});

test("buildDuckVolumeExpr: duckDb 0 -> null (ducking off, byte-identical mix)", () => {
  assert.equal(buildDuckVolumeExpr([{ start: 0, end: 1 }], { duckDb: 0 }), null);
});

test("buildDuckVolumeExpr: no narration windows -> null", () => {
  assert.equal(buildDuckVolumeExpr([], { duckDb: -6 }), null);
  assert.equal(buildDuckVolumeExpr(null, { duckDb: -6 }), null);
});

test("buildDuckVolumeExpr: one window builds a volume=eval=frame filter with between() ramps to the -6dB floor", () => {
  const expr = buildDuckVolumeExpr([{ start: 1, end: 2 }], { duckDb: -6, rampSec: 0.08 });
  assert.match(expr, /^volume=eval=frame:volume='/);
  assert.match(expr, /between\(t,0\.920000,1\.000000\)/); // ramp-down window: [start-ramp, start]
  assert.match(expr, /between\(t,1\.000000,2\.000000\)/); // held-duck window: [start, end]
  assert.match(expr, /between\(t,2\.000000,2\.080000\)/); // ramp-up window: [end, end+ramp]
  const floor = dbToLinear(-6).toFixed(6);
  assert.ok(expr.includes(floor), `expected floor ${floor} in expression`);
});

test("buildDuckVolumeExpr: a window starting before the clip's own start clamps the ramp-down to 0", () => {
  const expr = buildDuckVolumeExpr([{ start: 0.02, end: 1 }], { duckDb: -6, rampSec: 0.08 });
  assert.match(expr, /between\(t,0\.000000,0\.020000\)/);
});

test("buildDuckVolumeExpr: several separate windows are combined with min()", () => {
  const expr = buildDuckVolumeExpr(
    [{ start: 0, end: 0.5 }, { start: 3, end: 3.5 }],
    { duckDb: -6, rampSec: 0.08 }
  );
  assert.match(expr, /^volume=eval=frame:volume='min\(/);
});

test("buildDuckVolumeExpr: ffmpeg evaluates an expression with many windows (min() takes two args)", () => {
  const windows = [0, 1, 2, 3, 4].map((s) => ({ start: s + 0.2, end: s + 0.6 }));
  const filter = buildDuckVolumeExpr(windows, { duckDb: -6, rampSec: 0.08 });
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=5", "-af", filter, "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("mergeDuckWindows: a breath shorter than HOLD_GAP_SEC between lines stays ducked", () => {
  const merged = mergeDuckWindows([{ start: 0, end: 2 }, { start: 2.6, end: 4 }, { start: 5.5, end: 6 }], 0.08);
  assert.deepEqual(merged, [{ start: 0, end: 4 }, { start: 5.5, end: 6 }]);
});
