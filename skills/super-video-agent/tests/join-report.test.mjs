// Pure report math (scripts/lib/join-report.mjs) — synthetic sample/frame
// buffers, no ffmpeg or video decode needed for this part.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loudnessSpread,
  maxStepInRange,
  joinWindowIndices,
  typicalMaxStep,
  analyzeJoinClick,
  meanAbsDiff,
  formatReport,
} from "../scripts/lib/join-report.mjs";

test("loudnessSpread: flat parts at the same loudness -> spread 0, no warning", () => {
  const s = loudnessSpread([-16, -16, -16]);
  assert.equal(s.spreadLu, 0);
  assert.equal(s.warn, false);
});

test("loudnessSpread: over 1 LU apart warns", () => {
  const s = loudnessSpread([-16, -14.5]);
  assert.ok(Math.abs(s.spreadLu - 1.5) < 1e-9);
  assert.equal(s.warn, true);
});

test("loudnessSpread: ignores non-finite (unmeasurable) parts", () => {
  const s = loudnessSpread([-16, null, -16.4]);
  assert.ok(Math.abs(s.spreadLu - 0.4) < 1e-9);
});

test("loudnessSpread: no measurable parts -> nulls, no warning", () => {
  const s = loudnessSpread([null, undefined, NaN]);
  assert.equal(s.min, null);
  assert.equal(s.warn, false);
});

test("maxStepInRange: finds the largest consecutive-sample delta in the range", () => {
  const samples = new Float32Array([0, 0.1, 0.1, 0.9, 0.9, 0.9]);
  assert.ok(Math.abs(maxStepInRange(samples, 0, samples.length) - 0.8) < 1e-6);
  assert.ok(Math.abs(maxStepInRange(samples, 0, 3) - 0.1) < 1e-6); // jump at idx 3 excluded
});

test("joinWindowIndices: +/-windowMs around the join time, clamped at 0", () => {
  const { start, end } = joinWindowIndices(48000, 0.005, 20);
  assert.equal(start, 0); // 0.005s - 0.02s would be negative
  assert.equal(end, Math.round(0.025 * 48000));
});

test("typicalMaxStep: excludes the margin near the part's own edges", () => {
  // A single spike right at the edge should not count once the margin
  // covers it; the interior of the part is flat.
  const samples = new Float32Array(200).fill(0);
  samples[5] = 1; // near the start edge
  const margin = 10;
  assert.equal(typicalMaxStep(samples, 0, 200, margin), 0);
  assert.ok(typicalMaxStep(samples, 0, 200, 2) > 0); // margin too small to exclude it
});

test("typicalMaxStep: falls back to the whole range when the part is too short for the margin", () => {
  const samples = new Float32Array([0, 1, 0]);
  assert.ok(typicalMaxStep(samples, 0, 3, 100) > 0);
});

test("analyzeJoinClick: flags a jump well above the parts' own typical maximum", () => {
  const r = analyzeJoinClick({ joinTimeSec: 8, windowMaxStep: 0.5, partTypicalMaxStep: 0.1 });
  assert.equal(r.flagged, true);
  assert.ok(Math.abs(r.ratio - 5) < 1e-9);
});

test("analyzeJoinClick: a jump in line with the typical maximum is not flagged", () => {
  const r = analyzeJoinClick({ joinTimeSec: 8, windowMaxStep: 0.11, partTypicalMaxStep: 0.1 });
  assert.equal(r.flagged, false);
});

test("analyzeJoinClick: zero typical maximum with a real jump is flagged, not divide-by-zero NaN", () => {
  const r = analyzeJoinClick({ joinTimeSec: 8, windowMaxStep: 0.2, partTypicalMaxStep: 0 });
  assert.equal(r.flagged, true);
  assert.equal(r.ratio, Infinity);
});

test("meanAbsDiff: identical frames -> 0, uniformly offset frames -> that offset", () => {
  const a = Buffer.from([10, 20, 30, 40]);
  const b = Buffer.from([10, 20, 30, 40]);
  const c = Buffer.from([15, 25, 35, 45]);
  assert.equal(meanAbsDiff(a, b), 0);
  assert.equal(meanAbsDiff(a, c), 5);
});

test("formatReport: text mode names every part and every join, json mode round-trips", () => {
  const report = {
    outPath: "/tmp/out.mp4",
    totalDurationSec: 20,
    parts: [
      { index: 0, source: "/a/intro.mp4", durationSec: 8, integratedLufs: -16, truePeakDb: -4.9 },
      { index: 1, source: "/a/body.mp4", durationSec: 12, integratedLufs: -16.2, truePeakDb: -3.1 },
    ],
    loudnessSpread: { min: -16.2, max: -16, spreadLu: 0.2, warn: false },
    joins: [
      {
        index: 0,
        atSec: 8,
        betweenParts: [0, 1],
        click: { joinTimeSec: 8, windowMaxStep: 0.02, partTypicalMaxStep: 0.018, ratio: 1.11, flagged: false },
        meanPixelDiff: 1.4,
      },
    ],
  };
  const text = formatReport(report);
  assert.match(text, /intro\.mp4/);
  assert.match(text, /body\.mp4/);
  assert.match(text, /join 0 @ 8\.000s/);
  assert.match(text, /mean pixel diff 1\.40/);

  const json = JSON.parse(formatReport(report, { json: true }));
  assert.deepEqual(json, report);
});
