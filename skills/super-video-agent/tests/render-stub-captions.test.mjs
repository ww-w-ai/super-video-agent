// render.mjs --stub with captions on (P3): optional; the stub's empty lines
// draw no caption, there is no narration gate, and the page's own sound is
// the audio of out/<quality>-stub.mp4.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frameHashes } from "../scripts/render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
await import(path.join(scripts, "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

test("Reel.caption: an empty line (a stub line) draws nothing", () => {
  let drawn = 0;
  const ctx = {
    canvas: { width: 1080, height: 1920 },
    measureText: (s) => ({ width: s.length * 10 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    fillText: () => drawn++,
    strokeText: () => drawn++,
    fillRect: () => drawn++,
    save() {}, restore() {}, beginPath() {}, fill() {}, roundRect() {},
  };
  assert.equal(Reel.caption(ctx, { id: "stub", text: "", start: 0, end: 2 }, 1, { width: 1080, height: 1920 }), undefined);
  assert.equal(Reel.caption(ctx, null, 1, { width: 1080, height: 1920 }), undefined);
  assert.equal(drawn, 0);
});

const PAGE = `<!doctype html><canvas width="8" height="8"></canvas><script>
var timings = null;
var ready = fetch("voice/timings.json").then(function (r) { if (!r.ok) throw new Error("voice/timings.json not found"); return r.json(); }).then(function (d) { timings = d; });
window.__reel = {
  width: 8, height: 8, fps: 30, ready: ready,
  get duration() { return timings.duration; },
  get shots() { return timings.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function (t) {
    var g = document.querySelector("canvas").getContext("2d");
    var on = new URLSearchParams(location.search).get("captions") !== "0";
    g.fillStyle = on ? "rgb(" + (Math.round(t * 30) * 5 % 256) + ",40,40)" : "#000";
    g.fillRect(0, 0, 8, 8);
  },
};
</script>`;

test("render --stub with captions on: no voice needed; writes out/final-stub.mp4 with the frames and an audio track", { timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-stubcap-"));
  fs.writeFileSync(path.join(dir, "reel.html"), PAGE);
  try {
    const r = spawnSync(process.execPath, [path.join(scripts, "render.mjs"), dir, "--stub", "1"], { encoding: "utf8", timeout: 180000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /wrote .*final-stub\.mp4\n/);
    const out = path.join(dir, "out", "final-stub.mp4");
    assert.equal((await frameHashes(out)).length, 30);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out], { encoding: "utf8" });
    assert.deepEqual(probe.stdout.trim().split("\n").sort(), ["audio", "video"]);
    assert.ok(fs.existsSync(path.join(dir, "out", "segments", "final", "stub.mp4")), "captioned segments go to segments/final/");
    assert.equal(fs.existsSync(path.join(dir, "out", "final.mp4")), false);
    assert.equal(fs.existsSync(path.join(dir, "voice")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
