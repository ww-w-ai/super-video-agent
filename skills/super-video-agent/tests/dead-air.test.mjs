// Pure run-finding (scripts/lib/dead-air.mjs) over a sequence of
// seek()-time -> canvas-pixel-hash pairs, as produced by
// scripts/lib/browser.mjs's scanDeadAirBySeek. No browser needed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadAirRunsFromHashes, excludeEndHold } from "../scripts/lib/dead-air.mjs";

function times(count, stepSec) {
  return Array.from({ length: count }, (_, i) => i * stepSec);
}

test("deadAirRunsFromHashes: a >=0.8s run of identical hashes is flagged", () => {
  // 0.1s step, 9 identical hashes (0.0s..0.8s) -> an 0.8s run.
  const hashes = Array(9).fill("same");
  const runs = deadAirRunsFromHashes(times(9, 0.1), hashes, 0.8);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].startSec - 0) < 1e-9);
  assert.ok(Math.abs(runs[0].durationSec - 0.8) < 1e-9);
});

test("deadAirRunsFromHashes: a run just under 0.8s is not flagged", () => {
  // 8 identical hashes -> a 0.7s span, below the 0.8s minimum.
  const hashes = Array(8).fill("same");
  const runs = deadAirRunsFromHashes(times(8, 0.1), hashes, 0.8);
  assert.equal(runs.length, 0);
});

test("deadAirRunsFromHashes: any single pixel change (hash change) ends a run", () => {
  const hashes = ["a", "a", "a", "a", "a", "a", "a", "a", "b", "a", "a", "a", "a", "a", "a", "a", "a"];
  const runs = deadAirRunsFromHashes(times(hashes.length, 0.1), hashes, 0.8);
  // The single "b" breaks what would otherwise be one long run into two
  // shorter ones, each spanning less than 0.8s -> no run reported.
  assert.equal(runs.length, 0);
});

test("deadAirRunsFromHashes: fine motion (every hash distinct) reports no dead air", () => {
  const hashes = Array.from({ length: 30 }, (_, i) => `h${i}`);
  const runs = deadAirRunsFromHashes(times(30, 0.1), hashes, 0.8);
  assert.equal(runs.length, 0);
});

test("deadAirRunsFromHashes: multiple separated runs are all reported", () => {
  const hashes = [
    ...Array(9).fill("a"), // 0.0-0.8s dead air
    "x",
    ...Array(9).fill("b"), // dead air again, later
  ];
  const runs = deadAirRunsFromHashes(times(hashes.length, 0.1), hashes, 0.8);
  assert.equal(runs.length, 2);
});

test("excludeEndHold: a still end hold after the last line is not dead air", () => {
  assert.deepEqual(excludeEndHold([{ startSec: 12.3, durationSec: 1.56 }], 12.35, 0.8), []);
});

test("excludeEndHold: a still run that starts well before the last line ends stays flagged, cut at the hold", () => {
  const runs = excludeEndHold([{ startSec: 10, durationSec: 3.5 }], 12, 0.8);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].durationSec - 2) < 1e-9);
});
