// review.mjs --file: facts about one finished video with no page — stream
// lengths, loudness whole and per part, picture dead air, silence, black
// runs. Fixture: 3 s at 10 fps, black for 0.5 s then a still red frame;
// audio runs 0.2 s past the picture, loud for 1.5 s then 14 dB quieter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import { main, reviewFile, parseParts } from "../scripts/review.mjs";

async function makeFixture(outPath) {
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:d=3:r=10,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,0.5)'",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(lt(t\\,1.5)\\,0.5\\,0.1)*sin(2*PI*440*t):s=48000:d=3.2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    outPath,
  ]);
}

test("parseParts: ascending positive seconds only", () => {
  assert.deepEqual(parseParts("8.03, 41.5"), [8.03, 41.5]);
  assert.throws(() => parseParts("5,3"), /ascending/);
  assert.throws(() => parseParts("a"), /positive seconds/);
});

test("reviewFile: stream delta, per-part loudness, dead air and black runs of a joined-style file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-review-file-"));
  const clip = path.join(tmp, "upload.mp4");
  await makeFixture(clip);

  const r = await reviewFile({ file: clip, cuts: [1.5] });

  assert.ok(Math.abs(r.streams.videoSec - 3) < 0.02, `video ${r.streams.videoSec}`);
  assert.ok(Math.abs(r.streams.audioMinusVideoMs - 200) < 60, `audio overhang ~200 ms, got ${r.streams.audioMinusVideoMs}`);

  assert.equal(typeof r.loudness.whole.integratedLufs, "number");
  assert.equal(r.loudness.parts.length, 2);
  const [loud, quiet] = r.loudness.parts;
  assert.ok(Math.abs(loud.durationSec - 1.5) < 1e-6 && Math.abs(quiet.startSec - 1.5) < 1e-6);
  assert.ok(loud.integratedLufs - quiet.integratedLufs > 10, `part 0 should be ~14 LU louder: ${loud.integratedLufs} vs ${quiet.integratedLufs}`);
  assert.equal(r.loudness.spread.warn, true);

  assert.ok(r.black.runs.length >= 1, "the black opening is reported");
  assert.ok(r.black.runs[0].startSec < 0.05 && Math.abs(r.black.runs[0].endSec - 0.5) < 0.15, JSON.stringify(r.black.runs));

  assert.ok(r.deadAir.runs.length >= 1, "the still red picture is reported as dead air");
  assert.ok(r.deadAir.runs.some((x) => x.durationSec >= 2), JSON.stringify(r.deadAir.runs));

  assert.ok(r.silence.firstSoundSec != null && r.silence.firstSoundSec < 0.05);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("review.mjs main() --file --json --out: needs no reel directory and writes the report", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-review-file-cli-"));
  const clip = path.join(tmp, "upload.mp4");
  const out = path.join(tmp, "report.json");
  await makeFixture(clip);

  let captured = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    await main(["--file", clip, "--parts", "1.5", "--json", "--out", out]);
  } finally {
    process.stdout.write = origWrite;
  }
  const printed = JSON.parse(captured);
  assert.equal(printed.loudness.parts.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).streams, printed.streams);

  fs.rmSync(tmp, { recursive: true, force: true });
});
