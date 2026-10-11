// S3a: text contrast from the drawn colours (lib/text-contrast.mjs), the probe's records
// (lib/page-probe.mjs), the captions-on render path (lib/render-contrast.mjs) and dub's record path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCssColor, judgeRecord, contrastFindings, formatContrastFindings } from "../scripts/lib/text-contrast.mjs";
import { measureCaptionContrast, sampleTimesForLines, formatContrastReport, lumBand, backgroundUnderText } from "../scripts/lib/caption-contrast.mjs";
import { formatStateChecks, VISIBLE_ALPHA } from "../scripts/lib/state-checks.mjs";
import { installTextProbe, collectFrameStates } from "../scripts/lib/page-probe.mjs";
import { createContrastCollector, measureDrawnFrame, reportRenderContrast, captionRecordsAtSamples } from "../scripts/lib/render-contrast.mjs";
import { openReel } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(here, "..", "scripts", "engine", "reel-engine.js");
const opts = { fps: 10, minAlpha: VISIBLE_ALPHA };

/** A uniform background histogram at one grey level (what the probe returns for a flat picture). */
function flatPicture(grey, n = 1000) {
  const hist = new Array(256).fill(0);
  hist[lumBand(grey, grey, grey)] = n;
  return { hist, n };
}

test("dub: the background under a text is the picture where the layer draws letters, the layer composited elsewhere", () => {
  const picture = new Uint8Array(4 * 3).fill(250);
  const caption = new Uint8Array(4 * 4);
  caption.set([255, 255, 255, 255], 4); // pixel 1: a white letter
  caption.set([0, 0, 0, 255], 8); // pixel 2: an opaque black band
  const h = backgroundUnderText({ caption, picture, width: 4, height: 1 }, [0, 0, 3, 1], [255, 255, 255]);
  assert.equal(h.n, 3, "the box only");
  assert.equal(h.hist[lumBand(250, 250, 250)], 2, "the letter pixel shows the picture under it, not the letter");
  assert.equal(h.hist[0], 1);
});

const rec = (o) => ({ text: "Hello", font: "800 56px sans-serif", alpha: 1, effAlpha: 1, box: [0, 0, 100, 40], kind: "fill", color: "#ffffff", role: "caption", backing: null, ...o });

test("parseCssColor: canvas and computed-style forms; gradients are not colours", () => {
  assert.deepEqual(parseCssColor("#ffffff"), { rgb: [255, 255, 255], a: 1 });
  assert.deepEqual(parseCssColor("#0f0"), { rgb: [0, 255, 0], a: 1 });
  assert.deepEqual(parseCssColor("rgba(0, 0, 0, 0.62)"), { rgb: [0, 0, 0], a: 0.62 });
  assert.deepEqual(parseCssColor("rgb(10 20 30 / 0.5)"), { rgb: [10, 20, 30], a: 0.5 });
  assert.equal(parseCssColor("transparent").a, 0);
  assert.equal(parseCssColor("paint"), null);
});

test("pair: white text on its own opaque black box is 21:1, no pixels needed", () => {
  const j = judgeRecord(rec({ backing: { kind: "fill", color: "#000000", alpha: 1 } }));
  assert.equal(j.method, "pair");
  assert.equal(j.grade, "ok");
  assert.ok(Math.abs(j.ratio - 21) < 1e-9);
  assert.equal(j.backColor, "#000000");
});

test("pair: an outline backs its fill; translucent text blends into its box", () => {
  assert.equal(judgeRecord(rec({ backing: { kind: "outline", color: "#000000", alpha: 1 } })).method, "pair");
  const faint = judgeRecord(rec({ effAlpha: 0.1, backing: { kind: "fill", color: "#000000", alpha: 1 } }));
  assert.equal(faint.method, "pair");
  assert.equal(faint.grade, "low", `10% white over black reads low (${faint.ratio})`);
});

test("translucent band or gradient backing is not a pair: the picture under the box decides", () => {
  const band = rec({ backing: { kind: "fill", color: "rgba(0, 0, 0, 0.62)", alpha: 0.62 } });
  assert.equal(judgeRecord(band).method, "unmeasured", "no picture histogram, nothing guessed");
  const dark = judgeRecord({ ...band, picture: flatPicture(40) });
  assert.equal(dark.method, "picture");
  assert.equal(dark.grade, "ok");
  const paint = judgeRecord(rec({ backing: { kind: "fill", color: "paint", alpha: 1 }, picture: flatPicture(250) }));
  assert.equal(paint.method, "picture");
  assert.equal(paint.grade, "low");
});

test("gradient text is reported as not measured, with the reason", () => {
  const j = judgeRecord(rec({ color: "paint", backing: { kind: "fill", color: "#000000", alpha: 1 } }));
  assert.equal(j.method, "unmeasured");
  assert.match(j.reason, /gradient/);
});

test("translucent text on a picture: the ratio falls between the opaque text and no text", () => {
  const full = judgeRecord(rec({ picture: flatPicture(20) })).ratio;
  const half = judgeRecord(rec({ effAlpha: 0.5, picture: flatPicture(20) })).ratio;
  assert.ok(half > 1 && half < full, `${half} between 1 and ${full}`);
});

test("findings: a pair is one group across frames and texts; outlines and invisible draws are skipped", () => {
  const boxed = (text) => rec({ text, backing: { kind: "fill", color: "#333333", alpha: 1 } });
  const frames = [0, 1, 2].map((frame) => ({ frame, lineId: `l${frame}`, texts: [boxed("one"), boxed("two"), rec({ kind: "stroke", servesAsOutline: true }), rec({ effAlpha: 0, alpha: 0 })] }));
  const f = contrastFindings(frames, opts);
  assert.equal(f.groups.length, 1);
  const g = f.groups[0];
  assert.equal(g.method, "pair");
  assert.equal(g.frames, 6);
  assert.equal(g.texts, 2);
  assert.equal(g.first, 0);
  assert.equal(g.last, 0.2);
  assert.deepEqual(g.lineIds, ["l0", "l1", "l2"]);
  assert.equal(f.records, 6);
});

test("findings: the same colours at another font size are another group; picture checks group by text", () => {
  const a = rec({ backing: { kind: "fill", color: "#000000", alpha: 1 } });
  const b = { ...a, font: "800 24px sans-serif" };
  const p1 = rec({ text: "x", picture: flatPicture(250) });
  const p2 = rec({ text: "y", picture: flatPicture(250) });
  const f = contrastFindings([{ frame: 0, texts: [a, b, p1, p2] }], opts);
  assert.equal(f.pair, 2);
  assert.equal(f.picture, 2);
});

test("format: flagged groups name text, role, span, ratio, method and colours; empty input says checked nothing", () => {
  const f = contrastFindings([{ frame: 5, texts: [rec({ text: "Bare", picture: flatPicture(250) }), rec({ text: "Boxed", backing: { kind: "fill", color: "#000000", alpha: 1 } })] }], opts);
  const s = formatContrastFindings(f);
  assert.match(s, /2 measured \(1 pair, 1 picture\), 1 flagged/);
  assert.match(s, /LOW \d+\.\d+:1 picture caption "Bare" 0\.50–0\.50 s .*text #ffffff/);
  assert.doesNotMatch(s, /"Boxed"/);
  assert.match(formatContrastFindings(contrastFindings([], opts)), /checked nothing .*WebGL/);
  assert.match(formatStateChecks({ sampledFrames: 1, contrast: f }), /text contrast/);
});

test("dub: measureCaptionContrast measures a frame from its records; a pair reads no files", async () => {
  const lines = [{ id: "l1", start: 0, end: 1 }];
  const records = new Map(sampleTimesForLines(lines, 10).map((s) => [s.frame, [rec({ backing: { kind: "fill", color: "#000000", alpha: 1 } })]]));
  const rows = await measureCaptionContrast({ captionsDir: "/nonexistent", pictureMp4: "/nonexistent.mp4", lines, fps: 10, width: 64, height: 64, frameFile: () => "x.png", records });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.method === "pair" && r.grade === "ok"), JSON.stringify(rows[0]));
  const faint = await measureCaptionContrast({ captionsDir: "/nonexistent", pictureMp4: "/nonexistent.mp4", lines, fps: 10, width: 64, height: 64, frameFile: () => "x.png",
    records: new Map([...records.keys()].map((k) => [k, [rec({ effAlpha: 0.1, backing: { kind: "fill", color: "#000000", alpha: 1 } })]])) });
  assert.match(formatContrastReport(faint), /LOW .*on its own box #000000 \(pair\)/);
});

test("dub: captionRecordsAtSamples seeks once per sampled frame and feeds measureCaptionContrast", async () => {
  const lines = [{ id: "l1", start: 0, end: 1 }];
  const seeks = [];
  const probe = {
    install: async () => {},
    seek: async (_page, t) => {
      seeks.push(t);
      return [rec({ role: "caption", backing: { kind: "fill", color: "#000000", alpha: 1 } }), rec({ role: "picture" })];
    },
  };
  const page = { evaluate: async () => true };
  const records = await captionRecordsAtSamples({ page, lines, fps: 10, probe });
  assert.equal(seeks.length, sampleTimesForLines(lines, 10).length);
  assert.ok([...records.values()].every((r) => r.length === 1 && r[0].role === "caption"));
  const rows = await measureCaptionContrast({ captionsDir: "/nonexistent", pictureMp4: "/nonexistent.mp4", lines, fps: 10, width: 64, height: 64, frameFile: () => "x.png", records });
  assert.ok(rows.every((r) => r.method === "pair" && r.grade === "ok"), JSON.stringify(rows[0]));
});

test("dub: an engine that does not tag its draws, or a seek that draws no caption, keeps the pixel path", async () => {
  const lines = [{ id: "l1", start: 0, end: 1 }];
  const probe = { install: async () => { throw new Error("must not install"); }, seek: async () => [] };
  assert.equal(await captionRecordsAtSamples({ page: { evaluate: async () => false }, lines, fps: 10, probe }), null);
  const silent = { install: async () => {}, seek: async () => [rec({ role: "picture" })] };
  assert.equal(await captionRecordsAtSamples({ page: { evaluate: async () => true }, lines, fps: 10, probe: silent }), null);
});

// ---- real browser ---------------------------------------------------------------------------------

/**
 * A reel whose picture is a white image (drawImage) and whose caption is drawn by the engine:
 * t < 0.5 white text on an opaque black box, else white text bare. A DOM label over the canvas
 * mirrors it: white on black, then white with no background.
 */
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<div style="position:relative;width:400px;height:200px">
<canvas width="400" height="200" style="position:absolute;left:0;top:0"></canvas>
<div id="label" style="position:absolute;left:20px;top:20px;font:700 20px sans-serif;color:#fff;padding:4px">Label</div>
</div>
<script src="reel-engine.js"></script>
<script>
var ctx = document.querySelector("canvas").getContext("2d");
var white = document.createElement("canvas"); white.width = 400; white.height = 200;
var w = white.getContext("2d"); w.fillStyle = "#fff"; w.fillRect(0, 0, 400, 200);
window.__reel = {
  width: 400, height: 200, fps: 10, duration: 1, ready: Promise.resolve(), shots: [],
  seek: function (t) {
    var boxed = t < 0.5;
    ctx.clearRect(0, 0, 400, 200);
    ctx.drawImage(white, 0, 0);
    var o = boxed ? { color: "#fff", band: "#000" } : { color: "#fff" };
    Reel.caption(ctx, { text: "Hello there" }, t, Object.assign({ width: 400, height: 200, x: 20, y: 120, boxW: 360, boxH: 60, fontPx: 28 }, o));
    document.getElementById("label").style.background = boxed ? "#000" : "transparent";
  }
};
</script></body></html>`;

async function withPage(fn, html = PAGE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-s3a-"));
  fs.writeFileSync(path.join(dir, "reel.html"), html);
  fs.copyFileSync(engine, path.join(dir, "reel-engine.js"));
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url, { warm: false, width: 400, height: 200, readyTimeoutMs: 20000 });
    try {
      await fn(s.page);
    } finally {
      await s.close();
    }
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("browser: white text on its own opaque box over a white picture is a pair, ok, no flags; bare white text on it is a low picture check", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await installTextProbe(page, { pixels: true });
    const { frames } = await collectFrameStates(page, { fps: 2, duration: 1, step: 1, dom: true });
    assert.equal(frames.length, 2);
    const caption = (f) => f.texts.filter((r) => r.role === "caption");
    const [boxed] = caption(frames[0]);
    assert.equal(boxed.color, "#ffffff");
    assert.deepEqual(boxed.backing, { kind: "fill", color: "#000000", alpha: 1 });
    assert.equal(boxed.picture, undefined, "a pair reads no pixels");
    const [bare] = caption(frames[1]);
    assert.equal(bare.backing, null, "the white picture is an image, not a backing");
    assert.ok(bare.picture && bare.picture.n > 0);

    const onlyBoxed = contrastFindings([{ ...frames[0], dom: [] }], { fps: 2, minAlpha: VISIBLE_ALPHA });
    assert.equal(onlyBoxed.groups.length, 1);
    assert.equal(onlyBoxed.groups[0].method, "pair");
    assert.equal(onlyBoxed.groups[0].grade, "ok");
    assert.match(formatContrastFindings(onlyBoxed), /0 flagged/);

    const onlyBare = contrastFindings([{ ...frames[1], dom: [] }], { fps: 2, minAlpha: VISIBLE_ALPHA });
    assert.equal(onlyBare.groups[0].method, "picture");
    assert.equal(onlyBare.groups[0].grade, "low");

    const dom = (f) => f.dom.find((r) => r.text === "Label");
    assert.equal(judgeRecord(dom(frames[0])).method, "pair");
    assert.equal(judgeRecord(dom(frames[0])).grade, "ok");
    const bareDom = judgeRecord(dom(frames[1]));
    assert.equal(bareDom.method, "picture");
    assert.equal(bareDom.grade, "low");
  });
});

// t < 0.5: an outlined text (black stroke, then white fill). Else: a black band, then an image over part of
// it, then the text — the image breaks the band as a backing.
const BACKINGS = `<!doctype html><canvas width="400" height="200"></canvas><script>
var ctx = document.querySelector("canvas").getContext("2d");
var img = document.createElement("canvas"); img.width = 60; img.height = 60;
img.getContext("2d").fillRect(0, 0, 60, 60);
window.__reel = { width: 400, height: 200, fps: 10, duration: 1, ready: Promise.resolve(), shots: [],
  seek: function (t) {
    ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, 400, 200);
    ctx.font = "40px sans-serif"; ctx.textBaseline = "top";
    if (t < 0.5) {
      ctx.lineWidth = 6; ctx.strokeStyle = "#000"; ctx.strokeText("Outlined", 40, 60);
      ctx.fillStyle = "#fff"; ctx.fillText("Outlined", 40, 60);
    } else {
      ctx.fillStyle = "#000"; ctx.beginPath(); ctx.roundRect(20, 40, 360, 80, 12); ctx.fill();
      ctx.drawImage(img, 60, 50);
      ctx.fillStyle = "#fff"; ctx.fillText("Covered", 40, 60);
    }
  } };
</script>`;

test("browser: an outline stroke backs its fill; an image drawn over the band before the text breaks it", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await installTextProbe(page, { pixels: true });
    const { frames } = await collectFrameStates(page, { fps: 2, duration: 1, step: 1 });
    const [stroke, fill] = frames[0].texts;
    assert.equal(stroke.kind, "stroke");
    assert.equal(stroke.servesAsOutline, true);
    assert.equal(stroke.lineWidth, 6);
    assert.deepEqual(fill.backing, { kind: "outline", color: "#000000", alpha: 1 });
    assert.equal(judgeRecord(fill).method, "pair");
    const [covered] = frames[1].texts;
    assert.equal(covered.backing, null);
    assert.equal(judgeRecord(covered).method, "picture");
    const f = contrastFindings(frames, { fps: 2, minAlpha: VISIBLE_ALPHA });
    assert.equal(f.records, 2, "the outline stroke is not a text of its own");
  }, BACKINGS);
});

test("browser: the captions-on render path reads caption records at its sampled frames", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    const boxed = createContrastCollector({ lines: [{ id: "l1", start: 0, end: 0.4 }], fps: 10, width: 400, height: 200 });
    for (const frame of boxed.frames.keys()) await measureDrawnFrame(boxed, { page, frame, withPng: null, capture: null });
    assert.equal(boxed.mode, "records");
    assert.ok(boxed.states.length >= 1 && boxed.states.every((s) => s.texts.length === 1 && s.texts[0].role === "caption"));
    const bare = createContrastCollector({ lines: [{ id: "l2", start: 0.6, end: 1 }], fps: 10, width: 400, height: 200 });
    for (const frame of bare.frames.keys()) await measureDrawnFrame(bare, { page, frame, withPng: null, capture: null });
    const out = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s, ...rest) => (typeof s === "string" ? (out.push(s), true) : write(s, ...rest));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-s3a-out-"));
    try {
      reportRenderContrast(boxed, path.join(dir, "a.json"));
      reportRenderContrast(bare, path.join(dir, "b.json"));
    } finally {
      process.stdout.write = write;
    }
    const [a, b] = out;
    assert.match(a, /caption contrast .* 1 measured \(1 pair, 0 picture\), 0 flagged/);
    assert.match(b, /1 flagged\n  LOW .* picture caption "Hello there" .*lines l2/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8"));
    assert.equal(saved.method, "records");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
