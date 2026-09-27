// Static contract scan (scripts/lib/static-scan.mjs) against synthetic
// reel.html fixtures — no browser needed for this check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";

function writeFixture(sceneBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-scan-"));
  const html = `<!doctype html><html><body><canvas id="stage"></canvas>
<script>/* SCENE:BEGIN */\n${sceneBody}\n/* SCENE:END */</script>
</body></html>`;
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, html, "utf8");
  return file;
}

test("static-scan: clean scene with rng(key) and one timings.json fetch passes", () => {
  const file = writeFixture(`
    var ready = fetch("voice/timings.json").then(function(r){return r.json();});
    function seek(t) { var n = Reel.rng("k")(); }
  `);
  const result = scanReelHtml(file);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("static-scan: Math.random is banned", () => {
  const file = writeFixture(`function seek(t){ return Math.random(); }`);
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "Math.random"));
});

test("static-scan: Date.now / new Date are banned", () => {
  const file = writeFixture(`function seek(t){ return Date.now() + new Date(); }`);
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "Date"));
});

test("static-scan: performance.now, requestAnimationFrame, setTimeout, setInterval are banned", () => {
  const file = writeFixture(`
    function seek(t){ performance.now(); requestAnimationFrame(seek); setTimeout(seek,1); setInterval(seek,1); }
  `);
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  const names = result.violations.map((v) => v.name);
  assert.ok(names.includes("performance.now"));
  assert.ok(names.includes("requestAnimationFrame"));
  assert.ok(names.includes("setTimeout"));
  assert.ok(names.includes("setInterval"));
});

test("static-scan: a second fetch() beyond the timings.json loader is banned", () => {
  const file = writeFixture(`
    fetch("voice/timings.json");
    function seek(t){ fetch("https://example.com/x"); }
  `);
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "fetch" && v.count === 2));
});

test("static-scan: more than one <canvas> is banned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-scan-"));
  const html = `<!doctype html><html><body><canvas></canvas><canvas></canvas>
<script>/* SCENE:BEGIN */\nfunction seek(t){}\n/* SCENE:END */</script></body></html>`;
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, html, "utf8");
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "canvas-count" && v.count === 2));
});

test("static-scan: CSS transition/animation is banned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-scan-"));
  const html = `<!doctype html><html><head><style>#stage{transition: all 1s;}</style></head><body><canvas></canvas>
<script>/* SCENE:BEGIN */\nfunction seek(t){}\n/* SCENE:END */</script></body></html>`;
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, html, "utf8");
  const result = scanReelHtml(file);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.name === "css-animation"));
});

test("static-scan: missing SCENE markers is reported as sceneFound:false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-scan-"));
  const file = path.join(dir, "reel.html");
  fs.writeFileSync(file, "<html><body><canvas></canvas></body></html>", "utf8");
  const result = scanReelHtml(file);
  assert.equal(result.sceneFound, false);
});
