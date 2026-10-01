// overlap.mjs: span merging (pure) and the CLI against small fixture pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkHookResult, overlapSpans, formatSpans } from "../scripts/lib/overlap.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "overlap.mjs");

const S = (frame, pairs) => ({ frame, pairs: Object.entries(pairs).map(([pair, count]) => ({ pair, count })) });

test("overlapSpans: merges consecutive frames per pair, splits on a gap, keeps clean pairs", () => {
  const samples = [
    S(0, { "quilt/legs": 0, "quilt/arms": 0 }),
    S(1, { "quilt/legs": 3, "quilt/arms": 0 }),
    S(2, { "quilt/legs": 7, "quilt/arms": 0 }),
    S(3, { "quilt/legs": 0, "quilt/arms": 0 }),
    S(4, { "quilt/legs": 2, "quilt/arms": 0 }),
  ];
  const r = overlapSpans(samples, { fps: 10, step: 1 });
  assert.deepEqual(r["quilt/arms"], { spans: [], framesWithOverlap: 0, maxCount: 0 });
  assert.equal(r["quilt/legs"].framesWithOverlap, 3);
  assert.equal(r["quilt/legs"].maxCount, 7);
  assert.deepEqual(r["quilt/legs"].spans, [
    { startFrame: 1, endFrame: 2, start: 0.1, end: 0.2, frames: 2, maxCount: 7, maxAt: 0.2 },
    { startFrame: 4, endFrame: 4, start: 0.4, end: 0.4, frames: 1, maxCount: 2, maxAt: 0.4 },
  ]);
});

test("overlapSpans: with --step, frames one step apart are consecutive; a pair missing from a sample ends its span", () => {
  const stepped = overlapSpans([S(0, { a: 1 }), S(3, { a: 2 }), S(6, { a: 1 })], { fps: 30, step: 3 });
  assert.equal(stepped.a.spans.length, 1);
  assert.equal(stepped.a.spans[0].frames, 3);
  assert.equal(stepped.a.spans[0].endFrame, 6);
  const missing = overlapSpans([S(0, { a: 1 }), S(1, {}), S(2, { a: 1 })], { fps: 30, step: 1 });
  assert.equal(missing.a.spans.length, 2);
});

test("checkHookResult: accepts [{pair, count}], names the time on anything else", () => {
  assert.deepEqual(checkHookResult([{ pair: "c/p", count: 0 }], 1), [{ pair: "c/p", count: 0 }]);
  assert.throws(() => checkHookResult(null, 0.5), /overlap\(0\.500\) returned object/);
  assert.throws(() => checkHookResult([{ count: 1 }], 0), /no "pair" string/);
  assert.throws(() => checkHookResult([{ pair: "c/p", count: -1 }], 0), /no count ≥ 0/);
});

test("formatSpans: one line per pair, 'none' for a clean pair", () => {
  const text = formatSpans(overlapSpans([S(0, { "c/b": 0, "c/a": 4 })], { fps: 10, step: 1 }));
  assert.equal(text, "c/a: 1 span — 0.000–0.000 s (frames 0–0, max 4 at 0.000 s)\nc/b: none\n");
});

function fixture(hook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-overlap-"));
  fs.writeFileSync(path.join(dir, "reel.html"), `<!doctype html><canvas width="8" height="8"></canvas><script>
window.__reel = { width: 8, height: 8, fps: 10, duration: 1, ready: Promise.resolve(), shots: [],
  seek: function (t) { window.__t = t; } ${hook} };
</script>`);
  return dir;
}

test("overlap.mjs: prints the spans and writes JSON; exit 0 although overlaps exist", () => {
  // the hook trusts the seek: it reads the time the page was last seeked to
  const dir = fixture(`, overlap: function (t) { if (Math.abs(window.__t - t) > 1e-9) throw new Error("not seeked");
    return [{ pair: "lid/hand", count: t >= 0.3 && t < 0.6 ? 5 : 0 }, { pair: "lid/arm", count: 0 }]; }`);
  const out = path.join(dir, "o.json");
  try {
    const r = spawnSync(process.execPath, [script, dir, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sampled 10 frames/);
    assert.match(r.stdout, /lid\/hand: 1 span — 0\.300–0\.500 s \(frames 3–5, max 5 at 0\.300 s\)/);
    assert.match(r.stdout, /lid\/arm: none/);
    const json = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(json.sampledFrames, 10);
    assert.equal(json.pairs["lid/hand"].framesWithOverlap, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("overlap.mjs: a page without the hook is reported, exit 0, no JSON", () => {
  const dir = fixture("");
  try {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no window\.__reel\.overlap hook/);
    assert.equal(fs.existsSync(path.join(dir, "out", "overlap.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("overlap.mjs: a malformed hook answer and a bad --step fail with a message", () => {
  const dir = fixture(`, overlap: function () { return { pair: "x" }; }`);
  try {
    const bad = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not an array of \{pair, count\}/);
    const step = spawnSync(process.execPath, [script, dir, "--step", "0"], { encoding: "utf8" });
    assert.equal(step.status, 1);
    assert.match(step.stderr, /--step takes a whole number/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
