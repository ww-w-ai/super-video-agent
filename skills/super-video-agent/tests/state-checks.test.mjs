// state-checks.mjs: text overlap, glyph fallback and one-frame flicker (pure logic, source review,
// and the CLI against fixture pages). Facts only; the CLI exits 0 whatever it finds.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { namedFamilies, textOverlaps, textOverlapSpans, findFlicker, visibleKeys, glyphFallbacks, formatStateChecks } from "../scripts/lib/state-checks.mjs";
import { visibilitySourceReview, framesIn, formatSourceFindings, gatherSources } from "../scripts/lib/source-review.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "state-checks.mjs");

const T = (text, box, alpha = 1, font = "20px X") => ({ text, box, alpha, font });

test("namedFamilies: drops generic families, keeps quoted names, finds the list after the size", () => {
  assert.deepEqual(namedFamilies('bold 40px "JetBrains Mono", monospace'), ['"JetBrains Mono"']);
  assert.deepEqual(namedFamilies("32px/1.2 Pretendard, sans-serif"), ["Pretendard"]);
  assert.deepEqual(namedFamilies("32px sans-serif"), []);
});

test("textOverlaps: reports two different texts sharing area; skips same text, slivers and faded text", () => {
  const a = T("Hello", [0, 0, 100, 20]);
  assert.deepEqual(textOverlaps([a, T("World", [50, 5, 150, 25])]), [{ pair: "Hello / World", count: 750 }]);
  assert.deepEqual(textOverlaps([a, T("Hello", [2, 2, 102, 22])]), []);
  assert.equal(textOverlaps([a, T("Far", [200, 0, 300, 20])])[0].count, 0);
  assert.equal(textOverlaps([a, T("Edge", [0, 19, 100, 39])])[0].count, 0); // 100 px² of 2000: a sliver under 10% of the smaller box
  assert.deepEqual(textOverlaps([a, T("Ghost", [50, 5, 150, 25], 0.01)]), []);
});

test("textOverlapSpans: merges frames into spans per pair and drops pairs that never overlap", () => {
  const over = [T("A", [0, 0, 50, 20]), T("B", [10, 0, 60, 20])];
  const clear = [T("A", [0, 0, 50, 20]), T("B", [100, 0, 150, 20])];
  const frames = [clear, over, over, clear].map((texts, frame) => ({ frame, texts }));
  const r = textOverlapSpans(frames, { fps: 10, step: 1 });
  assert.deepEqual(Object.keys(r), ["A / B"]);
  assert.equal(r["A / B"].spans.length, 1);
  assert.equal(r["A / B"].spans[0].start, 0.1);
  assert.equal(r["A / B"].spans[0].end, 0.2);
  const none = textOverlapSpans([clear, clear].map((texts, frame) => ({ frame, texts })), { fps: 10, step: 1 });
  assert.deepEqual(none, {});
});

test("findFlicker: one frame with absent neighbours is reported; two frames, edges and steady elements are not", () => {
  const f = (frame, ...keys) => ({ frame, keys });
  const frames = [f(0, "steady"), f(1, "steady", "flash"), f(2, "steady"), f(3, "steady", "pair"), f(4, "steady", "pair"), f(5, "steady"), f(6, "steady", "last")];
  const r = findFlicker(frames, { fps: 10 });
  assert.deepEqual(r, [{ key: "flash", frame: 1, t: 0.1, frames: 1 }]);
  assert.deepEqual(findFlicker([f(0, "a"), f(1, "a"), f(2, "a")], { fps: 10 }), []);
});

test("visibleKeys: texts above the alpha floor and hook layers with opacity", () => {
  const keys = visibleKeys({ texts: [T("Hi", [0, 0, 1, 1]), T("Faint", [0, 0, 1, 1], 0.01), T("  ", [0, 0, 1, 1])],
    layers: [{ id: "glow", opacity: 0.8 }, { id: "gone", opacity: 0 }, { id: "plain" }] });
  assert.deepEqual(keys.sort(), ['layer glow', 'layer plain', 'text "Hi"']);
});

test("glyphFallbacks: names the character and string the font lacks; generic-only fonts are listed as not checked", () => {
  const frames = [
    { frame: 0, texts: [T("ab", [0, 0, 1, 1], 1, "20px Mono")] },
    { frame: 3, texts: [T("aˈb", [0, 0, 1, 1], 1, "20px Mono"), T("plain", [0, 0, 1, 1], 1, "20px sans-serif")] },
  ];
  const r = glyphFallbacks(frames, (fam, ch) => (ch === "ˈ" ? false : true), { fps: 10 });
  assert.deepEqual(r.fallbacks, [{ families: "Mono", char: "ˈ", codepoint: "U+02C8", strings: ["aˈb"], firstAt: 0.3, lastAt: 0.3, frames: 1 }]);
  assert.deepEqual(r.uncheckedFonts, [{ font: "20px sans-serif", frames: 1 }]);
  const clean = glyphFallbacks(frames.slice(0, 1), () => true, { fps: 10 });
  assert.deepEqual(clean.fallbacks, []);
  assert.match(formatStateChecks({ glyphs: r, sampledFrames: 2 }), /U\+02C8 "ˈ" not in Mono: 0\.300–0\.300 s, in "aˈb"/);
});

test("framesIn: counts whole frames in a half-open window", () => {
  assert.equal(framesIn(1, 1.03, 30), 1);
  assert.equal(framesIn(1, 2, 30), 30);
  assert.equal(framesIn(1, 1, 30), 0);
  assert.equal(framesIn(1, 1, 30, true), 1);
});

const src = (text) => [{ file: "reel.html", text, lineOffset: 0 }];
const kinds = (text, fps = 30) => visibilitySourceReview(src(text), fps).map((f) => f.kind);

test("visibilitySourceReview: a window under 2 frames, a 1-frame fade and a one-frame gap are found with file:line", () => {
  const code = [
    "if (t >= 1.0 && t < 1.03) drawFlash();",
    "const a = Math.min(1, (t - 2) / 0.02);",
    "if (t >= 3 && t < 4) drawA();",
    "if (t >= 4.02 && t < 5) drawB();",
  ].join("\n");
  const found = visibilitySourceReview(src(code), 30);
  assert.deepEqual(found.map((f) => [f.line, f.kind]), [[1, "short-window"], [2, "short-fade"], [4, "one-frame-gap"]]);
  assert.match(found[0].why, /comparison 1–1\.03 s shows for 1 frame at 30 fps/);
  assert.match(formatSourceFindings(found, "x"), /reel\.html:1 short-window/);
});

test("visibilitySourceReview: overlap, two clocks and rounded boundaries are found", () => {
  assert.deepEqual(kinds("if (t >= 1 && t < 2.03) a();\nif (t >= 2 && t < 3) b();"), ["one-frame-overlap"]);
  assert.deepEqual(kinds("if (baseT > 1 && dubT < 2) show();"), ["two-clocks"]);
  assert.deepEqual(kinds("if (t < Math.round(x * fps) / fps) a();\nif (t >= Math.floor(y * fps) / fps) b();"), ["rounded-boundary", "mixed-rounding", "rounded-boundary"]);
  assert.deepEqual(kinds("const f = (t - 5) / 0;"), ["short-fade"]);
});

test("visibilitySourceReview: sound windows and ordinary fades give nothing", () => {
  const clean = ["if (t >= 1.0 && t < 2.0) a();", "if (t >= 2.0 && t < 3.5) b();", "const k = (t - 1) / 0.5;", "const ms = (t - 1) / 1000;"].join("\n");
  assert.deepEqual(kinds(clean), []);
  assert.match(formatSourceFindings([], "flicker source review"), /no candidates in the source/);
});

test("gatherSources: reel.html scene block, its scripts and src/*.js, with line offsets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-src-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "reel.html"), `line1\n<script src="scene.js"></script>\n/* ENGINE */\n/* SCENE:BEGIN */\nif (t >= 1 && t < 1.01) a();\n/* SCENE:END */\n`);
    fs.writeFileSync(path.join(dir, "scene.js"), "import './part.js';\nx();\n");
    fs.writeFileSync(path.join(dir, "part.js"), "y();\n");
    fs.writeFileSync(path.join(dir, "src", "more.js"), "z();\n");
    const s = gatherSources(dir);
    assert.deepEqual(s.map((x) => x.file).sort(), ["part.js", "reel.html", "scene.js", "src/more.js"]);
    const f = visibilitySourceReview(s, 30);
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(draw, { fps = 10, hook = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-state-"));
  fs.writeFileSync(path.join(dir, "reel.html"), `<!doctype html><canvas id="c" width="300" height="200"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.__reel = { width: 300, height: 200, fps: ${fps}, duration: 1, ready: Promise.resolve(), shots: [],
  seek: function (t) { ctx.clearRect(0, 0, 300, 200); const frame = Math.round(t * ${fps}); ${draw} } ${hook} };
</script>`);
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [script, dir, ...args], { encoding: "utf8" });

test("state-checks.mjs: finds the planted text overlap, one-frame flicker and fallback glyphs; exit 0", () => {
  const dir = fixture(`
    ctx.font = '20px "SvaMissingFont"';
    ctx.fillText("Hello", 10, 50);
    ctx.fillText("World", 12, 52);
    if (frame === 5) ctx.fillText("Flash", 10, 150);`);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sampled 10 frames/);
    assert.match(r.stdout, /text overlap: 1 pair\n  Hello \/ World: 0\.000–0\.900 s/);
    assert.match(r.stdout, /one-frame flicker: 1\n  0\.500 s \(frame 5\): text "Flash"/);
    assert.match(r.stdout, /glyph fallback: 0 characters and 1 font family drawn by a fallback font\n  none of the 11 characters drawn with SvaMissingFont are in it/);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "out", "state-checks.json"), "utf8"));
    assert.equal(json.state.flicker[0].frame, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state-checks.mjs: a clean page reports none for all three", () => {
  const dir = fixture(`
    ctx.font = "20px sans-serif";
    ctx.fillText("Hello", 10, 50);
    ctx.fillText("World", 10, 120);`);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /text overlap: none/);
    assert.match(r.stdout, /glyph fallback: none/);
    assert.match(r.stdout, /one-frame flicker: none \(texts only; no window\.__reel\.visibleAt hook\)/);
    assert.match(r.stdout, /flicker source review \(10 fps\): no candidates/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state-checks.mjs: the visibleAt hook adds layers to the flicker check; a malformed answer fails with a message", () => {
  const dir = fixture("ctx.font = '20px sans-serif'; ctx.fillText('x', 5, 20);", { hook: `, visibleAt: function (t) { return Math.round(t * 10) === 4 ? [{ id: "spark", opacity: 1 }] : []; }` });
  const bad = fixture("", { hook: `, visibleAt: function () { return { id: "x" }; }` });
  try {
    const r = run(dir, "--only", "flicker", "--no-source");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0\.400 s \(frame 4\): layer spark/);
    const b = run(bad, "--only", "flicker", "--no-source");
    assert.equal(b.status, 1);
    assert.match(b.stderr, /visibleAt\(0\.000\) returned object, not an array/);
    const s = run(dir, "--only", "nope");
    assert.equal(s.status, 1);
    assert.match(s.stderr, /--only takes overlap, glyphs, flicker/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

test("state-checks.mjs --source-only: reviews the source, opens no browser", () => {
  const dir = fixture("");
  fs.appendFileSync(path.join(dir, "reel.html"), "<script>if (t >= 1.02 && t < 1.05) a();</script>");
  try {
    const r = run(dir, "--source-only");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /flicker source review \(10 fps\)/);
    assert.match(r.stdout, /reel\.html:\d+ short-window: .*shows for 0 frames/);
    assert.doesNotMatch(r.stdout, /sampled/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
