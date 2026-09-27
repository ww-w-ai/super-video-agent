// clampAtempoRate is pure; applyAtempo is exercised against real ffmpeg on
// a synthetic silent wav (no network, ffmpeg is a local dependency already
// required by the rest of the pipeline).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampAtempoRate, applyAtempo, ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";

test("clampAtempoRate: clamps to [0.8, 1.3], passes values inside the range through", () => {
  assert.equal(clampAtempoRate(0.5), 0.8);
  assert.equal(clampAtempoRate(2.0), 1.3);
  assert.equal(clampAtempoRate(1.1), 1.1);
});

test("applyAtempo: speeding up 1.25x shortens a fixed-duration clip by ~1/1.25", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-atempo-"));
  const inPath = path.join(tmp, "in.wav");
  const outPath = path.join(tmp, "out.wav");
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "2.000",
    "-c:a",
    "pcm_s16le",
    inPath,
  ]);
  await applyAtempo(inPath, outPath, 1.25);
  const outDuration = await probeDuration(outPath);
  assert.ok(Math.abs(outDuration - 2 / 1.25) < 0.05, `expected ~1.6s, got ${outDuration}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
