// Pure-logic tests for groupIssueRuns (scripts/lib/layout-scan.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupIssueRuns } from "../scripts/lib/layout-scan.mjs";

function times(count, stepSec) {
  return Array.from({ length: count }, (_, i) => i * stepSec);
}

test("groupIssueRuns: no issues anywhere -> no runs", () => {
  const runs = groupIssueRuns(times(5, 0.1), [[], [], [], [], []]);
  assert.deepEqual(runs, []);
});

test("groupIssueRuns: a single sample with an issue is its own run", () => {
  const issuesByTime = [[], [{ type: "text-overflow" }], []];
  const runs = groupIssueRuns(times(3, 0.1), issuesByTime);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startSec, 0.1);
  assert.equal(runs[0].endSec, 0.1);
  assert.equal(runs[0].sampleCount, 1);
  assert.equal(runs[0].issueCount, 1);
  assert.deepEqual(runs[0].types, ["text-overflow"]);
});

test("groupIssueRuns: consecutive samples with issues merge into one run", () => {
  const issuesByTime = [
    [],
    [{ type: "text-outside-safe-area" }],
    [{ type: "text-outside-safe-area" }],
    [{ type: "text-outside-safe-area" }],
    [],
  ];
  const runs = groupIssueRuns(times(5, 0.1), issuesByTime);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].startSec - 0.1) < 1e-9);
  assert.ok(Math.abs(runs[0].endSec - 0.3) < 1e-9);
  assert.equal(runs[0].sampleCount, 3);
  assert.equal(runs[0].issueCount, 3);
});

test("groupIssueRuns: two runs separated by a clean sample are reported separately", () => {
  const issuesByTime = [[{ type: "a" }], [], [{ type: "a" }]];
  const runs = groupIssueRuns(times(3, 0.1), issuesByTime);
  assert.equal(runs.length, 2);
});

test("groupIssueRuns: a sample with two issue types reports both types once each", () => {
  const issuesByTime = [[{ type: "text-overflow" }, { type: "clip-frame-load-failed" }, { type: "text-overflow" }]];
  const runs = groupIssueRuns(times(1, 0.1), issuesByTime);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].issueCount, 3);
  assert.deepEqual(runs[0].types.sort(), ["clip-frame-load-failed", "text-overflow"]);
});

test("groupIssueRuns: a run lists the distinct texts of its issues (which caption or sticker)", () => {
  const issuesByTime = [[{ type: "text-outside-safe-area", text: "SALE" }], [{ type: "text-outside-safe-area", text: "SALE" }, { type: "x" }]];
  const runs = groupIssueRuns(times(2, 0.1), issuesByTime);
  assert.deepEqual(runs[0].texts, ["SALE"]);
});
