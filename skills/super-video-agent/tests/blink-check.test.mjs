// blink-check.mjs: blink analysis (pure), source review, GLB clip keyframes and the page hook.
// Report only; the CLI exits 0 whatever it finds.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBlinks, analyzeBlinks, formatBlinks } from "../scripts/lib/blink.mjs";
import { blinkSourceReview } from "../scripts/lib/source-review.mjs";
import { readGltf, morphTracks } from "../scripts/lib/glb-clip-tracks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "blink-check.mjs");

/** Series at 30 fps over `seconds` with closure values `at(frame)`. */
const series = (seconds, at, fps = 30) => Array.from({ length: Math.round(seconds * fps) }, (_, f) => ({ t: f / fps, v: at(f) }));
/** A blink as a ramp of closure values starting at frame `f0`. */
const ramp = (f0, values) => (f) => (f >= f0 && f < f0 + values.length ? values[f - f0] : 0);
const either = (...fns) => (f) => Math.max(...fns.map((g) => g(f)));

test("findBlinks: a 6-frame ramp is one blink with close, open and total times; a lid flutter under 0.5 is not a blink", () => {
  const s = series(2, either(ramp(30, [0.3, 0.8, 1, 1, 0.6, 0.2]), ramp(5, [0.3, 0.3])));
  const b = findBlinks(s);
  assert.equal(b.length, 1);
  assert.equal(b[0].peak, 1);
  assert.ok(b[0].totalSec > 0.15 && b[0].totalSec < 0.25, `total ${b[0].totalSec}`);
  assert.ok(b[0].closeSec > 0 && b[0].openSec > 0);
});

test("analyzeBlinks: a one-frame blink pair is fast and close; three within 1 s flutter; a normal blink is clean", () => {
  const quick = analyzeBlinks(series(3, either(ramp(10, [1]), ramp(20, [1]))));
  assert.equal(quick.count, 2);
  assert.deepEqual(quick.flags.map((f) => f.type).sort(), ["close-blinks", "fast-blink", "fast-blink"]);
  assert.match(quick.flags.find((f) => f.type === "fast-blink").detail, /in 6\d ms/);

  const flutter = analyzeBlinks(series(3, either(ramp(10, [0.5, 1, 0.5]), ramp(18, [0.5, 1, 0.5]), ramp(26, [0.5, 1, 0.5]))));
  assert.ok(flutter.flags.some((f) => f.type === "flutter"));

  const clean = analyzeBlinks(series(8, either(ramp(30, [0.3, 0.8, 1, 1, 0.6, 0.2]), ramp(150, [0.3, 0.8, 1, 1, 0.6, 0.2]))));
  assert.equal(clean.count, 2);
  assert.deepEqual(clean.flags, []);
  assert.deepEqual(clean.intervals, [4]);
  assert.match(formatBlinks({ derby: clean }), /^derby: 2 blinks, blink \d+–\d+ ms, gaps 4\.00–4\.00 s\n$/);
});

const src = (text) => [{ file: "derby.js", text, lineOffset: 0 }];
const kinds = (text) => blinkSourceReview(src(text)).map((f) => `${f.line}:${f.kind}`);

test("blinkSourceReview: fast durations, short intervals, close keyframes and random drives are found with file:line", () => {
  assert.deepEqual(kinds("const blinkDurationMs = 60;"), ["1:fast-blink"]);
  assert.deepEqual(kinds("const blinkCloseSec = 0.03;"), ["1:fast-blink"]);
  assert.deepEqual(kinds("const blinkInterval = 0.8;"), ["1:close-blinks"]);
  assert.deepEqual(kinds("let blinksPerMinute = 90;"), ["1:close-blinks"]);
  assert.deepEqual(kinds("const open = (t % 1.2) < 0.1; // blink"), ["1:close-blinks"]);
  assert.deepEqual(kinds("if (Math.random() < 0.02) startBlink();"), ["1:random-blink"]);
  assert.deepEqual(kinds("const blinkTimes = [1.0, 1.5, 6];"), ["1:close-blinks"]);
  const keys = "const blinkKeys = [[0, 0], [0.02, 1], [0.04, 0], [3, 0], [3.02, 1], [3.04, 0]];";
  const found = blinkSourceReview(src(keys));
  assert.ok(found.length >= 2);
  assert.ok(found.every((f) => f.line === 1));
  assert.ok(found.some((f) => f.kind === "fast-blink" && /keyframes at/.test(f.why)));
});

test("blinkSourceReview: human-range values and code without blinks give nothing", () => {
  assert.deepEqual(kinds("const blinkInterval = 3.5;\nconst blinkDurationMs = 250;\nconst blinkTimes = [1, 4.5, 9];"), []);
  assert.deepEqual(kinds("const x = 0.03;\nif (Math.random() < 0.5) wave();"), []);
  assert.deepEqual(kinds("// blinkInterval = 0.2 in an old draft"), []);
});

/** A one-mesh GLB: node "Head" with morph targets [mouthOpen, eyeBlinkLeft] and one weights clip. */
function glb(times, blinkValues) {
  const n = times.length;
  const bin = Buffer.alloc(n * 4 + n * 8);
  times.forEach((t, i) => bin.writeFloatLE(t, i * 4));
  blinkValues.forEach((v, i) => { bin.writeFloatLE(0, n * 4 + i * 8); bin.writeFloatLE(v, n * 4 + i * 8 + 4); });
  const json = {
    asset: { version: "2.0" },
    nodes: [{ name: "Head", mesh: 0 }],
    meshes: [{ name: "HeadMesh", primitives: [{ attributes: {}, targets: [{}, {}] }], extras: { targetNames: ["mouthOpen", "eyeBlinkLeft"] } }],
    animations: [{ name: "idle", channels: [{ sampler: 0, target: { node: 0, path: "weights" } }], samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: n * 4 }, { buffer: 0, byteOffset: n * 4, byteLength: n * 8 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: n, type: "SCALAR", min: [times[0]], max: [times[n - 1]] }, { bufferView: 1, componentType: 5126, count: n * 2, type: "SCALAR" }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]);
}

test("morphTracks: reads the blink morph's keyframes and skips other morphs", () => {
  const tracks = morphTracks(readGltf(glb([0, 1, 1.1, 1.2, 3], [0, 0, 1, 0, 0])));
  assert.equal(tracks.length, 1);
  assert.deepEqual([tracks[0].clip, tracks[0].node, tracks[0].morph], ["idle", "Head", "eyeBlinkLeft"]);
  assert.deepEqual(tracks[0].series.map((p) => p.v), [0, 0, 1, 0, 0]);
  assert.equal(morphTracks(readGltf(glb([0, 1], [0, 0])), /^nothing$/).length, 0);
});

function reel(hook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-blink-"));
  fs.writeFileSync(path.join(dir, "reel.html"), `<!doctype html><canvas width="8" height="8"></canvas><script>
window.__reel = { width: 8, height: 8, fps: 30, duration: 4, ready: Promise.resolve(), shots: [],
  seek: function (t) { window.__t = t; } ${hook} };
</script>`);
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [script, dir, ...args], { encoding: "utf8" });

test("blink-check.mjs hook: flags the planted one-frame blinks, quiet on a human blink; exit 0", () => {
  const planted = reel(`, blink: function (t) { const f = Math.round(t * 30); return [{ character: "derby", closed: f === 10 || f === 20 ? 1 : 0 }]; }`);
  const clean = reel(`, blink: function (t) { const f = Math.round(t * 30) - 30; const v = [0.3, 0.8, 1, 1, 0.6, 0.2][f]; return [{ character: "derby", closed: v || 0 }]; }`);
  try {
    const r = run(planted, "--no-source");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /derby: 2 blinks/);
    assert.match(r.stdout, /fast-blink: closes and opens in \d+ ms/);
    assert.match(r.stdout, /close-blinks/);
    const json = JSON.parse(fs.readFileSync(path.join(planted, "out", "blink-check.json"), "utf8"));
    assert.equal(json.state.characters.derby.count, 2);
    const c = run(clean, "--no-source");
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /derby: 1 blink, blink \d+–\d+ ms\n/);
    assert.doesNotMatch(c.stdout, /fast-blink|close-blinks|flutter/);
  } finally {
    fs.rmSync(planted, { recursive: true, force: true });
    fs.rmSync(clean, { recursive: true, force: true });
  }
});

test("blink-check.mjs: no hook is reported; source review runs first; a malformed hook and --glb work", () => {
  const dir = reel("");
  const bad = reel(`, blink: function () { return [{ character: "d" }]; }`);
  fs.appendFileSync(path.join(dir, "reel.html"), "<script>const blinkInterval = 0.8;</script>");
  const g = path.join(dir, "head.glb");
  fs.writeFileSync(g, glb([0, 1, 1.01, 1.02, 3], [0, 0, 1, 0, 0]));
  try {
    const r = run(dir, "--glb", g);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /blink source review: 1 candidate/);
    assert.match(r.stdout, /reel\.html:\d+ close-blinks/);
    assert.match(r.stdout, /idle\/Head\.eyeBlinkLeft: 1 blink/);
    assert.match(r.stdout, /fast-blink/);
    assert.match(r.stdout, /no window\.__reel\.blink hook in this page/);
    const b = run(bad, "--no-source");
    assert.equal(b.status, 1);
    assert.match(b.stderr, /no numeric "closed"/);
    const s = run(dir, "--source-only");
    assert.doesNotMatch(s.stdout, /no window\.__reel\.blink hook/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});
