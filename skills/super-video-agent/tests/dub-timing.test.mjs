// Pure unit tests for scripts/lib/dub-timing.mjs (dub.mjs's slot-fitting
// and clock math). No ffmpeg, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlots, fitLineToSlot, shiftAndScaleWords, fitAllLines, buildPlacedTimings, trimEdgeSilence } from "../scripts/lib/dub-timing.mjs";

test("computeSlots: slot i runs from base line i's start to line i+1's start; the last runs to filmDuration", () => {
  const baseLines = [
    { id: "l1", start: 0.4, end: 1.0 },
    { id: "l2", start: 1.4, end: 2.0 },
    { id: "l3", start: 2.4, end: 2.9 },
  ];
  const slots = computeSlots(baseLines, 3.3);
  assert.deepEqual(slots, [
    { id: "l1", start: 0.4, end: 1.4 },
    { id: "l2", start: 1.4, end: 2.4 },
    { id: "l3", start: 2.4, end: 3.3 },
  ]);
});

test("fitLineToSlot: a clip that already fits is unchanged", () => {
  const fit = fitLineToSlot(0.8, 1.0);
  assert.deepEqual(fit, { ok: true, atempoFactor: 1, actualDurationSec: 0.8 });
});

test("fitLineToSlot: a clip up to 1.2x its slot is sped up to fit exactly", () => {
  const fit = fitLineToSlot(1.2, 1.0); // requires exactly 1.2x
  assert.equal(fit.ok, true);
  assert.ok(Math.abs(fit.atempoFactor - 1.2) < 1e-9);
  assert.ok(Math.abs(fit.actualDurationSec - 1.0) < 1e-9);
});

test("fitLineToSlot: a clip needing more than 1.2x is refused, naming the required factor", () => {
  const fit = fitLineToSlot(1.5, 1.0); // requires 1.5x
  assert.equal(fit.ok, false);
  assert.ok(Math.abs(fit.requiredFactor - 1.5) < 1e-9);
  assert.equal(fit.maxAtempo, 1.2);
});

test("fitLineToSlot: a custom maxAtempo is honoured", () => {
  const fit = fitLineToSlot(1.3, 1.0, 1.5);
  assert.equal(fit.ok, true);
  assert.ok(Math.abs(fit.atempoFactor - 1.3) < 1e-9);
});

test("shiftAndScaleWords: clip-relative, scaled by atempoFactor, placed at the slot start", () => {
  // dub line's own words are on its own timeline (dubLineStart=2); slot starts at 10;
  // atempoFactor 2 (sped up 2x) halves every local duration.
  const words = [
    { w: "hello", start: 2.0, end: 2.4 },
    { w: "world", start: 2.4, end: 3.0 },
  ];
  const out = shiftAndScaleWords(words, 2.0, 2, 10);
  assert.deepEqual(out, [
    { w: "hello", start: 10, end: 10.2 },
    { w: "world", start: 10.2, end: 10.5 },
  ]);
});

test("shiftAndScaleWords: atempoFactor 1 (no speedup) just shifts", () => {
  const words = [{ w: "a", start: 0.5, end: 0.9 }];
  const out = shiftAndScaleWords(words, 0.5, 1, 3);
  assert.deepEqual(out, [{ w: "a", start: 3, end: 3.4 }]);
});

test("shiftAndScaleWords: empty/undefined words -> []", () => {
  assert.deepEqual(shiftAndScaleWords(undefined, 0, 1, 0), []);
  assert.deepEqual(shiftAndScaleWords([], 0, 1, 0), []);
});

const BASE_LINES = [
  { id: "l1", start: 0, end: 0.9 },
  { id: "l2", start: 1.0, end: 1.8 },
];
const FILM_DURATION = 2.5;

test("fitAllLines: places every line on the base clock when all fit", () => {
  const dubLines = [
    { id: "l1", text: "Hello there", start: 0, end: 0.7, words: [{ w: "Hello", start: 0, end: 0.3 }, { w: "there", start: 0.3, end: 0.7 }] },
    { id: "l2", text: "General Kenobi", start: 0.9, end: 1.5, words: [] },
  ];
  const clipDurations = new Map([["l1", 0.7], ["l2", 0.6]]);
  const result = fitAllLines(BASE_LINES, dubLines, clipDurations, FILM_DURATION);
  assert.equal(result.ok, true);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].start, 0); // l1's slot: [0, 1.0)
  assert.ok(Math.abs(result.lines[0].end - 0.7) < 1e-9);
  assert.equal(result.lines[1].start, 1.0); // l2's slot: [1.0, 2.5)
  assert.ok(Math.abs(result.lines[1].end - 1.6) < 1e-9);
});

test("fitAllLines: a line longer than its slot but within 1.2x is sped up, not cut", () => {
  const dubLines = [
    { id: "l1", text: "x", start: 0, end: 1.1, words: [] }, // slot is [0,1.0) -> 1.1s needs 1.1x
    { id: "l2", text: "y", start: 0, end: 0.5, words: [] },
  ];
  const clipDurations = new Map([["l1", 1.1], ["l2", 0.5]]);
  const result = fitAllLines(BASE_LINES, dubLines, clipDurations, FILM_DURATION);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.lines[0].atempoFactor - 1.1) < 1e-9);
  assert.ok(Math.abs(result.lines[0].end - 1.0) < 1e-9); // fit exactly to the slot
});

test("fitAllLines: fails closed (no line placed) when any line needs more than 1.2x, naming it", () => {
  const dubLines = [
    { id: "l1", text: "x", start: 0, end: 1.5, words: [] }, // slot [0,1.0) -> needs 1.5x
    { id: "l2", text: "y", start: 0, end: 0.5, words: [] },
  ];
  const clipDurations = new Map([["l1", 1.5], ["l2", 0.5]]);
  const result = fitAllLines(BASE_LINES, dubLines, clipDurations, FILM_DURATION);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].id, "l1");
  assert.ok(Math.abs(result.failures[0].requiredFactor - 1.5) < 1e-9);
});

test("fitAllLines: a missing dub line id is reported as a failure, not silently skipped", () => {
  const dubLines = [{ id: "l1", text: "x", start: 0, end: 0.5, words: [] }]; // l2 missing
  const clipDurations = new Map([["l1", 0.5]]);
  const result = fitAllLines(BASE_LINES, dubLines, clipDurations, FILM_DURATION);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].id, "l2");
  assert.match(result.failures[0].reason, /no matching dub line id/);
});

// ---- buildPlacedTimings (dub/<code>/timings.placed.json's writer) ----

test("buildPlacedTimings: wraps fitted lines with duration/lang/provider, same shape as voice/timings.json", () => {
  const fittedLines = [{ id: "l1", text: "Hello", start: 0, end: 0.7, words: [] }];
  const out = buildPlacedTimings(fittedLines, 2.5, "en-US");
  assert.deepEqual(out, { duration: 2.5, lines: fittedLines, lang: "en-US", provider: "dub" });
});

test("buildPlacedTimings: lang defaults to null when omitted", () => {
  const out = buildPlacedTimings([], 1.0);
  assert.equal(out.lang, null);
  assert.equal(out.provider, "dub");
});

// ---- trimEdgeSilence (dub.mjs's pre-fit edge-silence trim) ----

function windows(spans, winSec = 0.01) {
  // spans: array of [durationSec, rmsDb] run lengths, laid out back to back.
  const out = [];
  let t = 0;
  for (const [durSec, rmsDb] of spans) {
    for (let s = 0; s < durSec - 1e-9; s += winSec) {
      out.push({ startSec: t, endSec: t + winSec, rmsDb });
      t += winSec;
    }
  }
  return out;
}

test("trimEdgeSilence: found-in-production shape — 0.03s lead silence, speech, 0.13s tail silence", () => {
  const w = windows([
    [0.03, -60],
    [1.0, -10],
    [0.13, -60],
  ]);
  const clipDurationSec = 1.16;
  const range = trimEdgeSilence(w, clipDurationSec, { thresholdDb: -45, padSec: 0.04 });
  assert.ok(Math.abs(range.leadTrimSec - 0) < 1e-6, `leadTrimSec=${range.leadTrimSec}`); // speech starts before the 0.04 pad would even trim
  assert.ok(range.tailTrimSec > 0.06 && range.tailTrimSec < 0.1, `tailTrimSec=${range.tailTrimSec}`);
  assert.ok(range.trimmedEndSec < clipDurationSec);
});

test("trimEdgeSilence: keeps padSec of silence on each side, never cuts into speech", () => {
  const w = windows([
    [0.2, -60],
    [0.5, -10],
    [0.2, -60],
  ]);
  const range = trimEdgeSilence(w, 0.9, { thresholdDb: -45, padSec: 0.04 });
  assert.ok(Math.abs(range.trimmedStartSec - (0.2 - 0.04)) < 0.011, `trimmedStartSec=${range.trimmedStartSec}`);
  assert.ok(Math.abs(range.trimmedEndSec - (0.7 + 0.04)) < 0.011, `trimmedEndSec=${range.trimmedEndSec}`);
});

test("trimEdgeSilence: an internal pause (mid-clip) is never trimmed, only the two edges", () => {
  const w = windows([
    [0.1, -60], // lead
    [0.3, -10], // speech
    [0.5, -60], // internal pause — must survive
    [0.3, -10], // speech
    [0.1, -60], // tail
  ]);
  const clipDurationSec = 1.3;
  const range = trimEdgeSilence(w, clipDurationSec, { thresholdDb: -45, padSec: 0.04 });
  // trimmed window still spans across the internal pause (0.4 to 0.9), untouched.
  assert.ok(range.trimmedStartSec < 0.4, `trimmedStartSec=${range.trimmedStartSec}`);
  assert.ok(range.trimmedEndSec > 0.9, `trimmedEndSec=${range.trimmedEndSec}`);
});

test("trimEdgeSilence: all-silent clip trims nothing (no speech to bound the cut)", () => {
  const w = windows([[1.0, -60]]);
  const range = trimEdgeSilence(w, 1.0);
  assert.deepEqual(range, { leadTrimSec: 0, tailTrimSec: 0, trimmedStartSec: 0, trimmedEndSec: 1.0 });
});

test("trimEdgeSilence: no windows at all -> no trim", () => {
  const range = trimEdgeSilence([], 1.0);
  assert.deepEqual(range, { leadTrimSec: 0, tailTrimSec: 0, trimmedStartSec: 0, trimmedEndSec: 1.0 });
});
