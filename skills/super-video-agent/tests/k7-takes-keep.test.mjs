// K7 takes-keep: a later --takes round adds takes after the ones on disk instead of
// overwriting them, and --use of a line's own raw take is processed as raw (trimmed,
// film speed, rawTake record, measured word times kept) — provider "none" and a mocked
// provider, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, synthesizeTakes } from "../scripts/voice.mjs";
import { reelPaths, readJson, writeJson } from "../scripts/lib/reeldir.mjs";
import { probeDuration } from "../scripts/lib/ffmpeg.mjs";
import { trimClipToVoice } from "../scripts/lib/clip-trim.mjs";
import { fingerprintFile, isRecordedRawTake } from "../scripts/lib/raw-take.mjs";
import * as none from "../scripts/voice/none.mjs";

function tmpReelDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sva-k7-"));
}

function writePlan(dir, lines) {
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "ko-KR", gapMs: 250 }, lines }, null, 2), "utf8");
}

/** none.mjs with the text lengthened on every call, so each take has different bytes and length. */
function makeVaryingProvider() {
  const calls = [];
  return {
    calls,
    tagMap: () => ({}),
    async synth({ text, outPath }) {
      calls.push(outPath);
      return none.synth({ text: text + "다".repeat(calls.length * 4), outPath });
    },
  };
}

function takesArgs(dir, spec, provider) {
  const paths = reelPaths(dir);
  return { dir, paths, plan: { meta: { lang: "ko-KR", gapMs: 250 }, lines: [{ id: "l1", text: "다음 토큰은 뭘까?" }] }, lineIds: ["l1"], spec, provider, providerName: "none", voiceCfg: {}, pronounce: undefined, lang: "ko-KR", gapMs: 250, sttEnabled: false, keepTiming: true };
}

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== "string") return orig.call(process.stdout, chunk, ...rest);
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

const takePath = (paths, k) => path.join(paths.voiceDir, "takes", `l1-${k}.wav`);

test("K7-1: a second --takes 2 round writes l1-3, l1-4 and leaves l1-1, l1-2 byte-identical", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeVaryingProvider();
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));
  const round1 = [1, 2].map((k) => fs.readFileSync(takePath(paths, k)));

  const out = await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));

  [1, 2].forEach((k, i) => assert.ok(fs.readFileSync(takePath(paths, k)).equals(round1[i]), `l1-${k} changed`));
  assert.ok(fs.existsSync(takePath(paths, 3)) && fs.existsSync(takePath(paths, 4)));
  assert.equal(fs.existsSync(takePath(paths, 5)), false);
  assert.ok(!fs.readFileSync(takePath(paths, 3)).equals(round1[0]), "round 2 is new audio");
  assert.match(out, /takes l1-3\.\.l1-4 written; earlier takes l1-1\.\.l1-2 kept/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-2: a tone round then a count round accumulates marks per take number", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeVaryingProvider();
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "tone", marks: ["confident", "calm"] }, provider)));
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));
  const manifest = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  assert.deepEqual(manifest.l1, { mode: "tone", marks: ["confident", "calm", null, null] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-2: manifest marks are cut back to the takes on disk before a new round's marks are added", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeVaryingProvider();
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "tone", marks: ["confident", "calm"] }, provider)));
  fs.rmSync(takePath(paths, 2));
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "tone", marks: ["excited", "sad"] }, provider)));
  const manifest = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  // take 2 was deleted, so the new round is takes 2 and 3; its marks sit at those numbers.
  assert.deepEqual(manifest.l1, { mode: "tone", marks: ["confident", "excited", "sad"] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-2: --pick l1=4 after two --takes 2 rounds installs take 4", async () => {
  const dir = tmpReelDir();
  writePlan(dir, [{ id: "l1", text: "짧은 문장" }]);
  const paths = reelPaths(dir);
  await captureStdout(() => main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]));
  await captureStdout(() => main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]));
  assert.equal(readJson(paths.timingsJson).lines[0].rawTake.source, "takes/l1-1.wav");

  const out = await captureStdout(() => main([dir, "--provider", "none", "--pick", "l1=4", "--no-stt", "--retime"]));

  assert.match(out, /installed take\(s\): l1=4/);
  const l1 = readJson(paths.timingsJson).lines[0];
  assert.equal(l1.rawTake.source, "takes/l1-4.wav");
  assert.equal(l1.rawTake.sha256, fingerprintFile(takePath(paths, 4)).sha256);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-2: --pick-by reads every take on disk, not only the first five", async () => {
  const dir = tmpReelDir();
  writePlan(dir, [{ id: "l1", text: "짧은 문장" }]);
  const paths = reelPaths(dir);
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt"]));
  for (let k = 1; k <= 6; k++) await none.synth({ text: "가".repeat(10 + k * 3), outPath: takePath(paths, k) });

  const out = await captureStdout(() => main([dir, "--provider", "none", "--no-stt", "--lines", "l1", "--pick-by", "length:20", "--retime"]));

  const rows = out.split("\n").filter((l) => /^l1\t\d+\t/.test(l));
  assert.deepEqual(rows.map((l) => Number(l.split("\t")[1])), [1, 2, 3, 4, 5, 6]);
  assert.match(out, /installed take\(s\): l1=6/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-3: a line with no clip gets the first take of this round, and a later round leaves it alone", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeVaryingProvider();
  const clip = path.join(paths.voiceDir, "line-l1.wav");
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));
  const installed = fs.readFileSync(clip);
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));
  assert.ok(fs.readFileSync(clip).equals(installed), "round 2 changed the installed clip");
  assert.equal(readJson(paths.timingsJson).lines[0].rawTake.source, "takes/l1-1.wav");

  // With the clip gone, the next round installs its own first take (l1-5), not take 1.
  fs.rmSync(clip);
  await captureStdout(() => synthesizeTakes(takesArgs(dir, { mode: "count", n: 2 }, provider)));
  const l1 = readJson(paths.timingsJson).lines[0];
  assert.equal(l1.rawTake.source, "takes/l1-5.wav");
  assert.equal(l1.rawTake.sha256, fingerprintFile(takePath(paths, 5)).sha256);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isRecordedRawTake: true for the recorded raw take or a byte copy, false otherwise", () => {
  const dir = tmpReelDir();
  const a = path.join(dir, "a.wav");
  const b = path.join(dir, "b.wav");
  fs.writeFileSync(a, "same bytes");
  fs.writeFileSync(b, "other bytes");
  const line = { id: "l1", rawTake: { ...fingerprintFile(a), source: "synth" } };
  assert.equal(isRecordedRawTake(line, a), true);
  fs.copyFileSync(a, path.join(dir, "copy.wav"));
  assert.equal(isRecordedRawTake(line, path.join(dir, "copy.wav")), true);
  assert.equal(isRecordedRawTake(line, b), false);
  assert.equal(isRecordedRawTake({ id: "l1" }, a), false);
  assert.equal(isRecordedRawTake(undefined, a), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A reel with line l1 at rate 1.1 installed once (its raw take recorded). */
async function rateReel(text = "하나 둘 셋 넷 다섯 여섯") {
  const dir = tmpReelDir();
  writePlan(dir, [{ id: "l1", text, rate: 1.1 }]);
  const paths = reelPaths(dir);
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt"]));
  return { dir, paths, raw: path.join(paths.voiceDir, "raw", "l1.wav"), clip: path.join(paths.voiceDir, "line-l1.wav") };
}

test("K7-4: --use of the line's own raw take is trimmed, gets the film's speed, and records rawTake", async () => {
  const { dir, paths, raw, clip } = await rateReel();
  const rawSha = fingerprintFile(raw).sha256;
  const trimmedCopy = path.join(dir, "trimmed.wav");
  await trimClipToVoice(raw, trimmedCopy);
  const expected = (await probeDuration(trimmedCopy)) / 1.1;

  const out = await captureStdout(() => main([dir, "--provider", "none", "--use", `l1=${raw}`, "--no-stt", "--retime"]));

  const got = await probeDuration(clip);
  assert.ok(Math.abs(got - expected) / expected < 0.02, `clip ${got}s, expected ${expected}s (trimmed raw / 1.1)`);
  const l1 = readJson(paths.timingsJson).lines[0];
  assert.equal(l1.rawTake.sha256, rawSha);
  assert.equal(l1.rawTake.source, "synth", "keeps the source recorded with the raw take");
  assert.match(out, /installed raw take: l1 <- .*l1\.wav \(film speed applied\)/);
  assert.doesNotMatch(out, /installed finished audio/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-4 control: --use of any other WAV is taken as finished — no tempo, no trim", async () => {
  const { dir, paths, clip } = await rateReel();
  const other = path.join(dir, "finished.wav");
  await none.synth({ text: "다른 녹음 파일입니다 길게", outPath: other });
  const otherSec = await probeDuration(other);

  const out = await captureStdout(() => main([dir, "--provider", "none", "--use", `l1=${other}`, "--no-stt", "--retime"]));

  const got = await probeDuration(clip);
  assert.ok(Math.abs(got - otherSec) < 0.01, `clip ${got}s, file ${otherSec}s`);
  assert.match(out, /installed finished audio: l1 <- /);
  assert.equal(readJson(paths.timingsJson).lines[0].rawTake, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("K7-5: raw-take --use with no STT keeps the measured word times, inside the new line span", async () => {
  const { dir, paths, raw } = await rateReel("하나 둘 셋");
  const timings = readJson(paths.timingsJson);
  const prev = timings.lines[0];
  const span = prev.end - prev.start;
  prev.words = [
    { text: "하나", start: prev.start + 0.1 * span, end: prev.start + 0.3 * span },
    { text: "둘", start: prev.start + 0.4 * span, end: prev.start + 0.6 * span },
    { text: "셋", start: prev.start + 0.7 * span, end: prev.start + 0.95 * span },
  ];
  prev.wordsMeasured = 3;
  writeJson(paths.timingsJson, timings);

  const out = await captureStdout(() => main([dir, "--provider", "none", "--use", `l1=${raw}`, "--no-stt", "--retime"]));

  const l1 = readJson(paths.timingsJson).lines[0];
  assert.equal(l1.wordsMeasured, 3);
  assert.equal(l1.words.length, 3);
  for (const w of l1.words) assert.ok(w.start >= l1.start - 1e-9 && w.end <= l1.end + 1e-9, `word ${JSON.stringify(w)} outside [${l1.start}, ${l1.end}]`);
  // Relative positions survive the shift and scale.
  const rel = (w) => (w.start - l1.start) / (l1.end - l1.start);
  assert.ok(Math.abs(rel(l1.words[1]) - 0.4) < 0.01, `word 2 at ${rel(l1.words[1])}`);
  assert.match(out, /line "l1": word times carried from its earlier install of the same raw take \(×\d/);
  fs.rmSync(dir, { recursive: true, force: true });
});
