// scripts/lib/join-report-media.mjs: pure spans and black-frame runs, stream-length
// probing, and the single-decode picture scan on generated clips.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import { partSpans, probeStreamDurations, isBlackFrame, createBlackRuns, scanFilePicture } from "../scripts/lib/join-report-media.mjs";

test("isBlackFrame: 98 % of pixels at or under grey 25 (blackdetect pix_th 0.10, pic_th 0.98)", () => {
  assert.equal(isBlackFrame(Buffer.alloc(100, 25)), true);
  assert.equal(isBlackFrame(Buffer.alloc(100, 26)), false);
  const almost = Buffer.alloc(100, 0);
  almost.fill(200, 0, 3); // 97 % black
  assert.equal(isBlackFrame(almost), false);
  almost[2] = 0; // 98 % black
  assert.equal(isBlackFrame(almost), true);
});

test("createBlackRuns: start, end (first frame after) and duration like blackdetect; a single frame counts", () => {
  const runs = createBlackRuns(10);
  for (const b of [true, true, true, false, false, true, false]) runs.push(b);
  const got = runs.finish().map((r) => [r.startSec, r.endSec, r.durationSec].map((v) => Math.round(v * 1000) / 1000));
  assert.deepEqual(got, [[0, 0.3, 0.3], [0.5, 0.6, 0.1]]);
  const tail = createBlackRuns(10);
  for (const b of [false, true, true]) tail.push(b);
  assert.equal(tail.finish().length, 1, "a run that reaches the end is closed");
});

test("partSpans: cut times become consecutive spans covering the whole file", () => {
  assert.deepEqual(partSpans([8, 48], 60), [
    { index: 0, startSec: 0, durationSec: 8 },
    { index: 1, startSec: 8, durationSec: 40 },
    { index: 2, startSec: 48, durationSec: 12 },
  ]);
  assert.deepEqual(partSpans([], 5), [{ index: 0, startSec: 0, durationSec: 5 }]);
  assert.equal(partSpans([0, 70], 60).length, 1, "cuts outside (0, total) are ignored");
});


test("probeStreamDurations: reports video and audio stream lengths separately", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-streams-"));
  const clip = path.join(tmp, "c.mp4");
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip,
  ]);
  const { videoSec, audioSec } = await probeStreamDurations(clip);
  assert.ok(Math.abs(videoSec - 1) < 0.02, `video ${videoSec}`);
  assert.ok(audioSec > 1.35, `audio ${audioSec} should outlast the video`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("scanFilePicture: one decode feeds freeze, black and frame counts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-picture-"));
  const clip = path.join(tmp, "c.mp4");
  // 0.5 s black, 1.2 s still red, 1.3 s moving test pattern, 10 fps.
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.5:r=10", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1.2:r=10",
    "-f", "lavfi", "-i", "testsrc=s=64x64:d=1.3:r=10", "-filter_complex", "[0][1][2]concat=n=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
  ]);
  const spawned = [];
  const spawnFn = (bin, args, opts) => {
    spawned.push([bin, ...args].join(" "));
    return spawn(bin, args, opts);
  };
  const r = await scanFilePicture(clip, { width: 64, height: 64, fps: 10, expectedSec: 3, spawnFn });
  assert.equal(spawned.length, 1, `one decode, got: ${spawned.join(" | ")}`);
  assert.deepEqual(r.frames, { decoded: 30, expected: 30, decodedMinusExpected: 0, identicalNeighbours: r.frames.identicalNeighbours });
  assert.ok(r.frames.identicalNeighbours >= 10, `the still red holds repeat frames: ${r.frames.identicalNeighbours}`);
  assert.equal(r.blackRuns.length, 1);
  assert.ok(r.blackRuns[0].startSec === 0 && Math.abs(r.blackRuns[0].endSec - 0.5) < 1e-9, JSON.stringify(r.blackRuns));
  assert.equal(r.freezeRuns.length, 1, JSON.stringify(r.freezeRuns));
  assert.ok(Math.abs(r.freezeRuns[0].startSec - 0.5) < 1e-9 && Math.abs(r.freezeRuns[0].durationSec - 1.1) < 1e-9, JSON.stringify(r.freezeRuns));
  fs.rmSync(tmp, { recursive: true, force: true });
});
