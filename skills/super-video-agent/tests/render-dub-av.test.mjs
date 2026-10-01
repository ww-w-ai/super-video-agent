// Picture-first A/V defects found by two real films (no network; local
// ffmpeg only):
//   1. a -c copy segment join drifts off the 1/fps grid -> dub makes one
//      frame more than the picture (concatMp4 / snapToFrameGrid)
//   2. dub's mix cut the bed after the last line (mixDubAudio)
//   3. dub's mix was dual-mono, losing the bed's stereo (mixDubAudio)
//   4. renderSfx's plain arrays crossed page.evaluate in one piece and ran
//      Node out of heap (pullPageSfx)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe, probeDuration, snapToFrameGrid, planFrameGrid, nominalFps } from "../scripts/lib/ffmpeg.mjs";
import { concatMp4, frameHashes, pullPageSfx } from "../scripts/render.mjs";
import { mixDubAudio } from "../scripts/dub.mjs";

const FPS = 30;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sva-${tag}-`));
}

// One segment the way render.mjs encodes it: PNG frames through an image
// pipe into libx264 (B-frames on, as in a real render).
async function encodeSegment(outPath, frames, offset) {
  const { stdout: pngs } = await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=size=160x120:rate=${FPS}`,
    "-vf", `trim=start_frame=${offset}:end_frame=${offset + frames}`,
    "-f", "image2pipe", "-c:v", "png", "-",
  ]);
  await ffmpeg(["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", outPath], { input: pngs });
}

async function packets(file) {
  const { stdout } = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base:packet=pts,dts,duration", "-of", "json", file]);
  return JSON.parse(stdout.toString());
}

/** Asserts every packet of `file` sits on the frame grid: track timescale = fps, PTS a permutation of 0..n-1, every duration one frame. */
async function assertOnGrid(file, n) {
  const j = await packets(file);
  assert.equal(j.streams[0].time_base, `1/${FPS}`);
  const pts = j.packets.map((p) => Number(p.pts)).sort((a, b) => a - b);
  assert.deepEqual(pts, Array.from({ length: n }, (_, i) => i));
  assert.ok(j.packets.every((p) => Number(p.duration) === 1), "every packet lasts one frame");
  const dts = j.packets.map((p) => Number(p.dts));
  assert.ok(dts.every((d, i) => i === 0 || d > dts[i - 1]), "DTS strictly rises");
  assert.ok(j.packets.every((p) => Number(p.dts) <= Number(p.pts)), "DTS <= PTS");
}

/** Overlays an alpha PNG sequence of `n` frames on `picture` the way dub.mjs's overlayCaptions does; returns the result's frame count. */
async function overlayFrameCount(picture, n, dir) {
  const pngDir = path.join(dir, "cap");
  fs.mkdirSync(pngDir, { recursive: true });
  await ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=red@0.5:size=160x120:rate=${FPS},format=rgba`, "-frames:v", String(n), path.join(pngDir, "frame-%05d.png")]);
  const out = path.join(dir, "overlay.mp4");
  await ffmpeg(["-y", "-i", picture, "-framerate", String(FPS), "-i", path.join(pngDir, "frame-%05d.png"), "-filter_complex", "[1:v]format=rgba[cap];[0:v][cap]overlay=format=auto[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out]);
  return (await frameHashes(out)).length;
}

// ---- 1. frame grid ------------------------------------------------------

test("concatMp4 (defect 1): uneven segments join onto the exact 1/fps grid; frame count and framemd5 equal the segments'", async () => {
  const dir = tmpDir("grid");
  try {
    const lengths = [1, 2, 3, 7, 13, 17, 23, 31, 47, 5, 4];
    const segs = [];
    let offset = 0;
    for (const [i, n] of lengths.entries()) {
      const p = path.join(dir, `seg${i}.mp4`);
      await encodeSegment(p, n, offset);
      segs.push(p);
      offset += n;
    }
    const expected = [];
    for (const p of segs) expected.push(...(await frameHashes(p)));
    assert.equal(expected.length, offset);

    const out = path.join(dir, "picture.mp4");
    await concatMp4(segs, out, FPS);
    assert.deepEqual(await frameHashes(out), expected, "every frame decodes the same as in its segment");
    await assertOnGrid(out, offset);
    assert.ok(Math.abs((await probeDuration(out)) - offset / FPS) < 1e-6, "length is exactly frames / fps (no held last frame)");
    assert.equal(await overlayFrameCount(out, offset, dir), offset, "a caption overlay keeps the frame count");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapToFrameGrid (defect 1, dub side): a picture drifted off the grid is re-stamped losslessly; the overlay then keeps its frame count", async () => {
  const dir = tmpDir("drift");
  try {
    const n = 90;
    const src = path.join(dir, "src.mp4");
    await encodeSegment(src, n, 0);
    // Packets drift early by one tick per 4 packets (~22 ticks of 512 at the end), as at segment joins.
    const drifted = path.join(dir, "drifted.mp4");
    await ffmpeg(["-y", "-i", src, "-c", "copy", "-bsf:v", "setts=pts=PTS-floor(N/4):dts=DTS-floor(N/4)", drifted]);
    const before = (await packets(drifted)).packets.map((p) => Number(p.duration));
    assert.ok(before.some((d) => d !== 512), "the fixture really is off the grid");

    const fixed = path.join(dir, "fixed.mp4");
    const { frames } = await snapToFrameGrid(drifted, fixed, FPS);
    assert.equal(frames, n);
    assert.deepEqual(await frameHashes(fixed), await frameHashes(src));
    await assertOnGrid(fixed, n);
    assert.equal(await overlayFrameCount(fixed, n, dir), n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planFrameGrid refuses drift of half a frame or more (two packets on one frame)", () => {
  const timeBase = 1 / 15360;
  const ok = planFrameGrid({ timeBase, packets: [0, 1024, 512].map((pts, i) => ({ pts, dts: i * 512 - 512 })) }, FPS);
  assert.deepEqual(ok, { frames: 3, delay: 1, minPts: 0 });
  assert.throws(() => planFrameGrid({ timeBase, packets: [0, 200, 1024].map((pts) => ({ pts, dts: pts })) }, FPS), /drift by half a frame/);
});

test("nominalFps keeps exact rates and snaps a drifted probe to the nearest integer", () => {
  assert.equal(nominalFps(30), 30);
  assert.equal(nominalFps(30000 / 1001), 30000 / 1001);
  assert.equal(nominalFps(29.98), 30);
  assert.equal(nominalFps(12.5), 12.5);
});

// ---- 2 + 3. dub mix: full-length stereo bed --------------------------------

/** Decodes `wav` to interleaved float stereo samples at 48 kHz. */
async function decodeStereo(wav) {
  const { stdout } = await ffmpeg(["-i", wav, "-f", "f32le", "-ac", "2", "-ar", "48000", "-"]);
  const a = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
  return a;
}

function rmsDb(samples, ch, fromSec, toSec) {
  let sum = 0;
  let n = 0;
  for (let i = Math.round(fromSec * 48000); i < Math.round(toSec * 48000); i++, n++) sum += samples[i * 2 + ch] ** 2;
  return 10 * Math.log10(sum / n + 1e-20);
}

test("mixDubAudio (defects 2, 3): the bed runs the full picture after the last line, keeps its stereo, and the voice sits centred", async () => {
  const dir = tmpDir("dubmix");
  try {
    const durationSec = 4;
    // Bed: a left-only tone from 2 s to the end (a panned cue + the ending after the last line).
    const bed = path.join(dir, "bed.wav");
    await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=4", "-af", "volume=enable='lt(t,2)':volume=0,pan=stereo|c0=c0|c1=0*c0", "-c:a", "pcm_s16le", bed]);
    // One mono voice line, 1 s long, placed at 0.5 s; the film runs 2.5 s past it.
    const line = path.join(dir, "line.wav");
    await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", "-ac", "1", "-c:a", "pcm_s16le", line]);
    const out = path.join(dir, "mix.wav");
    await mixDubAudio({
      placedClips: [{ id: "l1", path: line, startSec: 0.5 }],
      bedPath: bed,
      narrationWindows: [{ start: 0.5, end: 1.5 }],
      duckDb: -6,
      durationSec,
      outPath: out,
    });

    assert.ok(Math.abs((await probeDuration(out)) - durationSec) < 0.01, "mix is the picture's length");
    const s = await decodeStereo(out);
    // 2: the bed after the last line is there (3.5-3.9 s, well after the voice ends at 1.5 s).
    assert.ok(rmsDb(s, 0, 3.5, 3.9) > -40, `bed tail left ${rmsDb(s, 0, 3.5, 3.9).toFixed(1)} dB`);
    // 3: the bed's pan survives — left loud, right silent.
    assert.ok(rmsDb(s, 0, 2.5, 3.5) - rmsDb(s, 1, 2.5, 3.5) > 30, "bed stays left-only (not dual-mono)");
    // Voice centred: equal in both channels while it speaks over a silent bed.
    const l = rmsDb(s, 0, 0.6, 1.4);
    const r = rmsDb(s, 1, 0.6, 1.4);
    assert.ok(l > -40 && Math.abs(l - r) < 0.1, `voice L ${l.toFixed(2)} R ${r.toFixed(2)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. renderSfx transfer ------------------------------------------------

/** A stand-in for a Playwright page whose evaluate runs `fn` against a fake window, recording each call's result size. */
function fakePage(renderSfx) {
  const calls = [];
  globalThis.window = { __reel: { audio: { renderSfx } } };
  return {
    calls,
    async evaluate(fn, arg) {
      const result = await fn(arg);
      calls.push(JSON.stringify(result ?? null).length);
      return result;
    },
  };
}

function readWavInt16(file) {
  const buf = fs.readFileSync(file);
  return { channels: buf.readUInt16LE(22), rate: buf.readUInt32LE(24), dataSize: buf.readUInt32LE(40), data: new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length)) };
}

const pcm = (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);

test("pullPageSfx (defect 4): typed-array channels cross in bounded chunks and land sample-exact in the WAV", async () => {
  const dir = tmpDir("sfx");
  try {
    const frames = 2_500_000; // ~52 s at 48 kHz: three chunks, the last one partial
    const L = new Float32Array(frames);
    const R = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      L[i] = Math.sin(i / 37);
      R[i] = ((i % 1000) / 500 - 1) * 1.2; // exceeds ±1: clipped like writeWavPCM16
    }
    const page = fakePage(() => [L, R]);
    const outPath = path.join(dir, "sfx.wav");
    const info = await pullPageSfx(page, { sampleRate: 48000, outPath });
    assert.deepEqual(info, { channels: 2, frames });

    const chunkFrames = 1 << 20;
    const maxPayload = Math.ceil((chunkFrames * 4) / 3) * 4 * 2 + 64; // base64 of one chunk, two channels
    assert.ok(Math.max(...page.calls) <= maxPayload, `largest evaluate result ${Math.max(...page.calls)} chars > ${maxPayload}`);
    assert.equal(page.calls.length, 1 + Math.ceil(frames / chunkFrames) + 1); // info, chunks, cleanup

    const wav = readWavInt16(outPath);
    assert.equal(wav.channels, 2);
    assert.equal(wav.rate, 48000);
    assert.equal(wav.dataSize, frames * 4);
    for (const i of [0, 1, 999, chunkFrames - 1, chunkFrames, 2 * chunkFrames + 7, frames - 1]) {
      assert.equal(wav.data[i * 2], pcm(L[i]), `L[${i}]`);
      assert.equal(wav.data[i * 2 + 1], pcm(R[i]), `R[${i}]`);
    }
    assert.equal(globalThis.window.__svaSfx, undefined, "the page copy is released");
  } finally {
    delete globalThis.window;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pullPageSfx (defect 4): plain arrays (older templates) are still accepted; a page with no renderSfx writes nothing", async () => {
  const dir = tmpDir("sfx-plain");
  try {
    const L = Array.from({ length: 2500 }, (_, i) => Math.cos(i / 9) * 0.5);
    const R = Array.from({ length: 2500 }, (_, i) => -Math.cos(i / 9) * 0.5);
    const page = fakePage(async () => [L, R]);
    const outPath = path.join(dir, "sfx.wav");
    await pullPageSfx(page, { sampleRate: 48000, outPath, chunkFrames: 1000 });
    const wav = readWavInt16(outPath);
    for (let i = 0; i < 2500; i++) {
      assert.equal(wav.data[i * 2], pcm(L[i]));
      assert.equal(wav.data[i * 2 + 1], pcm(R[i]));
    }
    // The WAV decodes as 2500 stereo frames.
    assert.ok(Math.abs((await probeDuration(outPath)) - 2500 / 48000) < 1e-4);

    globalThis.window = { __reel: { audio: {} } };
    const none = await pullPageSfx({ evaluate: async (fn, arg) => fn(arg) }, { sampleRate: 48000, outPath: path.join(dir, "none.wav") });
    assert.equal(none, null);
    assert.ok(!fs.existsSync(path.join(dir, "none.wav")));
  } finally {
    delete globalThis.window;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
