// Pure timing math (scripts/lib/timing.mjs) — no network, no ffmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLineTimes,
  buildConcatSegments,
  wordsProportional,
  wordsFromCharAlignment,
  HEAD_SILENCE_SEC,
  TAIL_SILENCE_SEC,
} from "../scripts/lib/timing.mjs";

test("computeLineTimes: lays out durations with head/tail silence and gapMs between lines", () => {
  const { lineTimes, totalDuration } = computeLineTimes([2, 3], 250);
  assert.ok(Math.abs(lineTimes[0].start - HEAD_SILENCE_SEC) < 1e-9);
  assert.ok(Math.abs(lineTimes[0].end - (HEAD_SILENCE_SEC + 2)) < 1e-9);
  assert.ok(Math.abs(lineTimes[1].start - (HEAD_SILENCE_SEC + 2 + 0.25)) < 1e-9);
  assert.ok(Math.abs(lineTimes[1].end - (HEAD_SILENCE_SEC + 2 + 0.25 + 3)) < 1e-9);
  const expectedTotal = HEAD_SILENCE_SEC + 2 + 0.25 + 3 + TAIL_SILENCE_SEC;
  assert.ok(Math.abs(totalDuration - expectedTotal) < 1e-9);
});

test("computeLineTimes: single line has no inter-line gap", () => {
  const { lineTimes, totalDuration } = computeLineTimes([1.5], 500);
  assert.ok(Math.abs(lineTimes[0].end - (HEAD_SILENCE_SEC + 1.5)) < 1e-9);
  assert.ok(Math.abs(totalDuration - (HEAD_SILENCE_SEC + 1.5 + TAIL_SILENCE_SEC)) < 1e-9);
});

test("computeLineTimes: a custom tailSec replaces the default 0.4s tail silence", () => {
  const { lineTimes, totalDuration } = computeLineTimes([2], 250, 3.0);
  const expectedTotal = HEAD_SILENCE_SEC + 2 + 3.0;
  assert.ok(Math.abs(totalDuration - expectedTotal) < 1e-9);
  assert.ok(Math.abs(lineTimes[0].end - (HEAD_SILENCE_SEC + 2)) < 1e-9);
});

test("buildConcatSegments: a custom tailSec replaces the default 0.4s tail silence segment", () => {
  const segs = buildConcatSegments([{ id: "a", durationSec: 1 }], 250, 3.0);
  assert.equal(segs[segs.length - 1].kind, "silence");
  assert.equal(segs[segs.length - 1].durationSec, 3.0);
});

test("buildConcatSegments: silence-line-silence-line-...-silence, no gap after last line", () => {
  const segs = buildConcatSegments(
    [
      { id: "a", durationSec: 1 },
      { id: "b", durationSec: 2 },
    ],
    250
  );
  const kinds = segs.map((s) => s.kind);
  assert.deepEqual(kinds, ["silence", "line", "silence", "line", "silence"]);
  assert.equal(segs[0].durationSec, HEAD_SILENCE_SEC);
  assert.equal(segs[1].id, "a");
  assert.ok(Math.abs(segs[2].durationSec - 0.25) < 1e-9);
  assert.equal(segs[3].id, "b");
  assert.equal(segs[4].durationSec, TAIL_SILENCE_SEC);
});

test("wordsProportional: splits a line's window by character count, in order", () => {
  const words = wordsProportional("ab cd", 10, 11); // "ab"=2, "cd"=2 -> 50/50
  assert.equal(words.length, 2);
  assert.ok(Math.abs(words[0].start - 10) < 1e-9);
  assert.ok(Math.abs(words[0].end - 10.5) < 1e-9);
  assert.ok(Math.abs(words[1].start - 10.5) < 1e-9);
  assert.ok(Math.abs(words[1].end - 11) < 1e-9);
});

test("wordsProportional: uneven word lengths get proportional shares", () => {
  const words = wordsProportional("a bbbb", 0, 5); // 1 char + 4 chars = 5 total
  assert.ok(Math.abs(words[0].end - words[0].start - 1) < 1e-9); // 1/5 * 5 = 1
  assert.ok(Math.abs(words[1].end - words[1].start - 4) < 1e-9); // 4/5 * 5 = 4
});

test("wordsFromCharAlignment: builds word windows from char-level start/end arrays", () => {
  const text = "ab cd";
  const starts = [0, 0.1, 0.2, 0.4, 0.5];
  const ends = [0.1, 0.2, 0.3, 0.5, 0.6];
  const words = wordsFromCharAlignment(text, starts, ends, 100 /* lineStart offset */);
  assert.equal(words.length, 2);
  assert.equal(words[0].w, "ab");
  assert.ok(Math.abs(words[0].start - 100) < 1e-9);
  assert.ok(Math.abs(words[0].end - 100.2) < 1e-9);
  assert.equal(words[1].w, "cd");
  assert.ok(Math.abs(words[1].start - 100.4) < 1e-9);
  assert.ok(Math.abs(words[1].end - 100.6) < 1e-9);
});
