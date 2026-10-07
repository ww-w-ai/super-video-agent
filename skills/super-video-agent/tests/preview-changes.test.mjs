import { test } from "node:test";
import assert from "node:assert/strict";
import { previewWindows, previewArgs } from "../scripts/preview-changes.mjs";
const timings = { duration: 9, lines: [
  { id: "a", start: 1, end: 2 }, { id: "b", start: 3, end: 4 },
  { id: "c", start: 5, end: 6 }, { id: "d", start: 7, end: 8 },
] };
test("preview spans use neighboring speech boundaries, not fixed handles", () => {
  assert.deepEqual(previewWindows(timings, ["b"]), [{ from: 2, to: 5, ids: ["b"] }]);
  assert.deepEqual(previewWindows(timings, ["a", "d"]), [
    { from: 0, to: 3, ids: ["a"] }, { from: 6, to: 9, ids: ["d"] },
  ]);
  assert.deepEqual(previewWindows(timings, ["b", "c"]), [{ from: 2, to: 7, ids: ["b", "c"] }]);
});
test("unknown IDs and broken clocks never produce a plausible preview", () => {
  assert.throws(() => previewWindows(timings, ["missing"]), /unknown/);
  assert.throws(() => previewWindows({ ...timings, duration: 4 }, ["a"]), /invalid/);
});
test("mixed previews require both picture and existing audio", () => {
  const args = previewArgs("/mixed.mp4", { from: 2, to: 5 }, "/preview.mp4");
  assert.ok(args.includes("0:v:0"));
  assert.ok(args.includes("0:a:0"));
  assert.equal(args[args.indexOf("-t") + 1], "3");
  assert.equal(args[args.indexOf("-ss") + 1], "2");
});
