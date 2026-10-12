// Sprint K4: --insert-time moves every .srt under out/ (subfolders too) and
// treats a line or cue within 1 ms of the insertion point as starting there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { shiftSrt, shiftPlacedTimings } from "../scripts/lib/dub-timing.mjs";
import { insertTime } from "../scripts/dub.mjs";

const DUB_CLI = fileURLToPath(new URL("../scripts/dub.mjs", import.meta.url));
const CUE_AT_5 = "1\n00:00:05,000 --> 00:00:06,000\nhello\n";

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sva-k4-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function makeReel(dir) {
  for (const code of ["ko", "en"]) {
    write(dir, `dub/${code}/timings.placed.json`, JSON.stringify({ duration: 10, lines: [{ id: "a", text: "t", start: 5, end: 6 }] }));
  }
}

test("T1 insertTime moves SRTs in subfolders of out/ and counts them in their language rows", (t) => {
  const dir = tmp(t, "sub");
  makeReel(dir);
  const ko = write(dir, "out/srt/ko.srt", CUE_AT_5);
  const en = write(dir, "out/subs/en.srt", CUE_AT_5);
  const result = insertTime({ dir, at: 3, seconds: 2 });
  for (const file of [ko, en]) assert.match(fs.readFileSync(file, "utf8"), /00:00:07,000 --> 00:00:08,000/);
  assert.equal(result.rows.find((r) => r.lang === "ko").srt, 1);
  assert.equal(result.rows.find((r) => r.lang === "en").srt, 1);
  assert.equal(result.unassignedSrt.length, 0);
  assert.ok(result.text.includes(ko) && result.text.includes(en), "report lists each moved SRT path");
});

test("T2 hidden folders and node_modules under out/ are skipped and not listed", (t) => {
  const dir = tmp(t, "skip");
  makeReel(dir);
  const backup = write(dir, "out/.backup/x/ko.srt", CUE_AT_5);
  const nm = write(dir, "out/node_modules/a.srt", CUE_AT_5);
  const deep = write(dir, "out/deep/a/b/ko.srt", CUE_AT_5);
  const result = insertTime({ dir, at: 3, seconds: 2 });
  assert.equal(fs.readFileSync(backup, "utf8"), CUE_AT_5);
  assert.equal(fs.readFileSync(nm, "utf8"), CUE_AT_5);
  assert.match(fs.readFileSync(deep, "utf8"), /00:00:07,000/, "recursion really ran");
  assert.ok(!result.text.includes(".backup") && !result.text.includes("node_modules"));
});

test("T3 a placed line whose start carries float error at the insertion point moves, no straddle", () => {
  const placed = { duration: 50, lines: [{ id: "p1", start: 43.316146999999994, end: 45, words: [{ w: "x", start: 43.316146999999994, end: 44 }] }] };
  const moved = shiftPlacedTimings(placed, 43.316147, 2);
  assert.ok(Math.abs(moved.lines[0].start - 45.316147) < 1e-9);
  assert.ok(Math.abs(moved.lines[0].words[0].start - 45.316147) < 1e-9);
  assert.equal(moved.duration, 52);
  const ending = { duration: 50, lines: [{ id: "p0", start: 40, end: 43.3165 }] };
  assert.equal(shiftPlacedTimings(ending, 43.316, 2).lines[0].start, 40, "a line ending within 1 ms of at stays");
  assert.throws(() => shiftPlacedTimings({ duration: 50, lines: [{ id: "s", start: 43, end: 44 }] }, 43.316147, 2), /line "s" \(43s-44s\) straddles the insertion point 43.316147s/);
});

test("T4 an SRT cue starting within 1 ms of at moves; a cue ending within 1 ms of at stays", () => {
  const text = "1\n00:00:40,000 --> 00:00:43,316\nbefore\n\n2\n00:00:43,316 --> 00:00:45,000\nafter\n";
  const out = shiftSrt(text, 43.3162, 2);
  assert.equal(out.shifted, 1);
  assert.match(out.text, /00:00:40,000 --> 00:00:43,316/);
  assert.match(out.text, /00:00:45,316 --> 00:00:47,000/);
  assert.equal(shiftSrt("1\n00:00:43,316 --> 00:00:45,000\nx\n", 43.3165, 2).shifted, 1);
  assert.throws(() => shiftSrt("1\n00:00:43,000 --> 00:00:45,000\nx\n", 43.3165, 2), /SRT line 2: the cue straddles the insertion point 43.3165s/);
});

test("T5 dub.mjs --help names subfolders and the 1 ms rule", () => {
  const help = execFileSync(process.execPath, [DUB_CLI, "--help"], { encoding: "utf8" });
  assert.match(help, /subfolders/);
  assert.match(help, /1 ms/);
});
