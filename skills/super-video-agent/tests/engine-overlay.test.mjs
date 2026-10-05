// reel-engine.js helpers for a film's own overlay code: Reel.checkSafe,
// Reel.captionRows / Reel.balanceParts ("\n" forces a row), Reel.layerFiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

// 10 px per character, identity transform.
function fakeCtx(transform) {
  return {
    canvas: { width: 1080, height: 1920 },
    measureText: (s) => ({ width: s.length * 10 }),
    getTransform: () => transform || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  };
}

test("checkSafe: a hand-drawn box outside the safe area records one issue, inside records none", () => {
  Reel.setSafeArea("shorts");
  Reel.clearIssues();
  Reel.checkSafe(fakeCtx(), "sticker", 950, 600, 1050, 700, 1080, 1920);
  assert.equal(Reel.issues().length, 1);
  assert.equal(Reel.issues()[0].type, "text-outside-safe-area");
  Reel.clearIssues();
  Reel.checkSafe(fakeCtx(), "inside", 200, 600, 400, 700, 1080, 1920);
  assert.equal(Reel.issues().length, 0);
});

test("checkSafe: the active transform is applied (a translated box moves out)", () => {
  Reel.clearIssues();
  Reel.checkSafe(fakeCtx({ a: 1, b: 0, c: 0, d: 1, e: 700, f: 0 }), "moved", 200, 600, 400, 700, 1080, 1920);
  assert.equal(Reel.issues().length, 1);
});

test("checkSafe: an outline counts half its width past the box on each side", () => {
  Reel.setSafeArea("shorts");
  const s = Reel.safeArea(1080, 1920);
  const right = s.x + s.w - 1; // 1 px inside the right edge
  Reel.clearIssues();
  Reel.checkSafe(fakeCtx(), "plain", 400, 600, right, 700, 1080, 1920);
  assert.equal(Reel.issues().length, 0);
  Reel.checkSafe(fakeCtx(), "outlined", 400, 600, right, 700, 1080, 1920, { outline: 3 });
  assert.equal(Reel.issues().length, 1);
  assert.equal(Reel.issues()[0].drawn.right, Math.round(right + 1.5));
  Reel.clearIssues();
  Reel.checkSafe(fakeCtx(), "thin", 400, 600, right - 2, 700, 1080, 1920, { outline: 2 });
  assert.equal(Reel.issues().length, 0);
});

test("captionRows: an optional stroke fits the rows inside maxW with the outline; omitted, nothing changes", () => {
  const plain = Reel.captionRows(fakeCtx(), "aaaa bbbb", 90);
  assert.deepEqual(plain.rows, [[0, 1]]);
  assert.equal(plain.stroke, 0);
  assert.deepEqual(Reel.captionRows(fakeCtx(), "aaaa bbbb", 90, "en").rows, plain.rows);
  const stroked = Reel.captionRows(fakeCtx(), "aaaa bbbb", 90, { lang: "en", stroke: 4 });
  assert.deepEqual(stroked.rows, [[0], [1]]);
  assert.equal(stroked.stroke, 4);
  assert.ok(stroked.rowWidths.every((w) => w + stroked.stroke <= 90));
});

test("captionRows: a \\n starts a new row even when everything fits on one", () => {
  const r = Reel.captionRows(fakeCtx(), "자! 오늘은 우리\n차례예요", 2000);
  assert.deepEqual(r.words, ["자!", "오늘은", "우리", "차례예요"]);
  assert.deepEqual(r.rows, [[0, 1, 2], [3]]);
  assert.deepEqual(r.rowWidths, [20 + 10 + 20 + 10 + 30, 40]);
  assert.equal(r.spaceW, 10);
});

test("captionRows: '|' markers are dropped; each part balances on its own", () => {
  const r = Reel.captionRows(fakeCtx(), "aaaa bbbb | cccc dddd eeee\nff", 140);
  assert.deepEqual(r.words, ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ff"]);
  assert.equal(r.rows[r.rows.length - 1].join(), "5");
  assert.ok(r.rows.every((row) => !row.includes(5) || row.length === 1));
  assert.ok(r.rowWidths.every((w) => w <= 140));
});

test("balanceParts: indices are into the full widths array", () => {
  const b = Reel.balanceParts([10, 10, 10, 10], 5, 100, [2, 2]);
  assert.deepEqual(b.rows, [[0, 1], [2, 3]]);
  assert.deepEqual(b.widths, [25, 25]);
});

test("layerFiles: normal render and caption layer without dub read the film's own files", () => {
  assert.deepEqual(Reel.layerFiles("ko-KR", { layer: null, dub: null }), {
    timings: ["voice/timings.json"],
    plan: ["plan.json"],
  });
  assert.deepEqual(Reel.layerFiles("ko-KR", { layer: "captions", dub: null }).timings, ["voice/timings.json"]);
  // no location.search in node: the URL state is the normal render
  assert.deepEqual(Reel.layerFiles("ko-KR").timings, ["voice/timings.json"]);
});

test("layerFiles: base-language dub falls back to the film's own files; another language does not", () => {
  assert.deepEqual(Reel.layerFiles("ko-KR", { layer: "captions", dub: "ko" }), {
    timings: ["dub/ko/timings.placed.json", "voice/timings.json"],
    plan: ["dub/ko/plan.json", "plan.json"],
  });
  assert.deepEqual(Reel.layerFiles("ko-KR", { layer: "captions", dub: "en" }), {
    timings: ["dub/en/timings.placed.json"],
    plan: ["dub/en/plan.json"],
  });
});
