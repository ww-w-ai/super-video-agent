// scripts/lib/join-report-media.mjs: pure span/blackdetect parsing, and
// stream-length probing on a generated clip whose audio outlasts its video.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import { partSpans, parseBlackDetect, probeStreamDurations } from "../scripts/lib/join-report-media.mjs";

test("partSpans: cut times become consecutive spans covering the whole file", () => {
  assert.deepEqual(partSpans([8, 48], 60), [
    { index: 0, startSec: 0, durationSec: 8 },
    { index: 1, startSec: 8, durationSec: 40 },
    { index: 2, startSec: 48, durationSec: 12 },
  ]);
  assert.deepEqual(partSpans([], 5), [{ index: 0, startSec: 0, durationSec: 5 }]);
  assert.equal(partSpans([0, 70], 60).length, 1, "cuts outside (0, total) are ignored");
});

test("parseBlackDetect: reads every black run from ffmpeg's log", () => {
  const log =
    "[blackdetect @ 0x1] black_start:0 black_end:0.5 black_duration:0.5\n" +
    "frame=...\n[blackdetect @ 0x1] black_start:12.3 black_end:12.4 black_duration:0.1\n";
  assert.deepEqual(parseBlackDetect(log), [
    { startSec: 0, endSec: 0.5, durationSec: 0.5 },
    { startSec: 12.3, endSec: 12.4, durationSec: 0.1 },
  ]);
  assert.deepEqual(parseBlackDetect("nothing here"), []);
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
