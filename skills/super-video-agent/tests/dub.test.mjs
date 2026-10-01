// ffmpeg-backed test for dub.mjs's measureEdgeEnvelope (feeds
// trimEdgeSilence, scripts/lib/dub-timing.mjs) — a generated silence+tone+
// silence wav, no network, ffmpeg is a local dependency already required by
// the rest of the pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";
import { trimEdgeSilence } from "../scripts/lib/dub-timing.mjs";
import { measureEdgeEnvelope } from "../scripts/dub.mjs";
import { computeGapDeltas, buildTimeMap, segmentFactors, buildSpaceFilterGraph, buildSpaceFfmpegArgs } from "../scripts/lib/dub-space.mjs";

/** Frame `index` of `mp4`, scaled to 16x16 gray bytes. */
async function frameBytes(mp4, index) {
  const { stdout } = await ffmpeg(["-i", mp4, "-vf", `select=eq(n\\,${index}),scale=16:16`, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]);
  return stdout;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function frameCountOf(mp4) {
  const { stdout } = await ffmpeg(["-i", mp4, "-map", "0:v", "-f", "framemd5", "pipe:1"]);
  return stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).length;
}

test("--min-gap ffmpeg step (T19): one call writes both outputs; length grows by the deltas; first and last frames unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-dub-space-"));
  try {
    const src = path.join(tmp, "picture.mp4");
    const bed = path.join(tmp, "bed.wav");
    // 3 s, 30 fps, a moving pattern so frames differ from each other.
    await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=3", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", src]);
    await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", bed]);

    const baseLines = [
      { id: "a", start: 0.5, end: 1.2 },
      { id: "b", start: 1.5, end: 2.5 },
    ];
    const placed = [
      { id: "a", start: 0.5, end: 1.4 }, // 0.1 s gap
      { id: "b", start: 1.5, end: 2.6 },
    ];
    const deltas = computeGapDeltas(baseLines, placed, 0.5);
    const map = buildTimeMap(baseLines, 3, deltas.map((d) => d.delta));
    assert.ok(Math.abs(map.newDuration - 3.4) < 1e-9);
    const frameCount = Math.round(map.newDuration * 30);
    const outMp4 = path.join(tmp, "spaced.mp4");
    const outWav = path.join(tmp, "spaced.wav");
    const graph = buildSpaceFilterGraph(segmentFactors(map), 30, map.newDuration);
    await ffmpeg(buildSpaceFfmpegArgs({ pictureMp4: src, bedWav: bed, outMp4, outWav, graph, frameCount }));

    assert.equal(await frameCountOf(outMp4), 102);
    const bedDur = await probeDuration(outWav);
    assert.ok(Math.abs(bedDur - 3.4) < 0.01, `bed ${bedDur}`);

    const srcFirst = await frameBytes(src, 0);
    const srcLast = await frameBytes(src, 89);
    const srcMid = await frameBytes(src, 45);
    const outFirst = await frameBytes(outMp4, 0);
    const outLast = await frameBytes(outMp4, 101);
    assert.ok(meanAbsDiff(outFirst, srcFirst) < 3, `first frame diff ${meanAbsDiff(outFirst, srcFirst)}`);
    assert.ok(meanAbsDiff(outLast, srcLast) < 3, `last frame diff ${meanAbsDiff(outLast, srcLast)}`);
    assert.ok(meanAbsDiff(outLast, srcMid) > meanAbsDiff(outLast, srcLast) + 1, "the frame comparison can tell frames apart");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("measureEdgeEnvelope + trimEdgeSilence: finds a generated 0.2s-silence / 0.6s-tone / 0.3s-silence take's edges", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-edge-trim-"));
  const wavPath = path.join(tmp, "take.wav");
  try {
    // silence, tone, silence, concatenated with the concat filter — one
    // real wav a take's edge silence looks like.
    await ffmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-filter_complex",
      "[0:a]atrim=0:0.2[s1];[1:a]atrim=0:0.6[tone];[2:a]atrim=0:0.3[s2];[s1][tone][s2]concat=n=3:v=0:a=1[out]",
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);

    const clipDurationSec = await probeDuration(wavPath);
    assert.ok(Math.abs(clipDurationSec - 1.1) < 0.02, `clipDurationSec=${clipDurationSec}`);

    const envelope = await measureEdgeEnvelope(wavPath);
    assert.ok(envelope.length > 0);

    const range = trimEdgeSilence(envelope, clipDurationSec, { thresholdDb: -45, padSec: 0.04 });
    // lead: 0.2s silence -> trimmed start ~0.2 - 0.04 pad = ~0.16
    assert.ok(Math.abs(range.trimmedStartSec - 0.16) < 0.03, `trimmedStartSec=${range.trimmedStartSec}`);
    // tail: tone ends at ~0.8, so trimmed end ~0.8 + 0.04 pad = ~0.84
    assert.ok(Math.abs(range.trimmedEndSec - 0.84) < 0.03, `trimmedEndSec=${range.trimmedEndSec}`);
    assert.ok(range.leadTrimSec > 0.1, `leadTrimSec=${range.leadTrimSec}`);
    assert.ok(range.tailTrimSec > 0.2, `tailTrimSec=${range.tailTrimSec}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
