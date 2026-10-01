// render.mjs --insert (T05): flag parsing, the splice plan, and an ffmpeg
// fixture splice checked for exact frame count, framemd5 and grid timestamps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseInsertFlag,
  planInsert,
  spliceTrack,
  verifyInsertedSpan,
  frameHashes,
  writeInsertStills,
} from "../scripts/render.mjs";
import { ffmpeg, ffprobe, probeFrameCount } from "../scripts/lib/ffmpeg.mjs";

const FPS = 30;
const SEGS = [
  { id: "l1", frameStart: 0, frameEnd: 30 },
  { id: "l2", frameStart: 30, frameEnd: 60 },
  { id: "l3", frameStart: 60, frameEnd: 90 },
];

test("parseInsertFlag: splits on the last @", () => {
  const r = parseInsertFlag("/a/b@c/clip.mp4@1.5");
  assert.equal(r.clipPath, "/a/b@c/clip.mp4");
  assert.equal(r.startSec, 1.5);
  for (const bad of [true, "clip.mp4", "clip.mp4@", "@2", "clip.mp4@x", "clip.mp4@-1"]) {
    assert.throws(() => parseInsertFlag(bad), /--insert takes <clip\.mp4>@<start-sec>/, String(bad));
  }
});

test("planInsert: clip on segment boundaries covers whole segments", () => {
  const p = planInsert({ segments: SEGS, startSec: 0, fps: FPS, clipFrames: 60 });
  assert.deepEqual(p.pieces.map((x) => x.kind + (x.id ? ":" + x.id : "")), ["clip", "segment:l3"]);
  assert.deepEqual(p.coveredIds, ["l1", "l2"]);
  assert.deepEqual(p.partialIds, []);
  assert.equal(p.snapped, false);
});

test("planInsert: clip inside segments keeps head and tail parts; frames add up", () => {
  const p = planInsert({ segments: SEGS, startSec: 40 / FPS, fps: FPS, clipFrames: 30 });
  assert.deepEqual(
    p.pieces.map((x) => (x.kind === "part" ? `part:${x.id}:${x.from}-${x.to}` : x.kind + (x.id ? ":" + x.id : ""))),
    ["segment:l1", "part:l2:0-10", "clip", "part:l3:10-30"]
  );
  assert.deepEqual(p.partialIds, ["l2", "l3"]);
  assert.equal(p.pieces.reduce((n, x) => n + x.frames, 0), 90);
  assert.deepEqual([p.startFrame, p.endFrame], [40, 70]);
});

test("planInsert: clip at the very end, off-grid start snaps, out of range throws", () => {
  const end = planInsert({ segments: SEGS, startSec: 2, fps: FPS, clipFrames: 30 });
  assert.deepEqual(end.pieces.map((x) => x.kind), ["segment", "segment", "clip"]);
  const snapped = planInsert({ segments: SEGS, startSec: 1.01, fps: FPS, clipFrames: 10 });
  assert.equal(snapped.startFrame, 30);
  assert.equal(snapped.snapped, true);
  assert.throws(() => planInsert({ segments: SEGS, startSec: 2.5, fps: FPS, clipFrames: 30 }), /does not fit the film's frames \[0,90\)/);
  assert.throws(() => planInsert({ segments: SEGS, startSec: 0, fps: FPS, clipFrames: 0 }), /no frames/);
});

// Encodes `frames` frames of a lavfi source the way render.mjs encodes a
// segment (libx264, yuv420p, crf 18, preset medium) — through an image
// pipe, so the encoder sees the same kind of input.
async function encode(src, frames, outPath, size = "160x120", crf = 18) {
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", `${src}=size=${size}:rate=${FPS}`, "-frames:v", String(frames),
    "-f", "image2pipe", "-c:v", "png", outPath + ".pngs",
  ]);
  await ffmpeg([
    "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", outPath + ".pngs",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", "medium", outPath,
  ]);
  fs.rmSync(outPath + ".pngs");
}

async function packetTimes(file) {
  const { stdout } = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base:packet=pts,dts", "-of", "json", file]);
  const j = JSON.parse(stdout.toString());
  const [num, den] = j.streams[0].time_base.split("/").map(Number);
  return { tb: num / den, packets: j.packets };
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-insert-"));
  const seg = (id) => path.join(dir, `${id}.mp4`);
  await encode("testsrc", 30, seg("l1"));
  await encode("testsrc2", 30, seg("l2"));
  await encode("rgbtestsrc", 30, seg("l3"));
  return { dir, seg };
}

async function spliceAndCheck({ dir, seg }, { startSec, clipPath }) {
  const clipFrames = await probeFrameCount(clipPath);
  const plan = planInsert({ segments: SEGS, startSec, fps: FPS, clipFrames });
  const outPath = path.join(dir, `out-${plan.startFrame}.mp4`);
  const result = await spliceTrack({
    pieces: plan.pieces, segmentPath: seg, clipPath, fps: FPS, crf: 18, preset: "medium",
    workDir: path.join(dir, `_insert-${plan.startFrame}`), outPath,
  });
  await verifyInsertedSpan({ outPath, clipPath: result.clipUsed, startFrame: plan.startFrame, expectedFrames: 90 });
  // independent checks of the same facts
  assert.equal(await probeFrameCount(outPath), 90);
  const out = await frameHashes(outPath);
  const clip = await frameHashes(result.clipUsed);
  assert.deepEqual(out.slice(plan.startFrame, plan.endFrame), clip);
  const { tb, packets } = await packetTimes(outPath);
  for (const p of packets) {
    for (const v of [p.pts, p.dts]) {
      const frames = v * tb * FPS;
      assert.ok(Math.abs(frames - Math.round(frames)) < 1e-9, `timestamp ${v} is off the 1/${FPS} grid`);
    }
  }
  return { plan, result, out, outPath };
}

test("spliceTrack: clip on segment boundaries — 90 frames, span framemd5 equals the clip, untouched segments bit-equal", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip.mp4");
    await encode("smptebars", 30, clipPath);
    const { result, out } = await spliceAndCheck(fx, { startSec: 1, clipPath });
    assert.equal(result.clipReencoded, false);
    assert.equal(result.clipUsed, clipPath);
    assert.deepEqual(out.slice(0, 30), await frameHashes(fx.seg("l1")));
    assert.deepEqual(out.slice(60, 90), await frameHashes(fx.seg("l3")));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("spliceTrack: clip inside segments — partial segments re-encoded, still exact count and span", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip.mp4");
    await encode("smptebars", 30, clipPath);
    const { result, out } = await spliceAndCheck(fx, { startSec: 40 / FPS, clipPath });
    assert.equal(result.clipReencoded, false);
    assert.deepEqual(out.slice(0, 30), await frameHashes(fx.seg("l1")));
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("spliceTrack: a clip of another size is re-encoded first; span matches the re-encoded clip", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip-big.mp4");
    await encode("smptebars", 20, clipPath, "320x240");
    const { result } = await spliceAndCheck(fx, { startSec: 0.5, clipPath });
    assert.equal(result.clipReencoded, true);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("spliceTrack: a same-size clip encoded elsewhere (colour tags, other crf) is re-encoded to the segments' headers", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip-tagged.mp4");
    // direct lavfi encode: carries tv range / bt470bg tags and a 1:1 SAR the image-pipe segments lack
    await ffmpeg(["-y", "-f", "lavfi", "-i", `smptebars=size=160x120:rate=${FPS}`, "-frames:v", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-preset", "veryfast", clipPath]);
    const { result } = await spliceAndCheck(fx, { startSec: 1, clipPath });
    assert.equal(result.clipReencoded, true);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("verifyInsertedSpan: fails on a wrong frame count and on a span that is not the clip", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip.mp4");
    await encode("smptebars", 30, clipPath);
    await assert.rejects(verifyInsertedSpan({ outPath: fx.seg("l1"), clipPath, startFrame: 0, expectedFrames: 90 }), /frame count gate failed: joined video has 30 frames/);
    await assert.rejects(verifyInsertedSpan({ outPath: fx.seg("l1"), clipPath, startFrame: 0, expectedFrames: 30 }), /framemd5 gate failed: film frame 0 differs/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("writeInsertStills: one JPEG per clip frame named by film frame, plus stills.json", async () => {
  const fx = await fixture();
  try {
    const clipPath = path.join(fx.dir, "clip.mp4");
    await encode("smptebars", 12, clipPath);
    const dir = path.join(fx.dir, "stills");
    await writeInsertStills({ clipPath, dir, startFrame: 45, count: 12, fps: FPS });
    const jpgs = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    assert.equal(jpgs.length, 12);
    assert.equal(jpgs[0], "frame-000045.jpg");
    assert.equal(jpgs[11], "frame-000056.jpg");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "stills.json"), "utf8")), { fps: FPS, startFrame: 45, count: 12, pattern: "frame-%06d.jpg" });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
