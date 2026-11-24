// Reel.caption()'s band centres the glyph ink vertically: equal space above the first row's ink and
// below the last row's ink, whatever the font's em-box metrics are.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "..", "scripts", "engine", "reel-engine.js")).href);
const Reel = globalThis.Reel;

// A font whose ink sits low in its em box: ink spans 12..42 below a "top" baseline, so the
// alphabetic baseline is 40 below the top, ascent 28, descent 2.
const INK = { top: 12, bottom: 42, alphabeticBase: 40 };

function mockCtx({ withInkMetrics = true } = {}) {
  const log = { rects: [], texts: [] };
  const ctx = {
    canvas: { width: 1080, height: 1920 },
    textBaseline: "alphabetic",
    font: "",
    fillStyle: "",
    save() {},
    restore() {},
    measureText(s) {
      const m = { width: String(s).length * 10 };
      if (!withInkMetrics) return m;
      const top = this.textBaseline === "top";
      m.actualBoundingBoxAscent = top ? -INK.top : INK.alphabeticBase - INK.top;
      m.actualBoundingBoxDescent = top ? INK.bottom : INK.bottom - INK.alphabeticBase;
      return m;
    },
    fillRect(x, y, w, h) { log.rects.push({ x, y, w, h }); },
    fillText(text, x, y) {
      const base = this.textBaseline === "top" ? y - INK.top : y - (INK.alphabeticBase - INK.top);
      // Absolute ink top/bottom of this row, whichever baseline was used.
      const inkTop = this.textBaseline === "top" ? y + INK.top : y - (INK.alphabeticBase - INK.top);
      const inkBottom = this.textBaseline === "top" ? y + INK.bottom : y + (INK.bottom - INK.alphabeticBase);
      log.texts.push({ text, inkTop, inkBottom, base });
    },
  };
  return { ctx, log };
}

const captionLine = (text) => ({ text, start: 0, end: 2 });

for (const text of ["안녕하세요 ABC 123", "한 줄\n두 번째 줄 둘"]) {
  test(`caption band: ink is vertically centred (${text.split("\n").length} row(s))`, () => {
    const { ctx, log } = mockCtx();
    Reel.caption(ctx, captionLine(text), 0, { fontPx: 50, lineHeight: 62 });
    assert.equal(log.rects.length, 1, "one band drawn");
    const band = log.rects[0];
    const top = Math.min(...log.texts.map((t) => t.inkTop));
    const bottom = Math.max(...log.texts.map((t) => t.inkBottom));
    const gapTop = top - band.y;
    const gapBottom = band.y + band.h - bottom;
    assert.ok(Math.abs(gapTop - gapBottom) <= 0.5, `top gap ${gapTop} vs bottom gap ${gapBottom}`);
  });
}

test("caption band: without ink metrics the rows are drawn as before", () => {
  const { ctx, log } = mockCtx({ withInkMetrics: false });
  Reel.caption(ctx, captionLine("안녕하세요 ABC 123"), 0, { fontPx: 50, lineHeight: 62 });
  assert.equal(log.rects.length, 1);
  assert.equal(log.texts.length, 1);
  const gap = log.texts[0].inkTop - log.rects[0].y;
  assert.ok(Math.abs(gap - (INK.top + 62 * 0.15)) < 1e-6, "falls back to the top-baseline placement");
});
