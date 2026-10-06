// Sprint A8: per-language caption layer — caption chunks (item 20), corner notes
// (44), missing label keys (43), caption contrast (49), scene-text spans and
// still --dub (27), page declarations, "checked nothing" reports, and the
// termination-guard hardening.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTerminationGuard, sceneSpanVerdict } from "../scripts/dub.mjs";
import { previewDubTimings, stillFileName } from "../scripts/still.mjs";
import { formatCaptionBreaks } from "../scripts/lib/caption-breaks.mjs";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import { scaffold } from "../scripts/new-reel.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { openReel } from "../scripts/lib/browser.mjs";
import {
  measureCaptionContrast,
  relLuminance,
  contrastRatio,
  gradeContrast,
  analyzeCaptionFrame,
  sampleTimesForLines,
  formatContrastReport,
} from "../scripts/lib/caption-contrast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const words = (text) => text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, start: i, end: i + 1 }));
const chunkTexts = (text, maxChars, opts) => {
  const ws = words(text).filter((x) => x.w !== "|");
  return Reel.captionChunks(ws, maxChars, { breaks: Reel.captionBreaksFromText(text), ...opts }).map((c) => c.map((i) => ws[i].w));
};

// ---- 20 caption chunks -----------------------------------------------------

test("20: a '|' piece that fits keeps its commas even when the whole line is longer", () => {
  assert.deepEqual(chunkTexts("Yes, we can | no, they cannot do", 20), [
    ["Yes,", "we", "can"],
    ["no,", "they", "cannot", "do"],
  ]);
});

test("20: a piece that does not fit still splits at its comma", () => {
  const chunks = chunkTexts("Yes, we can do it all by tomorrow morning at the old station", 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length > 1), JSON.stringify(chunks));
});

test("20: a lone word from an automatic cut joins its neighbour when the pair fits", () => {
  const chunks = chunkTexts("Honestly, we can do it all by tomorrow", 24);
  assert.ok(chunks.every((c) => c.length > 1), JSON.stringify(chunks));
  assert.equal(chunks[0][0], "Honestly,");
});

test("20: a writer's '|' is never merged away", () => {
  assert.deepEqual(chunkTexts("Wait | we can do it", 40), [["Wait"], ["we", "can", "do", "it"]]);
});

// ---- 44 corner notes -------------------------------------------------------

const timings = {
  duration: 20,
  lines: [
    { id: "l1", text: "Welcome to the delta", start: 0, end: 4, words: [{ w: "Welcome", start: 0, end: 1 }, { w: "to", start: 1, end: 1.5 }, { w: "the", start: 1.5, end: 2 }, { w: "delta", start: 2.5, end: 4 }] },
    { id: "l2", text: "Nothing here", start: 5, end: 8 },
  ],
};
const basePlan = { lines: [{ id: "l1", text: "x", notes: [{ at: "word:delta", text: "delta: where a river meets the sea" }] }, { id: "l2", text: "y" }] };

test("44: wording comes from the language's plan, the moment from that language's word times", () => {
  const plan = { lines: [{ id: "l1", text: "Willkommen", notes: [{ at: "word:delta", text: "Delta: Flussmündung", corner: "bl", holdSec: 2 }] }, { id: "l2" }] };
  Reel.clearIssues();
  const notes = Reel.cornerNotes({ timings, plan, basePlan });
  assert.equal(notes.length, 1);
  assert.deepEqual({ ...notes[0] }, { id: "l1#0", lineId: "l1", text: "Delta: Flussmündung", corner: "bl", from: 2.5, to: 4.5 });
  assert.deepEqual(Reel.issues(), []);
});

test("44: a word the language's line lacks falls back to the line start and is recorded; a missing note is recorded", () => {
  Reel.clearIssues();
  const lost = Reel.cornerNotes({ timings, plan: { lines: [{ id: "l1", notes: [{ at: "word:Mündung", text: "n" }] }] }, basePlan });
  assert.equal(lost[0].from, 0);
  assert.equal(Reel.issues()[0].type, "note-word-not-found");
  Reel.clearIssues();
  Reel.cornerNotes({ timings, plan: { lines: [{ id: "l1" }] }, basePlan });
  assert.equal(Reel.issues()[0].type, "note-missing-in-language");
  Reel.clearIssues();
});

function noteCtx() {
  const log = { fills: [], texts: [] };
  const ctx = {
    canvas: { width: 1080, height: 1920 },
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    measureText: (s) => ({ width: String(s).length * 10 }),
    fillText: (s) => log.texts.push({ s, alpha: ctx.globalAlpha }),
    fillRect: (x, y, w, h) => log.fills.push({ x, y, w, h, alpha: ctx.globalAlpha }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return { ctx, log };
}

test("44: a note draws only inside its window, inside the safe area, with a fade", () => {
  const notes = [{ id: "l1#0", lineId: "l1", text: "delta: where a river meets the sea", corner: "tr", from: 2, to: 5 }];
  const before = noteCtx();
  Reel.drawCornerNotes(before.ctx, notes, 1.9, {});
  assert.equal(before.log.fills.length, 0);
  const fading = noteCtx();
  Reel.drawCornerNotes(fading.ctx, notes, 2.1, {});
  assert.ok(fading.log.fills[0].alpha < 1 && fading.log.fills[0].alpha > 0);
  const shown = noteCtx();
  Reel.drawCornerNotes(shown.ctx, notes, 3, {});
  const box = shown.log.fills[0];
  const safe = Reel.safeArea(1080, 1920);
  assert.equal(box.alpha, 1);
  assert.ok(box.x >= safe.x && box.x + box.w <= safe.x + safe.w && box.y >= safe.y);
  assert.ok(shown.log.texts.length > 0);
  const after = noteCtx();
  Reel.drawCornerNotes(after.ctx, notes, 5, {});
  assert.equal(after.log.fills.length, 0);
});

// ---- 43 missing label keys ---------------------------------------------------

test("43: a language that lacks a picture-string key is recorded; the base language and a present key are not", () => {
  Reel.setBaseLang("ko-KR");
  try {
    Reel.clearIssues();
    globalThis.__svaPicture = { lang: "en", strings: { brand: "Morning Brief" } };
    assert.equal(Reel.pictureText("brand", "아침"), "Morning Brief");
    assert.equal(Reel.pictureText("price", "9,900원"), "9,900원");
    assert.deepEqual(Reel.issues().map((i) => [i.type, i.key, i.lang]), [["picture-string-missing", "price", "en"]]);
    Reel.clearIssues();
    globalThis.__svaPicture = { lang: "ko", strings: {} };
    Reel.pictureText("price", "9,900원");
    assert.deepEqual(Reel.issues(), []);
  } finally {
    delete globalThis.__svaPicture;
    Reel.setBaseLang(null);
    Reel.clearIssues();
  }
});

test("43: overlayText records a key the dub's overlay lacks, never for the base language", () => {
  Reel.clearIssues();
  assert.equal(Reel.overlayText({ cta: "Subscribe" }, "cta", "구독", { dub: "en", base: "ko" }), "Subscribe");
  assert.equal(Reel.overlayText({ cta: "Subscribe" }, "price", "9,900원", { dub: "en", base: "ko" }), "9,900원");
  assert.equal(Reel.overlayText({}, "price", "9,900원", { dub: "ko-KR", base: "ko" }), "9,900원");
  assert.deepEqual(Reel.issues().map((i) => [i.type, i.key]), [["overlay-text-missing", "price"]]);
  Reel.clearIssues();
});

// ---- carries: page declarations, fonts, checked nothing ----------------------

test("declarations: a malformed regions / holds / langSpans entry throws and names it; good ones pass", () => {
  assert.deepEqual(Reel.checkRegions(undefined), []);
  const ok = [{ id: "logo", kind: "overlay", box: [0, 0, 10, 10], outline: 2, from: 1, to: 2 }];
  assert.equal(Reel.checkRegions(ok), ok);
  assert.throws(() => Reel.checkRegions([{ id: "a", kind: "key", box: [5, 5, 1, 9] }]), /regions\[0\] \(a\): box/);
  assert.throws(() => Reel.checkRegions([{ id: "a", kind: "sticker", box: [0, 0, 1, 1] }]), /kind/);
  assert.throws(() => Reel.checkRegions({}), /must be an array/);
  assert.throws(() => Reel.checkHolds([{ from: 3, to: 3 }]), /holds\[0\]/);
  assert.deepEqual(Reel.checkHolds([{ from: 1, to: 2, reason: "freeze" }]).length, 1);
  assert.throws(() => Reel.checkLangSpans([{ start: 1, end: 2, in: "world" }]), /langSpans\[0\]/);
  assert.throws(() => Reel.checkLangSpans([{ start: 2, end: 1 }]), /end > start/);
  assert.equal(Reel.checkLangSpans([{ start: 1, end: 2, in: "scene" }, { start: 3, end: 4 }]).length, 2);
});

test("captionFonts: exact tag, then primary subtag, then '*'; null when none names one", () => {
  const map = { ja: "'Noto Sans JP'", "zh-Hans": "'Noto Sans SC'", "*": "'Pretendard'" };
  assert.equal(Reel.captionFontFor(map, "ja-JP"), "'Noto Sans JP'");
  assert.equal(Reel.captionFontFor(map, "zh-Hans"), "'Noto Sans SC'");
  assert.equal(Reel.captionFontFor(map, "fr"), "'Pretendard'");
  assert.equal(Reel.captionFontFor({ ja: "x" }, "fr"), null);
  assert.equal(Reel.captionFontFor(undefined, "fr"), null);
});

test("captionFonts: Reel.caption draws with the language's font", () => {
  const { ctx } = noteCtx();
  ctx.textBaseline = "";
  const fonts = [];
  Object.defineProperty(ctx, "font", { get: () => fonts[fonts.length - 1], set: (v) => fonts.push(v) });
  Reel.caption(ctx, { text: "こんにちは" }, 0, { width: 1080, height: 1920, lang: "ja", captionFonts: { ja: "'Noto Sans JP'" } });
  assert.ok(fonts.some((f) => /Noto Sans JP/.test(f)), fonts.join(" | "));
});

test("safe area 'none' says it checked nothing; the presets do not", () => {
  const log = console.info;
  const lines = [];
  console.info = (s) => lines.push(s);
  try {
    Reel.setSafeArea("none");
    assert.match(Reel.safeAreaNote(), /^checked nothing/);
    assert.match(lines[0], /^checked nothing/);
    Reel.setSafeArea("shorts");
    assert.equal(Reel.safeAreaNote(), null);
  } finally {
    console.info = log;
    Reel.setSafeArea("shorts");
  }
});

test("--breaks: a table with no break to read reads 'checked nothing', not a pass", () => {
  assert.match(formatCaptionBreaks([{ id: "a", before: null, after: null }, { id: "b", before: null, after: null }]), /checked nothing — every line is one piece \(2 lines\)/);
  assert.match(formatCaptionBreaks([]), /checked nothing/);
  assert.match(formatCaptionBreaks([{ id: "a", before: "can", after: "not" }, { id: "b", before: null, after: null }]), /b: \(one piece\)/);
});

// ---- 49 contrast -----------------------------------------------------------

const W = 40;
const H = 20;
/** RGBA caption: two 6x4 blocks of `color` (a gap between them shows the picture). */
function captionFrame(colors) {
  const px = new Uint8Array(W * H * 4);
  const block = (x0, color) => {
    for (let y = 8; y < 12; y++) {
      for (let x = x0; x < x0 + 6; x++) px.set([...color, 255], (y * W + x) * 4);
    }
  };
  block(5, colors[0]);
  block(20, colors[1] || colors[0]);
  return px;
}
const pictureFrame = (rgb) => {
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(rgb, i * 3);
  return px;
};

test("49: WCAG math — black on white is 21:1, equal colours 1:1; grades at 3 and 4.5", () => {
  assert.equal(contrastRatio(relLuminance(255, 255, 255), relLuminance(0, 0, 0)).toFixed(1), "21.0");
  assert.equal(contrastRatio(0.5, 0.5), 1);
  assert.deepEqual([2.9, 3, 4.4, 4.5].map(gradeContrast), ["low", "marginal", "marginal", "ok"]);
});

test("49: white text on a bright picture is flagged (light on light)", () => {
  const r = analyzeCaptionFrame({ caption: captionFrame([[255, 255, 255]]), picture: pictureFrame([240, 240, 240]), width: W, height: H });
  assert.equal(r.grade, "low");
  assert.equal(r.direction, "light on light");
  assert.ok(r.ratio < 1.2);
});

test("49: dark text on a dark picture is flagged too (dark on dark)", () => {
  const r = analyzeCaptionFrame({ caption: captionFrame([[17, 17, 17]]), picture: pictureFrame([20, 20, 24]), width: W, height: H });
  assert.equal(r.grade, "low");
  assert.equal(r.direction, "dark on dark");
});

test("49: readable pairs pass in both directions", () => {
  assert.equal(analyzeCaptionFrame({ caption: captionFrame([[255, 255, 255]]), picture: pictureFrame([10, 10, 10]), width: W, height: H }).grade, "ok");
  assert.equal(analyzeCaptionFrame({ caption: captionFrame([[17, 17, 17]]), picture: pictureFrame([240, 240, 240]), width: W, height: H }).grade, "ok");
});

test("49: an outlined caption (white fill, black outline) is judged by the tone that reads best", () => {
  const r = analyzeCaptionFrame({ caption: captionFrame([[255, 255, 255], [0, 0, 0]]), picture: pictureFrame([240, 240, 240]), width: W, height: H });
  assert.equal(r.tones.length, 2);
  assert.equal(r.grade, "ok");
});

test("49: a frame with no drawn caption is null; the report says checked nothing when nothing was measured", () => {
  assert.equal(analyzeCaptionFrame({ caption: new Uint8Array(W * H * 4), picture: pictureFrame([0, 0, 0]), width: W, height: H }), null);
  assert.match(formatContrastReport([{ lineId: "l1", t: 1, grade: "no-caption" }]), /checked nothing/);
});

test("49: the report names line id, time, grade and direction for flagged frames only", () => {
  const low = analyzeCaptionFrame({ caption: captionFrame([[255, 255, 255]]), picture: pictureFrame([240, 240, 240]), width: W, height: H });
  const ok = analyzeCaptionFrame({ caption: captionFrame([[255, 255, 255]]), picture: pictureFrame([0, 0, 0]), width: W, height: H });
  const text = formatContrastReport([{ lineId: "l3", t: 4.5, ...low }, { lineId: "l4", t: 6, ...ok }]);
  assert.match(text, /2 frames measured, 1 flagged/);
  assert.match(text, /l3 t=4\.50s LOW .*light on light/);
  assert.doesNotMatch(text, /l4/);
});

test("49: samples fall inside each line on distinct frames; a very short line gets one", () => {
  const s = sampleTimesForLines([{ id: "a", start: 0, end: 3 }, { id: "b", start: 3, end: 3.2 }], 30);
  assert.equal(s.filter((x) => x.lineId === "a").length, 3);
  assert.equal(s.filter((x) => x.lineId === "b").length, 1);
  assert.ok(s.every((x) => x.t >= 0 && x.t < 3.2));
});

// ---- 27 scene text + still --dub -------------------------------------------

test("27: scene text over the base picture stops the dub of another language, and names the fix", () => {
  const spans = [{ start: 10, end: 12, in: "scene" }, { start: 20, end: 21 }];
  const msg = sceneSpanVerdict({ spans, lang: "en", baseLang: "ko-KR", pictureSource: "base", dir: "/r" });
  assert.match(msg, /render\.mjs \/r --no-captions --lang en/);
  assert.match(msg, /10-12/);
  assert.equal(sceneSpanVerdict({ spans, lang: "en", baseLang: "ko-KR", pictureSource: "lang", dir: "/r" }), null);
  assert.equal(sceneSpanVerdict({ spans, lang: "ko", baseLang: "ko-KR", pictureSource: "base", dir: "/r" }), null);
  assert.equal(sceneSpanVerdict({ spans: [{ start: 1, end: 2 }], lang: "en", baseLang: "ko", pictureSource: "base", dir: "/r" }), null);
  assert.equal(sceneSpanVerdict({ spans, lang: "en", baseLang: null, pictureSource: "base", dir: "/r" }), null);
});

test("27: previewDubTimings keeps the base clock, takes the language's text, drops words, lists missing lines", () => {
  const base = { duration: 9, lines: [{ id: "a", text: "안녕", start: 0, end: 4, words: [{ w: "안녕", start: 0, end: 1 }] }, { id: "b", text: "끝", start: 4, end: 9 }] };
  const { timings: t, missing } = previewDubTimings(base, { lines: [{ id: "a", text: "Hello there" }] });
  assert.equal(t.duration, 9);
  assert.deepEqual(t.lines.map((l) => [l.id, l.text, l.start, l.end, "words" in l]), [["a", "Hello there", 0, 4, false], ["b", "끝", 4, 9, false]]);
  assert.deepEqual(missing, ["b"]);
  assert.equal(base.lines[0].words.length, 1);
});

test("27: still file name for a language preview", () => {
  assert.equal(stillFileName("12.5", false, "zh-Hans"), "still-12.5-dub-zh-Hans.png");
  assert.equal(stillFileName("12.5", false), "still-12.5.png");
});

test("27: still.mjs --dub refuses --no-captions and --stub before opening a browser", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a8-still-"));
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), "<!doctype html>");
    const run = (...extra) => spawnSync(process.execPath, [path.join(here, "..", "scripts", "still.mjs"), dir, "--at", "1", "--dub", "en", ...extra], { encoding: "utf8" });
    const a = run("--no-captions");
    assert.notEqual(a.status, 0);
    assert.match(a.stderr, /--dub previews a language's caption layer/);
    const b = run("--stub", "4");
    assert.notEqual(b.status, 0);
    assert.match(b.stderr, /--dub needs the film's own voice\/timings\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fixtures: ffmpeg readers and a real caption-layer page -----------------------

const rawFirstPixel = async (png) => {
  const { stdout } = await ffmpeg(["-i", png, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [...stdout.subarray(0, 3)];
};

test("49: measureCaptionContrast reads a real caption PNG against a real picture file, both directions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a8-contrast-"));
  try {
    const caption = path.join(dir, "frame-00001.png");
    // a white 16x8 block on a transparent 64x64 canvas
    await ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=16x8:d=1", "-vf", "format=rgba,pad=64:64:20:28:color=0x00000000", "-frames:v", "1", caption]);
    for (const f of [4, 6]) fs.copyFileSync(caption, path.join(dir, `frame-0000${f}.png`));
    const lines = [{ id: "l1", start: 0, end: 0.8 }];
    const run = async (color) => {
      const mp4 = path.join(dir, `${color}.mp4`);
      await ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=64x64:d=1:r=10`, "-pix_fmt", "yuv420p", mp4]);
      return measureCaptionContrast({ captionsDir: dir, pictureMp4: mp4, lines, fps: 10, width: 64, height: 64, frameFile: (n) => `frame-${String(n).padStart(5, "0")}.png` });
    };
    const bright = await run("white");
    assert.equal(bright.length, 3);
    assert.ok(bright.every((r) => r.grade === "low" && r.direction === "light on light"), JSON.stringify(bright));
    const dark = await run("black");
    assert.ok(dark.every((r) => r.grade === "ok"), JSON.stringify(dark));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Paints green when the dub's first line reads "Hello there" (the language's plan text), red otherwise.
const DUB_PAGE = `<!doctype html><canvas width="16" height="16"></canvas><script>
var q = new URLSearchParams(location.search);
var timings = null;
var ready = fetch("dub/" + q.get("dub") + "/timings.placed.json").then(function (r) { return r.json(); }).then(function (d) { timings = d; });
window.__reel = {
  width: 16, height: 16, fps: 10, ready: ready, layers: ["captions"],
  get duration() { return timings.duration; },
  get shots() { return timings.lines.map(function (l) { return { id: l.id, start: l.start, end: l.end, readAt: (l.start + l.end) / 2 }; }); },
  seek: function () { var g = document.querySelector("canvas").getContext("2d"); g.fillStyle = timings.lines[0].text === "Hello there" ? "#00ff00" : "#ff0000"; g.fillRect(0, 0, 16, 16); },
};
</script>`;

test("27: still --dub previews a language that is not dubbed yet from its plan text on the base clock, and writes nothing into the reel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a8-dubstill-"));
  try {
    fs.mkdirSync(path.join(dir, "voice"));
    fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reel.html"), DUB_PAGE);
    fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify({ duration: 4, lines: [{ id: "a", text: "안녕", start: 0, end: 4 }] }));
    fs.writeFileSync(path.join(dir, "dub", "en", "plan.json"), JSON.stringify({ meta: { lang: "en" }, lines: [{ id: "a", text: "Hello there" }] }));
    const r = spawnSync(process.execPath, [path.join(here, "..", "scripts", "still.mjs"), dir, "--at", "1", "--dub", "en"], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /previewing on the base language's clock/);
    const [red, green, blue] = await rawFirstPixel(path.join(dir, "out", "still-1-dub-en.png"));
    assert.ok(green > 250 && red < 5 && blue < 5, `first pixel ${[red, green, blue]} (green = the language's plan text reached the page)`);
    assert.equal(fs.existsSync(path.join(dir, "dub", "en", "timings.placed.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- scaffolded templates in a browser: corner notes + page declarations ----------

const hasBrowser = fs.existsSync(path.join(here, "..", "node_modules", "playwright-core", "index.mjs"));
const skipBrowser = !hasBrowser && "playwright-core not installed";

async function noteReel(threeD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a8-tpl-"));
  await scaffold({ dir, width: 216, height: 384, fps: 10, title: "T", ratio: "9:16", threeD });
  const base = { duration: 6, lines: [{ id: "l1", text: "안녕 델타 하세요", start: 0.4, end: 5.5 }] };
  const placed = { duration: 6, lines: [{ id: "l1", text: "Hello delta river", start: 0.4, end: 5.5, words: [{ w: "Hello", start: 0.4, end: 1 }, { w: "delta", start: 3, end: 3.6 }, { w: "river", start: 4, end: 5 }] }] };
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "ko-KR" }, lines: [{ id: "l1", text: "안녕 델타 하세요", notes: [{ at: "word:델타", text: "델타: 강이 바다를 만나는 곳" }] }] }));
  fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "en", "timings.placed.json"), JSON.stringify(placed));
  fs.writeFileSync(path.join(dir, "dub", "en", "plan.json"), JSON.stringify({ meta: { lang: "en" }, lines: [{ id: "l1", text: "Hello delta river", notes: [{ at: "word:delta", text: "Delta: where a river meets the sea", holdSec: 1 }] }] }));
  return dir;
}

async function topRightPainted(page, t) {
  return page.evaluate(async (x) => {
    const r = window.__reel.seek(x);
    if (r && r.then) await r;
    const c = document.getElementById("stage");
    const d = c.getContext("2d").getImageData(c.width / 2, 0, c.width / 2, c.height / 3).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, t);
}

for (const threeD of [false, true]) {
  test(`${threeD ? "3D" : "2D"} template: the dub's corner note shows from that language's word time, and the page declarations are arrays`, { skip: skipBrowser }, async () => {
    const dir = await noteReel(threeD);
    const server = await serveDir(dir);
    let session;
    try {
      session = await openReel(server.url.replace(/\/$/, "") + "/reel.html?layer=captions&dub=en", { width: 216, height: 384 });
      assert.equal(await topRightPainted(session.page, 2.5), 0, "before the English word 'delta' (3.0 s): no note");
      assert.ok((await topRightPainted(session.page, 3.4)) > 0, "after it: the note is drawn");
      assert.equal(await topRightPainted(session.page, 4.8), 0, "after holdSec: gone");
      const decl = await session.page.evaluate(() => ({ r: window.__reel.regions, h: window.__reel.holds, s: window.__reel.langSpans, f: window.__reel.captionFonts }));
      assert.deepEqual(decl, { r: [], h: [], s: [], f: {} });
      assert.deepEqual(session.errors, []);
    } finally {
      if (session) await session.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---- leader note: termination guard -------------------------------------------

test("guard: one failed removal (a child still writing) does not stop the others or change the exit code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a8-guard-"));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const real = fs.rmSync;
  const tried = [];
  const calls = [];
  const writes = [];
  fs.rmSync = (p, o) => {
    tried.push(p);
    if (p === a) throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
    return real(p, o);
  };
  try {
    createTerminationGuard({ temps: new Set([a, b]), kill: () => {}, exit: (c) => calls.push(c), write: (s) => writes.push(s) }).handle("SIGTERM");
  } finally {
    fs.rmSync = real;
  }
  try {
    assert.deepEqual(calls, [143]);
    assert.deepEqual(tried, [a, b]);
    assert.equal(fs.existsSync(b), false);
    assert.ok(writes.some((s) => /could not remove .*ENOTEMPTY/.test(s)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guard: it is installed before the --insert-time early return", () => {
  const src = fs.readFileSync(path.join(here, "..", "scripts", "dub.mjs"), "utf8");
  const install = src.indexOf("createTerminationGuard().install()");
  assert.ok(install > 0);
  assert.ok(install < src.indexOf("return runTimeInsert(dir, flags)"));
});
