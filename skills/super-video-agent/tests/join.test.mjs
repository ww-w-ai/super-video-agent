// join.mjs end to end: two generated color+tone clips (no ffmpeg mocking —
// ffmpeg is a local dependency already required by the rest of the
// pipeline) joined into one file, checked for duration and a sane report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";
import { main } from "../scripts/join.mjs";

async function makeClip(outPath, { color, freq, durationSec }) {
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64:d=${durationSec}:r=10`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${durationSec}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    outPath,
  ]);
}

test("join.mjs main(): joins two parts, reports loudness and one join with sane facts", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-join-e2e-"));
  const partA = path.join(tmp, "a.mp4");
  const partB = path.join(tmp, "b.mp4");
  const outPath = path.join(tmp, "joined.mp4");

  await makeClip(partA, { color: "red", freq: 220, durationSec: 1 });
  await makeClip(partB, { color: "blue", freq: 880, durationSec: 1.5 });

  let captured = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return origWrite(chunk, ...rest);
  };
  try {
    await main([outPath, partA, partB, "--json"]);
  } finally {
    process.stdout.write = origWrite;
  }

  assert.ok(fs.existsSync(outPath), "joined file should exist");
  const outDuration = await probeDuration(outPath);
  assert.ok(Math.abs(outDuration - 2.5) < 0.15, `expected ~2.5s, got ${outDuration}`);

  const report = JSON.parse(captured.trim());
  assert.equal(report.parts.length, 2);
  assert.equal(report.joins.length, 1);
  for (const p of report.parts) {
    assert.equal(typeof p.integratedLufs, "number");
  }
  const join = report.joins[0];
  assert.ok(join.atSec > 0.9 && join.atSec < 1.1, `join time should sit near the 1s cut, got ${join.atSec}`);
  assert.equal(typeof join.click.windowMaxStep, "number");
  assert.equal(typeof join.click.flagged, "boolean");
  // Red -> blue is a hard cut: the frames should differ by a lot, not a
  // near-zero match-cut value.
  assert.ok(join.meanPixelDiff > 10, `expected a visible cut, got diff ${join.meanPixelDiff}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("join.mjs main(): refuses to write over one of its own inputs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-join-guard-"));
  const partA = path.join(tmp, "a.mp4");
  const partB = path.join(tmp, "b.mp4");
  await makeClip(partA, { color: "green", freq: 300, durationSec: 0.5 });
  await makeClip(partB, { color: "yellow", freq: 600, durationSec: 0.5 });

  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
  };
  try {
    await main([partA, partA, partB]);
  } finally {
    process.exit = origExit;
  }
  assert.equal(exitCode, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});
