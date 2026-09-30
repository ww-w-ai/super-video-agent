// Pure-function test for activeShotIndex (scripts/lib/shot-lookup.mjs,
// mirroring assets/template/reel.html): a promo session saw the picture
// jump back to scene 1 in the silence between lines because the scaffold
// picked its scene from currentLineIndex (the *spoken* window, -1 in a
// gap) instead of the tiled shot the gap belongs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeShotIndex } from "../scripts/lib/shot-lookup.mjs";

// Three lines' shots, tiled end-to-end per pipeline.md: shot i spans line
// i's start to line i+1's start (a gap after a line's speech but before the
// next line's start belongs to the shot before it), the last shot to the
// film's end.
const shots = [
  { id: "l0", start: 0, end: 3 },
  { id: "l1", start: 3, end: 7 },
  { id: "l2", start: 7, end: 10 },
];

test("activeShotIndex: a time inside a shot's span resolves to that shot", () => {
  assert.equal(activeShotIndex(shots, 0), 0);
  assert.equal(activeShotIndex(shots, 2.9), 0);
  assert.equal(activeShotIndex(shots, 3), 1);
  assert.equal(activeShotIndex(shots, 5), 1);
  assert.equal(activeShotIndex(shots, 9.99), 2);
});

test("activeShotIndex: a gap between one line's speech and the next line's start still resolves to the previous shot, never -1 or wrapping to 0", () => {
  // Line 0 spoke 0..1.8s but its shot (and the gap after it) runs to 3s,
  // where line 1's shot starts — the gap at t=2.5 belongs to shot 0.
  assert.equal(activeShotIndex(shots, 2.5), 0);
  // Same for the gap inside shot 1's span, before line 1's own end.
  assert.equal(activeShotIndex(shots, 6.9), 1);
});

test("activeShotIndex: at or after the film's end, holds the last shot", () => {
  assert.equal(activeShotIndex(shots, 10), 2);
  assert.equal(activeShotIndex(shots, 15), 2);
});

test("activeShotIndex: no shots yet -> -1, not a false 0", () => {
  assert.equal(activeShotIndex([], 1), -1);
});
