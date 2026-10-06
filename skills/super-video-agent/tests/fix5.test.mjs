// FIX5: render-time caption contrast (49), punctuation and script table (N6), "checked nothing" next
// step (19), clip blend helper (45).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, "..");
await import(path.join(skill, "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const { layerFromDifference, analyzeCaptionFrame, formatContrastReport } = await import("../scripts/lib/caption-contrast.mjs");
const { createContrastCollector, measureDrawnFrame, reportRenderContrast } = await import("../scripts/lib/render-contrast.mjs");
const { checkText, LANGUAGES } = await import("../scripts/lib/punct-rules.mjs");
const { checkLanguages, formatPunctReport, languagePlans } = await import("../scripts/punct-check.mjs");
const { checkedNothingNext } = await import("../scripts/lib/checked-nothing.mjs");
const { formatCueWarnings } = await import("../scripts/lib/cue-check.mjs");
const { formatCaptionBreaks } = await import("../scripts/lib/caption-breaks.mjs");

const W = 320;
const H = 180;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Flat RGB picture with a filled box (the caption) of another colour. */
function frame(bg, box) {
  const rgb = new Uint8Array(W * H * 3);
  for (let p = 0; p < W * H; p++) rgb.set(bg, p * 3);
  if (box) {
    for (let y = 130; y < 154; y++) for (let x = 100; x < 220; x++) rgb.set(box, (y * W + x) * 3);
  }
  return rgb;
}

// ---- 49: both directions, from the difference of two drawn frames ----------------

test("49: layerFromDifference marks only the pixels that differ, opaque, in the drawn colour", () => {
  const layer = layerFromDifference(frame([200, 200, 200], [255, 255, 255]), frame([200, 200, 200]));
  assert.deepEqual([...layer.slice((140 * W + 150) * 4, (140 * W + 150) * 4 + 4)], [255, 255, 255, 255]);
  assert.equal(layer[3], 0);
});

test("49: light text on a light picture and dark text on a dark one are both LOW; light on dark is ok", () => {
  const cases = [
    { bg: [225, 225, 225], text: [255, 255, 255], grade: "low", direction: "light on light" },
    { bg: [25, 25, 25], text: [0, 0, 0], grade: "low", direction: "dark on dark" },
    { bg: [20, 20, 20], text: [255, 255, 255], grade: "ok", direction: "light on dark" },
  ];
  for (const c of cases) {
    const picture = frame(c.bg);
    const found = analyzeCaptionFrame({ caption: layerFromDifference(frame(c.bg, c.text), picture), picture, width: W, height: H });
    assert.equal(found.grade, c.grade, c.direction);
    assert.equal(found.direction, c.direction);
    assert.ok(Number.isFinite(found.ratio));
  }
});

/** A PNG of a flat picture with an optional box, made by ffmpeg (the tool the measure decodes with). */
function pngOf(bgHex, boxHex) {
  const vf = boxHex ? `drawbox=x=100:y=130:w=120:h=24:color=${boxHex}:t=fill` : "null";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${bgHex}:s=${W}x${H}`, "-vf", vf, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

test("49: measureDrawnFrame draws the instant again without captions and reports the ratio; the page is left with captions on", async () => {
  const calls = [];
  const page = { evaluate: async (fn) => { calls.push(String(fn).includes("setCaptionsOn(false)") ? "off" : String(fn).includes("setCaptionsOn(true)") ? "on" : "seek"); return true; } };
  const collector = createContrastCollector({ lines: [{ id: "l1", start: 0, end: 2 }], fps: 10, width: W, height: H });
  const [frameNo] = [...collector.frames.keys()];
  await measureDrawnFrame(collector, { page, frame: frameNo, withPng: pngOf("0xe0e0e0", "white"), capture: async () => pngOf("0xe0e0e0") });
  assert.equal(collector.rows.length, 1);
  assert.equal(collector.rows[0].lineId, "l1");
  assert.equal(collector.rows[0].grade, "low");
  assert.equal(collector.rows[0].direction, "light on light");
  assert.deepEqual(calls, ["off", "seek", "on"]);
});

test("49: a frame that is not a sample is skipped; an engine without setCaptionsOn says it measured nothing and never throws", async () => {
  const collector = createContrastCollector({ lines: [{ id: "l1", start: 0, end: 2 }], fps: 10, width: W, height: H });
  await measureDrawnFrame(collector, { page: {}, frame: 9999, withPng: Buffer.alloc(0), capture: async () => null });
  assert.equal(collector.rows.length, 0);
  const [frameNo] = [...collector.frames.keys()];
  const old = { evaluate: async () => false };
  await measureDrawnFrame(collector, { page: old, frame: frameNo, withPng: Buffer.alloc(0), capture: async () => null });
  assert.equal(collector.unsupported, true);
  const out = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    reportRenderContrast(collector, path.join(tmp("sva-fix5-"), "contrast.json"));
  } finally {
    process.stdout.write = write;
  }
  assert.match(out.join(""), /not measured .*setCaptionsOn/);
});

test("49: Reel.setCaptionsOn turns caption() off and on", () => {
  const drawn = [];
  const ctx = { canvas: { width: 1080, height: 1920 }, save() {}, restore() {}, measureText: (s) => ({ width: s.length * 10 }), fillText: (s) => drawn.push(s), strokeText() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, set font(v) {}, get font() { return ""; } };
  Reel.setCaptionsOn(false);
  assert.equal(Reel.captionsOn(), false);
  try { Reel.caption(ctx, { text: "hello" }, 0, {}); } catch { /* a fake ctx may lack a method; only "drew nothing" matters */ }
  assert.equal(drawn.length, 0);
  Reel.setCaptionsOn(true);
  assert.equal(Reel.captionsOn(), true);
});

test("49: render.mjs loads and its help describes the render-time contrast", async () => {
  await import("../scripts/render.mjs");
  const src = fs.readFileSync(path.join(skill, "scripts", "render.mjs"), "utf8");
  assert.match(src, /Caption contrast: a render with captions on/);
});

// ---- N6: punctuation and script ---------------------------------------------------

test("N6: a deliberately wrong sentence is reported before the table is trusted", () => {
  const wrong = [
    ["de", "Das ist gut，oder nicht"],
    ["es", "Que quieres?"],
    ["en", "Why¿ not"],
    ["ja", "これは本当です,そうです"],
    ["zh", "这是真的,对吗"],
    ["ko", "정말 그래요。"],
  ];
  for (const [lang, text] of wrong) {
    const found = checkText(lang, text).filter((f) => f.severity === "wrong");
    assert.ok(found.length >= 1, `${lang}: ${text}`);
  }
  for (const [lang, text] of [["de", "Das ist gut, oder nicht?"], ["es", "¿Qué quieres?"], ["ja", "これは本当です、そうです。"], ["zh-Hans", "这是真的，对吗？"], ["ko", "정말 그래요."]]) {
    assert.deepEqual(checkText(lang, text), [], `${lang}: ${text}`);
  }
});

test("N6: graded findings are check, not wrong", () => {
  const f = checkText("fr", "Vraiment? oui");
  assert.deepEqual(f.map((x) => `${x.rule} ${x.severity}`), ["fr-space-before-high-mark check"]);
  assert.ok(checkText("de", "Das ist Привет gut").some((x) => x.rule === "other-script" && x.severity === "check"));
  assert.ok(checkText("zh", "这 是真的").some((x) => x.rule === "space-between-cjk"));
});

test("N6: languages come from the film's plan and dub folders; a language with no row says checked nothing", () => {
  const dir = tmp("sva-fix5-film-");
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en" }, lines: [{ id: "a", text: "Fine line." }] }));
  fs.mkdirSync(path.join(dir, "dub", "de"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "de", "plan.json"), JSON.stringify({ meta: { lang: "de" }, lines: [{ id: "a", text: "Guter Satz，ja" }] }));
  fs.mkdirSync(path.join(dir, "dub", "xx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "xx", "plan.json"), JSON.stringify({ lines: [{ id: "a", text: "x" }] }));
  const plans = languagePlans(dir);
  assert.deepEqual(plans.map((p) => p.lang), ["en", "de", "xx"]);
  const result = checkLanguages(plans);
  assert.deepEqual(result.noRow, ["xx"]);
  const text = formatPunctReport(result);
  assert.match(text, /de a: fullwidth-mark \[wrong\]/);
  assert.match(text, /xx: checked nothing .*rerun only this check/);
});

test("N6: a film with no caption text prints checked nothing", () => {
  assert.match(formatPunctReport(checkLanguages([])), /checked nothing .*rerun only this check/);
});

test("N6: the table in pipeline.md and the rules name the same languages", () => {
  const md = fs.readFileSync(path.join(skill, "references", "pipeline.md"), "utf8");
  const section = md.slice(md.indexOf("### Punctuation and script table"), md.indexOf("### Reviewing: `review.mjs`"));
  const codes = [...section.matchAll(/^\| (\w\w) \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(codes, Object.keys(LANGUAGES).sort());
});

// ---- 19: the printed message carries the next step --------------------------------

test("19: every tool that prints checked nothing also says to confirm, make targets, rerun only that check", () => {
  const sentence = /Confirm this video needs this check; if it does, make .+ and rerun only this check\./;
  assert.match(checkedNothingNext("a word cue"), sentence);
  assert.match(checkedNothingNext(), sentence);
  assert.match(formatCueWarnings([], 0), sentence);
  assert.match(formatCaptionBreaks([]), sentence);
  assert.match(formatCaptionBreaks([{ id: "a", before: null, after: null }]), sentence);
  assert.match(formatContrastReport([]), sentence);
  Reel.setSafeArea("none");
  try {
    assert.match(Reel.safeAreaNote(), sentence);
  } finally {
    Reel.setSafeArea("shorts");
  }
});

// ---- 45: clip blend ---------------------------------------------------------------

const CLIPS = { idle: { duration: 2, loop: true }, wave: { duration: 1.5 }, sit: { duration: 3 } };
const SWITCHES = [{ at: 0, clip: "idle" }, { at: 4, clip: "wave" }, { at: 8, clip: "sit" }];

test("45: blend weight is clamp((t - at) / 0.25) for the current clip and the rest for the previous", () => {
  const mid = Reel.clipBlend(SWITCHES, 4.1, CLIPS);
  assert.deepEqual(mid.map((x) => x.clip), ["wave", "idle"]);
  assert.ok(Math.abs(mid[0].weight - 0.4) < 1e-9);
  assert.ok(Math.abs(mid[1].weight - 0.6) < 1e-9);
  assert.ok(Math.abs(mid[0].weight + mid[1].weight - 1) < 1e-9);
});

test("45: after the blend the previous clip is gone, so the pose depends on t alone (any seek order)", () => {
  assert.deepEqual(Reel.clipBlend(SWITCHES, 4.25, CLIPS).map((x) => x.clip), ["wave"]);
  const forward = [3, 4.1, 4.3, 9].map((t) => JSON.stringify(Reel.clipBlend(SWITCHES, t, CLIPS)));
  const backward = [9, 4.3, 4.1, 3].map((t) => JSON.stringify(Reel.clipBlend(SWITCHES, t, CLIPS))).reverse();
  assert.deepEqual(forward, backward);
});

test("45: local time uses the clip's real length: a loop wraps, a one-shot holds its last pose", () => {
  const idle = Reel.clipBlend(SWITCHES, 3.5, CLIPS)[0];
  assert.equal(idle.clip, "idle");
  assert.ok(Math.abs(idle.time - 1.5) < 1e-9);
  const wave = Reel.clipBlend(SWITCHES, 7, CLIPS)[0];
  assert.equal(wave.clip, "wave");
  assert.equal(wave.time, 1.5);
  assert.equal(Reel.clipBlend(SWITCHES, 0.5, CLIPS).length, 1);
});

test("45: blend length and easing are options; a clip with no real duration throws", () => {
  const slow = Reel.clipBlend(SWITCHES, 4.5, CLIPS, { blend: 1 });
  assert.ok(Math.abs(slow[0].weight - 0.5) < 1e-9);
  const eased = Reel.clipBlend(SWITCHES, 4.125, CLIPS, { ease: (u) => u * u });
  assert.ok(Math.abs(eased[0].weight - 0.25) < 1e-9);
  assert.throws(() => Reel.clipBlend(SWITCHES, 1, { idle: {} }), /needs a duration/);
});
