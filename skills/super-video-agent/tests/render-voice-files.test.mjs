// render.mjs --narration / --timings, the shared termination guard, and the float premaster.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withVoiceFiles, planCacheKey } from "../scripts/render.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import { createTerminationGuard, SIGNAL_EXIT } from "../scripts/lib/termination.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

function reel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-voicefiles-"));
  fs.mkdirSync(path.join(dir, "voice"));
  fs.mkdirSync(path.join(dir, "out"));
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: 2, lines: [] }));
  fs.writeFileSync(path.join(dir, "voice", "timings.placed.json"), JSON.stringify({ duration: 2, lines: [] }));
  fs.writeFileSync(path.join(dir, "voice", "narration.placed.wav"), "");
  return dir;
}

test("--narration / --timings replace the reel's own voice files; absent flags leave paths as they are", (t) => {
  const dir = reel();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const own = reelPaths(dir);
  assert.deepEqual(withVoiceFiles(own, {}), own);
  const placed = withVoiceFiles(own, { timings: path.join(dir, "voice", "timings.placed.json"), narration: path.join(dir, "voice", "narration.placed.wav") });
  assert.equal(placed.timingsJson, path.join(dir, "voice", "timings.placed.json"));
  assert.equal(placed.narrationWav, path.join(dir, "voice", "narration.placed.wav"));
  assert.equal(placed.reelHtml, own.reelHtml);
  assert.throws(() => withVoiceFiles(own, { timings: path.join(dir, "nope.json") }), /--timings: no such file/);
  assert.throws(() => withVoiceFiles(own, { timings: true }), /--timings takes a file path/);
  assert.throws(() => withVoiceFiles(own, { narration: path.join(dir, "voice", "narration.placed.wav"), stub: "3" }), /cannot be combined/);
});

test("the plan cache key changes with the --timings file and stays the same without it", (t) => {
  const dir = reel();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const own = reelPaths(dir);
  const base = { dir, preview: true, noCaptions: false, lang: null, only: null, probeAll: false, stubSec: null, stubSegments: 1 };
  const a = planCacheKey({ ...base, paths: own });
  assert.equal(JSON.parse(a).timings, null);
  const b = planCacheKey({ ...base, paths: withVoiceFiles(own, { timings: path.join(dir, "voice", "timings.placed.json") }) });
  assert.notEqual(a, b);
  assert.equal(JSON.parse(b).timings[0], path.join(dir, "voice", "timings.placed.json"));
});

test("termination guard: ends children, removes temps, exits 128+n, names its script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-guard-"));
  const calls = [];
  const writes = [];
  createTerminationGuard({ name: "render.mjs", temps: [dir], kill: () => calls.push("kill"), exit: (c) => calls.push(c), write: (s) => writes.push(s) }).handle("SIGTERM");
  assert.deepEqual(calls, ["kill", SIGNAL_EXIT.SIGTERM]);
  assert.equal(fs.existsSync(dir), false);
  assert.match(writes.join(""), /^render\.mjs: stopped by SIGTERM/);
});

test("render.mjs installs the guard and both premasters are written as 32-bit float", () => {
  const render = fs.readFileSync(path.join(scripts, "render.mjs"), "utf8");
  const dub = fs.readFileSync(path.join(scripts, "dub.mjs"), "utf8");
  assert.match(render, /createTerminationGuard\(\{ name: "render\.mjs" \}\)\.install\(\)/);
  for (const src of [render, dub]) {
    assert.match(src, /"\[premaster\]", "-c:a", "pcm_f32le", premasterPath/);
    assert.doesNotMatch(src, /"\[premaster\]", "-c:a", "pcm_s16le"/);
  }
});
