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

test("reportLineFill: a well-filled, unsped line with room after it is not warned", () => {
  const slots = [
    { id: "l1", start: 0, end: 2.0 },
    { id: "l2", start: 2.0, end: 3.0 },
  ];
  const [r] = reportLineFill([{ id: "l1", start: 0, end: 1.5, atempoFactor: 1 }], slots);
  assert.ok(Math.abs(r.fill - 0.75) < 1e-9);
  assert.ok(Math.abs(r.gapAfter - 0.5) < 1e-9, "gap runs from the line's end to its slot's end");
  assert.equal(r.fillWarn, false);
  assert.equal(r.gapWarn, false);
  assert.equal(r.warn, false);
});

test("reportLineFill (T20): fill 0.95 with a 0.1 s gap is warned for the gap", () => {
  const [r] = reportLineFill([{ id: "l1", start: 0, end: 0.95, atempoFactor: 1 }], SLOTS);
  assert.ok(Math.abs(r.fill - 0.95) < 1e-9);
  assert.ok(Math.abs(r.gapAfter - 0.05) < 1e-9);
  assert.equal(r.fillWarn, false);
  assert.equal(r.gapWarn, true);
  assert.equal(r.warn, true);
});

test("reportLineFill (T20): the base line's own gap is reported, and only a gap under 0.4 s warns", () => {
  const slots = [
    { id: "l1", start: 0, end: 3.0 },
    { id: "l2", start: 3.0, end: 4.0 },
  ];
  const baseLines = [
    { id: "l1", start: 0, end: 2.0 }, // base gap 1.0
    { id: "l2", start: 3.0, end: 3.5 },
  ];
  const [r] = reportLineFill([{ id: "l1", start: 0, end: 2.5, atempoFactor: 1 }], slots, baseLines); // gap 0.5, base 1.0
  assert.ok(Math.abs(r.baseGap - 1.0) < 1e-9);
  assert.equal(r.gapWarn, false);
  const [short] = reportLineFill([{ id: "l1", start: 0, end: 2.7, atempoFactor: 1 }], slots, baseLines); // gap 0.3
  assert.equal(short.gapWarn, true);
});

test("reportLineFill (T10, T20): the last line gets no gap and no low-fill warning", () => {
  const [r] = reportLineFill([{ id: "l3", start: 2.0, end: 2.5, atempoFactor: 1 }], SLOTS); // 50 % of an end-card slot
  assert.equal(r.last, true);
  assert.ok(Math.abs(r.fill - 0.5) < 1e-9);
  assert.equal(r.gapAfter, null);
  assert.equal(r.warn, false);
  const [notLast] = reportLineFill([{ id: "l2", start: 1.0, end: 1.5, atempoFactor: 1 }], SLOTS);
  assert.equal(notLast.fillWarn, true, "the same 50 % fill on a middle line still warns");
});

test("reportLineFill (T10): the last line still warns when it needed atempo", () => {
  const [r] = reportLineFill([{ id: "l3", start: 2.0, end: 3.0, atempoFactor: 1.1 }], SLOTS);
  assert.equal(r.warn, true);
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

test("formatFillWarnings (T20): a short gap is listed with the base gap and suggests --min-gap", () => {
  const report = [
    { id: "l1", fill: 0.95, atempoFactor: 1, gapAfter: 0.1, baseGap: 0.7, last: false, fillWarn: false, gapWarn: true, warn: true },
    { id: "l2", fill: 0.9, atempoFactor: 1, gapAfter: 0.6, baseGap: 0.5, last: false, fillWarn: false, gapWarn: false, warn: false },
  ];
  const out = formatFillWarnings(report);
  assert.match(out, /l1: gap after 0\.10s \(base line's own gap 0\.70s\)/);
  assert.doesNotMatch(out, /l2:/);
  assert.doesNotMatch(out, /slot fill is off/, "a gap-only warning does not claim the fill is off");
  assert.match(out, /--min-gap/);
});
