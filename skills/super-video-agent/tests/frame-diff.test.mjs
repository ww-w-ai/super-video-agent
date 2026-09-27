// Pure pixel-diff analysis (scripts/lib/frame-diff.mjs) — synthetic
// greyscale frame buffers, no ffmpeg/video decode needed for this part.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedFraction,
  analyzeMotion,
  estimateBoilCadence,
  evaluateBoilCadence,
} from "../scripts/lib/frame-diff.mjs";

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

test("estimateBoilCadence: recovers the reseed interval from periodic spikes", () => {
  const fps = 30;
  const period = 4; // frames between spikes -> 4/30 = 0.1333s
  const fractions = [];
  for (let i = 0; i < 120; i++) {
    fractions.push(i % period === 0 ? 0.03 : 0.0001); // spike vs near-zero
  }
  const { cadenceSec, spikeCount } = estimateBoilCadence(fractions, fps);
  assert.ok(spikeCount >= 2);
  assert.ok(Math.abs(cadenceSec - period / fps) < 1e-6);
});

test("estimateBoilCadence: fewer than 2 spikes -> null cadence, not a crash", () => {
  const result = estimateBoilCadence([0.0001, 0.0001, 0.0001], 30);
  assert.equal(result.cadenceSec, null);
});

test("evaluateBoilCadence: a preview render reports 'info' and never fails the gate, even when the boil is undetectable", () => {
  const result = evaluateBoilCadence({
    cadenceSec: null, // sub-pixel boil vanished after the preview's downscale
    spikeCount: 0,
    plannedHz: 8,
    toleranceSec: 1 / 30,
    isPreview: true,
    analyzedWidthPx: 540,
  });
  assert.equal(result.status, "info");
  assert.equal(result.pass, true);
});

test("evaluateBoilCadence: a full-resolution render with the same undetectable cadence still fails the gate", () => {
  const result = evaluateBoilCadence({
    cadenceSec: null,
    spikeCount: 0,
    plannedHz: 8,
    toleranceSec: 1 / 30,
    isPreview: false,
    analyzedWidthPx: 1080,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.pass, false);
});

test("evaluateBoilCadence: within tolerance and not a preview -> pass", () => {
  const result = evaluateBoilCadence({
    cadenceSec: 1 / 8, // exactly the planned 8Hz interval
    spikeCount: 10,
    plannedHz: 8,
    toleranceSec: 1 / 30,
    isPreview: false,
    analyzedWidthPx: 1080,
  });
  assert.equal(result.status, "pass");
  assert.equal(result.pass, true);
});
