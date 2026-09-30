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
