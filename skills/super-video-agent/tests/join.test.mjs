// join.mjs end to end: two generated color+tone clips (no ffmpeg mocking —
// ffmpeg is a local dependency already required by the rest of the
// pipeline) joined into one file, checked for duration and a sane report.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, probeDuration, probeFrameCount } from "../scripts/lib/ffmpeg.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";
import { probeStreamDurations } from "../scripts/lib/join-report-media.mjs";
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

// A part whose audio track is longer or shorter than its video (the AAC
// overhang of a real render, exaggerated). Video = `videoSec` at 10 fps;
// audio = `expr` for `audioSec`.
async function makeMismatchedClip(outPath, { color, videoSec, audioSec, expr }) {
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64:d=${videoSec}:r=10`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${expr}:s=48000:d=${audioSec}`,
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

/** First 10 ms window at or after `fromSec` whose RMS is above -30 dBFS. */
function firstSoundAfter(pcm, sampleRate, fromSec) {
  const win = Math.round(sampleRate * 0.01);
  const thr = Math.pow(10, -30 / 20);
  for (let i = Math.round(fromSec * sampleRate); i + win <= pcm.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += pcm[k] * pcm[k];
    if (Math.sqrt(s / win) > thr) return i / sampleRate;
  }
  return null;
}

async function joinQuietly(args) {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await main(args);
  } finally {
    process.stdout.write = origWrite;
  }
}

for (const [label, firstAudioSec] of [
  ["audio longer than video (overhang)", 1.3],
  ["audio shorter than video", 0.6],
]) {
  test(`join.mjs main(): ${label} — the joined audio matches the picture and the next part's sound starts on its own frame`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-join-trim-"));
    const partA = path.join(tmp, "a.mp4");
    const partB = path.join(tmp, "b.mp4");
    const outPath = path.join(tmp, "joined.mp4");
    await makeMismatchedClip(partA, { color: "red", videoSec: 1, audioSec: firstAudioSec, expr: "0.5*sin(2*PI*220*t)" });
    // Part B is silent for 0.5 s, then a tone: its sound belongs at 1.0 + 0.5 = 1.5 s.
    await makeMismatchedClip(partB, { color: "blue", videoSec: 1, audioSec: 1, expr: "if(gt(t\\,0.5)\\,0.5*sin(2*PI*880*t)\\,0)" });

    await joinQuietly([outPath, partA, partB]);

    const { videoSec, audioSec } = await probeStreamDurations(outPath);
    assert.ok(Math.abs(videoSec - 2) < 0.02, `video ~2.0 s, got ${videoSec}`);
    assert.ok(Math.abs(audioSec - videoSec) < 0.03, `audio ${audioSec}s should match video ${videoSec}s`);
    assert.equal(await probeFrameCount(outPath), 20, "no held frame: 10 + 10 frames");

    const pcm = await decodeMonoPcm(outPath, 48000);
    const onset = firstSoundAfter(pcm, 48000, 1.05);
    assert.ok(onset != null && Math.abs(onset - 1.5) < 0.03, `part B's tone should start at ~1.50 s, got ${onset}`);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

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
