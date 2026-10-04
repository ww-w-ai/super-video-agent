// word-times.mjs / cue-check.mjs: waveform re-measurement of word times and the word-cue warnings.
// Synthetic narration (tone bursts at known times), no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { parseWav } from "../scripts/lib/wav-read.mjs";
import { measureWordOnsets, formatWordOnsets } from "../scripts/lib/word-onsets.mjs";
import { checkWordCues, formatCueWarnings, firstWordIndexContaining } from "../scripts/lib/cue-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wordTimes = path.join(here, "..", "scripts", "word-times.mjs");
const cueCheck = path.join(here, "..", "scripts", "cue-check.mjs");
const SR = 48000;

/** 4 s mono narration: a 0.3 s 200 Hz burst starting at each time in `bursts`. */
function narration(bursts) {
  const x = new Float32Array(SR * 4);
  for (const b of bursts) {
    const n = Math.round(0.3 * SR), s0 = Math.round(b * SR);
    for (let i = 0; i < n; i++) x[s0 + i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR) * Math.min(1, i / (0.005 * SR));
  }
  return x;
}

const timingsOf = (alphaAt, betaAt, extra = {}) => ({
  lines: [{ id: "a", text: "alpha beta", start: 0.5, end: 3, wordsMeasured: 2, ...extra,
    words: [{ w: "alpha", start: alphaAt, end: alphaAt + 0.3 }, { w: "beta", start: betaAt, end: betaAt + 0.3 }] }],
});

test("measureWordOnsets: reports the word whose sound starts 180 ms from its recorded time, quiet on a clean line", () => {
  const x = narration([1.0, 2.0]);
  const bad = measureWordOnsets(timingsOf(1.0, 2.18), x, SR);
  assert.equal(bad.words.length, 2);
  assert.equal(bad.words[0].status, "ok");
  assert.equal(bad.words[1].status, "off");
  assert.ok(Math.abs(bad.words[1].offsetSec + 0.18) < 0.015, `offset ${bad.words[1].offsetSec}`);
  assert.equal(bad.off, 1);
  assert.match(formatWordOnsets(bad), /a#1 "beta": recorded 2\.180 s, sound starts 2\.0\d\d s \(-1[78]\d ms\)/);

  const clean = measureWordOnsets(timingsOf(1.01, 2.0), x, SR);
  assert.equal(clean.off, 0);
  assert.equal(clean.noOnset, 0);
  assert.match(formatWordOnsets(clean), /^2 words measured; 0 off by more than 120 ms, 0 with no clear onset\n$/);
});

test("measureWordOnsets: silence near a word is 'no-onset'; interpolated lines are tagged", () => {
  const r = measureWordOnsets(timingsOf(1.0, 3.5, { wordsMeasured: 0 }), narration([1.0]), SR);
  assert.equal(r.words[1].status, "no-onset");
  assert.equal(r.words[1].lineInterpolated, true);
  assert.match(formatWordOnsets(r), /\(line has interpolated words\)/);
});

test("measureWordOnsets: --lines restricts the words measured", () => {
  const x = narration([1.0, 1.4]);
  const r = measureWordOnsets(timingsOf(1.0, 1.4), x, SR, { lineIds: ["a"] });
  assert.deepEqual(r.words.map((w) => w.status), ["ok", "ok"]);
  assert.equal(measureWordOnsets(timingsOf(1.0, 1.4), x, SR, { lineIds: ["zz"] }).words.length, 0);
});

test("parseWav: reads what wav.mjs writes; rejects a non-WAV", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-wav-"));
  try {
    const f = path.join(tmp, "t.wav");
    writeWavPCM16(f, [Float32Array.from([0, 0.5, -0.5, 1])], 8000);
    const w = parseWav(fs.readFileSync(f));
    assert.equal(w.sampleRate, 8000);
    assert.equal(w.samples.length, 4);
    assert.ok(Math.abs(w.samples[1] - 0.5) < 1e-3);
    assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /not a RIFF\/WAVE/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function reelDir({ timings, plan, bursts }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-wt-"));
  fs.mkdirSync(path.join(dir, "voice"));
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(timings));
  if (plan) fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  if (bursts) writeWavPCM16(path.join(dir, "voice", "narration.wav"), [narration(bursts)], SR);
  return dir;
}

test("word-times.mjs: prints the off word, writes JSON, exit 0", () => {
  const dir = reelDir({ timings: timingsOf(1.0, 2.18), bursts: [1.0, 2.0] });
  try {
    const r = spawnSync(process.execPath, [wordTimes, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 words measured; 1 off by more than 120 ms/);
    assert.match(r.stdout, /a#1 "beta"/);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "out", "word-times.json"), "utf8"));
    assert.equal(json.off, 1);
    const loose = spawnSync(process.execPath, [wordTimes, dir, "--threshold", "300"], { encoding: "utf8" });
    assert.match(loose.stdout, /0 off by more than 300 ms/);
    const bad = spawnSync(process.execPath, [wordTimes, dir, "--threshold", "x"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const planWith = (at) => ({ lines: [{ id: "a", text: "alpha beta", cues: [{ asset: "ding", at }] }] });

test("checkWordCues: planted defects each give their warning; a clean cue gives none", () => {
  const timings = timingsOf(1.0, 2.0);
  const onsets = measureWordOnsets(timings, narration([1.0, 2.0]), SR);
  assert.deepEqual(checkWordCues(planWith("word:beta"), timings, onsets), []);
  assert.deepEqual(checkWordCues(planWith("start"), timings, onsets), []);

  const missing = checkWordCues(planWith("word:gamma"), timings, onsets);
  assert.deepEqual(missing.map((w) => w.type), ["cue-word-missing"]);

  const uncertain = checkWordCues(planWith("word:beta"), timingsOf(1.0, 2.0, { wordsMeasured: 1 }), onsets);
  assert.deepEqual(uncertain.map((w) => w.type), ["cue-word-uncertain"]);
  assert.match(uncertain[0].detail, /only 1 of 2/);

  const heard = checkWordCues(planWith("word:beta"), timingsOf(1.0, 2.0, { stt: { heard: "alpha bata" } }), onsets);
  assert.deepEqual(heard.map((w) => w.type), ["cue-word-not-heard"]);

  const moved = measureWordOnsets(timingsOf(1.0, 2.18), narration([1.0, 2.0]), SR);
  const m = checkWordCues(planWith("word:beta"), timingsOf(1.0, 2.18), moved);
  assert.deepEqual(m.map((w) => w.type), ["cue-word-moved"]);
  assert.match(formatCueWarnings(m, 1), /1 word cue checked, 1 warning\na ding at word:beta: cue-word-moved: recorded 2\.180 s/);

  const gone = checkWordCues(planWith("word:beta"), { lines: [] }, null);
  assert.deepEqual(gone.map((w) => w.type), ["cue-line-missing"]);
});

test("firstWordIndexContaining: skips break marks like the engine", () => {
  assert.equal(firstWordIndexContaining("let's | open the", "open"), 1);
  assert.equal(firstWordIndexContaining("let's open", "zzz"), -1);
});

test("cue-check.mjs: warns on a moved cue word, quiet on a clean reel, skips the waveform without narration.wav", () => {
  const dir = reelDir({ timings: timingsOf(1.0, 2.18), plan: planWith("word:beta"), bursts: [1.0, 2.0] });
  const clean = reelDir({ timings: timingsOf(1.0, 2.0), plan: planWith("word:beta"), bursts: [1.0, 2.0] });
  const noWav = reelDir({ timings: timingsOf(1.0, 2.0), plan: planWith("word:beta") });
  try {
    const r = spawnSync(process.execPath, [cueCheck, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 word cue checked, 1 warning/);
    assert.match(r.stdout, /cue-word-moved/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "out", "cue-check.json"), "utf8")).waveformChecked, true);
    const c = spawnSync(process.execPath, [cueCheck, clean], { encoding: "utf8" });
    assert.match(c.stdout, /1 word cue checked, no warnings/);
    const n = spawnSync(process.execPath, [cueCheck, noWav], { encoding: "utf8" });
    assert.equal(n.status, 0, n.stderr);
    assert.match(n.stdout, /moved-word checks skipped/);
  } finally {
    for (const d of [dir, clean, noWav]) fs.rmSync(d, { recursive: true, force: true });
  }
});
