// A3: take choice and re-recording — re-take fit order (51), comparison with slot and existing take (25),
// defects the STT check cannot hear (37), pitch report (65), word starts after a pause (N16), and the
// carried A2 gaps (oversize lines, stt-pending, apostrophes, groq models).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeAll, main } from "../scripts/voice.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import { probeDuration, ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import * as none from "../scripts/voice/none.mjs";
import * as typecast from "../scripts/voice/typecast.mjs";
import * as fish from "../scripts/voice/fish.mjs";
import * as elevenlabs from "../scripts/voice/elevenlabs.mjs";
import { chooseTake, planRetakeFit, previousSlots, writeWavMono16, partialRebuildNote } from "../scripts/voice/line-edit.mjs";
import { findClipDefects, describeDefects, pitchTrack, endContour, wordContours } from "../scripts/voice/take-check.mjs";
import { snapStartsToSound } from "../scripts/lib/word-onsets.mjs";
import { stripQuoteMarks } from "../scripts/lib/pronounce.mjs";
import { sttTranscribe } from "../scripts/lib/stt-engine.mjs";

const tmp = (p = "sva-a3-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
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

// --- signals ----------------------------------------------------------------------------

const RATE = 48000;

/** Mono PCM16: `parts` = [{sec, amp?, hz?|hzFn?, fadeSec?}] joined in order; no amp = silence. */
function signal(parts) {
  const chunks = parts.map(({ sec, amp = 0, hz = 150, hzFn = null, fadeSec = 0 }) => {
    const n = Math.round(sec * RATE);
    const out = new Int16Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      phase += (2 * Math.PI * (hzFn ? hzFn(t / sec) : hz)) / RATE;
      const fade = fadeSec > 0 ? Math.min(1, t / fadeSec) : 1;
      out[i] = Math.round(32767 * amp * fade * (Math.sin(phase) + 0.4 * Math.sin(2 * phase)) / 1.4);
    }
    return out;
  });
  const all = new Int16Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

const asFloat = (int16) => Float32Array.from(int16, (v) => v / 32768);

// --- 51: re-take order ----------------------------------------------------------------------

const BASE = { providerName: "none", voiceCfg: {}, lang: "ko-KR", gapMs: 250, sttEnabled: false };
const A_TEXT = "가나다라마바사아자차카타파하"; // none.mjs: 7 characters per second, 14 = 2.0 s

async function firstRun() {
  const dir = tmp();
  const paths = reelPaths(dir);
  const args = { ...BASE, dir, paths, provider: none };
  const lines = [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄" }];
  const first = await synthesizeAll({ ...args, lines });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  return { dir, paths, args, first, lines };
}

const withSay = (n) => [{ id: "a", text: A_TEXT, say: "가".repeat(n) }, { id: "b", text: "다음 줄" }];

test("51: planRetakeFit follows the dub order: unchanged, sped up to 1.1x, refused beyond, slowed for a long gap", () => {
  const slot = { slotSec: 2.5, oldClipSec: 2.0 };
  const fits = planRetakeFit(1.9, slot);
  assert.ok(fits.ok && fits.atempoFactor === 1 && fits.breathSec >= 0.5 && !fits.longGap);
  const sped = planRetakeFit(2.14, slot);
  assert.ok(sped.ok && Math.abs(sped.atempoFactor - 1.07) < 0.001, "2.14 s leaves 0.5 s of breath at 1.07x");
  const over = planRetakeFit(2.9, slot);
  assert.equal(over.ok, false);
  assert.ok(over.requiredFactor > 1.1);
  const short = planRetakeFit(1.0, slot);
  assert.ok(short.ok && short.atempoFactor === 0.95 && short.longGap, "slowed to 0.95x, still a long gap: reported");
  // a pause the film already had is not charged to the take
  assert.equal(planRetakeFit(2.0, { slotSec: 4.0, oldClipSec: 2.0 }).longGap, false);
});

test("51: previousSlots: start to the next start; the last line adds its planned pause", () => {
  const prev = [{ id: "a", start: 0.4, end: 2.4 }, { id: "b", start: 2.9, end: 3.3 }];
  const slots = previousSlots(prev, [{ id: "a" }, { id: "b", pauseAfterMs: 1200 }], 250);
  assert.deepEqual(slots.get("a"), { slotSec: 2.5, oldClipSec: 2.0 });
  assert.ok(Math.abs(slots.get("b").slotSec - (0.4 + 1.2)) < 1e-9);
});

test("51: a take needing breath from the pause after it keeps the next line where it was", async (t) => {
  const { dir, paths, args, first, lines } = await firstRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = await captureStdout(async () => {
    const run = await synthesizeAll({ ...args, lines: withSay(17), onlyLineIds: ["a"] });
    assert.deepEqual(run.refused, []);
    assert.deepEqual(run.moved, [], "no later line moves");
    assert.ok(Math.abs(run.timings.lines[1].start - first.timings.lines[1].start) < 1e-6, "b keeps its start");
    const len = run.timings.lines[0].end - run.timings.lines[0].start;
    assert.ok(len > 2.0, `the take borrowed breath: ${len}`);
  });
  assert.match(out, /a: take 2\.43s, slot 2\.50s, existing take 2\.00s — fits \(sped up 1\.10x; 0\.29s of silence after it; under the 0\.5s breath\)/);
  assert.ok(fs.existsSync(paths.narrationWav));
});

test("51: a take that needs more than 1.1x is refused: old clip back, later lines stay, the take is kept", async (t) => {
  const { dir, paths, args, first } = await firstRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"));
  let run;
  const out = await captureStdout(async () => {
    run = await synthesizeAll({ ...args, lines: withSay(20), onlyLineIds: ["a"] });
  });
  assert.deepEqual(run.refused, ["a"]);
  assert.deepEqual(run.timings.lines.map((l) => [l.start, l.end]), first.timings.lines.map((l) => [l.start, l.end]));
  assert.ok(before.equals(fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"))), "the old clip is restored byte for byte");
  const kept = fs.readdirSync(path.join(paths.voiceDir, "takes", "a")).filter((f) => f.startsWith("refused-"));
  assert.equal(kept.length, 1);
  assert.match(out, /a: take 2\.86s, slot 2\.50s, existing take 2\.00s — refused: needs 1\.14x/);
  assert.equal(fs.readdirSync(paths.voiceDir).filter((f) => f.includes(".old-")).length, 0, "no temp copy is left");
});

test("51/25: a picked take (takeWavs) is judged against the slot the same way", async (t) => {
  const { dir, paths, args, first } = await firstRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const take = path.join(dir, "long-take.wav");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=3.2", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", take]);
  let run;
  await captureStdout(async () => {
    run = await synthesizeAll({ ...args, lines: first.timings.lines.map((l) => ({ id: l.id, text: l.text })), onlyLineIds: ["a"], takeWavs: new Map([["a", take]]) });
  });
  assert.deepEqual(run.refused, ["a"]);
  assert.ok(Math.abs((await probeDuration(path.join(paths.voiceDir, "line-a.wav"))) - 2.0) < 0.01);
});

test("51: a start that moved by a sub-millisecond rounding is not a moved line", async (t) => {
  const { dir, paths, args, lines } = await firstRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timings = readJson(paths.timingsJson);
  timings.lines[1].start += 0.0004;
  fs.writeFileSync(paths.timingsJson, JSON.stringify(timings));
  let run;
  await captureStdout(async () => {
    run = await synthesizeAll({ ...args, lines, onlyLineIds: ["a"] });
  });
  assert.deepEqual(run.moved, []);
});

test("51: the note after a re-take names dub tracks whose placed times are stale", (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "dub", "en"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "en", "timings.placed.json"), "{}");
  fs.mkdirSync(path.join(dir, "dub", "ja"), { recursive: true });
  assert.match(partialRebuildNote(dir, ["l2"]), /dub tracks placed on the old times \(en\)/);
  assert.equal(partialRebuildNote(dir, []), "");
});

// --- 25: choosing among takes ----------------------------------------------------------------

test("25: chooseTake compares with the installed take (k = 0) and skips takes over the slot", () => {
  const installed = { id: "a", k: 0, installed: true, lengthSec: 2, cer: 0.05 };
  const rows = [installed, { id: "a", k: 1, lengthSec: 2.2, cer: 0.1, fits: true }, { id: "a", k: 2, lengthSec: 4, cer: 0, fits: false, needs: 1.6 }];
  assert.equal(chooseTake(rows, { by: "stt" }), 0, "the installed take beats a worse new one; the best-scoring take is over the slot");
  assert.equal(chooseTake([{ ...installed, cer: 0.2 }, rows[1], rows[2]], { by: "stt" }), 1);
  assert.equal(chooseTake([{ ...installed, cer: 0.1 }, rows[1]], { by: "stt" }), 0, "a tie keeps the installed take");
  assert.equal(chooseTake(rows, { by: "length", sec: 2.1 }), 0);
});

test("25: when no take fits the slot chooseTake refuses with NO_FIT", () => {
  const rows = [{ id: "a", k: 0, installed: true, lengthSec: 2, cer: null }, { id: "a", k: 1, lengthSec: 4, cer: 0, fits: false, needs: 1.6 }];
  assert.throws(() => chooseTake(rows, { by: "stt" }), (e) => e.code === "NO_FIT" && /needs 1\.60x/.test(e.message));
  assert.equal(chooseTake([{ id: "a", k: 1, lengthSec: 1, cer: 0.1 }], { by: "stt" }), 1, "rows without fit data behave as before");
});

test("25: a re-take prints its STT error rate against the existing take", async (t) => {
  const { dir, paths, args } = await firstRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timings = readJson(paths.timingsJson);
  timings.lines[0].stt = { cer: 0.02 };
  fs.writeFileSync(paths.timingsJson, JSON.stringify(timings));
  const saved = { engine: process.env.SVA_STT_ENGINE, key: process.env.GROQ_API_KEY, fetch: globalThis.fetch };
  process.env.SVA_STT_ENGINE = "groq";
  process.env.GROQ_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: A_TEXT, words: [] }) });
  let out;
  try {
    out = await captureStdout(async () => {
      await synthesizeAll({ ...args, sttEnabled: true, lines: [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄" }], onlyLineIds: ["a"] });
    });
  } finally {
    for (const [name, v] of [["SVA_STT_ENGINE", saved.engine], ["GROQ_API_KEY", saved.key]]) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
    globalThis.fetch = saved.fetch;
  }
  assert.match(out, /a: STT error rate 0\.02 \(existing take\) -> 0\.00 \(new take\): better/);
});

// --- 37: defects the STT check cannot hear ---------------------------------------------------

const body = { amp: 0.5, hz: 150, fadeSec: 0.04 };
// A line that dies away: the last frame over -50 dBFS sits well under -35 dBFS.
const DECAY = [{ amp: 0.15, sec: 0.03 }, { amp: 0.04, sec: 0.03 }, { amp: 0.01, sec: 0.03 }, { amp: 0.002, sec: 0.03 }];

test("37: a clean clip has no HEAD, DIP or PAUSE", () => {
  const clip = signal([{ sec: 0.05 }, { ...body, sec: 1.5 }, ...DECAY, { sec: 0.3 }]);
  const d = findClipDefects(asFloat(clip), RATE);
  assert.deepEqual(describeDefects(d), []);
});

test("37: HEAD abrupt: full level from the first sample", () => {
  const d = findClipDefects(asFloat(signal([{ amp: 0.5, hz: 150, sec: 1.5 }, { sec: 0.3 }])), RATE);
  assert.equal(d.head.abrupt, true);
  assert.match(describeDefects(d)[0], /^HEAD cut/);
});

test("37: HEAD weak: the first 150 ms is far under the body level", () => {
  const d = findClipDefects(asFloat(signal([{ sec: 0.05 }, { amp: 0.05, hz: 150, sec: 0.25, fadeSec: 0.04 }, { amp: 0.5, hz: 150, sec: 1.2 }, { sec: 0.3 }])), RATE);
  assert.equal(d.head.weak, true);
});

test("37: DIP: a 300 ms stretch 20 dB down between loud parts; PAUSE: 0.5 s of silence inside", () => {
  const dip = findClipDefects(asFloat(signal([{ sec: 0.05 }, { ...body, sec: 1 }, { amp: 0.05, hz: 150, sec: 0.3 }, { amp: 0.5, hz: 150, sec: 1 }, { sec: 0.3 }])), RATE);
  assert.equal(dip.dips.length, 1);
  assert.ok(Math.abs(dip.dips[0].atSec - 1.05) < 0.05 && dip.pauses.length === 0, JSON.stringify(dip));
  const gap = findClipDefects(asFloat(signal([{ sec: 0.05 }, { ...body, sec: 0.5 }, { sec: 0.5 }, { amp: 0.5, hz: 150, sec: 0.5 }, { sec: 0.3 }])), RATE);
  assert.equal(gap.pauses.length, 1);
  assert.ok(Math.abs(gap.pauses[0].sec - 0.5) < 0.03 && gap.dips.length === 0, JSON.stringify(gap));
  assert.equal(findClipDefects(new Float32Array(RATE), RATE), null, "silence has nothing to report");
});

test("37: a freshly made line prints its defects and never stops the run", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = {
    async synth({ outPath }) {
      writeWavMono16(outPath, signal([{ sec: 0.05 }, { ...body, sec: 0.5 }, { sec: 0.6 }, { amp: 0.5, hz: 150, sec: 0.5 }, ...DECAY]), RATE);
      return { wavPath: outPath };
    },
  };
  const out = await captureStdout(async () => {
    await synthesizeAll({ ...BASE, dir, paths: reelPaths(dir), provider, lines: [{ id: "x", text: "하나 둘" }] });
  });
  assert.match(out, /line "x": .*PAUSE 0\.\d\d s of silence at 0\.\d\d s — facts the STT check cannot hear/);
});

// --- 65: pitch -------------------------------------------------------------------------------

const hzRise = (u) => 120 + 80 * u;
const hzFall = (u) => 200 - 80 * u;

test("65: endContour reads a rise, a fall and a level end in semitones", () => {
  const rise = endContour(pitchTrack(asFloat(signal([{ amp: 0.5, hz: 130, sec: 0.6 }, { amp: 0.5, hzFn: hzRise, sec: 0.5 }])), RATE));
  assert.equal(rise.direction, "rise");
  assert.ok(rise.deltaSemitones > 2);
  const fall = endContour(pitchTrack(asFloat(signal([{ amp: 0.5, hz: 200, sec: 0.6 }, { amp: 0.5, hzFn: hzFall, sec: 0.5 }])), RATE));
  assert.equal(fall.direction, "fall");
  const level = endContour(pitchTrack(asFloat(signal([{ amp: 0.5, hz: 150, sec: 1.2 }])), RATE));
  assert.equal(level.direction, "level");
  assert.equal(endContour(pitchTrack(new Float32Array(RATE), RATE)), null, "no voiced frames: no contour");
});

test("65: wordContours names each word's shape; a quiet word is unvoiced", () => {
  const sig = signal([
    { amp: 0.5, hzFn: hzRise, sec: 0.4 },
    { amp: 0.5, hzFn: hzFall, sec: 0.4 },
    { amp: 0.5, hz: 150, sec: 0.4 },
    { amp: 0.5, hzFn: (u) => 150 - 40 * Math.sin(Math.PI * u), sec: 0.4 },
    { amp: 0.5, hzFn: (u) => 110 + 40 * Math.sin(Math.PI * u), sec: 0.4 },
    { sec: 0.4 },
  ]);
  const words = ["up", "down", "flat", "dip", "peak", "gone"].map((w, i) => ({ w, start: i * 0.4 + 0.02, end: (i + 1) * 0.4 - 0.02 }));
  const shapes = wordContours(pitchTrack(asFloat(sig), RATE), words).map((x) => x.shape);
  assert.deepEqual(shapes, ["rising", "falling", "level", "dipping", "peaking", "unvoiced"]);
});

test("65: --pitch reports a line that ends in a question mark with its measured contour, and writes out/pitch.json", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  fs.mkdirSync(paths.voiceDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en-US", gapMs: 250 }, lines: [{ id: "q", text: "Really?" }, { id: "s", text: "Yes." }] }));
  writeWavMono16(path.join(paths.voiceDir, "line-q.wav"), signal([{ amp: 0.5, hz: 130, sec: 0.6 }, { amp: 0.5, hzFn: hzRise, sec: 0.5 }]), RATE);
  writeWavMono16(path.join(paths.voiceDir, "line-s.wav"), signal([{ amp: 0.5, hz: 150, sec: 1.1 }]), RATE);
  fs.writeFileSync(paths.timingsJson, JSON.stringify({ duration: 4, lines: [
    { id: "q", text: "Really?", start: 0, end: 1.1, words: [{ w: "Really?", start: 0, end: 1.1 }] },
    { id: "s", text: "Yes.", start: 1.6, end: 2.7, words: [{ w: "Yes.", start: 1.6, end: 2.7 }] },
  ] }));
  const out = await captureStdout(() => main([dir, "--pitch", "--words"]));
  assert.match(out, /q\t\d+%\t[\d.]+ Hz\t[\d.]+ st\trise \+[\d.]+ st\t\?/);
  assert.match(out, /q: the text ends with a question mark; measured end contour: rise/);
  assert.match(out, /cannot tell whether a rise, fall or tone is the right one/);
  const json = readJson(path.join(dir, "out", "pitch.json"));
  assert.deepEqual(json.lines.map((l) => l.id), ["q", "s"]);
  assert.equal(json.lines[1].end.direction, "level");
});

// --- N16: a word after a pause starts at its sound ---------------------------------------------

test("N16: a word recorded inside the pause moves to where its sound begins; earlier words and unpaused words stay", () => {
  const sig = asFloat(signal([{ amp: 0.5, hz: 150, sec: 0.3 }, { sec: 0.7 }, { amp: 0.5, hz: 150, sec: 0.5 }, { amp: 0.5, hz: 170, sec: 0.3 }]));
  const words = [{ w: "a", start: 0, end: 0.3 }, { w: "b", start: 0.75, end: 1.5 }, { w: "c", start: 1.5, end: 1.8 }];
  const { words: out, moved } = snapStartsToSound(words, sig, RATE);
  assert.deepEqual(moved.map((m) => m.w), ["b"]);
  assert.ok(Math.abs(out[1].start - 1.0) <= 0.02, `b starts ${out[1].start}`);
  assert.equal(out[1].end, 1.5);
  assert.deepEqual([out[0], out[2]], [words[0], words[2]]);
});

test("N16: the first word after head silence, an offset clock, and a start already on its sound", () => {
  const sig = asFloat(signal([{ sec: 0.2 }, { amp: 0.5, hz: 150, sec: 0.8 }]));
  const late = snapStartsToSound([{ w: "a", start: 10, end: 11 }], sig, RATE, 10);
  assert.ok(Math.abs(late.words[0].start - 10.2) <= 0.02, `${late.words[0].start}`);
  const exact = snapStartsToSound([{ w: "a", start: 0.2, end: 1 }], sig, RATE);
  assert.deepEqual(exact.moved, []);
});

test("N16: a breath above the floor in the pause, or sound not found before the next word, leaves the start alone", () => {
  const breath = asFloat(signal([{ amp: 0.5, hz: 150, sec: 0.3 }, { amp: 0.2, hz: 150, sec: 0.3 }, { sec: 0.4 }, { amp: 0.5, hz: 150, sec: 0.5 }]));
  assert.deepEqual(snapStartsToSound([{ w: "a", start: 0, end: 0.3 }, { w: "b", start: 0.9, end: 1.5 }], breath, RATE).moved, []);
  const empty = asFloat(signal([{ amp: 0.5, hz: 150, sec: 0.3 }, { sec: 0.7 }, { amp: 0.5, hz: 150, sec: 0.5 }]));
  const stays = snapStartsToSound([{ w: "a", start: 0, end: 0.3 }, { w: "b", start: 0.4, end: 0.6 }, { w: "c", start: 0.7, end: 1.5 }], empty, RATE);
  assert.deepEqual(stays.moved, [], "no sound between the recorded start and the next word");
});

test("N16: a provider-timed line gets its word start moved to the sound at install", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = {
    async synth({ outPath }) {
      writeWavMono16(outPath, signal([{ amp: 0.5, hz: 150, sec: 0.3 }, { sec: 0.7 }, { amp: 0.5, hz: 150, sec: 0.5 }]), RATE);
      return { wavPath: outPath, wordsRelative: true, words: [{ w: "one", start: 0, end: 0.3 }, { w: "two", start: 0.75, end: 1.5 }] };
    },
  };
  let run;
  const out = await captureStdout(async () => {
    run = await synthesizeAll({ ...BASE, dir, paths: reelPaths(dir), provider, lines: [{ id: "x", text: "one two" }] });
  });
  const line = run.timings.lines[0];
  assert.ok(Math.abs(line.words[1].start - (line.start + 1.0)) <= 0.02, `${line.words[1].start} vs ${line.start + 1}`);
  assert.match(out, /line "x": 1 word start\(s\) after a pause moved to where the sound begins/);
});

// --- TTS usage log -----------------------------------------------------------------------------

test("usage: every successful request appends one JSON line to voice/tts-usage.jsonl; a failed one records nothing", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  const logFile = path.join(paths.voiceDir, "tts-usage.jsonl");
  const one = { ...BASE, dir, paths, provider: none, lines: [{ id: "a", text: "가나다라마바사" }, { id: "b", text: "하나 둘" }] };
  await captureStdout(() => synthesizeAll(one));
  const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, "one line per request (none has no batch call)");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["audioSec", "chars", "cost", "lineIds", "model", "provider", "ts", "voiceId"]);
  assert.deepEqual([rows[0].provider, rows[0].lineIds, rows[0].chars, rows[0].cost], ["none", ["a"], 7, null]);
  assert.ok(Math.abs(rows[0].audioSec - 1.0) < 0.01, `${rows[0].audioSec}`);
  assert.ok(!Number.isNaN(Date.parse(rows[0].ts)));

  fs.rmSync(logFile);
  const batch = {
    async synthBatch(items) {
      const out = [];
      for (const it of items) out.push({ ...(await none.synth({ text: it.text, outPath: it.outPath })), id: it.id, cost: 0.01 });
      return out;
    },
  };
  await captureStdout(() => synthesizeAll({ ...one, provider: batch, voiceCfg: { model: "m1", voiceId: "v1" } }));
  const [row] = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([row.lineIds, row.model, row.voiceId, row.cost], [["a", "b"], "m1", "v1", 0.02], "one batch request, the provider's cost summed");

  fs.rmSync(logFile);
  const failing = { async synth() { throw new Error("boom"); } };
  await assert.rejects(captureStdout(() => synthesizeAll({ ...one, provider: failing })), /boom/);
  assert.equal(fs.existsSync(logFile), false);
});

// --- carried from A2 -----------------------------------------------------------------------

test("A2 gap: groq progress carries `models`", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.wav"), "not a wav");
  const seen = [];
  const fetch = async () => ({ ok: true, json: async () => ({ text: "hi", words: [{ word: "hi", start: 0, end: 0.2 }] }) });
  const res = await sttTranscribe(dir, [{ id: "a", wav: "a.wav", text: "hi" }], "en", { env: { SVA_STT_ENGINE: "groq", GROQ_API_KEY: "k" }, fetch, onProgress: (p) => seen.push(p.models && p.models.get("a")) });
  assert.deepEqual(seen, ["groq:whisper-large-v3-turbo"]);
  assert.equal(res.models.get("a"), "groq:whisper-large-v3-turbo");
});

test("A2 gap: an oversize line is measured on the sent text and refused by typecast, fish and elevenlabs before any request", async () => {
  const item = (n) => [{ id: "big", text: "x".repeat(n), outPath: path.join(os.tmpdir(), "never.wav") }];
  await assert.rejects(typecast.synthBatch(item(2000), { voiceCfg: {} }), /typecast: line "big" is 2001 characters as sent/);
  await assert.rejects(fish.synthBatch(item(2500), { voiceCfg: {} }), /fish: line "big" is 2501 characters as sent/);
  await assert.rejects(elevenlabs.synthBatch(item(2492), { voiceCfg: {} }), /elevenlabs: line "big" is 2493 characters as sent/);
});

test("A2 gap: a full voice run deletes voice/stt-pending.json, a --lines run keeps it", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "en-US", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "a", text: "one two three" }, { id: "b", text: "four" }] }));
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt"]));
  const pending = path.join(paths.voiceDir, "stt-pending.json");
  fs.writeFileSync(pending, JSON.stringify({ ids: ["a"] }));
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt", "--lines", "a"]));
  assert.ok(fs.existsSync(pending), "a partial run leaves the resume file");
  await captureStdout(() => main([dir, "--provider", "none", "--no-stt"]));
  assert.equal(fs.existsSync(pending), false);
});

test("A2 gap: an apostrophe that touches a letter stays; a single quote goes only around a quoted span", () => {
  const cases = [
    ["the dogs' bones and rock 'n' roll", "the dogs' bones and rock 'n' roll"],
    ["She said 'ship it' today", "She said ship it today"],
    ["it's the dogs' bowls", "it's the dogs' bowls"],
    ["‘quoted’ and ’tis", "quoted and ’tis"],
    ["a ' b", "a b"],
    ["He said \"hi\" and 'go home.'", "He said hi and go home."],
  ];
  for (const [text, want] of cases) assert.equal(stripQuoteMarks(text), want, text);
});
