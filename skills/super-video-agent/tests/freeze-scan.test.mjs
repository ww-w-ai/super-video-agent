// The shared freeze method (scripts/lib/freeze-scan.mjs) on synthetic grey
// frame sequences: the random-access path (page seeks) and the streamed path
// (one file decode) must find the same freezes as a check of every frame pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFreezes, createFreezeStream, runsFromPairFlags, isUnchanged, sampleClock } from "../scripts/lib/freeze-scan.mjs";

const SIZE = 400;
const FPS = 30;

/** Frames from segments: ["move", n] changes every frame, ["still", n] repeats one picture. */
function sequence(segments) {
  const frames = [];
  let tone = 0;
  for (const [kind, n] of segments) {
    for (let i = 0; i < n; i++) {
      if (kind === "move" || i === 0) tone = (tone + 37) % 256;
      frames.push(Buffer.alloc(SIZE, tone));
    }
  }
  return frames;
}

function streamed(frames, fps = FPS) {
  const s = createFreezeStream({ fps });
  for (const f of frames) s.push(f);
  return s.finish().runs;
}

async function pulled(frames, fps = FPS) {
  return (await scanFreezes((i) => frames[i], { frameCount: frames.length, fps })).runs;
}

/** Every frame pair checked: the answer both coarse-to-fine paths must reproduce. */
function everyPair(frames, fps = FPS) {
  const flags = [];
  for (let p = 0; p + 1 < frames.length; p++) flags.push(isUnchanged(frames[p], frames[p + 1]));
  return runsFromPairFlags(flags, 0, fps);
}

const round = (runs) => runs.map((r) => [Math.round(r.startSec * 1000), Math.round(r.durationSec * 1000)]);

test("a 1 s freeze is found by both paths, with its start and length", async () => {
  const frames = sequence([["move", 45], ["still", 31], ["move", 45]]);
  const want = [[1500, 1000]];
  assert.deepEqual(round(streamed(frames)), want);
  assert.deepEqual(round(await pulled(frames)), want);
});

test("a 0.5 s freeze is not reported", async () => {
  const frames = sequence([["move", 45], ["still", 16], ["move", 45]]);
  assert.deepEqual(streamed(frames), []);
  assert.deepEqual(await pulled(frames), []);
});

test("a one-frame change the 0.1 s samples miss still splits the run (dense re-check)", async () => {
  // Frames 0-31 one picture, frame 32 another, 33-64 the first again: pairs 31 and 32 change,
  // and no sample (pairs 0, 3, ..., 30, 33) lands on them.
  const a = Buffer.alloc(SIZE, 10);
  const b = Buffer.alloc(SIZE, 200);
  const frames = [...Array(32).fill(a), b, ...Array(32).fill(a)];
  const next = sampleClock(FPS);
  const samples = Array.from({ length: 22 }, next);
  assert.ok(!samples.includes(31) && !samples.includes(32), "the change sits between samples");
  const want = [[0, 1033], [1100, 1033]];
  assert.deepEqual(round(streamed(frames)), want);
  assert.deepEqual(round(await pulled(frames)), want);
});

test("sparse + dense agree with checking every pair, on many random sequences and frame rates", async () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let trial = 0; trial < 200; trial++) {
    const fps = [10, 24, 25, 30, 60][trial % 5];
    const segments = Array.from({ length: 1 + rand(8) }, () => [rand(2) ? "move" : "still", 1 + rand(fps * 3)]);
    const frames = sequence(segments);
    const want = everyPair(frames, fps);
    assert.deepEqual(streamed(frames, fps), want, `stream, trial ${trial} ${JSON.stringify(segments)}`);
    assert.deepEqual(await pulled(frames, fps), want, `pull, trial ${trial} ${JSON.stringify(segments)}`);
  }
});

test("frames with no freeze are read only at the samples: two per 0.1 s, not every frame", async () => {
  const frames = sequence([["move", 300]]);
  const read = new Set();
  const scan = await scanFreezes((i) => (read.add(i), frames[i]), { frameCount: frames.length, fps: FPS });
  assert.deepEqual(scan.runs, []);
  assert.deepEqual(scan.recheckSpans, []);
  assert.equal(read.size, 200, "100 samples x (frame, next frame)");
});

test("a long freeze streams with a bounded look-back: 10 min of one still frame is one run", () => {
  const still = Buffer.alloc(SIZE, 90);
  const s = createFreezeStream({ fps: FPS });
  for (let i = 0; i < 10 * 60 * FPS; i++) s.push(still);
  const { runs } = s.finish();
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].durationSec - (10 * 60 * FPS - 1) / FPS) < 1e-6);
});
