// Sprint A4: render.mjs span render (N1), unique temp names (L6), picture/bed/
// timings pair checks (39) and the picture-length finding (L5/N18). Pure logic
// plus small ffmpeg fixtures; no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  uniqueTempPath,
  parseSpanFlag,
  planSpanFrames,
  planSpanSplice,
  spliceSpanPieces,
  pictureDurationFinding,
  pairProblems,
  checkPicturePair,
  frameHashes,
} from "../scripts/render.mjs";
import { ffmpeg, probeFrameCount } from "../scripts/lib/ffmpeg.mjs";

const FPS = 30;
const SEGS = [
  { id: "a", frameStart: 0, frameEnd: 30 },
  { id: "b", frameStart: 30, frameEnd: 60 },
  { id: "c", frameStart: 60, frameEnd: 90 },
];

test("uniqueTempPath: keeps stem and extension, carries µs and pid, never repeats", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(uniqueTempPath("/o/_video.mp4"));
  assert.equal(seen.size, 2000);
  const p = uniqueTempPath("/o/_video.mp4");
  assert.match(p, new RegExp(`^/o/_video-\\d{16}-${process.pid}\\.mp4$`));
  assert.match(uniqueTempPath("/o/final.mp4.tmp"), /^\/o\/final\.mp4-\d{16}-\d+\.tmp$/);
  assert.match(uniqueTempPath("/o/_insert"), /^\/o\/_insert-\d{16}-\d+$/);
});

test("parseSpanFlag: one or several spans; bad input names the format", () => {
  assert.deepEqual(parseSpanFlag("12.5-15"), [{ fromSec: 12.5, toSec: 15 }]);
  assert.deepEqual(parseSpanFlag("3-4, 40-42.5"), [{ fromSec: 3, toSec: 4 }, { fromSec: 40, toSec: 42.5 }]);
  for (const bad of [true, "", "5", "5-", "-5", "6-5", "5-5", "a-b", "1-2,"]) {
    assert.throws(() => parseSpanFlag(bad), /--span takes <from>-<to> seconds/, String(bad));
  }
});

test("planSpanFrames: 0.5 s margin each side, snapped outward, clamped, merged", () => {
  const one = planSpanFrames({ spans: [{ fromSec: 1.01, toSec: 1.5 }], fps: FPS, filmStart: 0, filmEnd: 90 });
  assert.deepEqual(one, [{ startFrame: 15, endFrame: 60 }]); // floor(0.51*30)=15, ceil(2.0*30)=60
  const clamped = planSpanFrames({ spans: [{ fromSec: 0.2, toSec: 2.9 }], fps: FPS, filmStart: 0, filmEnd: 90 });
  assert.deepEqual(clamped, [{ startFrame: 0, endFrame: 90 }]);
  const merged = planSpanFrames({ spans: [{ fromSec: 40 / FPS, toSec: 2 }, { fromSec: 0.1, toSec: 0.2 }], fps: FPS, filmStart: 0, filmEnd: 300 });
  assert.deepEqual(merged, [{ startFrame: 0, endFrame: 21 }, { startFrame: 25, endFrame: 75 }]);
  const touching = planSpanFrames({ spans: [{ fromSec: 2, toSec: 3 }, { fromSec: 4, toSec: 5 }], fps: FPS, filmStart: 0, filmEnd: 300 });
  assert.deepEqual(touching, [{ startFrame: 45, endFrame: 165 }]); // [45,105) and [105,165) touch
  assert.throws(() => planSpanFrames({ spans: [{ fromSec: 50, toSec: 51 }], fps: FPS, filmStart: 0, filmEnd: 90 }), /lies outside the film/);
});

test("planSpanSplice: pieces tile each touched segment exactly; untouched segments are absent", () => {
  const plan = planSpanSplice({ segments: SEGS, ranges: [{ startFrame: 40, endFrame: 70 }] });
  assert.deepEqual(plan.map((t) => t.id), ["b", "c"]);
  assert.deepEqual(plan[0].pieces, [{ kind: "old", from: 0, to: 10 }, { kind: "new", from: 40, to: 60 }]);
  assert.deepEqual(plan[1].pieces, [{ kind: "new", from: 60, to: 70 }, { kind: "old", from: 10, to: 30 }]);
  for (const t of plan) {
    const n = t.pieces.reduce((sum, p) => sum + p.to - p.from, 0);
    assert.equal(n, t.segment.frameEnd - t.segment.frameStart);
  }
});

test("planSpanSplice: two ranges in one segment leave old pieces between and around", () => {
  const [t] = planSpanSplice({ segments: SEGS, ranges: [{ startFrame: 2, endFrame: 5 }, { startFrame: 10, endFrame: 12 }] });
  assert.deepEqual(t.pieces.map((p) => `${p.kind}:${p.from}-${p.to}`), ["old:0-2", "new:2-5", "old:5-10", "new:10-12", "old:12-30"]);
});

test("planSpanSplice: a range covering a whole segment yields one new piece", () => {
  const plan = planSpanSplice({ segments: SEGS, ranges: [{ startFrame: 0, endFrame: 90 }] });
  assert.equal(plan.length, 3);
  assert.ok(plan.every((t) => t.pieces.length === 1 && t.pieces[0].kind === "new"));
});

test("pictureDurationFinding: within 50 ms is fine; otherwise names the right value and both fixes", () => {
  assert.equal(pictureDurationFinding({ pictureSec: 10, timingsSec: 10.04, frames: 300, fps: 30, timingsPath: "t.json" }), null);
  const f = pictureDurationFinding({ pictureSec: 10, timingsSec: 12.5, frames: 300, fps: 30, timingsPath: "voice/timings.json" });
  assert.equal(f.right, 10);
  assert.match(f.message, /picture length 10s \(the page's 300 frames at 30 fps\) differs from the timings duration \(12\.5s\)/);
  assert.match(f.message, /is the right value/);
  assert.match(f.message, /set "duration" to 10 in out\/picture\.timings\.json/);
  assert.match(f.message, /--fix-picture-duration/);
  assert.match(pictureDurationFinding({ pictureSec: 10, timingsSec: undefined, frames: 300, fps: 30, timingsPath: "t" }).message, /no numeric duration/);
});

test("pairProblems: stamps, bed length, timings length", () => {
  assert.deepEqual(pairProblems({ videoSec: 10, bedSec: 10.01, timingsSec: 10, videoStamp: "20260101-000000", bedStamp: "20260101-000000" }), []);
  assert.match(pairProblems({ videoSec: 10, bedSec: 10, videoStamp: "20260101-000000", bedStamp: "20260101-000100" })[0], /different renders/);
  assert.match(pairProblems({ videoSec: 10, bedSec: 7.2 })[0], /picture is 10\.000s but the bed is 7\.200s/);
  assert.match(pairProblems({ videoSec: 10, bedSec: 10, timingsSec: 12 })[0], /timings duration is 12s \(the picture length is the right value\)/);
  assert.deepEqual(pairProblems({ videoSec: 10, bedSec: 10, timingsSec: null }), []);
  assert.equal(pairProblems({ videoSec: 10, bedSec: 10, timingsSec: NaN }).length, 1);
});

// ---- ffmpeg fixtures ----------------------------------------------------

// Encodes lavfi frames the way render.mjs encodes a segment (image pipe, libx264).
async function encode(src, frames, outPath) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `${src}=size=160x120:rate=${FPS}`, "-frames:v", String(frames), "-f", "image2pipe", "-c:v", "png", `${outPath}.pngs`]);
  await ffmpeg(["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", `${outPath}.pngs`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", outPath]);
  fs.rmSync(`${outPath}.pngs`);
}

test("spliceSpanPieces: exact frame count, new frames equal the rendered piece, head cut from the old segment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-span-"));
  try {
    const old = path.join(dir, "old.mp4");
    await encode("testsrc", 30, old);
    const newPiece = path.join(dir, "new-src.mp4");
    await encode("smptebars", 8, newPiece);
    const pieces = [{ kind: "old", from: 0, to: 10 }, { kind: "new", from: 10, to: 18 }, { kind: "old", from: 18, to: 30 }];
    const renderNew = async (_p, outPath) => fs.copyFileSync(newPiece, outPath);
    const workDir = path.join(dir, "work");
    fs.mkdirSync(workDir);
    const built = await spliceSpanPieces({ pieces, oldPath: old, renderNew, fps: FPS, crf: 18, preset: "medium", workDir });
    assert.equal(await probeFrameCount(built), 30);
    const out = await frameHashes(built);
    const fresh = await frameHashes(newPiece);
    assert.deepEqual(out.slice(10, 18), fresh);
    assert.notDeepEqual(out.slice(0, 10), fresh.slice(0, 10));
    const oldHashes = await frameHashes(old);
    assert.notDeepEqual(out.slice(10, 18), oldHashes.slice(10, 18));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spliceSpanPieces: a segment wholly inside the span is the rendered piece itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-span-"));
  try {
    const newPiece = path.join(dir, "new-src.mp4");
    await encode("smptebars", 30, newPiece);
    const built = await spliceSpanPieces({
      pieces: [{ kind: "new", from: 0, to: 30 }],
      oldPath: path.join(dir, "absent.mp4"),
      renderNew: async (_p, outPath) => fs.copyFileSync(newPiece, outPath),
      fps: FPS, crf: 18, preset: "medium", workDir: dir,
    });
    assert.deepEqual(await frameHashes(built), await frameHashes(newPiece));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function writePair(outDir, { stem = "picture", videoStamp, bedStamp, videoFrames = 30, bedSec = 1, timingsSec = 1 }) {
  const video = path.join(outDir, `${stem}-${videoStamp}.mp4`);
  const bed = path.join(outDir, `${stem}-${bedStamp}.bed.wav`);
  await encode("testsrc", videoFrames, video);
  await ffmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(bedSec), "-c:a", "pcm_s16le", bed]);
  fs.writeFileSync(path.join(outDir, `${stem}.timings.json`), JSON.stringify({ duration: timingsSec, lines: [] }));
  fs.symlinkSync(path.basename(video), path.join(outDir, `${stem}.mp4`));
  fs.symlinkSync(path.basename(bed), path.join(outDir, `${stem}.bed.wav`));
}

test("checkPicturePair: a pair from one render passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-pair-"));
  try {
    await writePair(dir, { videoStamp: "20261007-101010", bedStamp: "20261007-101010" });
    assert.deepEqual(await checkPicturePair({ outDir: dir }), { ok: true, problems: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPicturePair: bed from another render, short bed, wrong timings and missing files are refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-pair-"));
  try {
    await writePair(dir, { videoStamp: "20261007-101010", bedStamp: "20261007-090000", bedSec: 0.6, timingsSec: 2.5 });
    const r = await checkPicturePair({ outDir: dir });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems.join("\n"), /different renders/);
    assert.match(r.problems.join("\n"), /bed is 0\.600s/);
    assert.match(r.problems.join("\n"), /timings duration is 2\.5s/);
    fs.rmSync(path.join(dir, "picture.timings.json"));
    assert.match((await checkPicturePair({ outDir: dir })).problems[0], /missing .*picture\.timings\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPicturePair: a language picture reads the picture-<code> files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-pair-"));
  try {
    await writePair(dir, { stem: "picture-zh-Hans", videoStamp: "20261007-101010", bedStamp: "20261007-101010" });
    assert.equal((await checkPicturePair({ outDir: dir, lang: "zh-Hans" })).ok, true);
    assert.equal((await checkPicturePair({ outDir: dir })).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
