// Pure unit tests for scripts/lib/dub-fill.mjs (dub.mjs's slot-fill report).
// No ffmpeg, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportLineFill, formatFillWarnings, formatFillTable, gapRange, GAP_MIN_SEC, GAP_MAX_SHARE, GAP_MAX_FLOOR_SEC } from "../scripts/lib/dub-fill.mjs";

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

test("reportLineFill (T10, T20): the last line gets no gap and no gap warning", () => {
  const [r] = reportLineFill([{ id: "l3", start: 2.0, end: 2.5, atempoFactor: 1 }], SLOTS); // 50 % of an end-card slot
  assert.equal(r.last, true);
  assert.ok(Math.abs(r.fill - 0.5) < 1e-9);
  assert.equal(r.gapAfter, null);
  assert.equal(r.gapState, null);
  assert.equal(r.warn, false);
});

test("gapRange: min 0.4 s; max a quarter of the slot, never under 1 s", () => {
  assert.equal(GAP_MIN_SEC, 0.4);
  assert.equal(GAP_MAX_SHARE, 0.25);
  assert.equal(GAP_MAX_FLOOR_SEC, 1.0);
  assert.deepEqual(gapRange(2), { min: 0.4, max: 1.0 });
  assert.deepEqual(gapRange(8), { min: 0.4, max: 2.0 });
});

test("reportLineFill (D10): the scene sets the range — both ends, regardless of the base language's gap", () => {
  const slots = [
    { id: "a", start: 0, end: 8.0 }, // allowed 0.4-2.0 s
    { id: "b", start: 8.0, end: 10.0 }, // allowed 0.4-1.0 s
    { id: "c", start: 10.0, end: 12.0 },
  ];
  const base = [
    { id: "a", start: 0, end: 7.9 }, // base gap 0.1 — does not lower the floor
    { id: "b", start: 8.0, end: 8.5 }, // base gap 1.5 — does not raise the ceiling
    { id: "c", start: 10.0, end: 11.0 },
  ];
  const at = (id, end) => reportLineFill([{ id, start: slots.find((s) => s.id === id).start, end, atempoFactor: 1 }], slots, base)[0];
  assert.equal(at("a", 7.7).gapState, "crammed"); // 0.3 < 0.4
  assert.equal(at("a", 7.6).gapState, "ok"); // 0.4, the low end
  assert.equal(at("a", 6.0).gapState, "ok"); // 2.0, the high end
  assert.equal(at("a", 5.9).gapState, "sparse"); // 2.1 > 2.0
  assert.equal(at("b", 9.0).gapState, "ok"); // 1.0 in a 2 s scene
  const sparse = at("b", 8.9); // 1.1 > 1.0, although the base line itself left 1.5
  assert.equal(sparse.gapState, "sparse");
  assert.equal(sparse.gapWarn, true);
  assert.equal(sparse.fillWarn, false);
  assert.ok(Math.abs(sparse.baseGap - 1.5) < 1e-9);
});

test("reportLineFill (T10): the last line still warns when it needed atempo", () => {
  const [r] = reportLineFill([{ id: "l3", start: 2.0, end: 3.0, atempoFactor: 1.1 }], SLOTS);
  assert.equal(r.warn, true);
});

test("reportLineFill: a low fill is judged by its gap — 0.6 s after a line in a 1 s scene is within range", () => {
  const lines = [{ id: "l2", start: 1.0, end: 1.4, atempoFactor: 1 }]; // gap 0.6, allowed 0.4-1.0
  const [r] = reportLineFill(lines, SLOTS);
  assert.ok(Math.abs(r.fill - 0.4) < 1e-9);
  assert.equal(r.gapState, "ok");
  assert.equal(r.warn, false);
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
  assert.doesNotMatch(out, /squeezed/, "a gap-only warning does not claim the line was squeezed");
  assert.match(out, /crammed/);
  assert.match(out, /--min-gap/);
});

test("formatFillWarnings (D10): crammed and sparse lines are listed apart, with the scene's range", () => {
  const slots = [
    { id: "a", start: 0, end: 2.0 },
    { id: "b", start: 2.0, end: 4.0 },
    { id: "c", start: 4.0, end: 6.0 },
  ];
  const report = reportLineFill(
    [
      { id: "a", start: 0, end: 1.8, atempoFactor: 1 }, // gap 0.2 -> crammed
      { id: "b", start: 2.0, end: 2.5, atempoFactor: 1 }, // gap 1.5 -> sparse
      { id: "c", start: 4.0, end: 5.0, atempoFactor: 1 },
    ],
    slots
  );
  const out = formatFillWarnings(report);
  assert.match(out, /crammed[^\n]*\n {2}a: gap after 0\.20s \(allowed 0\.40-1\.00s\)\n/);
  assert.match(out, /too sparse[^\n]*\n {2}b: gap after 1\.50s \(allowed 0\.40-1\.00s\)\n/);
  assert.doesNotMatch(out, / c:/);
});

test("formatFillTable (--table): one row per line with fill, gap, range and state", () => {
  const slots = [
    { id: "a", start: 0, end: 2.0 },
    { id: "b", start: 2.0, end: 4.0 },
  ];
  const report = reportLineFill([{ id: "a", start: 0, end: 1.5, atempoFactor: 1 }, { id: "b", start: 2.0, end: 3.0, atempoFactor: 1.05 }], slots);
  const out = formatFillTable(report);
  assert.match(out, /^fill and gap after/);
  assert.match(out, /\n {2}a {2}75% {2}0\.50s {2}0\.40-1\.00s {2}ok\n/);
  assert.match(out, /\n {2}b {2}50% {2}- {2}- {2}last atempo 1\.05x\n/);
});
