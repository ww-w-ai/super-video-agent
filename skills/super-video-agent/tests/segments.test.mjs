// Pure segment math for partial re-rendering (scripts/lib/segments.mjs):
// tiling shots into frame-range segments, deciding segment reuse from
// stored vs. current metadata, and validating --only. No I/O, no ffmpeg,
// no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSegments,
  probeFrameIndices,
  decideSegmentReuse,
  unknownOnlyIds,
  validateOnly,
} from "../scripts/lib/segments.mjs";

// ---- computeSegments: tiling --------------------------------------------

test("segments: tiling shots (touching, no gap) become one segment each", () => {
  const shots = [
    { id: "l1", start: 0.4, end: 1.4 },
    { id: "l2", start: 1.4, end: 2.4 },
    { id: "l3", start: 2.4, end: 3.2 },
  ];
  const { segments, warnings } = computeSegments({ shots, fps: 30, duration: 3.6 });
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    segments.map((s) => [s.id, s.frameStart, s.frameEnd]),
    [
      ["l1", 0, 42], // forced start 0, not round(0.4*30)=12
      ["l2", 42, 72],
      ["l3", 72, 108], // forced end round(3.6*30)=108, not round(3.2*30)=96
    ]
  );
});

test("segments: a gap between shots merges them into one segment and warns", () => {
  const shots = [
    { id: "l1", start: 0, end: 1.0 }, // frames 0-30
    { id: "l2", start: 1.25, end: 2.0 }, // gap: frame 37 vs expected 30
  ];
  const { segments, warnings } = computeSegments({ shots, fps: 30, duration: 2.0 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, "l1+l2");
  assert.deepEqual(segments[0].shotIds, ["l1", "l2"]);
  assert.equal(segments[0].frameStart, 0);
  assert.equal(segments[0].frameEnd, 60);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /do not tile/);
});

test("segments: an overlap between shots also merges (frameEnd = max)", () => {
  const shots = [
    { id: "l1", start: 0, end: 1.0 }, // frames 0-30
    { id: "l2", start: 0.9, end: 2.0 }, // overlap: starts at frame 27, before 30
  ];
  const { segments, warnings } = computeSegments({ shots, fps: 30, duration: 2.0 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].frameStart, 0);
  assert.equal(segments[0].frameEnd, 60);
  assert.equal(warnings.length, 1);
});

test("segments: rounding at boundaries — fractional frame numbers round to nearest, not truncate", () => {
  // 0.0165s * 30fps = 0.495 -> rounds to 0 (not 1); with duration forcing
  // the film to end exactly on the rounded last frame.
  const shots = [
    { id: "l1", start: 0, end: 1.0166666667 }, // 30.5 frames -> rounds to 31 (banker's? Math.round -> 31)
    { id: "l2", start: 1.0166666667, end: 2.0 },
  ];
  const { segments, warnings } = computeSegments({ shots, fps: 30, duration: 2.0 });
  assert.equal(warnings.length, 0, "identical fractional start/end must round to the same frame and tile");
  assert.equal(segments[0].frameEnd, segments[1].frameStart);
  assert.equal(segments[1].frameEnd, 60);
});

test("segments: single shot spans the whole film with no warnings", () => {
  const shots = [{ id: "only", start: 0.1, end: 1.9 }];
  const { segments, warnings } = computeSegments({ shots, fps: 30, duration: 2.0 });
  assert.equal(warnings.length, 0);
  assert.deepEqual(segments, [{ id: "only", frameStart: 0, frameEnd: 60, shotIds: ["only"] }]);
});

test("segments: no shots at all falls back to one full-range segment with a warning", () => {
  const { segments, warnings } = computeSegments({ shots: [], fps: 30, duration: 2.0 });
  assert.deepEqual(segments, [{ id: "full", frameStart: 0, frameEnd: 60, shotIds: [] }]);
  assert.equal(warnings.length, 1);
});

test("segments: probeFrameIndices picks first/middle/last frame of a range", () => {
  assert.deepEqual(probeFrameIndices(0, 10), [0, 4, 9]);
  assert.deepEqual(probeFrameIndices(5, 6), [5, 5, 5]); // single-frame segment: all three coincide
  assert.deepEqual(probeFrameIndices(0, 2), [0, 0, 1]);
});

// ---- decideSegmentReuse ---------------------------------------------------

const BASE_CURRENT = { frameStart: 0, frameEnd: 30, fps: 30, width: 1080, height: 1920, probes: ["a", "b", "c"] };

test("reuse: matching stored metadata, mp4 present -> reuse", () => {
  const stored = { ...BASE_CURRENT };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, true);
  assert.match(reason, /match/);
});

test("reuse: no stored metadata -> render", () => {
  const { reuse, reason } = decideSegmentReuse({ stored: null, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, false);
  assert.match(reason, /no stored/);
});

test("reuse: mp4 missing -> render even if metadata matches", () => {
  const stored = { ...BASE_CURRENT };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: false });
  assert.equal(reuse, false);
  assert.match(reason, /missing/);
});

test("reuse: frame range changed -> render", () => {
  const stored = { ...BASE_CURRENT, frameStart: 1, frameEnd: 31 };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, false);
  assert.match(reason, /frame range changed/);
});

test("reuse: fps changed -> render", () => {
  const stored = { ...BASE_CURRENT, fps: 24 };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, false);
  assert.match(reason, /fps changed/);
});

test("reuse: size changed -> render", () => {
  const stored = { ...BASE_CURRENT, width: 540 };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, false);
  assert.match(reason, /size changed/);
});

test("reuse: one probe hash differs (content changed) -> render", () => {
  const stored = { ...BASE_CURRENT, probes: ["a", "DIFFERENT", "c"] };
  const { reuse, reason } = decideSegmentReuse({ stored, current: BASE_CURRENT, mp4Exists: true });
  assert.equal(reuse, false);
  assert.match(reason, /probe hash mismatch/);
});

// ---- --only validation -----------------------------------------------------

const SEGMENTS = [
  { id: "l1", frameStart: 0, frameEnd: 30 },
  { id: "l2", frameStart: 30, frameEnd: 60 },
  { id: "l3", frameStart: 60, frameEnd: 90 },
];

test("--only: unknown id is reported", () => {
  const unknown = unknownOnlyIds({ segments: SEGMENTS, onlyIds: ["l1", "nope"] });
  assert.deepEqual(unknown, ["nope"]);
});

test("--only: known ids only -> no unknowns", () => {
  const unknown = unknownOnlyIds({ segments: SEGMENTS, onlyIds: ["l2"] });
  assert.deepEqual(unknown, []);
});

test("--only: segments outside --only whose stored range still matches -> ok", () => {
  const storedById = new Map([
    ["l1", { frameStart: 0, frameEnd: 30 }],
    ["l3", { frameStart: 60, frameEnd: 90 }],
  ]);
  const { ok, mustInclude } = validateOnly({ segments: SEGMENTS, onlyIds: ["l2"], storedById });
  assert.equal(ok, true);
  assert.deepEqual(mustInclude, []);
});

test("--only: a reused segment whose frame range moved must be included", () => {
  // l3's stored range no longer matches the current timeline (its start moved).
  const storedById = new Map([
    ["l1", { frameStart: 0, frameEnd: 30 }],
    ["l3", { frameStart: 55, frameEnd: 85 }], // stale
  ]);
  const { ok, mustInclude } = validateOnly({ segments: SEGMENTS, onlyIds: ["l2"], storedById });
  assert.equal(ok, false);
  assert.deepEqual(mustInclude, ["l3"]);
});

test("--only: a reused segment with no stored metadata at all must be included", () => {
  const storedById = new Map([["l1", { frameStart: 0, frameEnd: 30 }]]); // l3 never stored
  const { ok, mustInclude } = validateOnly({ segments: SEGMENTS, onlyIds: ["l2"], storedById });
  assert.equal(ok, false);
  assert.deepEqual(mustInclude, ["l3"]);
});

test("--only: everything outside --only stale -> all reported", () => {
  const storedById = new Map();
  const { ok, mustInclude } = validateOnly({ segments: SEGMENTS, onlyIds: ["l2"], storedById });
  assert.equal(ok, false);
  assert.deepEqual(mustInclude, ["l1", "l3"]);
});
