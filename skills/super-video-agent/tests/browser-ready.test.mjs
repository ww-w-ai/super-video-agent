// openReel's ready timeout (T02) and the --stub timings (T01).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readyTimeoutMs, withTimeout, stubTimings, stubSeconds, openReel, captureFrame } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");

function fixtureDir(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-ready-"));
  fs.writeFileSync(path.join(dir, "reel.html"), html);
  return dir;
}

test("readyTimeoutMs: default 120 s, env override only when positive", () => {
  assert.equal(readyTimeoutMs({}), 120000);
  assert.equal(readyTimeoutMs({ SVA_READY_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(readyTimeoutMs({ SVA_READY_TIMEOUT_MS: "0" }), 120000);
  assert.equal(readyTimeoutMs({ SVA_READY_TIMEOUT_MS: "abc" }), 120000);
});

test("withTimeout: passes a settled value through, names the step on timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "x"), 7);
  const started = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 50, "await window.__reel.ready"), (e) => {
    assert.match(e.message, /step "await window\.__reel\.ready" timed out after 0\.05 s/);
    assert.equal(e.readyTimeout, true);
    return true;
  });
  assert.ok(Date.now() - started < 1000);
  // a late rejection of the wrapped promise must not become unhandled
  let reject;
  const late = new Promise((_, r) => (reject = r));
  await assert.rejects(withTimeout(late, 10, "late"));
  reject(new Error("closed"));
});

test("stubSeconds: absent → null; bad value or an existing timings.json → error", () => {
  assert.equal(stubSeconds(undefined, "/x", () => false), null);
  assert.equal(stubSeconds("4", "/x", () => false), 4);
  assert.throws(() => stubSeconds(true, "/x", () => false), /--stub takes a length/);
  assert.throws(() => stubSeconds("0", "/x", () => false), /--stub takes a length/);
  assert.throws(() => stubSeconds("-2", "/x", () => false), /--stub takes a length/);
  assert.throws(() => stubSeconds("4", "/x/voice/timings.json", () => true), /exists — drop --stub/);
});

test("stubTimings: one silent line spanning the length", () => {
  assert.deepEqual(stubTimings(3.5), { duration: 3.5, lines: [{ id: "stub", text: "", start: 0, end: 3.5, words: [] }] });
});

const NEVER_READY = `<!doctype html><canvas width="8" height="8"></canvas><script>
console.error("boom from the page");
window.__reel = { width: 8, height: 8, fps: 30, duration: 1, ready: new Promise(function () {}), seek: function () {}, shots: [] };
</script>`;

test("openReel: a ready that never settles fails within the timeout, naming the step and page errors", async () => {
  const dir = fixtureDir(NEVER_READY);
  const server = await serveDir(dir);
  const started = Date.now();
  try {
    await assert.rejects(openReel(server.url, { readyTimeoutMs: 1500 }), (e) => {
      assert.match(e.message, /step "await window\.__reel\.ready" timed out after 1\.5 s/);
      assert.match(e.message, /boom from the page/);
      return true;
    });
    assert.ok(Date.now() - started < 15000, "should give up near the timeout");
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs: SVA_READY_TIMEOUT_MS makes a never-ready page exit non-zero", () => {
  const dir = fixtureDir(NEVER_READY);
  const r = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), dir, "--at", "0"], {
    env: { ...process.env, SVA_READY_TIMEOUT_MS: "1500" },
    encoding: "utf8",
    timeout: 60000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /timed out after 1\.5 s/);
});

// A page that, like the templates, requires voice/timings.json and draws
// its line count — proves the stub is served without a file on disk.
const NEEDS_TIMINGS = `<!doctype html><canvas width="8" height="8"></canvas><script>
var timings = null;
var ready = fetch("voice/timings.json").then(function (r) {
  if (!r.ok) throw new Error("voice/timings.json not found");
  return r.json();
}).then(function (d) { timings = d; });
window.__reel = {
  width: 8, height: 8, fps: 30, ready: ready,
  get duration() { return timings.duration; },
  get shots() { return timings.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function () { var g = document.querySelector("canvas").getContext("2d"); g.fillStyle = "#123456"; g.fillRect(0, 0, 8, 8); },
};
</script>`;

test("openReel --stub: serves one silent line without writing voice/timings.json", async () => {
  const dir = fixtureDir(NEEDS_TIMINGS);
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url, { stubSec: 2.5, readyTimeoutMs: 20000 });
    try {
      assert.equal(s.meta.duration, 2.5);
      assert.deepEqual(s.meta.shots, [{ id: "stub", start: 0, end: 2.5, readAt: 1.25 }]);
      assert.ok((await captureFrame(s.page, 1)).length > 0);
    } finally {
      await s.close();
    }
    assert.equal(fs.existsSync(path.join(dir, "voice", "timings.json")), false);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs --stub: writes a PNG for a reel with no voice/timings.json; without --stub it fails", () => {
  const dir = fixtureDir(NEEDS_TIMINGS);
  const withStub = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), dir, "--at", "1", "--stub", "2"], { encoding: "utf8", timeout: 60000 });
  assert.equal(withStub.status, 0, withStub.stderr);
  assert.ok(fs.existsSync(path.join(dir, "out", "still-1.png")));
  const without = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), dir, "--at", "1"], {
    env: { ...process.env, SVA_READY_TIMEOUT_MS: "10000" },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.notEqual(without.status, 0);
  assert.match(without.stderr, /timings\.json not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});
