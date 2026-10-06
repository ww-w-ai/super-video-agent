// Sprint A5: frame-exact cuts without re-encoding (N9), --assemble (5), --bed-only (6),
// the --plan cache, leftover temp cleanup, and the A4 gaps (span render end to end,
// stamps, --fix-picture-duration refusal). Pure logic, ffmpeg fixtures, and a tiny
// page rendered in a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { render, frameHashes, staleTempNames, removeStaleTemps, spliceSpanPieces, checkPicturePair, verifyInsertedSpan, summaryLine, reportGl } from "../scripts/render.mjs";
import { noteGlMessage } from "../scripts/lib/browser.mjs";
import { ffmpeg, probeGops, planFrameCut, cutFrames, concatMp4, frameHashRange, probePacketCount, videoStreamMd5, sameStream } from "../scripts/lib/ffmpeg.mjs";
import { parseEdl, entryCheckRanges } from "../scripts/lib/segments.mjs";
import { buildJoinAudioFilter } from "../scripts/lib/join-ffmpeg.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import { main as joinMain } from "../scripts/join.mjs";

const FPS = 30;
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "render.mjs");
const tmp = (p = "sva-a5-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- pure logic ---------------------------------------------------------

test("planFrameCut: whole GOPs are copied, only the frames up to the next keyframe are re-encoded", () => {
  const keyFrames = [0, 25, 50, 75];
  const plan = (from, to) => planFrameCut({ from, to, keyFrames, total: 100 }).map((p) => `${p.kind}:${p.from}-${p.to}`);
  assert.deepEqual(plan(0, 100), ["copy:0-100"]);
  assert.deepEqual(plan(25, 75), ["copy:25-75"]);
  assert.deepEqual(plan(10, 80), ["encode:10-25", "copy:25-75", "encode:75-80"]);
  assert.deepEqual(plan(60, 100), ["encode:60-75", "copy:75-100"]);
  assert.deepEqual(plan(0, 30), ["copy:0-25", "encode:25-30"]);
  assert.deepEqual(plan(30, 40), ["encode:30-40"]); // no whole GOP inside
  assert.deepEqual(plan(26, 49), ["encode:26-49"]);
  assert.throws(() => planFrameCut({ from: 5, to: 5, keyFrames, total: 100 }), /do not fit/);
  assert.throws(() => planFrameCut({ from: 0, to: 101, keyFrames, total: 100 }), /do not fit/);
});

test("parseEdl: one of src/segment per entry, whole frame numbers, new defaults to true under drafts/", () => {
  const edl = parseEdl({ entries: [{ segment: "a" }, { src: "out/drafts/b.slot.mp4" }, { src: "x.mp4", from: 5, to: 9, new: true }, { src: "y.mp4", new: false }] });
  assert.deepEqual(edl.map((e) => e.fresh), [false, true, true, false]);
  assert.deepEqual(edl[2], { src: "x.mp4", from: 5, to: 9, fresh: true });
  assert.deepEqual(edl[0], { segment: "a", from: 0, to: null, fresh: false });
  for (const bad of [null, {}, { entries: [] }, { entries: [{}] }, { entries: [{ src: "a", segment: "b" }] }, { entries: [{ src: "a", from: 1.5 }] }, { entries: [{ src: "a", from: 5, to: 5 }] }]) {
    assert.throws(() => parseEdl(bad), /EDL|entries/, JSON.stringify(bad));
  }
});

test("entryCheckRanges: a new entry in full; otherwise re-encoded pieces in full and two frames at each copied edge", () => {
  assert.deepEqual(entryCheckRanges({ frames: 40, pieces: [{ kind: "copy", from: 0, to: 40 }], fresh: true }), [{ from: 0, to: 40 }]);
  assert.deepEqual(entryCheckRanges({ frames: 40, pieces: [{ kind: "copy", from: 0, to: 40 }], fresh: false }), [{ from: 0, to: 2 }, { from: 38, to: 40 }]);
  const mixed = entryCheckRanges({ frames: 70, pieces: [{ kind: "encode", from: 0, to: 15 }, { kind: "copy", from: 15, to: 65 }, { kind: "encode", from: 65, to: 70 }], fresh: false });
  assert.deepEqual(mixed, [{ from: 0, to: 17 }, { from: 63, to: 70 }]);
  assert.deepEqual(entryCheckRanges({ frames: 1, pieces: [{ kind: "copy", from: 0, to: 1 }], fresh: false }), [{ from: 0, to: 1 }]);
});

test("staleTempNames: only <name>-<µs>-<pid> with a dead pid; never a live pid or our own", () => {
  const names = ["_video-1791000000123456-4242.mp4", "_sfx-1791000000123457-7777.wav", "_insert-1791000000123458-4242", "final-20261007-101010.mp4", "picture.mp4", "x-1791000000123459-31337.mp4"];
  assert.deepEqual(staleTempNames(names, (pid) => pid === 7777, 31337), ["_video-1791000000123456-4242.mp4", "_insert-1791000000123458-4242"]);
});

test("removeStaleTemps: removes dead-pid temp files and dirs in out/ and the segment caches, keeps the rest", () => {
  const out = tmp();
  try {
    fs.mkdirSync(path.join(out, "segments", "final"), { recursive: true });
    fs.mkdirSync(path.join(out, "segments-ko", "final-nocap"), { recursive: true });
    const dead = [
      path.join(out, "_video-1791000000123456-4242.mp4"),
      path.join(out, "segments", "final", "s1-1791000000123457-4242.mp4"),
      path.join(out, "segments-ko", "final-nocap", "_span-s2-1791000000123458-4242"),
    ];
    const keep = [path.join(out, "final-20261007-101010.mp4"), path.join(out, "segments", "final", "s1.mp4"), path.join(out, "_sfx-1791000000123459-7777.wav")];
    for (const f of [...dead.slice(0, 2), ...keep]) fs.writeFileSync(f, "x");
    fs.mkdirSync(dead[2]);
    const removed = removeStaleTemps(out, (pid) => pid === 7777);
    assert.deepEqual(removed.sort(), dead.sort());
    for (const f of dead) assert.equal(fs.existsSync(f), false, f);
    for (const f of keep) assert.equal(fs.existsSync(f), true, f);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("buildJoinAudioFilter: the join's per-part audio chain, offset past the copied video input", () => {
  const f = buildJoinAudioFilter({ count: 2, durationsSec: [1, 1.5], inputOffset: 1 });
  assert.match(f, /^\[1:a\]aresample=48000.*afade=t=out:st=0\.990:d=0\.01\[a0\];\[2:a\]aresample=48000.*\[a1\];\[a0\]\[a1\]concat=n=2:v=0:a=1\[a\]$/);
});

test("render.mjs refuses flag combinations it cannot honour, with a message", () => {
  const dir = tmp("sva-a5-flags-");
  try {
    fs.mkdirSync(path.join(dir, "voice"));
    fs.writeFileSync(path.join(dir, "reel.html"), "<!doctype html>");
    fs.writeFileSync(path.join(dir, "voice", "narration.wav"), "x");
    fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: 1, lines: [] }));
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, dir, ...args], { encoding: "utf8" });
    const cases = [
      [["--fix-picture-duration"], /--fix-picture-duration fixes the length of a picture render's timings; use it with --no-captions and no --stub/],
      [["--no-captions", "--stub", "3", "--fix-picture-duration"], /--fix-picture-duration fixes/],
      [["--bed-only"], /--bed-only rebuilds a picture's sound bed; add --no-captions/],
      [["--no-captions", "--bed-only", "--only", "a"], /--bed-only works on the film as a whole; it does not combine with --only/],
      [["--assemble", path.join(dir, "edl.json"), "--only", "a"], /--assemble works on the film as a whole; it does not combine with --only/],
      [["--assemble", path.join(dir, "missing.json")], /--assemble EDL not found/],
      [["--span", "1-2", "--assemble", path.join(dir, "e.json")], /--span works on the film as a whole; it does not combine with --assemble/],
    ];
    for (const [args, re] of cases) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stderr + r.stdout, re, args.join(" "));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reportGl: a GL warning is printed once; a GL error code stops the segment", () => {
  const gl = new Map();
  noteGlMessage(gl, "warning", "WebGL: texImage2D: ignoring unsupported format");
  const session = { gl };
  let printed = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => ((printed += String(s)), true);
  try {
    reportGl(session, "frames [0,20)");
    reportGl(session, "frames [20,40)");
    assert.equal(printed.match(/GL warning/g).length, 1, "shown once per session");
    noteGlMessage(gl, "warning", "GL_INVALID_OPERATION: glDrawElements: no program");
    assert.throws(() => reportGl(session, "frames [40,60)"), /WebGL error\(s\) while drawing frames \[40,60\), so those frames are wrong: GL error: GL_INVALID_OPERATION/);
    assert.match(printed, /GL error: GL_INVALID_OPERATION: glDrawElements: no program/);
  } finally {
    process.stdout.write = orig;
  }
  assert.doesNotThrow(() => reportGl({}, "a page session without a GL record"));
});

// ---- ffmpeg fixtures ----------------------------------------------------

// A clip encoded the way render.mjs encodes a segment (image pipe, libx264); `gop` frames per keyframe.
async function encode(src, frames, outPath, { gop = 250, size = "160x120" } = {}) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `${src}=size=${size}:rate=${FPS}`, "-frames:v", String(frames), "-f", "image2pipe", "-c:v", "png", `${outPath}.pngs`]);
  await ffmpeg(["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", `${outPath}.pngs`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", outPath]);
  fs.rmSync(`${outPath}.pngs`);
}

const same = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

test("cutFrames: a cut on keyframes is a packet copy; a cut off keyframes re-encodes only up to the next keyframe", async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, "src.mp4");
    await encode("testsrc", 100, src, { gop: 25 });
    assert.deepEqual((await probeGops(src)).keyFrames, [0, 25, 50, 75]);
    const all = await frameHashes(src);
    const cut = async (from, to) => {
      const out = path.join(dir, `cut-${from}-${to}.mp4`);
      const r = await cutFrames({ src, from, to, fps: FPS, crf: 18, preset: "medium", outPath: out });
      return { r, hashes: await frameHashes(out), count: await probePacketCount(out) };
    };
    const onKeys = await cut(25, 75);
    assert.deepEqual(onKeys.r.pieces.map((p) => p.kind), ["copy"]);
    assert.ok(same(onKeys.hashes, all.slice(25, 75)), "frames between keyframes keep their framemd5");

    const off = await cut(10, 80);
    assert.deepEqual(off.r.pieces, [{ kind: "encode", from: 10, to: 25 }, { kind: "copy", from: 25, to: 75 }, { kind: "encode", from: 75, to: 80 }]);
    assert.equal(off.count, 70);
    assert.ok(same(off.hashes.slice(15, 65), all.slice(25, 75)), "the whole GOPs inside are bit-identical");
    assert.ok(!same(off.hashes.slice(0, 15), all.slice(10, 25)), "the head up to the keyframe was re-encoded");
    assert.equal(off.r.fellBack, false);
    assert.ok(same(await frameHashRange(path.join(dir, "cut-10-80.mp4"), 20, 30, FPS), off.hashes.slice(20, 30)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spliceSpanPieces: head and tail frames of the old segment keep their framemd5 where the cut is on a keyframe", async () => {
  const dir = tmp();
  try {
    const old = path.join(dir, "old.mp4");
    await encode("testsrc", 40, old, { gop: 10 });
    const fresh = path.join(dir, "fresh.mp4");
    await encode("smptebars", 10, fresh, { gop: 10 });
    const workDir = path.join(dir, "work");
    fs.mkdirSync(workDir);
    const pieces = [{ kind: "old", from: 0, to: 10 }, { kind: "new", from: 10, to: 20 }, { kind: "old", from: 20, to: 40 }];
    const built = await spliceSpanPieces({ pieces, oldPath: old, renderNew: async (_p, out) => fs.copyFileSync(fresh, out), fps: FPS, crf: 18, preset: "medium", workDir });
    const out = await frameHashes(built);
    const was = await frameHashes(old);
    assert.equal(out.length, 40);
    assert.ok(same(out.slice(0, 10), was.slice(0, 10)), "head frames unchanged");
    assert.ok(same(out.slice(20, 40), was.slice(20, 40)), "tail frames unchanged");
    assert.ok(same(out.slice(10, 20), await frameHashes(fresh)), "new frames are the rendered piece");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concatMp4: parts on different track time bases still join frame-exact (the demuxer does not rescale)", async () => {
  const dir = tmp();
  try {
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mp4");
    await encode("testsrc", 20, a, { gop: 10 });
    await encode("smptebars", 20, b, { gop: 10 });
    const relabelled = path.join(dir, "b30.mp4");
    await ffmpeg(["-y", "-i", b, "-map", "0:v:0", "-c", "copy", "-video_track_timescale", "30", relabelled]);
    const out = path.join(dir, "out.mp4");
    await concatMp4([a, relabelled], out, FPS);
    assert.ok(same(await frameHashes(out), [...(await frameHashes(a)), ...(await frameHashes(b))]));
    assert.equal(await probePacketCount(out), 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyInsertedSpan: the count comes from packets and only the inserted span is hashed", async () => {
  const dir = tmp();
  try {
    const film = path.join(dir, "film.mp4");
    await encode("testsrc", 60, film, { gop: 10 });
    const clip = path.join(dir, "clip.mp4");
    await cutFrames({ src: film, from: 20, to: 30, fps: FPS, crf: 18, preset: "medium", outPath: clip });
    await verifyInsertedSpan({ outPath: film, clipPath: clip, startFrame: 20, expectedFrames: 60, fps: FPS });
    await assert.rejects(verifyInsertedSpan({ outPath: film, clipPath: clip, startFrame: 21, expectedFrames: 60, fps: FPS }), /framemd5 gate failed/);
    await assert.rejects(verifyInsertedSpan({ outPath: film, clipPath: clip, startFrame: 20, expectedFrames: 61, fps: FPS }), /frame count gate failed: joined video has 60/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("join.mjs: parts that share their stream are joined by packet copy (video frames identical); other parts are re-encoded", async () => {
  const dir = tmp();
  try {
    const mk = async (name, src, size) => {
      const v = path.join(dir, `${name}-v.mp4`);
      await encode(src, 20, v, { gop: 10, size });
      const p = path.join(dir, `${name}.mp4`);
      await ffmpeg(["-y", "-i", v, "-f", "lavfi", "-i", "sine=frequency=440:duration=0.7", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", p]);
      return p;
    };
    const a = await mk("a", "testsrc", "160x120");
    const b = await mk("b", "smptebars", "160x120");
    const c = await mk("c", "smptebars", "96x64");
    const notes = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (s) => (notes.push(String(s)), true);
    process.stdout.write = () => true;
    try {
      await joinMain([path.join(dir, "ab.mp4"), a, b, "--json"]);
      await joinMain([path.join(dir, "ac.mp4"), a, c, "--json"]);
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    assert.equal(notes.filter((n) => /stream copy, no re-encode/.test(n)).length, 1, "only the matching pair is copied");
    assert.ok(same(await frameHashes(path.join(dir, "ab.mp4")), [...(await frameHashes(a)), ...(await frameHashes(b))]), "copied video = the parts' frames");
    assert.equal(await probePacketCount(path.join(dir, "ac.mp4")), 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a tiny page in a real browser ---------------------------------------

const FILM_FPS = 10;

// Shots draw by their own local time, so a shot keeps its frames when the timeline shifts around it.
// `paint` repaints the frames of one shot in [from, to) seconds of the film (the "changed" frames).
function pageHtml({ lengths, paint = null }) {
  const shots = [];
  let t = 0;
  lengths.forEach((len, i) => {
    shots.push({ id: ["a", "b", "c", "d"][i], start: t, end: t + len, readAt: t + 0.05, hue: 60 + i * 90 });
    t += len;
  });
  return `<!doctype html><body style="margin:0"><canvas id="c" width="64" height="48"></canvas><script>
const SHOTS = ${JSON.stringify(shots)}; const PAINT = ${JSON.stringify(paint)};
const ctx = document.getElementById("c").getContext("2d");
function draw(t) {
  const s = SHOTS.find((x) => t >= x.start && t < x.end) || SHOTS[SHOTS.length - 1];
  const local = t - s.start;
  const changed = PAINT && t >= PAINT.from && t < PAINT.to;
  ctx.fillStyle = changed ? "#e02020" : "hsl(" + s.hue + ",60%,40%)"; ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(local * 30) % 56, 8 + (s.hue % 7), 6, 6);
}
window.__reel = { width: 64, height: 48, fps: ${FILM_FPS}, duration: ${t}, ready: Promise.resolve(),
  shots: SHOTS.map((s) => ({ id: s.id, start: s.start, end: s.end, readAt: s.readAt })), seek(t) { draw(t); } };
</script></body>`;
}

function reelDir(lengths) {
  const dir = tmp("sva-a5-reel-");
  fs.mkdirSync(path.join(dir, "voice"));
  fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths }));
  setTimings(dir, lengths.reduce((a, b) => a + b, 0));
  return dir;
}

function setTimings(dir, duration) {
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration, lines: [] }));
}

const quiet = async (fn) => {
  const orig = process.stdout.write.bind(process.stdout);
  let text = "";
  process.stdout.write = (s) => ((text += String(s)), true);
  try {
    return { result: await fn(), text };
  } finally {
    process.stdout.write = orig;
  }
};

const pictureRender = (dir, extra = {}) => render({ dir, paths: reelPaths(dir), preview: false, noCaptions: true, ...extra });
const real = (p) => fs.realpathSync(p);

test("end to end: picture render, plan cache, --span (publish or throw), --bed-only, --assemble over a shifted timeline", { timeout: 300000 }, async () => {
  const dir = reelDir([2, 2, 2]); // a [0,20) b [20,40) c [40,60) at 10 fps
  const out = path.join(dir, "out");
  const segDir = path.join(out, "segments", "final-nocap");
  try {
    // 1. the first picture render; every segment is rendered, the pair is published with real stamps
    const first = await quiet(() => pictureRender(dir));
    assert.equal(first.result.frames, 60);
    assert.deepEqual(await checkPicturePair({ outDir: out }), { ok: true, problems: [] });
    const filmV1 = await frameHashes(real(path.join(out, "picture.mp4")));
    const jsonB1 = fs.readFileSync(path.join(segDir, "b.json"), "utf8");

    // 2. --plan: probed once, then answered from the cache without opening the page
    const p1 = await quiet(() => pictureRender(dir, { plan: true }));
    assert.equal(p1.result.pageOpens, 1);
    const p2 = await quiet(() => pictureRender(dir, { plan: true }));
    assert.equal(p2.result.pageOpens, 0);
    assert.match(summaryLine(p2.result, 0.1), /\(cached: same inputs as the plan of /);
    assert.equal(p2.text, p1.text, "the cached plan prints the same lines");
    assert.ok(p2.result.decisions.every((d) => d.action === "REUSE"));
    const p3 = await quiet(() => pictureRender(dir, { plan: true, planCache: false }));
    assert.equal(p3.result.pageOpens, 1);

    // 3. --span: one shot changes between 2.5 s and 3.0 s; only that segment is rebuilt
    fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths: [2, 2, 2], paint: { from: 2.5, to: 3.0 } }));
    const stalePlan = await quiet(() => pictureRender(dir, { plan: true }));
    assert.equal(stalePlan.result.pageOpens, 1, "a changed page file is a cache miss");
    assert.ok(stalePlan.result.decisions.some((d) => d.action === "RENDER"));
    const cBackup = fs.readFileSync(path.join(segDir, "c.mp4"));
    fs.rmSync(path.join(segDir, "c.mp4"));
    await assert.rejects(quiet(() => pictureRender(dir, { spans: [{ fromSec: 2.5, toSec: 3.0 }] })), /never rendered/);
    assert.equal(fs.readdirSync(out).filter((n) => /^picture-\d{8}-\d{6}\.mp4$/.test(n)).length, 1, "a refused span publishes nothing");
    fs.writeFileSync(path.join(segDir, "c.mp4"), cBackup);
    const span = await quiet(() => pictureRender(dir, { spans: [{ fromSec: 2.5, toSec: 3.0 }] }));
    assert.equal(span.result.frames, 60);
    const filmV2 = await frameHashes(real(path.join(out, "picture.mp4")));
    assert.ok(same(filmV2.slice(0, 20), filmV1.slice(0, 20)) && same(filmV2.slice(40), filmV1.slice(40)), "untouched segments keep their frames");
    assert.ok(!same(filmV2.slice(20, 35), filmV1.slice(20, 35)), "the span frames are the new ones");
    assert.notEqual(fs.readFileSync(path.join(segDir, "b.json"), "utf8"), jsonB1, "segment b's probes were rewritten");
    assert.ok((await quiet(() => pictureRender(dir, { plan: true }))).result.decisions.every((d) => d.action === "REUSE"), "the cache matches the page after the span render");
    assert.deepEqual(await checkPicturePair({ outDir: out }), { ok: true, problems: [] });

    // 4. --bed-only: a new bed, the same picture stream, no frame captured
    const videoBefore = real(path.join(out, "picture.mp4"));
    const md5Before = await videoStreamMd5(videoBefore);
    const bed = await quiet(() => pictureRender(dir, { bedOnly: true }));
    assert.equal(bed.result.framesRendered, 0);
    assert.equal(bed.result.pageOpens, 1);
    assert.equal(await videoStreamMd5(real(path.join(out, "picture.mp4"))), md5Before, "the picture stream is unchanged");
    assert.notEqual(real(path.join(out, "picture.mp4")), videoBefore, "published under a new stamp");
    assert.ok(fs.existsSync(videoBefore), "the previous picture file is left alone");
    assert.deepEqual(await checkPicturePair({ outDir: out }), { ok: true, problems: [] });
    assert.match(summaryLine(bed.result, 1), /0 picture frames rendered/);

    // 5. --assemble: shot a grows by one second; b and c are copied to their new place, a's frames come from a new clip
    fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths: [3, 2, 2] }));
    setTimings(dir, 7);
    const newA = path.join(out, "new-a.mp4");
    await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc=size=64x48:rate=${FILM_FPS}`, "-frames:v", "30", "-f", "image2pipe", "-c:v", "png", `${newA}.pngs`]);
    await ffmpeg(["-y", "-f", "image2pipe", "-framerate", String(FILM_FPS), "-i", `${newA}.pngs`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", newA]);
    fs.rmSync(`${newA}.pngs`);
    const bMp4 = path.join(segDir, "b.mp4");
    const cMp4 = path.join(segDir, "c.mp4");
    const bHashes = await frameHashes(bMp4);
    const cHashes = await frameHashes(cMp4);
    const edl = path.join(dir, "edl.json");
    fs.writeFileSync(edl, JSON.stringify({ entries: [{ src: "out/new-a.mp4", new: true }, { segment: "b" }, { segment: "c" }] }));
    const planned = await quiet(() => pictureRender(dir, { assemble: edl, plan: true }));
    assert.match(planned.text, /NEW  out\/new-a\.mp4  \[0,30\)/);
    const err = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => (err.push(String(s)), true);
    let asm;
    try {
      asm = await quiet(() => pictureRender(dir, { assemble: edl }));
    } finally {
      process.stderr.write = origErr;
    }
    assert.equal(asm.result.frames, 70);
    assert.match(asm.text, /assemble: 70 frames joined by packet copy; framemd5 checked on \d+/);
    const hashed = Number(/framemd5 checked on (\d+)/.exec(asm.text)[1]);
    assert.ok(hashed < 70, `only the changed frames and seams are hashed (${hashed} of 70)`);
    const film = await frameHashes(real(path.join(out, "picture.mp4")));
    assert.ok(same(film.slice(30, 50), bHashes) && same(film.slice(50, 70), cHashes), "b and c keep their frames at their new place");
    assert.match(asm.text, /note: out\/new-a\.mp4: encoder headers differ from the cache's; re-encoded/, "a clip of another family is re-encoded like the segments");
    const json = (id) => JSON.parse(fs.readFileSync(path.join(segDir, `${id}.json`), "utf8"));
    // The clip for shot a is a test pattern, not what the page draws. Segment b still holds the paint of
    // step 3 (a span render) that the page no longer draws. The cache must not record either as current.
    assert.match(err.join(""), /warning: segment a: 3 of 3 copied probe frames differ from what the page draws now/);
    assert.match(err.join(""), /warning: segment b: 1 of 3 copied probe frames differ from what the page draws now \(clip frame 9:/);
    assert.doesNotMatch(err.join(""), /segment c:/);
    for (const id of ["a", "b"]) assert.equal(fs.existsSync(path.join(segDir, `${id}.json`)), false, `no cache entry for ${id}: its frames are not the page's`);
    assert.equal(json("c").frameStart, 50);
    const afterAsm = (await quiet(() => pictureRender(dir, { plan: true }))).result.decisions;
    assert.deepEqual(afterAsm.map((d) => d.action), ["RENDER", "RENDER", "REUSE"], "the next render draws a and b again; c follows the new timeline");
    assert.deepEqual(await checkPicturePair({ outDir: out }), { ok: true, problems: [] });
    assert.equal(fs.readdirSync(out).filter((n) => /^_/.test(n)).length, 0, "no temp file is left");

    // every entry now comes from the cache's own family: runs are packet-copied to their new places, bit for bit
    fs.writeFileSync(edl, JSON.stringify({ entries: [{ segment: "c" }, { segment: "a" }, { segment: "b" }] }));
    const reorder = await quiet(() => pictureRender(dir, { assemble: edl }));
    assert.doesNotMatch(reorder.text, /note:/);
    assert.ok(Number(/framemd5 checked on (\d+)/.exec(reorder.text)[1]) <= 12, "whole copied segments: only their seams are hashed");
    const reordered = await frameHashes(real(path.join(out, "picture.mp4")));
    assert.ok(same(reordered, [...film.slice(50, 70), ...film.slice(0, 30), ...film.slice(30, 50)]), "frames identical after the move");

    // an EDL that does not tile the page's timeline stops the step
    fs.writeFileSync(edl, JSON.stringify({ entries: [{ segment: "b" }, { segment: "c" }] }));
    await assert.rejects(quiet(() => pictureRender(dir, { assemble: edl })), /the EDL has 40 frames, the page's timeline 70/);

    // frames that are the page's own are recorded: render a from the page, assemble the three segments, the cache is current
    await quiet(() => pictureRender(dir));
    fs.writeFileSync(edl, JSON.stringify({ entries: [{ segment: "a" }, { segment: "b" }, { segment: "c" }] }));
    const own = [];
    process.stderr.write = (s) => (own.push(String(s)), true);
    try {
      await quiet(() => pictureRender(dir, { assemble: edl }));
    } finally {
      process.stderr.write = origErr;
    }
    assert.doesNotMatch(own.join(""), /copied probe frames differ/);
    assert.deepEqual([json("a").frameEnd, json("b").frameStart, json("c").frameStart], [30, 30, 50]);
    assert.ok((await quiet(() => pictureRender(dir, { plan: true }))).result.decisions.every((d) => d.action === "REUSE"), "the cache follows the new timeline");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--bed-only stops when the picture is not the page's timeline", { timeout: 120000 }, async () => {
  const dir = reelDir([2, 2]);
  try {
    await quiet(() => pictureRender(dir));
    fs.writeFileSync(path.join(dir, "reel.html"), pageHtml({ lengths: [2, 3] }));
    await assert.rejects(quiet(() => pictureRender(dir, { bedOnly: true })), /the picture is out of date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sameStream: segments of one render share a signature (the --assemble reference check)", async () => {
  const dir = tmp();
  try {
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mp4");
    await encode("testsrc", 10, a);
    await encode("smptebars", 12, b);
    assert.equal(await sameStream(a, b), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
