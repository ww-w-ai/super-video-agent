// Sentence-end audit (scripts/voice/end-cut.mjs) and the clip trim that must keep the last syllable
// (scripts/lib/clip-trim.mjs). The old trim cut with output-side -ss/-to and placed its fades on the
// cut clip's clock while the filter ran on the input's: the fade-out landed lead-trim seconds early and
// zeroed the end. `oldTrim` below is that command, kept here only to prove the gate bites.
// Fixtures in tests/fixtures/end-cut are real raw takes (24 kHz, cropped: head with its lead silence
// + the last 2.2 s; c1 whole).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trimClipToVoice, measureEdgeEnvelope, voicedSpanWithPads, lastSyllableDecayEndSec } from "../scripts/lib/clip-trim.mjs";
import { trimEdgeSilence } from "../scripts/lib/dub-timing.mjs";
import { endCutFacts, describeEndCut } from "../scripts/voice/end-cut.mjs";
import { findClipDefects, withEndCut, waveformFlag, describeDefects, defectCodes } from "../scripts/voice/take-check.mjs";
import { sentenceEnds } from "../scripts/lib/stt-compare.mjs";
import { reinstallsFromRaw } from "../scripts/voice.mjs";
import { voiceClipFacts, voiceClipFactLines } from "../scripts/review.mjs";
import { fingerprintFile } from "../scripts/lib/raw-take.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";

const SR = 48000;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "end-cut");

/** The pre-fix trim: output-side -ss/-to, fades on the cut clip's clock, no decay follow. */
async function oldTrim(src, out) {
  const dur = await probeDuration(src);
  const r = trimEdgeSilence(await measureEdgeEnvelope(src), dur, { thresholdDb: -50, headPadSec: 0.05, tailPadSec: 0.3 });
  const d = r.trimmedEndSec - r.trimmedStartSec;
  await ffmpeg(["-y", "-i", src, "-ss", String(r.trimmedStartSec), "-to", String(r.trimmedEndSec), "-af", `afade=t=in:st=0:d=0.02,afade=t=out:st=${(d - 0.03).toFixed(6)}:d=0.03`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/** The install's speed-up after the trim (meta.voice.rate 1.1). */
async function tempo(src, out, factor = 1.1) {
  await ffmpeg(["-y", "-i", src, "-af", `atempo=${factor}`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/** Seconds of exact digital zero at the end of `x`. */
function trailingZeroSec(x) {
  let n = 0;
  while (n < x.length && x[x.length - 1 - n] === 0) n++;
  return n / SR;
}

/** 0.7 s silence, 1.0 s body, a 30 ms gap, a soft final syllable (-37 dBFS) with a 0.2 s decay, 0.6 s silence. */
function softEnding() {
  const lead = 0.7, body = 1.0, gap = 0.03, last = 0.25, decay = 0.2, tail = 0.6;
  const out = new Float32Array(Math.round((lead + body + gap + last + decay + tail) * SR));
  const sine = (i, a) => a * Math.sin((2 * Math.PI * 220 * i) / SR);
  let i = Math.round(lead * SR);
  // Syllable-like 4-5 Hz level changes, so the envelope has a shape to align on (speech is never flat).
  for (const end = i + Math.round(body * SR); i < end; i++) out[i] = sine(i, 0.1 * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4.3 * i) / SR + 0.002 * i / SR * i / SR)));
  i += Math.round(gap * SR);
  for (const end = i + Math.round(last * SR); i < end; i++) out[i] = sine(i, 0.02);
  const d0 = i;
  for (const end = i + Math.round(decay * SR); i < end; i++) out[i] = sine(i, 0.02 * Math.exp(-(i - d0) / (0.035 * SR)));
  return out;
}

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-end-cut-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("soft final syllable: the old trim zeroes it and END_CUT bites; the new trim keeps it and END_CUT is quiet", () =>
  withDir(async (dir) => {
    const src = path.join(dir, "raw.wav");
    writeWavPCM16(src, [softEnding()], SR);
    const raw = await decodeMonoPcm(src, SR);
    const oldOut = path.join(dir, "old.wav");
    await oldTrim(src, oldOut);
    const oldClip = await decodeMonoPcm(oldOut, SR);
    assert.ok(trailingZeroSec(oldClip) > 0.6, `old trim leaves ${trailingZeroSec(oldClip)} s of zeros`);
    const oldFacts = endCutFacts(raw, oldClip, SR);
    assert.equal(oldFacts.cut, true);
    assert.equal(oldFacts.rawCut, false);
    assert.ok(oldFacts.lostSec >= 0.1, `lost ${oldFacts.lostSec}`);

    const newOut = path.join(dir, "new.wav");
    await trimClipToVoice(src, newOut);
    const newClip = await decodeMonoPcm(newOut, SR);
    // The decay ends at 2.18 s in the take, 1.53 s into the clip (0.65 s cut at the head): the clip still sounds there.
    const soundsUntil = (newClip.length - trailingZeroSec(newClip) * SR) / SR;
    assert.ok(soundsUntil >= 1.5, `new clip sounds until ${soundsUntil} s`);
    const newFacts = endCutFacts(raw, newClip, SR);
    assert.equal(newFacts.cut, false);
    assert.equal(newFacts.lostSec, 0);
    // The fade-in now applies on the cut clip's clock: the first sample is silent.
    assert.equal(newClip[0], 0);
  }));

test("voicedSpanWithPads: a decay longer than the 0.3 s tail pad moves the end past it", () => {
  const windows = [];
  const push = (sec, db) => { const s = windows.length * 0.01; windows.push({ startSec: s, endSec: s + 0.01, rmsDb: db }); };
  for (let k = 0; k < 100; k++) push(0, -20); // 1 s of voice
  for (let k = 0; k < 60; k++) push(0, -48 - k * 0.3); // 0.6 s decay under the -50 gate from k=0
  for (let k = 0; k < 100; k++) push(0, -120);
  const dur = windows.length * 0.01;
  const decayEnd = lastSyllableDecayEndSec(windows);
  assert.ok(decayEnd > 1.4, `decay end ${decayEnd}`);
  const range = voicedSpanWithPads(windows, dur);
  assert.ok(range.trimmedEndSec >= decayEnd + 0.08 - 1e-9);
  const plain = trimEdgeSilence(windows, dur, { thresholdDb: -50, headPadSec: 0.05, tailPadSec: 0.3 });
  assert.ok(range.trimmedEndSec > plain.trimmedEndSec);
});

test("voicedSpanWithPads: an ordinary take keeps its old length (the decay ends inside the pad)", () => {
  const windows = [];
  for (let k = 0; k < 200; k++) windows.push({ startSec: k * 0.01, endSec: (k + 1) * 0.01, rmsDb: k >= 20 && k < 150 ? -20 : -120 });
  const range = voicedSpanWithPads(windows, 2.0);
  assert.ok(Math.abs(range.trimmedEndSec - 1.8) < 1e-9);
  assert.ok(Math.abs(range.trimmedStartSec - 0.15) < 1e-9);
});

for (const id of ["n19", "n24", "h12a"]) {
  test(`regression ${id} (real raw take): old trim + 1.1x install gives END_CUT, new gives none`, () =>
    withDir(async (dir) => {
      const src = path.join(FIXTURES, `${id}.wav`);
      const raw = await decodeMonoPcm(src, SR);
      const oldT = path.join(dir, "old-trim.wav");
      const oldI = path.join(dir, "old.wav");
      await oldTrim(src, oldT);
      await tempo(oldT, oldI);
      const oldFacts = endCutFacts(raw, await decodeMonoPcm(oldI, SR), SR);
      assert.equal(oldFacts.cut, true, `old ${id}: ${JSON.stringify(oldFacts)}`);
      assert.equal(oldFacts.rawCut, false);

      const newT = path.join(dir, "new-trim.wav");
      const newI = path.join(dir, "new.wav");
      await trimClipToVoice(src, newT);
      await tempo(newT, newI);
      const newFacts = endCutFacts(raw, await decodeMonoPcm(newI, SR), SR);
      assert.equal(newFacts.cut, false, `new ${id}: ${JSON.stringify(newFacts)}`);
      assert.ok(Math.abs(newFacts.tempo - 1.1) < 0.03, `tempo found ${newFacts.tempo}`);
    }));
}

test("regression c1 (real raw take): the new trim keeps the end, with and without the speed-up", () =>
  withDir(async (dir) => {
    const src = path.join(FIXTURES, "c1.wav");
    const raw = await decodeMonoPcm(src, SR);
    const t = path.join(dir, "t.wav");
    const s = path.join(dir, "s.wav");
    await trimClipToVoice(src, t);
    await tempo(t, s);
    assert.equal(endCutFacts(raw, await decodeMonoPcm(t, SR), SR).cut, false);
    assert.equal(endCutFacts(raw, await decodeMonoPcm(s, SR), SR).cut, false);
  }));

test("a raw take that stops while speaking is END_CUT with rawCut (a new take is needed)", () => {
  const x = new Float32Array(SR);
  for (let i = Math.round(0.2 * SR); i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const facts = endCutFacts(x, x, SR);
  assert.equal(facts.cut, true);
  assert.equal(facts.rawCut, true);
  assert.match(describeEndCut(facts), /raw take itself/);
});

test("END_CUT is the gate flag and leads the defect lists; reinstallsFromRaw only for a whole raw take", () => {
  const clip = { samples: softEnding(), sampleRate: SR };
  const base = findClipDefects(clip.samples, SR);
  const cutClip = clip.samples.slice();
  cutClip.fill(0, cutClip.length - Math.round(0.95 * SR));
  const withCut = withEndCut(findClipDefects(cutClip, SR), { samples: cutClip, sampleRate: SR }, clip);
  assert.equal(waveformFlag(withCut), "END_CUT");
  assert.equal(defectCodes(withCut)[0], "END_CUT");
  assert.match(describeDefects(withCut)[0], /^END_CUT \(the last syllable lost/);
  assert.equal(withEndCut(base, clip, null), base);
  assert.equal(reinstallsFromRaw({ voiceFlag: "END_CUT", clipFacts: withCut }), true);
  assert.equal(reinstallsFromRaw({ voiceFlag: "END_CUT", clipFacts: { endCut: { cut: true, rawCut: true } } }), false);
  assert.equal(reinstallsFromRaw({ voiceFlag: "TAIL", clipFacts: withCut }), false);
});

test("review.mjs reports END_CUT from the current raw take and names the re-install", () =>
  withDir(async (dir) => {
    const raw = softEnding();
    const cutClip = raw.slice(Math.round(0.65 * SR));
    cutClip.fill(0, cutClip.length - Math.round(0.95 * SR));
    fs.mkdirSync(path.join(dir, "raw"));
    writeWavPCM16(path.join(dir, "raw", "a.wav"), [raw], SR);
    writeWavPCM16(path.join(dir, "line-a.wav"), [cutClip], SR);
    const rawTake = fingerprintFile(path.join(dir, "raw", "a.wav"));
    const facts = await voiceClipFacts({ lines: [{ id: "a", rawTake }] }, dir);
    assert.equal(facts.lines[0].flag, "END_CUT");
    assert.match(voiceClipFactLines(facts).join("\n"), /WARN voice clip END_CUT, line "a".*--use a=<reel>\/voice\/raw\/a\.wav/);
    // A stale raw take is never compared.
    const stale = await voiceClipFacts({ lines: [{ id: "a", rawTake: { sha256: "0" } }] }, dir);
    assert.notEqual(stale.lines[0]?.flag, "END_CUT");
  }));

test("sentenceEnds: each sentence's final syllable is looked up in the transcript", () => {
  const ends = sentenceEnds("비용이 줄었어요. 속도는 그대로 있었어요.", "비용이 줄었어요 속도는 그대로 있었어", "ko");
  assert.deepEqual(ends.map((e) => [e.sentence, e.final, e.heard]), [[1, "요", true], [2, "요", false]]);
  assert.deepEqual(sentenceEnds("Version 0.93 shipped. Done!", "version 0.93 shipped done", "en").map((e) => e.heard), [true, true]);
});
