// Pure unit tests for scripts/lib/dub-fill.mjs (dub.mjs's slot-fill report).
// No ffmpeg, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportLineFill, formatFillWarnings, LOW_FILL_THRESHOLD } from "../scripts/lib/dub-fill.mjs";

const SLOTS = [
  { id: "l1", start: 0, end: 1.0 },
  { id: "l2", start: 1.0, end: 2.0 },
  { id: "l3", start: 2.0, end: 3.0 },
];

test("reportLineFill: a well-filled, unsped line is not warned", () => {
  const lines = [{ id: "l1", start: 0, end: 0.9, atempoFactor: 1 }];
  const [r] = reportLineFill(lines, SLOTS);
  assert.ok(Math.abs(r.fill - 0.9) < 1e-9);
  assert.equal(r.warn, false);
});

test("reportLineFill: fill below the low threshold is warned", () => {
  const lines = [{ id: "l2", start: 1.0, end: 1.6, atempoFactor: 1 }]; // 0.6/1.0 = 0.6 < 0.75
  const [r] = reportLineFill(lines, SLOTS);
  assert.ok(Math.abs(r.fill - 0.6) < 1e-9);
  assert.ok(r.fill < LOW_FILL_THRESHOLD);
  assert.equal(r.warn, true);
});

test("reportLineFill: a line that needed atempo is warned even at full fill", () => {
  const lines = [{ id: "l3", start: 2.0, end: 3.0, atempoFactor: 1.15 }]; // fit exactly to slot
  const [r] = reportLineFill(lines, SLOTS);
  assert.ok(Math.abs(r.fill - 1.0) < 1e-9);
  assert.equal(r.atempoFactor, 1.15);
  assert.equal(r.warn, true);
});

test("reportLineFill: a missing slot yields a null fill, not a crash", () => {
  const lines = [{ id: "l9", start: 0, end: 0.5, atempoFactor: 1 }];
  const [r] = reportLineFill(lines, SLOTS);
  assert.equal(r.fill, null);
  assert.equal(r.warn, false);
});

test("formatFillWarnings: empty when nothing is warned", () => {
  const report = [{ id: "l1", fill: 0.9, atempoFactor: 1, warn: false }];
  assert.equal(formatFillWarnings(report), "");
});

test("formatFillWarnings: lists every warned id with fill% and the rewrite hint", () => {
  const report = [
    { id: "l1", fill: 0.9, atempoFactor: 1, warn: false },
    { id: "l2", fill: 0.6, atempoFactor: 1, warn: true },
    { id: "l3", fill: 1.0, atempoFactor: 1.15, warn: true },
  ];
  const out = formatFillWarnings(report);
  assert.match(out, /^WARN:/);
  assert.match(out, /l2: fill 60%/);
  assert.match(out, /l3: fill 100%, atempo 1\.15x/);
  assert.doesNotMatch(out, /l1:/);
  assert.match(out, /voice\.mjs --lines/);
});
