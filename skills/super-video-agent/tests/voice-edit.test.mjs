// Editing a finished narration without re-synthesis: --pick-by, the dub-folder
// note after --lines, measured word times kept across a partial rebuild,
// timings.json lang for --stt-only, a clean STT clearing MISHEARD, and
// --insert-pause. Local only: voice/none.mjs or hand-written PCM, no TTS or
// STT calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, synthesizeAll, applySttResult, runInsertPause } from "../scripts/voice.mjs";
import {
  dubCode,
  partialRebuildNote,
  parsePickBy,
  chooseTake,
  carriedWords,
  sttLangCode,
  sttOnlyLang,
  parseInsertPause,
  pauseWindow,
  quietestSample,
  insertSilence,
  shiftForPause,
  readWavMono16,
  writeWavMono16,
} from "../scripts/voice/line-edit.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import * as none from "../scripts/voice/none.mjs";

const RATE = 48000;

function tmpDir(prefix = "sva-voice-edit-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePlan(dir, plan) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
}

/** Runs `fn` with stdout captured; returns what it printed. */
async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

/** Mono PCM16 samples: a loud tone, except silence-ish over [quietFrom, quietTo) seconds. */
function toneWithGap(totalSec, quietFrom, quietTo) {
  const n = Math.round(totalSec * RATE);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const amp = t >= quietFrom && t < quietTo ? 30 : 12000;
    s[i] = Math.round(amp * Math.sin(2 * Math.PI * 220 * t));
  }
  return s;
}

// --- T12 --pick-by -----------------------------------------------------------

test("parsePickBy: length:<sec> and stt parse; anything else is refused", () => {
  assert.deepEqual(parsePickBy("length:3"), { by: "length", sec: 3 });
  assert.deepEqual(parsePickBy("length:2.75"), { by: "length", sec: 2.75 });
  assert.deepEqual(parsePickBy("stt"), { by: "stt" });
  assert.throws(() => parsePickBy("length:"), /length:<sec> or stt/);
  assert.throws(() => parsePickBy("length:0"), /length:<sec> or stt/);
  assert.throws(() => parsePickBy(true), /length:<sec> or stt/);
  assert.throws(() => parsePickBy("loudest"), /length:<sec> or stt/);
});

test("chooseTake length: takes of 2.4/3.2/3.7 s with target 3.0 pick the 3.2 s take", () => {
  const rows = [
    { k: 1, lengthSec: 2.4, cer: 0 },
    { k: 2, lengthSec: 3.2, cer: 0.3 },
    { k: 3, lengthSec: 3.7, cer: 0 },
  ];
  assert.equal(chooseTake(rows, { by: "length", sec: 3.0 }), 2);
  assert.equal(chooseTake(rows, { by: "length", sec: 10 }), 3);
});

test("chooseTake stt: lowest CER wins, takes without a result are skipped, ties go to the lower take", () => {
  assert.equal(chooseTake([{ k: 1, lengthSec: 1, cer: 0.2 }, { k: 2, lengthSec: 1, cer: null }, { k: 3, lengthSec: 1, cer: 0.05 }], { by: "stt" }), 3);
  assert.equal(chooseTake([{ k: 1, lengthSec: 1, cer: 0.1 }, { k: 2, lengthSec: 1, cer: 0.1 }], { by: "stt" }), 1);
  assert.throws(() => chooseTake([{ k: 1, lengthSec: 1, cer: null }], { by: "stt" }), /no take has an STT result/);
});

test("main --pick-by length:3.0: installs the take closest to 3.0 s and prints the table with it marked", async () => {
  const dir = tmpDir();
  const paths = reelPaths(dir);
  writePlan(dir, { meta: { lang: "ko-KR", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "l1", text: "첫 줄" }, { id: "l2", text: "둘째 줄" }] });
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt"]));
  const takesDir = path.join(paths.voiceDir, "takes");
  fs.mkdirSync(takesDir, { recursive: true });
  [2.4, 3.2, 3.7].forEach((sec, i) => writeWavMono16(path.join(takesDir, `l1-${i + 1}.wav`), new Int16Array(Math.round(sec * RATE)), RATE));

  const out = await captureStdout(() => main([dir, "--provider", "none", "--no-stt", "--lines", "l1", "--pick-by", "length:3.0", "--retime"]));
  assert.match(out, /takes:\nid\ttake\ttone\tcer\tduration\tlength\tpicked\n/);
  assert.match(out, /l1\t2\t-\t-\t3\.200s\t3\.200s\t<-\n/);
  assert.match(out, /installed take\(s\): l1=2/);
  const l1 = readJson(paths.timingsJson).lines[0];
  assert.ok(Math.abs(l1.end - l1.start - 3.2) < 0.01, `l1 is ${l1.end - l1.start}s`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T13 dub-folder note ------------------------------------------------------

test("partialRebuildNote: a dub folder says the picture does not move and names dub.mjs; a reel lists re-rendered lines", () => {
  const root = tmpDir();
  const dub = path.join(root, "dub", "en");
  assert.equal(dubCode(dub), "en");
  assert.equal(dubCode(root), null);
  assert.match(partialRebuildNote(dub, []), /dub\/en\/\): the picture does not move — run dub\.mjs --lang en to re-place the lines/);
  assert.doesNotMatch(partialRebuildNote(dub, ["l2"]), /re-render/);
  assert.equal(partialRebuildNote(root, ["l2"]), "lines with shifted start (their shots will re-render): l2\n");
  assert.equal(partialRebuildNote(root, []), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("main --lines in dub/<code>/ prints the dub note, never 'shots will re-render'", async () => {
  const root = tmpDir();
  const dub = path.join(root, "dub", "en");
  writePlan(dub, { meta: { lang: "en-US", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "l1", text: "one two" }, { id: "l2", text: "three" }] });
  await captureStdout(() => main([dub, "--provider", "none", "--no-stt"]));
  writePlan(dub, { meta: { lang: "en-US", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "l1", text: "one two three four five six" }, { id: "l2", text: "three" }] });
  const out = await captureStdout(() => main([dub, "--provider", "none", "--no-stt", "--lines", "l1", "--retime"]));
  assert.match(out, /the picture does not move — run dub\.mjs --lang en/);
  assert.doesNotMatch(out, /shots will re-render/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("main --lines: a dub folder keeps the new take's own length and says so; the base reel keeps the old slot", async () => {
  const root = tmpDir();
  const lineLen = (d) => {
    const l = readJson(reelPaths(d).timingsJson).lines[0];
    return l.end - l.start;
  };
  const meta = { lang: "en-US", gapMs: 250, voice: { levelLines: false } };
  const longText = "one two three four five six seven eight";
  const shortText = "one";
  const run = async (d, flagsExtra = []) => {
    writePlan(d, { meta, lines: [{ id: "l1", text: longText }, { id: "l2", text: "three" }] });
    await captureStdout(() => main([d, "--provider", "none", "--no-stt"]));
    const oldLen = lineLen(d);
    writePlan(d, { meta, lines: [{ id: "l1", text: shortText }, { id: "l2", text: "three" }] });
    const out = await captureStdout(() => main([d, "--provider", "none", "--no-stt", "--lines", "l1", ...flagsExtra]));
    return { oldLen, newLen: lineLen(d), out };
  };

  const base = await run(path.join(root, "reel"));
  assert.ok(Math.abs(base.newLen - base.oldLen) < 0.01, `base reel keeps its slot: ${base.oldLen} -> ${base.newLen}`);
  assert.doesNotMatch(base.out, /keep their own length/);

  const dub = await run(path.join(root, "dub", "en"));
  assert.ok(dub.newLen < dub.oldLen - 0.3, `dub folder keeps the natural length: ${dub.oldLen} -> ${dub.newLen}`);
  assert.equal(dub.out.match(/regenerated lines keep their own length/g).length, 1, "one line of output says so");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- T14 measured word times kept ---------------------------------------------

test("carriedWords: shifts the previous words by the start delta; a changed caption carries nothing", () => {
  const prev = { start: 1, text: "a b", words: [{ text: "a", start: 1.1, end: 1.3 }, { text: "b", start: 1.5, end: 1.9 }] };
  assert.deepEqual(carriedWords(prev, "a b", 2), [{ text: "a", start: 2.1, end: 2.3 }, { text: "b", start: 2.5, end: 2.9 }]);
  assert.equal(carriedWords(prev, "a c", 2), null);
  assert.equal(carriedWords(undefined, "a b", 2), null);
  assert.equal(carriedWords({ ...prev, words: [] }, "a b", 2), null);
});

test("voice --lines l2: l1 and l3 keep their measured words (l3 shifted by its start delta)", async () => {
  const dir = tmpDir();
  const paths = reelPaths(dir);
  const base = { dir, paths, provider: none, providerName: "none", voiceCfg: { levelLines: false }, lang: "ko-KR", gapMs: 250, sttEnabled: false };
  const lines = [{ id: "l1", text: "하나 둘" }, { id: "l2", text: "셋" }, { id: "l3", text: "넷 다섯" }];
  const first = await synthesizeAll({ ...base, lines });
  // Stand-in for measured (non-proportional) word times from an STT pass.
  const measured = (l) => [{ w: l.words[0].w, start: l.start + 0.01, end: l.start + 0.07 }, { w: l.words[1].w, start: l.end - 0.2, end: l.end - 0.03 }];
  first.timings.lines[0].words = measured(first.timings.lines[0]);
  first.timings.lines[2].words = measured(first.timings.lines[2]);
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));

  const longer = [lines[0], { id: "l2", text: "셋셋셋셋셋셋셋셋셋셋셋셋셋셋" }, lines[2]];
  const { timings } = await synthesizeAll({ ...base, lines: longer, onlyLineIds: ["l2"], keepTiming: false });
  assert.deepEqual(timings.lines[0].words, first.timings.lines[0].words);
  const delta = timings.lines[2].start - first.timings.lines[2].start;
  assert.ok(delta > 1, `l3 should have moved, delta ${delta}`);
  timings.lines[2].words.forEach((w, i) => {
    const old = first.timings.lines[2].words[i];
    assert.ok(Math.abs(w.start - (old.start + delta)) < 1e-9 && Math.abs(w.end - (old.end + delta)) < 1e-9, `word ${i}`);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T15 lang in timings.json -------------------------------------------------

test("timings.json carries lang; --stt-only uses it, then plan.meta.lang", async () => {
  const dir = tmpDir();
  const paths = reelPaths(dir);
  const { timings } = await synthesizeAll({ dir, paths, provider: none, providerName: "none", voiceCfg: { levelLines: false }, lang: "en-US", gapMs: 250, sttEnabled: false, lines: [{ id: "l1", text: "hello" }] });
  assert.equal(timings.lang, "en-US");
  assert.equal(sttLangCode(sttOnlyLang(timings, { meta: { lang: "ko-KR" } })), "en");
  assert.equal(sttLangCode(sttOnlyLang({ lines: [] }, { meta: { lang: "en-GB" } })), "en");
  assert.equal(sttLangCode(sttOnlyLang({ lines: [] }, null)), "ko");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T16 clean STT clears MISHEARD -------------------------------------------

test("applySttResult: a clean check clears an earlier MISHEARD; a gross mismatch still sets it", () => {
  const line = { id: "l1", text: "the quick brown fox jumps" };
  const flagged = { id: "l1", start: 0, end: 2, words: [], voiceFlag: "MISHEARD" };
  applySttResult(flagged, line, "the quick brown fox jumps", null);
  assert.equal(flagged.voiceFlag, undefined);
  assert.equal(flagged.stt.cer, 0);

  const clean = { id: "l1", start: 0, end: 2, words: [] };
  applySttResult(clean, line, "zzz qqq", null);
  assert.equal(clean.voiceFlag, "MISHEARD");

  const tail = { id: "l1", start: 0, end: 2, words: [], voiceFlag: "SHORT" };
  applySttResult(tail, line, "the quick brown fox jumps", null);
  assert.equal(tail.voiceFlag, "SHORT", "only MISHEARD is cleared by a passing check");
});

// --- T25 --insert-pause -------------------------------------------------------

test("parseInsertPause: id@word=ms entries; malformed ones are refused", () => {
  assert.deepEqual(parseInsertPause("l2@3=400,intro-2@0=250"), [
    { id: "l2", word: 3, ms: 400 },
    { id: "intro-2", word: 0, ms: 250 },
  ]);
  assert.throws(() => parseInsertPause("l2=400"), /<id>@<word-index>=<ms>/);
  assert.throws(() => parseInsertPause("l2@x=400"), /<id>@<word-index>=<ms>/);
  assert.throws(() => parseInsertPause("l2@1=0"), /<id>@<word-index>=<ms>/);
});

test("quietestSample: finds the quiet stretch between two loud ones", () => {
  const s = toneWithGap(1.1, 0.5, 0.6);
  const at = quietestSample(s, RATE, 0.3, 0.8);
  assert.ok(at / RATE >= 0.5 && at / RATE <= 0.6, `picked ${at / RATE}s`);
});

test("insertSilence: grows by exactly the count, zeros at the point, the rest unchanged", () => {
  const s = Int16Array.from([1, 2, 3, 4]);
  assert.deepEqual([...insertSilence(s, 2, 3)], [1, 2, 0, 0, 0, 3, 4]);
});

test("pauseWindow: stays between the middles of the two words; no following word is refused", () => {
  const words = [{ start: 10.0, end: 10.4 }, { start: 10.5, end: 11.0 }];
  const w = pauseWindow(words, 0, 10, 1.1);
  assert.ok(w.fromSec >= 0.2 && w.fromSec <= 0.4 && w.toSec >= 0.5 && w.toSec <= 0.75, JSON.stringify(w));
  assert.throws(() => pauseWindow(words, 1, 10, 1.1), /last word/);
  assert.throws(() => pauseWindow(words, 5, 10, 1.1), /no word 5/);
});

test("shiftForPause: later words, the line end, later lines and duration move by the pause; earlier ones stay", () => {
  const t = {
    duration: 5,
    lines: [
      { id: "a", start: 0.4, end: 1.5, words: [{ start: 0.4, end: 0.9 }, { start: 1.0, end: 1.5 }] },
      { id: "b", start: 2.2, end: 3.0, words: [{ start: 2.2, end: 3.0 }] },
    ],
  };
  shiftForPause(t, "a", 0, 0.4);
  assert.deepEqual(t.lines[0].words, [{ start: 0.4, end: 0.9 }, { start: 1.4, end: 1.9 }]);
  assert.equal(t.lines[0].end, 1.9);
  assert.deepEqual([t.lines[1].start, t.lines[1].end, t.lines[1].words[0].start], [2.6, 3.4, 2.6]);
  assert.ok(Math.abs(t.duration - 5.4) < 1e-9);
});

test("runInsertPause: the line grows by exactly the pause at its quiet point; later word times move by the same amount", async () => {
  const dir = tmpDir();
  const paths = reelPaths(dir);
  // Two equal-length words: their proportional boundary (0.55 s) sits in the quiet stretch.
  const plan = { meta: { lang: "ko-KR", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "l1", text: "가나 다라" }, { id: "l2", text: "셋" }] };
  writePlan(dir, plan);
  // l1: loud 0.5 s, quiet 0.1 s, loud 0.5 s; l2 from voice/none.mjs.
  const tonal = {
    async synth(args) {
      if (args.id !== "l1") return none.synth(args);
      fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
      writeWavMono16(args.outPath, toneWithGap(1.1, 0.5, 0.6), RATE);
      return { wavPath: args.outPath };
    },
  };
  const first = await synthesizeAll({ dir, paths, provider: tonal, providerName: "none", voiceCfg: { levelLines: false }, lang: "ko-KR", gapMs: 250, sttEnabled: false, lines: plan.lines });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  const before = first.timings;

  let after;
  const out = await captureStdout(async () => {
    after = await runInsertPause({ dir, paths, plan, spec: "l1@0=400" });
  });
  assert.match(out, /line "l1": inserted 0\.400s after word 0 "가나"/);
  assert.match(out, /lines with shifted start \(their shots will re-render\): l2/);

  const lenBefore = before.lines[0].end - before.lines[0].start;
  const lenAfter = after.lines[0].end - after.lines[0].start;
  assert.ok(Math.abs(lenAfter - lenBefore - 0.4) < 1e-4, `line grew by ${lenAfter - lenBefore}`);
  assert.ok(Math.abs(after.lines[0].words[0].start - before.lines[0].words[0].start) < 1e-6, "the word before the pause stays");
  assert.ok(Math.abs(after.lines[0].words[1].start - before.lines[0].words[1].start - 0.4) < 1e-4, "the word after the pause moves");
  assert.ok(Math.abs(after.lines[1].start - before.lines[1].start - 0.4) < 1e-4, "the next line moves");
  assert.ok(Math.abs(after.lines[1].words[0].start - before.lines[1].words[0].start - 0.4) < 1e-4, "the next line's words move");
  assert.ok(Math.abs(after.duration - before.duration - 0.4) < 1e-3);
  assert.equal(after.lang, "ko-KR");

  const { samples } = readWavMono16(path.join(paths.voiceDir, "line-l1.wav"));
  assert.equal(samples.length, Math.round(1.5 * RATE));
  // the inserted silence starts inside the quiet stretch (0.5–0.6 s)
  let firstZeroRun = -1;
  for (let i = 0; i + 1000 < samples.length; i++) {
    if (samples.subarray(i, i + 1000).every((v) => v === 0)) {
      firstZeroRun = i;
      break;
    }
  }
  assert.ok(firstZeroRun / RATE >= 0.5 && firstZeroRun / RATE <= 0.6, `silence at ${firstZeroRun / RATE}s`);
  assert.ok(fs.existsSync(paths.narrationWav));
  fs.rmSync(dir, { recursive: true, force: true });
});
