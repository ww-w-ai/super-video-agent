// Pure unit tests for scripts/lib/dub-space.mjs (dub.mjs --min-gap). No ffmpeg, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGapDeltas,
  buildTimeMap,
  remapTime,
  remapTimings,
  segmentFactors,
  atempoChain,
  buildSpaceFilterGraph,
  buildSpaceFfmpegArgs,
  formatSpaceReport,
} from "../scripts/lib/dub-space.mjs";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} expected ${b}, got ${a}`);

// Base: lead-in 0.5 s, three 2 s slots, the last runs to 7.0.
const BASE = {
  duration: 7.0,
  lines: [
    { id: "a", start: 0.5, end: 2.0, words: [{ w: "x", start: 0.5, end: 1.0 }] },
    { id: "b", start: 2.5, end: 4.0, words: [] },
    { id: "c", start: 4.5, end: 6.0, words: [] },
  ],
};
// Placed dub lines leaving 0.1 s gaps before b and c.
const PLACED = [
  { id: "a", start: 0.5, end: 2.4 },
  { id: "b", start: 2.5, end: 4.4 },
  { id: "c", start: 4.5, end: 6.8 },
];

test("computeGapDeltas: short gaps get the missing seconds, the last slot gets none", () => {
  const d = computeGapDeltas(BASE.lines, PLACED, 0.5);
  near(d[0].gap, 0.1);
  near(d[0].delta, 0.4);
  near(d[1].delta, 0.4);
  assert.equal(d[2].gap, null);
  assert.equal(d[2].delta, 0);
});

test("computeGapDeltas: a gap already at min-gap adds nothing", () => {
  const d = computeGapDeltas(BASE.lines, [{ id: "a", end: 1.9 }, { id: "b", end: 3.9 }, { id: "c", end: 6 }], 0.5);
  assert.deepEqual(d.map((x) => x.delta), [0, 0, 0]);
});

test("buildTimeMap: length grows by the sum of the deltas", () => {
  const map = buildTimeMap(BASE.lines, BASE.duration, [0.4, 0.4, 0]);
  near(map.newDuration, 7.8);
  assert.deepEqual(map.knotsOld, [0, 0.5, 2.5, 4.5, 7.0]);
  near(map.knotsNew[3], 5.3);
});

test("remapTime: lead-in and film start unchanged, the last slot only shifts, the end lands on the new length", () => {
  const map = buildTimeMap(BASE.lines, BASE.duration, [0.4, 0.4, 0]);
  near(remapTime(0, map), 0);
  near(remapTime(0.3, map), 0.3, "lead-in");
  near(remapTime(1.5, map), 0.5 + 1.0 * (2.4 / 2.0), "inside a stretched slot");
  near(remapTime(5.0, map), 5.8, "last slot is shifted, not stretched");
  near(remapTime(7.0, map), 7.8);
});

test("remapTimings (acceptance): with the placed lines re-fitted at the new starts, every gap reaches min-gap", () => {
  const deltas = computeGapDeltas(BASE.lines, PLACED, 0.5);
  const map = buildTimeMap(BASE.lines, BASE.duration, deltas.map((d) => d.delta));
  const spaced = remapTimings(BASE, map);
  near(spaced.duration, BASE.duration + 0.8);
  for (let i = 0; i < PLACED.length - 1; i++) {
    const placedEnd = spaced.lines[i].start + (PLACED[i].end - PLACED[i].start); // voice speed unchanged
    const gap = spaced.lines[i + 1].start - placedEnd;
    assert.ok(gap >= 0.5 - 1e-9, `gap after ${PLACED[i].id} = ${gap}`);
  }
  near(spaced.lines[0].words[0].start, 0.5, "words are remapped too");
  near(BASE.lines[1].start, 2.5, "input untouched");
});

test("segmentFactors: stretched slots get factor > 1, lead-in and last slot stay 1", () => {
  const map = buildTimeMap(BASE.lines, BASE.duration, [0.4, 0.4, 0]);
  const f = segmentFactors(map).map((s) => s.factor);
  near(f[0], 1);
  near(f[1], 1.2);
  near(f[2], 1.2);
  near(f[3], 1);
});

test("segmentFactors: a first line at 0 drops the empty lead-in (no divide by zero)", () => {
  const lines = [{ id: "a", start: 0, end: 1 }, { id: "b", start: 2, end: 3 }];
  const segs = segmentFactors(buildTimeMap(lines, 4, [0.5, 0]));
  assert.equal(segs.length, 2);
  assert.ok(segs.every((s) => Number.isFinite(s.factor)));
  near(segs[0].factor, 1.25);
});

test("atempoChain: 1 is empty, slow tempos under 0.5 are chained", () => {
  assert.equal(atempoChain(1), "");
  assert.equal(atempoChain(0.8), "atempo=0.800000");
  assert.equal(atempoChain(0.3), "atempo=0.5,atempo=0.600000");
});

test("buildSpaceFilterGraph: setpts for picture, atempo only on stretched bed segments, both outputs", () => {
  const map = buildTimeMap(BASE.lines, BASE.duration, [0.4, 0.4, 0]);
  const g = buildSpaceFilterGraph(segmentFactors(map), 30, map.newDuration);
  assert.match(g, /\[0:v\]trim=start=0\.500000:end=2\.500000,setpts=\(PTS-STARTPTS\)\*1\.200000\[v1\]/);
  assert.match(g, /\[1:a\]atrim=start=0\.500000:end=2\.500000,asetpts=PTS-STARTPTS,atempo=0\.833333\[a1\]/);
  assert.match(g, /\[1:a\]atrim=start=4\.500000:end=7\.000000,asetpts=PTS-STARTPTS\[a3\]/, "last slot has no atempo");
  assert.match(g, /concat=n=4:v=1:a=0,fps=30,.*\[v\]/);
  assert.match(g, /concat=n=4:v=0:a=1,apad,atrim=end=7\.800000\[a\]/);
});

test("buildSpaceFfmpegArgs: one call maps both [v] and [a] to their own outputs", () => {
  const args = buildSpaceFfmpegArgs({ pictureMp4: "p.mp4", bedWav: "b.wav", outMp4: "o.mp4", outWav: "o.wav", graph: "G", frameCount: 234 });
  const vi = args.indexOf("[v]");
  const ai = args.indexOf("[a]");
  assert.ok(vi > 0 && ai > vi);
  assert.ok(args.indexOf("o.mp4") > vi && args.indexOf("o.mp4") < ai);
  assert.ok(args.indexOf("o.wav") > ai);
  assert.equal(args[args.indexOf("-frames:v") + 1], "234");
});

test("formatSpaceReport: per-slot delta and factor, and old -> new length", () => {
  const deltas = computeGapDeltas(BASE.lines, PLACED, 0.5);
  const map = buildTimeMap(BASE.lines, BASE.duration, deltas.map((d) => d.delta));
  const out = formatSpaceReport(deltas, map, BASE.lines);
  assert.match(out, /a: gap 0\.100s, \+0\.400s, factor 1\.200/);
  assert.match(out, /c: last, \+0\.000s, factor 1\.000/);
  assert.match(out, /length 7\.000s -> 7\.800s/);
});
