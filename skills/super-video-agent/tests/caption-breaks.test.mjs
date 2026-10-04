// Caption break report (scripts/lib/caption-breaks.mjs) and the "|" marker it reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionPieces, captionBreakRows, formatCaptionBreaks, captionBreakReport } from "../scripts/lib/caption-breaks.mjs";
import { stripCaptionBreaks } from "../scripts/lib/pronounce.mjs";
import { captionBreakErrors } from "../scripts/validate-plan.mjs";

await import("../scripts/engine/reel-engine.js");
const Reel = globalThis.Reel;

test("marker: '|' splits a Korean line into the pieces the writer chose", () => {
  const pieces = captionPieces(Reel, "그렇게 해야만 | 할 수 밖에 없다.");
  assert.deepEqual(pieces.map((p) => p.join(" ")), ["그렇게 해야만", "할 수 밖에 없다."]);
});

test("marker: '|' keeps an English phrase together", () => {
  const pieces = captionPieces(Reel, "We cannot | do it any other way.");
  assert.deepEqual(pieces.map((p) => p.join(" ")), ["We cannot", "do it any other way."]);
});

test("marker: '\\n' breaks too, and '|' is never a word", () => {
  const pieces = captionPieces(Reel, "one two\nthree | four five six");
  assert.deepEqual(pieces.map((p) => p.join(" ")), ["one two", "three", "four five six"]);
  assert.equal(stripCaptionBreaks("a | b"), "a b");
});

test("marker: '||' and a leading '|' are rejected", () => {
  assert.equal(captionBreakErrors({ lines: [{ id: "a", text: "x | | y" }] }).length, 1);
  assert.equal(captionBreakErrors({ lines: [{ id: "a", text: "| x y" }] }).length, 1);
  assert.equal(captionBreakErrors({ lines: [{ id: "a", text: "x | y" }] }).length, 0);
});

test("report: one row per break with context on both sides, one-piece lines marked", () => {
  const rows = captionBreakRows(Reel, [
    { id: "l1", text: "이렇게 하면 할 | 수 밖에 없다." },
    { id: "l2", text: "short line" },
  ]);
  assert.deepEqual(rows[0], { id: "l1", before: "이렇게 하면 할", after: "수 밖에 없다." });
  assert.deepEqual(rows[1], { id: "l2", before: null, after: null });
});

test("report: text format is 'line id: …before | after…'", () => {
  const text = formatCaptionBreaks([
    { id: "l1", before: "can", after: "not" },
    { id: "l2", before: null, after: null },
  ]);
  assert.match(text, /l1: …can \| not…/);
  assert.match(text, /l2: \(one piece\)/);
});

test("report: maxChars adds the engine's own split of a long phrase", async () => {
  const plan = { lines: [{ id: "l1", text: "one two three four five six seven eight" }] };
  const none = await captionBreakReport(plan);
  const split = await captionBreakReport(plan, { maxChars: 20 });
  assert.match(none, /l1: \(one piece\)/);
  assert.match(split, /l1: …/);
});

function recordingCtx() {
  const drawn = [];
  const base = { measureText: (t) => ({ width: String(t).length * 10 }), fillText: (t) => drawn.push(t), strokeText: () => {} };
  const ctx = new Proxy(base, { get: (o, k) => (k in o ? o[k] : k === "drawn" ? drawn : () => ({ addColorStop() {} })), set: () => true });
  return ctx;
}

test("default caption box: a writer break starts a new row and the marker is not drawn", () => {
  const ctx = recordingCtx();
  Reel.caption(ctx, { text: "ab cd | ef gh" }, 0, { width: 1080, height: 1920 });
  const rows = ctx.drawn.filter((t) => t !== undefined);
  assert.ok(!rows.some((r) => r.includes("|")), JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.includes("cd ef")), "rows joined across the break: " + JSON.stringify(rows));
  assert.ok(rows.length >= 2, JSON.stringify(rows));
});

test("captionRows: a writer break starts a new row, marker removed", () => {
  const r = Reel.captionRows(recordingCtx(), "ab cd | ef gh", 1000);
  assert.deepEqual(r.words, ["ab", "cd", "ef", "gh"]);
  assert.deepEqual(r.rows, [[0, 1], [2, 3]]);
});

test("captionChunks: a writer break wins over the short-piece merge, an automatic one still merges", () => {
  const pieces = captionPieces(Reel, "이렇게 | 할 수 밖에 없다.");
  assert.deepEqual(pieces.map((p) => p.join(" ")), ["이렇게", "할 수 밖에 없다."]);
  const auto = captionPieces(Reel, "자, 보이지? 답이 쓰이는 중인데 벌써 화면에 떠!", 11);
  assert.ok(!auto.some((p) => p.join(" ") === "자,"));
});
