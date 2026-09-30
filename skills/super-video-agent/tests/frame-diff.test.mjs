// Pure pixel-diff analysis (scripts/lib/frame-diff.mjs) — synthetic
// greyscale frame buffers, no ffmpeg/video decode needed for this part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedFraction, analyzeMotion } from "../scripts/lib/frame-diff.mjs";

function frame(fillValue, size = 64 * 64) {
  return Buffer.alloc(size, fillValue);
}

test("changedFraction: identical frames -> 0, fully different frames -> 1", () => {
  const a = frame(100);
  const b = frame(100);
  const c = frame(200);
  assert.equal(changedFraction(a, b), 0);
  assert.equal(changedFraction(a, c), 1);
});

test("changedFraction: small deltas below the threshold don't count as changed", () => {
  const a = frame(100);
  const b = frame(102); // delta 2, threshold is 6
  assert.equal(changedFraction(a, b), 0);
});

test("analyzeMotion: flags a >=0.8s still run as dead air", () => {
  const fps = 30;
  const frames = [];
  for (let i = 0; i < fps * 2; i++) frames.push(frame(100)); // 2s of no change at all
  const { deadAirRuns } = analyzeMotion(frames, fps);
  assert.equal(deadAirRuns.length, 1);
  assert.ok(Math.abs(deadAirRuns[0].durationSec - (frames.length - 1) / fps) < 1e-6);
});

test("analyzeMotion: no dead air when every frame changes meaningfully", () => {
  const fps = 30;
  const frames = [];
  for (let i = 0; i < fps * 2; i++) frames.push(frame(i % 2 === 0 ? 50 : 200));
  const { deadAirRuns } = analyzeMotion(frames, fps);
  assert.equal(deadAirRuns.length, 0);
});
