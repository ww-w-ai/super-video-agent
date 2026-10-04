// render.mjs --handle / --use-draft: the span math (clamped at the film's
// edges), the sidecar a draft is stored with, and the cut that takes the slot
// back out of a handled clip.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { draftSpan, draftSidecar, slotCut, draftsDir } from "../scripts/lib/drafts.mjs";
import { parseHandleFlag, cutDraftSlot, spliceTrack, planInsert } from "../scripts/render.mjs";
import { run, ffmpeg, probeFrameCount } from "../scripts/lib/ffmpeg.mjs";

const FPS = 30;
const SEGS = [
  { id: "a", frameStart: 0, frameEnd: 60 },
  { id: "b", frameStart: 60, frameEnd: 120 },
  { id: "c", frameStart: 120, frameEnd: 180 },
];

test("draftSpan: handle widens both sides of the slot", () => {
  const s = draftSpan({ segment: SEGS[1], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0.5 });
  assert.deepEqual(s, { frameStart: 45, frameEnd: 135, handleBefore: 15, handleAfter: 15 });
});

test("draftSpan: clamps at the film's start and end, and handle 0 is the slot itself", () => {
  const first = draftSpan({ segment: SEGS[0], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0.5 });
  assert.deepEqual(first, { frameStart: 0, frameEnd: 75, handleBefore: 0, handleAfter: 15 });
  const last = draftSpan({ segment: SEGS[2], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0.5 });
  assert.deepEqual(last, { frameStart: 105, frameEnd: 180, handleBefore: 15, handleAfter: 0 });
  const zero = draftSpan({ segment: SEGS[1], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0 });
  assert.deepEqual(zero, { frameStart: 60, frameEnd: 120, handleBefore: 0, handleAfter: 0 });
  assert.throws(() => draftSpan({ segment: SEGS[1], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: -1 }), /--handle/);
});

test("parseHandleFlag: absent is 0, bad values throw", () => {
  assert.equal(parseHandleFlag(undefined), 0);
  assert.equal(parseHandleFlag("0.5"), 0.5);
  for (const bad of [true, "", "x", "-0.5"]) assert.throws(() => parseHandleFlag(bad), /--handle takes seconds/, String(bad));
});

test("draftSidecar: records slot start/end, handle and frames gained", () => {
  const span = draftSpan({ segment: SEGS[1], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0.5 });
  const j = draftSidecar({ segment: SEGS[1], span, fps: FPS, handleSec: 0.5, quality: "preview", width: 160, height: 120 });
  assert.equal(j.id, "b");
  assert.equal(j.slotStart, 2);
  assert.equal(j.slotEnd, 4);
  assert.equal(j.handleSec, 0.5);
  assert.deepEqual([j.slotFrameStart, j.slotFrameEnd, j.frameStart, j.frameEnd, j.handleBefore, j.handleAfter], [60, 120, 45, 135, 15, 15]);
  assert.equal(j.quality, "preview");
});

test("slotCut: slot position inside the handled clip; inconsistent sidecar throws", () => {
  const span = draftSpan({ segment: SEGS[2], fps: FPS, filmStart: 0, filmEnd: 180, handleSec: 0.5 });
  const j = draftSidecar({ segment: SEGS[2], span, fps: FPS, handleSec: 0.5, quality: "final", width: 1, height: 1 });
  assert.deepEqual(slotCut(j), { from: 15, to: 75, frames: 60, startSec: 4 });
  assert.throws(() => slotCut({ ...j, slotFrameEnd: 999 }), /not inside the clip/);
});

async function psnr(a, b) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"]);
  const m = /average:(inf|[\d.]+)/.exec(stderr);
  return m[1] === "inf" ? Infinity : parseFloat(m[1]);
}

test("--use-draft: cuts exactly the slot frames out of the handled clip, and the splice keeps the film's frame count", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-draft-"));
  try {
    const outDir = path.join(tmp, "out");
    const dir = draftsDir(outDir);
    fs.mkdirSync(dir, { recursive: true });
    // film: 3 shots of 30 frames; draft of shot b (frames 30..60) with a 10-frame handle = frames [20,70)
    const segs = [
      { id: "a", frameStart: 0, frameEnd: 30 },
      { id: "b", frameStart: 30, frameEnd: 60 },
      { id: "c", frameStart: 60, frameEnd: 90 },
    ];
    const enc = async (src, frames, out) =>
      ffmpeg(["-y", "-f", "lavfi", "-i", `${src}=size=160x120:rate=${FPS}`, "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", out]);
    for (const s of segs) await enc("testsrc", 30, path.join(tmp, `${s.id}.mp4`));
    const draftMp4 = path.join(dir, "b.mp4");
    await enc("testsrc2", 50, draftMp4);
    const span = draftSpan({ segment: segs[1], fps: FPS, filmStart: 0, filmEnd: 90, handleSec: 10 / FPS });
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(draftSidecar({ segment: segs[1], span, fps: FPS, handleSec: 10 / FPS, quality: "final", width: 160, height: 120 })));

    const insert = await cutDraftSlot({ paths: { outDir }, id: "b", preview: false });
    assert.equal(insert.startSec, 1);
    assert.equal(await probeFrameCount(insert.clipPath), 30);
    // the cut is draft frames [10,40): same picture as that trim, a shifted cut is not
    const exact = path.join(tmp, "exact.mp4");
    await ffmpeg(["-y", "-i", draftMp4, "-vf", "trim=start_frame=10:end_frame=40,setpts=PTS-STARTPTS", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", exact]);
    const shifted = path.join(tmp, "shifted.mp4");
    await ffmpeg(["-y", "-i", draftMp4, "-vf", "trim=start_frame=11:end_frame=41,setpts=PTS-STARTPTS", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", shifted]);
    const good = await psnr(insert.clipPath, exact);
    const bad = await psnr(insert.clipPath, shifted);
    assert.ok(good > 45, `cut matches draft frames [10,40): psnr ${good}`);
    assert.ok(good > bad + 5, `a one-frame shift scores lower (${bad}) than the exact cut (${good})`);

    // spliced at the slot start, the film keeps its 90 frames
    const clipFrames = await probeFrameCount(insert.clipPath);
    const plan = planInsert({ segments: segs, startSec: insert.startSec, fps: FPS, clipFrames });
    assert.deepEqual(plan.coveredIds, ["b"]);
    const outPath = path.join(tmp, "film.mp4");
    await spliceTrack({ pieces: plan.pieces, segmentPath: (id) => path.join(tmp, `${id}.mp4`), clipPath: insert.clipPath, fps: FPS, crf: 18, preset: "medium", workDir: path.join(tmp, "_w"), outPath });
    assert.equal(await probeFrameCount(outPath), 90);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--use-draft: missing draft and a quality mismatch fail with a one-line fix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-draft-"));
  try {
    await assert.rejects(() => cutDraftSlot({ paths: { outDir: tmp }, id: "x", preview: false }), /no draft for x .*--only x --handle/);
    const dir = draftsDir(tmp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.mp4"), "");
    fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ id: "x", quality: "preview", fps: FPS, slotFrameStart: 0, slotFrameEnd: 30, frameStart: 0, frameEnd: 30 }));
    await assert.rejects(() => cutDraftSlot({ paths: { outDir: tmp }, id: "x", preview: false }), /rendered as preview/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
