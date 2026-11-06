// Footage spans (references/pipeline.md "Footage spans"): the frame math, the engine's span
// resolution, the decode command's random access, the native host drawing a horizontal and a
// vertical clip with slow motion and a freeze, the browser refusal, and a full render whose
// field audio stays on its picture. Every clip is synthetic (ffmpeg lavfi), made in a temp folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkFootageSpans,
  spanFrameAt,
  sourceIndexAt,
  lastSourceIndex,
  decoderArgs,
  sourceFacts,
  decodeSize,
  fieldAudioPlan,
  atempoChain,
  fieldAudioCues,
} from "../scripts/lib/footage.mjs";
import { frameReader } from "../scripts/native/footage-host.mjs";
import { buildCueMixFilter } from "../scripts/lib/audio-mix.mjs";
import { buildClock, writeSilentWav } from "../scripts/lib/silent-clock.mjs";
import { openReel, captureRgbaFrame } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
await import(pathToFileURL(path.join(scripts, "engine", "reel-engine.js")).href);
const Reel = globalThis.Reel;

process.env.SVA_RENDERER = "native";
const FPS = 30;
const roots = [];
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sva-footage-${name}-`));
  roots.push(d);
  return d;
};
const sha = (b) => crypto.createHash("sha1").update(b).digest("hex");
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

// A 4 s horizontal clip whose frame 45 (1.5 s) is all white, with a 1 kHz beep from 1.5 s over a quiet hum;
// a 4 s vertical clip with a tone. Both 30 fps.
function makeClips(dir) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const wide = path.join(dir, "assets", "wide.mp4");
  const tall = path.join(dir, "assets", "tall.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4", "-f", "lavfi", "-i", "aevalsrc='if(between(t,1.5,1.6),0.5*sin(2*PI*1000*t),0.02*sin(2*PI*220*t))':s=48000:d=4",
    "-vf", "drawbox=enable='eq(n,45)':x=0:y=0:w=iw:h=ih:color=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-shortest", wide]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", tall]);
  return { wide, tall };
}

const span = (o) => ({ id: "s", src: "a.mp4", in: 0, start: 0, frames: 30, speed: 1, freeze: false, ...o });

// ---- frame math ------------------------------------------------------------

test("frame math: speed 1 maps film frames to source frames one to one, clamped to the span", () => {
  const s = span({ start: 1, frames: 30 });
  assert.equal(spanFrameAt(s, 1, FPS), 0);
  assert.equal(spanFrameAt(s, 1 + 10 / FPS, FPS), 10);
  assert.equal(spanFrameAt(s, 0.2, FPS), 0, "before the span: its first frame");
  assert.equal(spanFrameAt(s, 9, FPS), 29, "after the span: its last frame");
  assert.equal(sourceIndexAt(s, 17), 17);
});

test("frame math: slow motion shows each source frame twice, a freeze holds frame 0", () => {
  const slow = span({ speed: 0.5, frames: 60 });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => sourceIndexAt(slow, n)), [0, 0, 1, 1, 2, 2]);
  assert.equal(lastSourceIndex(slow), 29);
  const fast = span({ speed: 2, frames: 10 });
  assert.deepEqual([0, 1, 2].map((n) => sourceIndexAt(fast, n)), [0, 2, 4]);
  const freeze = span({ freeze: true, frames: 45 });
  assert.equal(sourceIndexAt(freeze, 44), 0);
  assert.equal(lastSourceIndex(freeze), 0);
});

test("checkFootageSpans names the entry and the field", () => {
  assert.throws(() => checkFootageSpans({}), /must be an array/);
  assert.throws(() => checkFootageSpans([span({ frames: 0 })]), /footage\[0\] "s": "frames"/);
  assert.throws(() => checkFootageSpans([span(), span()]), /the id is used twice/);
  assert.throws(() => checkFootageSpans([span({ audio: { loud: 1 } })]), /audio\.loud is not a field audio setting/);
  assert.doesNotThrow(() => checkFootageSpans([span({ audio: false, size: [640, 360], filter: "eq=saturation=1.1" })]));
});

test("sourceFacts: a rotated phone clip reports its display size", () => {
  const facts = sourceFacts({ streams: [{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }, { codec_type: "audio" }], format: { duration: "12.5" } });
  assert.deepEqual(facts, { width: 1080, height: 1920, rotation: -90, hasAudio: true, duration: 12.5 });
  assert.equal(sourceFacts({ streams: [{ codec_type: "video", width: 640, height: 360 }] }).hasAudio, false);
  assert.throws(() => sourceFacts({ streams: [{ codec_type: "audio" }] }, "x.m4a"), /x\.m4a has no video stream/);
});

test("decodeSize: the source's long side capped at the frame's long side, never enlarged; size wins", () => {
  assert.deepEqual(decodeSize({ width: 3840, height: 2160 }, { width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(decodeSize({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(decodeSize({ width: 640, height: 360 }, { width: 1920, height: 1080 }), { width: 640, height: 360 });
  assert.deepEqual(decodeSize({ width: 640, height: 360 }, { width: 1920, height: 1080 }, [1280, 720]), { width: 1280, height: 720 });
});

test("decoderArgs: the fps filter runs before select, and passthrough keeps the dropped head out", () => {
  const args = decoderArgs({ src: "/c.mp4", inSec: 2.5, fps: 30, width: 640, height: 360, filter: "eq=gamma=1.1", from: 12, count: 5 });
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf, /^fps=30,select=gte\(n\\,12\),eq=gamma=1\.1,scale=640:360:/);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), ["-ss", "2.5", "-i", "/c.mp4"]);
  assert.equal(args[args.indexOf("-fps_mode") + 1], "passthrough");
  assert.equal(args[args.indexOf("-frames:v") + 1], "5");
});

// ---- field audio -------------------------------------------------------------

test("fieldAudioPlan: speed 1 sounds, a freeze and an unstretched slow span are silent, audio:false mutes", () => {
  const spans = [
    span({ id: "a", in: 3, start: 1, frames: 60 }),
    span({ id: "b", freeze: true }),
    span({ id: "c", speed: 0.5 }),
    span({ id: "d", speed: 0.5, start: 2, frames: 30, audio: { stretch: true, gainDb: -3 } }),
    span({ id: "e", audio: false }),
  ];
  const plan = fieldAudioPlan(spans, FPS);
  assert.deepEqual(plan.map((p) => p.id), ["a", "d"]);
  assert.deepEqual([plan[0].atSec, plan[0].trimSec, plan[0].leadSec, plan[0].tempo], [1, 2, 3, 1]);
  assert.deepEqual([plan[1].tempo, plan[1].gainDb, plan[1].trimSec], [0.5, -3, 1]);
});

test("atempoChain: one stage inside 0.5..100, chained outside", () => {
  assert.equal(atempoChain(0.5), "atempo=0.5");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.equal(atempoChain(2), "atempo=2");
});

test("buildCueMixFilter: a field-audio cue starts in its file, keeps its level, stretches, skips the duck", () => {
  const { filterComplex } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    narrationWindows: [{ start: 0, end: 5 }],
    cues: [
      { trimSec: 2, levelDb: 0, gainDb: 1.5, atSec: 1, leadSec: 3, duck: false, fadeInSec: 0.015, fadeOutSec: 0.03 },
      { trimSec: 1, levelDb: -4, atSec: 4, leadSec: 2, tempo: 0.5 },
    ],
  });
  assert.match(filterComplex, /\[1:a\]atrim=3:5,asetpts=PTS-STARTPTS,pan=stereo[^;]*volume=1\.5dB,afade=t=in:st=0:d=0\.015,afade=t=out:st=1\.97:d=0\.03,adelay=1000:all=1\[cue0\]/);
  assert.match(filterComplex, /\[2:a\]atrim=2:2\.5,asetpts=PTS-STARTPTS,atempo=0\.5,pan=stereo[^;]*volume=-4dB,.*adelay=4000:all=1,volume=eval=frame/);
});

test("fieldAudioCues: a source without sound is named and left out; lufs levels over the span", async () => {
  const spans = [span({ id: "mute", src: "m.mp4" }), span({ id: "talk", src: "t.mp4", in: 2, frames: 90, audio: { lufs: -20 } })];
  const probe = async (p) => ({ hasAudio: !p.endsWith("m.mp4") });
  const seen = [];
  const measure = async (file, from, sec) => (seen.push([path.basename(file), from, sec]), -31);
  const { cues, notes } = await fieldAudioCues(spans, { root: "/reel", fps: FPS, duck: false, probe, measure });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].absPath, "/reel/t.mp4");
  assert.equal(cues[0].levelDb, 11);
  assert.equal(cues[0].duck, false);
  assert.deepEqual(seen, [["t.mp4", 2, 3]]);
  assert.match(notes[0], /footage "mute": m\.mp4 has no audio stream/);
});

// ---- the engine's span resolution ---------------------------------------------

test("Reel.footageSpans: at/line anchors, out and line lengths, start snapped to the frame grid", () => {
  const timings = { duration: 6, lines: [{ id: "l1", start: 0, end: 2.5 }, { id: "l2", start: 2.5, end: 6 }] };
  const spans = Reel.footageSpans(
    [
      { id: "a", src: "a.mp4", in: 1, out: 3, at: 0.511 },
      { id: "b", src: "b.mp4", line: "l2", offset: 0.5 },
      { id: "c", src: "a.mp4", in: 2, out: 3, speed: 0.5, at: 3 },
      { id: "d", src: "a.mp4", in: 2.9, freeze: true, dur: 1.5, at: 4.5, audio: false },
    ],
    timings,
    FPS
  );
  assert.deepEqual(spans.map((s) => [s.id, +s.start.toFixed(4), s.frames]), [["a", 0.5, 60], ["b", 3, 90], ["c", 3, 60], ["d", 4.5, 45]], "at 0.511 s snaps to frame 15 (0.5 s)");
  assert.equal(spans[0].start * FPS, Math.round(spans[0].start * FPS), "start is on the frame grid");
  assert.equal(spans[3].audio, false);
  assert.doesNotThrow(() => checkFootageSpans(spans), "the engine's output passes the Node check");
  assert.throws(() => Reel.footageSpans([{ id: "x", src: "a.mp4", line: "nope" }], timings, FPS), /line "nope" is not in voice\/timings\.json/);
  assert.throws(() => Reel.footageSpans([{ id: "x", src: "a.mp4", freeze: true, at: 0 }], timings, FPS), /needs "dur", "out" or "line"/);
  assert.throws(() => Reel.footageSpans([{ id: "x", src: "a.mp4", at: 0, out: 1, speed: 0 }], timings, FPS), /"speed" must be > 0/);
});

test("Reel.footageFrame with no native host rejects with the renderer to use", async () => {
  await assert.rejects(Reel.footageFrame("a", 0), /SVA_RENDERER=native/);
});

// ---- decoding ------------------------------------------------------------------

test("decoder: frame i decoded from the span start equals frame i decoded by starting at i", async () => {
  const dir = tmp("decode");
  const { wide } = makeClips(dir);
  const read = async (from, count) => {
    const p = spawn("ffmpeg", decoderArgs({ src: wide, inSec: 0.7, fps: FPS, width: 160, height: 90, from, count }), { stdio: ["ignore", "pipe", "ignore"] });
    const r = frameReader(p.stdout, 160 * 90 * 4);
    const out = [];
    for (let i = 0; i < count; i++) {
      const b = await r.next();
      if (!b) break;
      out.push(sha(b));
    }
    p.kill();
    return out;
  };
  const all = await read(0, 60);
  assert.equal(all.length, 60);
  assert.equal(new Set(all).size, 60, "60 different frames: the check below compares real content");
  for (const i of [1, 22, 59]) assert.equal((await read(i, 1))[0], all[i], `frame ${i}`);
});

// ---- the native page ------------------------------------------------------------

// A page that draws each active span with Reel.imageContain over a dark ground; its plan's lines
// carry the caption drawn as a bar of the line's text length (no font needed).
const PAGE = `<!doctype html><html><body><canvas id="stage" width="320" height="180"></canvas>
<script src="src/reel-engine.js"></script>
<script>
(function () {
  var W = 320, H = 180, FPS = 30;
  var ctx = document.getElementById("stage").getContext("2d");
  var timings = null, plan = null, spans = [], shots = [];
  var ready = Promise.all([fetch("voice/timings.json").then(function (r) { return r.json(); }), fetch("plan.json").then(function (r) { return r.json(); })]).then(function (x) {
    timings = x[0]; plan = x[1];
    spans = Reel.footageSpans(plan.footage, timings, FPS);
    shots = timings.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; });
  });
  window.__reel = {
    width: W, height: H, fps: FPS, ready: ready, layers: [],
    get duration() { return timings ? timings.duration : 0; },
    get shots() { return shots; },
    get footage() { return spans; },
    issues: function () { return []; },
    audio: { narration: "voice/narration.wav" },
    seek: async function (t) {
      ctx.fillStyle = "#203040"; ctx.fillRect(0, 0, W, H);
      for (var i = 0; i < spans.length; i++) {
        var s = spans[i];
        if (t < s.start || t >= s.end) continue;
        var f = await Reel.footageFrame(s.id, t);
        if (s.id === "tall") Reel.imageContain(ctx, f.image, 100, 10, 120, 160);
        else Reel.imageContain(ctx, f.image, 0, 0, W, H);
      }
      var line = plan.lines.find(function (l) { return t >= shots.find(function (s) { return s.id === l.id; }).start && t < shots.find(function (s) { return s.id === l.id; }).end; });
      if (line) { ctx.fillStyle = "#ff0"; ctx.fillRect(10, 160, line.text.length * 6, 10); }
    },
  };
})();
</script></body></html>`;

// Film: wide 0-2 s (in 1.0: its white frame lands at film 1.0 s), tall 2-3 s in a panel,
// a 0.5x slow span 3-4 s, a 1 s freeze 4-5 s.
const FOOTAGE = [
  { id: "wide", src: "assets/wide.mp4", in: 0.5, out: 2.5, line: "a" },
  { id: "tall", src: "assets/tall.mp4", in: 1, line: "b" },
  { id: "slow", src: "assets/wide.mp4", in: 2, speed: 0.5, line: "c" },
  { id: "still", src: "assets/wide.mp4", in: 3.2, freeze: true, line: "d" },
];

function makeReel(name) {
  const dir = tmp(name);
  makeClips(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.copyFileSync(path.join(scripts, "engine", "reel-engine.js"), path.join(dir, "src", "reel-engine.js"));
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
  const ids = ["a", "b", "c", "d"];
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { title: "footage test" }, footage: FOOTAGE, lines: ids.map((id) => ({ id, text: `caption ${id}` })) }, null, 2));
  const { timings } = buildClock({ scenes: ids.map((id, i) => ({ id, start: i === 0 ? 0 : i + 1, end: i === 0 ? 2 : i + 2 })) }, { fps: FPS });
  fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(timings));
  writeSilentWav(path.join(dir, "voice", "narration.wav"), timings.duration);
  return dir;
}

async function withSession(dir, fn) {
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url, { warm: false });
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  } finally {
    await server.close();
  }
}

const frameAt = async (s, t) => sha(await captureRgbaFrame(s.page, t));

test("native page: footage frames are a pure function of t, in any seek order and in a cold session", async () => {
  const dir = makeReel("page");
  const times = [0.1, 1.0, 2.4, 3.1, 3.5, 4.2, 4.9, 0.6];
  const inOrder = await withSession(dir, async (s) => {
    const out = [];
    for (const t of [...times].sort((a, b) => a - b)) out.push([t, await frameAt(s, t)]);
    return new Map(out);
  });
  await withSession(dir, async (s) => {
    for (const t of times) assert.equal(await frameAt(s, t), inOrder.get(t), `t=${t}`);
  });
});

test("native page: slow motion holds each source frame for two film frames, a freeze for its whole span", async () => {
  const dir = makeReel("slowfreeze");
  await withSession(dir, async (s) => {
    const slow = [];
    for (let k = 0; k < 6; k++) slow.push(await frameAt(s, 3 + k / FPS));
    assert.deepEqual([slow[0] === slow[1], slow[2] === slow[3], slow[4] === slow[5], slow[1] === slow[2]], [true, true, true, false]);
    const a = await frameAt(s, 4.0);
    const b = await frameAt(s, 4.5);
    const c = await frameAt(s, 4 + 29 / FPS);
    assert.ok(a === b && b === c, "the freeze shows one frame");
    const info = await s.page.evaluate(async () => {
      const f = await Reel.footageFrame("tall", 2.5);
      const w = await Reel.footageFrame("wide", 1.0);
      return { tall: [f.width, f.height, f.index], wideIndex: w.index, wideSec: w.sourceSec };
    });
    assert.deepEqual(info.tall, [180, 320, 15], "the vertical clip decodes at its own display size");
    assert.equal(info.wideIndex, 30);
    assert.ok(Math.abs(info.wideSec - 1.5) < 1e-9);
  });
});

test("native page: a span running past its source's end names the span and the source end", async () => {
  const dir = makeReel("ranout");
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  plan.footage[1] = { id: "tall", src: "assets/tall.mp4", in: 3.6, dur: 1, at: 2 };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  await withSession(dir, async (s) => {
    await assert.rejects(captureRgbaFrame(s.page, 2.9), /footage "tall": assets\/tall\.mp4 has no frame \d+ after 3\.6 s .*the source ends at 4\.0\d s/);
  });
});

test("browser renderer: a reel with footage stops with the renderer to use", (t) => {
  const dir = makeReel("browser");
  const r = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), dir, "--at", "1", "--out-dir", path.join(dir, "out")], { encoding: "utf8", env: { ...process.env, SVA_RENDERER: "browser" }, timeout: 120000 });
  if (/Chromium|playwright/i.test(r.stderr) && !/footage/.test(r.stderr)) return t.skip("no Chromium in this setup");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /footage frames are decoded only by the native renderer: run it with SVA_RENDERER=native/);
});

// ---- a full render ----------------------------------------------------------------

function greyMeans(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=16:9,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
  const px = 16 * 9;
  const out = [];
  for (let i = 0; i + px <= r.stdout.length; i += px) out.push(r.stdout.subarray(i, i + px).reduce((a, b) => a + b, 0) / px);
  return out;
}

function beepOnsetSec(file) {
  const sr = 48000;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-af", "highpass=f=700", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
  const x = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak / 2) return { at: i / sr, samples: x.length };
  return { at: null, samples: x.length };
}

test("render.mjs: footage film, field audio on its picture, one segment per span, a caption change re-encodes one span", { timeout: 300000 }, () => {
  const dir = makeReel("render");
  const run = () => spawnSync(process.execPath, [path.join(scripts, "render.mjs"), dir], { encoding: "utf8", env: { ...process.env, SVA_RENDERER: "native" }, timeout: 240000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const final = fs.realpathSync(path.join(dir, "out", "final.mp4"));
  const grey = greyMeans(final);
  assert.equal(grey.length, 150, "5 s at 30 fps");
  const flash = grey.indexOf(Math.max(...grey));
  assert.equal(flash, 30, "the source's white frame (source 1.5 s, in 0.5) lands on film frame 30");
  const beep = beepOnsetSec(final);
  assert.ok(Math.abs(beep.at - 1.0) <= 1 / FPS, `the beep heard at ${beep.at} s, its frame at 1.000 s`);
  assert.ok(Math.abs(beep.samples / 48000 - 5) <= 0.05, "audio runs the film's length");

  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  plan.lines[2].text = "a much longer caption c";
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  const second = run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  const decisions = second.stdout.split("\n").filter((l) => /^\s*(REUSE|RENDER)\b/.test(l));
  assert.deepEqual(decisions.map((l) => l.trim().split(/\s+/).slice(0, 2).join(" ")), ["REUSE a", "REUSE b", "RENDER c", "REUSE d"]);
});
