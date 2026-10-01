// Caption word times from heard word times (scripts/voice/word-align.mjs) and
// how voice.mjs records them (wordsMeasured). Fake STT word lists only: no
// network, no python.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alignCaptionWords, matchLetters } from "../scripts/voice/word-align.mjs";
import { synthesizeAll, applySttResult } from "../scripts/voice.mjs";
import { wordsProportional } from "../scripts/lib/timing.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import * as none from "../scripts/voice/none.mjs";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const times = (words) => words.map((w) => [w.w, +w.start.toFixed(4), +w.end.toFixed(4)]);

test("alignCaptionWords: exact match takes each heard word's own time, plus the offset", () => {
  const heard = [
    { w: "the", start: 0.1, end: 0.2 },
    { w: "quick", start: 0.5, end: 0.9 },
    { w: "brown", start: 1.4, end: 1.8 },
    { w: "fox.", start: 1.9, end: 2.3 },
  ];
  const { words, measured } = alignCaptionWords("The quick brown fox", heard, { offset: 10 });
  assert.equal(measured, 4);
  assert.deepEqual(times(words), [["The", 10.1, 10.2], ["quick", 10.5, 10.9], ["brown", 11.4, 11.8], ["fox", 11.9, 12.3]]);
});

test("alignCaptionWords: a digit in the caption matches the number spoken as a word, and back", () => {
  const ko = alignCaptionWords("3분 뒤에 출발", [
    { w: "삼", start: 0.2, end: 0.4 },
    { w: "분", start: 0.4, end: 0.6 },
    { w: "뒤에", start: 0.8, end: 1.1 },
    { w: "출발", start: 1.3, end: 1.7 },
  ]);
  assert.equal(ko.measured, 3);
  assert.deepEqual(times(ko.words), [["3분", 0.2, 0.6], ["뒤에", 0.8, 1.1], ["출발", 1.3, 1.7]]);

  const en = alignCaptionWords("three dogs ran", [
    { w: "3", start: 0, end: 0.3 },
    { w: "dogs", start: 0.4, end: 0.8 },
    { w: "ran", start: 1.0, end: 1.2 },
  ]);
  assert.equal(en.measured, 3);
  assert.deepEqual(times(en.words), [["three", 0, 0.3], ["dogs", 0.4, 0.8], ["ran", 1.0, 1.2]]);

  assert.deepEqual(matchLetters("9:15", "ko").join(""), "구시십오분");
  assert.deepEqual(matchLetters("10월", "ko").join(""), "십월");
  assert.deepEqual(matchLetters("21", "en").join(""), "twentyone");
});

test("alignCaptionWords: Korean spacing — a caption word split in two, and two caption words heard as one", () => {
  const { words, measured } = alignCaptionWords("대관람차 원스 쇼", [
    { w: "대관", start: 0, end: 0.3 },
    { w: "람차의", start: 0.3, end: 0.8 },
    { w: "원스쇼", start: 1.0, end: 1.6 },
  ]);
  assert.equal(measured, 3);
  assert.deepEqual(times(words), [["대관람차", 0, 0.8], ["원스", 1.0, 1.4], ["쇼", 1.4, 1.6]]);
});

test("alignCaptionWords: words the voice did not say are interpolated between measured neighbours", () => {
  const heard = [
    { w: "9시", start: 0, end: 0.3 },
    { w: "15분", start: 0.3, end: 0.7 },
    { w: "로비에", start: 0.8, end: 1.2 },
    { w: "모여", start: 1.3, end: 1.6 },
    { w: "차로", start: 1.8, end: 2.1 },
    { w: "3분에서", start: 2.2, end: 2.7 },
    { w: "5분이면", start: 2.8, end: 3.3 },
    { w: "도착해요.", start: 3.4, end: 4.0 },
  ];
  const { words, measured } = alignCaptionWords("9:15 로비 집합 → 차로 3~5분", heard, { offset: 5 });
  assert.equal(measured, 4, "9:15, 로비, 차로, 3~5분 measured; 집합 and → interpolated");
  assert.deepEqual(times(words), [
    ["9:15", 5, 5.7],
    ["로비", 5.8, 6.2],
    ["집합", 6.2, 6.8],
    ["→", 6.8, 6.8],
    ["차로", 6.8, 7.1],
    ["3~5분", 7.2, 8.3],
  ]);

  const gap = alignCaptionWords("alpha beta gamma delta", [
    { w: "alpha", start: 0, end: 0.5 },
    { w: "delta", start: 2.0, end: 2.5 },
  ]);
  assert.equal(gap.measured, 2);
  near(gap.words[1].start, 0.5, "beta starts where alpha ends");
  near(gap.words[1].end, 0.5 + 1.5 * (4 / 9), "beta and gamma share the gap by letters (4:5)");
  near(gap.words[2].end, 2.0, "gamma ends where delta starts");
});

test("alignCaptionWords: words stay in order; nothing heard gives nothing", () => {
  const { words } = alignCaptionWords("하나 둘 셋", [
    { w: "셋", start: 0.1, end: 0.3 },
    { w: "하나", start: 0.5, end: 0.8 },
    { w: "둘", start: 1.0, end: 1.2 },
  ]);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].end - 1e-9, `word ${i} starts after ${i - 1}`);
  assert.deepEqual(alignCaptionWords("a b", []), { words: [], measured: 0 });
  assert.deepEqual(alignCaptionWords("", [{ w: "a", start: 0, end: 1 }]), { words: [], measured: 0 });
});

test("applySttResult: STT words set the caption words and wordsMeasured", () => {
  const line = { id: "l1", text: "10월 19일 | 놀이공원!", say: "시월 십구일 놀이공원이에요!" };
  const lineOut = { id: "l1", start: 3, end: 6, words: [] };
  const sttWords = [
    { w: "10월", start: 0.4, end: 0.7 },
    { w: "19일", start: 0.75, end: 1.1 },
    { w: "놀이공언이에요", start: 1.3, end: 2.2 },
  ];
  applySttResult(lineOut, line, "10월 19일 놀이공언이에요", sttWords, "ko");
  assert.equal(lineOut.wordsMeasured, 3);
  assert.deepEqual(times(lineOut.words), [["10월", 3.4, 3.7], ["19일", 3.75, 4.1], ["놀이공원!", 4.3, 5.2]]);
});

test("voice: with STT unavailable, words fall back to the even spread and wordsMeasured is 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-word-align-"));
  const paths = reelPaths(dir);
  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines: [{ id: "l1", text: "하나 둘 셋" }],
    provider: none,
    providerName: "none",
    voiceCfg: { levelLines: false },
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false,
  });
  const l = timings.lines[0];
  assert.equal(l.wordsMeasured, 0);
  assert.deepEqual(l.words, wordsProportional("하나 둘 셋", l.start, l.end));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice --lines: an untouched line keeps its measured words and its wordsMeasured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-word-align-"));
  const paths = reelPaths(dir);
  const base = { dir, paths, provider: none, providerName: "none", voiceCfg: { levelLines: false }, lang: "ko-KR", gapMs: 250, sttEnabled: false };
  const lines = [{ id: "l1", text: "하나 둘" }, { id: "l2", text: "셋" }];
  const first = await synthesizeAll({ ...base, lines });
  const l1 = first.timings.lines[0];
  l1.words = [{ w: "하나", start: l1.start + 0.01, end: l1.start + 0.07 }, { w: "둘", start: l1.end - 0.2, end: l1.end - 0.03 }];
  l1.wordsMeasured = 2;
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));

  const { timings } = await synthesizeAll({ ...base, lines: [lines[0], { id: "l2", text: "셋셋셋" }], onlyLineIds: ["l2"], keepTiming: false });
  assert.deepEqual(timings.lines[0].words, l1.words);
  assert.equal(timings.lines[0].wordsMeasured, 2);
  assert.equal(timings.lines[1].wordsMeasured, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
