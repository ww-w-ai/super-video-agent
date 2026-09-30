// Pure-function test for scripts/engine/reel-engine.js's transformedBBox:
// checkSafe's safe-area test must use the text box after the canvas
// transform (ctx.getTransform()) is applied, not the raw pre-transform box —
// otherwise a rotated or scaled label can sit outside the safe area with no
// issue recorded (a film session hit this with a tilted sticker label).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

test("transformedBBox: identity matrix returns the box unchanged", () => {
  const box = Reel.transformedBBox(IDENTITY, 10, 20, 110, 60);
  assert.deepEqual(box, { left: 10, top: 20, right: 110, bottom: 60 });
});

test("transformedBBox: pure translation shifts the box", () => {
  const m = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 };
  const box = Reel.transformedBBox(m, 0, 0, 20, 10);
  assert.deepEqual(box, { left: 100, top: 50, right: 120, bottom: 60 });
});

test("transformedBBox: 90-degree rotation swaps the box's extents", () => {
  // ctx.rotate(Math.PI/2): a=cos, b=sin, c=-sin, d=cos
  const angle = Math.PI / 2;
  const m = { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 500, f: 900 };
  // A wide, short label centred at the rotation origin becomes tall and
  // narrow once rotated 90 degrees.
  const box = Reel.transformedBBox(m, -50, -5, 50, 5);
  assert.ok(Math.abs(box.left - 495) < 1e-9, `left: ${box.left}`);
  assert.ok(Math.abs(box.right - 505) < 1e-9, `right: ${box.right}`);
  assert.ok(Math.abs(box.top - 850) < 1e-9, `top: ${box.top}`);
  assert.ok(Math.abs(box.bottom - 950) < 1e-9, `bottom: ${box.bottom}`);
});

test("transformedBBox: a scaled label whose local box reads as safely inside is caught once actually transformed", () => {
  // 1080x1920 "shorts" safe area: x 80-888, y 200-1470.
  const s = Reel.safeArea(1080, 1920);
  // Local (pre-transform) box: comfortably inside the safe area's numeric
  // range on its own — this is exactly the bug this fix targets, comparing
  // this local box directly against the safe area (no transform applied)
  // reports "inside" even though it is not what gets drawn.
  const localBox = { left: 400, top: 400, right: 500, bottom: 440 };
  assert.ok(
    localBox.left >= s.x && localBox.top >= s.y && localBox.right <= s.x + s.w && localBox.bottom <= s.y + s.h,
    "test setup: the local box should read as inside the safe area before any transform is applied"
  );

  // A scene scaled 3x around the canvas origin (e.g. ctx.scale(3,3) for a
  // big stamp): the drawn position is 3x the local coordinates, well
  // outside the safe area — the old, untransformed comparison never saw
  // that.
  const m = { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 };
  const box = Reel.transformedBBox(m, localBox.left, localBox.top, localBox.right, localBox.bottom);
  const outside = box.left < s.x || box.top < s.y || box.right > s.x + s.w || box.bottom > s.y + s.h;
  assert.ok(outside, `expected the transformed box to poke outside the safe area, got ${JSON.stringify(box)}`);
});

test("transformedBBox: rotation alone can push a locally-centered box outside the safe area", () => {
  const s = Reel.safeArea(1080, 1920);
  const angle = Math.PI / 4; // 45 degrees
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Translated well inside the safe area, then rotated: a wide local box
  // that reads as inside if only translated pokes past the edge once
  // rotated.
  const m = { a: cos, b: sin, c: -sin, d: cos, e: 820, f: 900 };
  const localBox = { left: -60, top: -60, right: 60, bottom: 60 };

  const translateOnly = { a: 1, b: 0, c: 0, d: 1, e: m.e, f: m.f };
  const untransformedBox = Reel.transformedBBox(translateOnly, localBox.left, localBox.top, localBox.right, localBox.bottom);
  assert.ok(
    untransformedBox.left >= s.x && untransformedBox.right <= s.x + s.w,
    "test setup: translated-only (no rotation) should read as inside on the x axis"
  );

  const box = Reel.transformedBBox(m, localBox.left, localBox.top, localBox.right, localBox.bottom);
  assert.ok(box.right > s.x + s.w, `expected the rotated box to exceed the right edge, got ${JSON.stringify(box)}`);
});
