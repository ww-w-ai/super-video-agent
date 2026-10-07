// FIX15: line edges (decay cut, fades, waveform gate), cue fades, dub lead placement, --stt-only word times,
// raw take provenance, exact slot length on --pick, packet-copy joins, pinned effect variants.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cutSpans, cutLineSamples, decayEnd, withQuietTail, fadeIn } from "../scripts/lib/line-split.mjs";
import { kWeight, levelLufs, lineLoudness, audibleFloorLufs, edgeAudibility } from "../scripts/lib/perceived-level.mjs";
import { findClipDefects, describeDefects, waveformFlag } from "../scripts/voice/take-check.mjs";
import { edgeFadeArgs } from "../scripts/lib/clip-trim.mjs";
import { resolveCueFades, buildCueMixFilter, CUT_FADE_OUT_SEC } from "../scripts/lib/audio-mix.mjs";
import { cueFadeFields } from "../scripts/lib/cues.mjs";
import { fitAllLines } from "../scripts/lib/dub-timing.mjs";
import { shiftForTrim } from "../scripts/lib/fit-track.mjs";
import { fitTrack } from "../scripts/fit-track.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";
import { sttOnlyWords, fitRetake, slotLengthFilters, synthesizeAll, keepsRetake, main } from "../scripts/voice.mjs";
import { rawTakeStatus, rawTakeProblems, rawTakeWarning, stageRawTake, commitRawTake, discardRawTake, fingerprintFile } from "../scripts/lib/raw-take.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { readWav } from "../scripts/lib/wav-read.mjs";
import { ffmpeg, concatMp4 } from "../scripts/lib/ffmpeg.mjs";
import * as none from "../scripts/voice/none.mjs";

const SR = 48000;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p = "sva-fix15-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -200);
const peak = (a, from, to) => a.slice(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Samples of `totalSec`: a 220 Hz tone at `amp` over [from, to), then an exponential decay of `decaySec` to -90 dB. */
function voice(totalSec, spans, attackSec = 0.03) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const { from, to, amp = 0.5, decaySec = 0 } of spans) {
    for (let i = Math.round(from * SR); i < Math.round((to + decaySec) * SR); i++) {
      const t = i / SR;
      const ramp = Math.min(1, (t - from) / (attackSec || 1e-9));
      const env = ramp * (t < to ? amp : amp * 10 ** ((-90 * (t - to)) / decaySec / 20));
      out[i] += env * Math.sin(2 * Math.PI * 220 * t);
    }
  }
  return out;
}

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (c, ...rest) => (typeof c === "string" ? ((out += c), true) : orig(c, ...rest));
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

// --- 11: the line cut -----------------------------------------------------------------------

test("11: cutSpans: a clip may run to 20 ms before the next line's speech, and never starts before the previous spoken end", () => {
  const spans = cutSpans([{ start: 0.2, end: 1.0 }, { start: 1.6, end: 2.4 }], 3.0);
  assert.ok(Math.abs(spans[0].from - 0.1) < 1e-9);
  assert.ok(Math.abs(spans[0].to - 1.58) < 1e-9);
  assert.ok(Math.abs(spans[1].from - 1.5) < 1e-9);
  assert.equal(spans[1].to, 3.0);
  const tight = cutSpans([{ start: 0.2, end: 1.0 }, { start: 1.05, end: 2.0 }], 3.0);
  assert.ok(tight[1].from >= 1.0, "the next clip starts no earlier than the previous spoken end");
  const wide = cutSpans([{ start: 0.5, end: 1.0 }, { start: 2.0, end: 3.0 }], 4.0, { headKeepSec: 0.3, guardSec: 0.1 });
  assert.ok(Math.abs(wide[0].from - 0.2) < 1e-9 && Math.abs(wide[0].to - 1.9) < 1e-9, "the margins are options");
});

test("11: decayEnd: the first point after the speech where the perceived level stays under the audible floor", () => {
  const clip = voice(2, [{ from: 0.1, to: 1.0, decaySec: 0.2 }]);
  const weighted = kWeight(clip, SR);
  const floor = audibleFloorLufs(lineLoudness(weighted, SR, 0, SR));
  const end = decayEnd(weighted, SR, Math.round(1.0 * SR), floor) / SR;
  assert.ok(end > 1.05 && end < 1.15, `end ${end}`);
  assert.ok(levelLufs(weighted, Math.round(end * SR) + 480, weighted.length) < floor, "nothing audible after the cut");
  const sustained = kWeight(voice(2, [{ from: 0.1, to: 2 }]), SR);
  assert.equal(decayEnd(sustained, SR, Math.round(1.0 * SR), floor), sustained.length, "never settles");
});

test("11: withQuietTail cuts late: the decay and 0.2 s of room after the last word, a gentle fade, then exactly the quiet tail", () => {
  const clip = voice(2, [{ from: 0.1, to: 1.0, decaySec: 0.25 }]);
  const speechEnd = Math.round(1.0 * SR);
  const cut = withQuietTail(clip, SR, 0.3, speechEnd);
  assert.ok(cut.kept >= Math.round(1.2 * SR) && cut.kept <= Math.round(1.4 * SR), `kept to ${cut.kept / SR} s: the decay and 0.2 s of room`);
  assert.equal(cut.samples.length, cut.kept + Math.round(0.3 * SR));
  assert.ok(cut.samples[cut.kept - 1] === 0, "the last kept sample is the end of the fade-out");
  assert.ok(peak(cut.samples, cut.kept, cut.samples.length) === 0);
  const wider = withQuietTail(clip, SR, 0.3, speechEnd, { minTailSec: 0.5, maxTailSec: 0.45 });
  assert.ok(Math.abs(wider.kept - cut.kept - Math.round(0.25 * SR)) <= 480, "the longest tail wins over the shortest, both are options");
});

test("11: cutLineSamples: line 1 keeps its decay and room; line 2 never begins with line 1's tail; both edges are quiet", () => {
  // line 1 speaks 0.1-1.0 and decays to 1.25 s; line 2 speaks from 1.3 s. The engine's end for line 1 is 1.0.
  const request = voice(3, [{ from: 0.1, to: 1.0, decaySec: 0.25 }, { from: 1.3, to: 2.2, decaySec: 0.2 }]);
  const edges = [{ start: 0.1, end: 1.0 }, { start: 1.3, end: 2.2 }];
  const [a, b] = cutLineSamples(request, SR, { edges, spans: cutSpans(edges, 3) });
  assert.ok(a.samples.length >= Math.round((1.19 - a.from) * SR + 0.3 * SR), "line 1 keeps its decay and 0.2 s after the last word");
  assert.ok(db(peak(a.samples, a.samples.length - Math.round(0.005 * SR), a.samples.length)) < -60, "line 1 ends quiet");
  assert.ok(db(peak(b.samples, 0, Math.round(0.005 * SR))) < -60, "line 2 starts quiet");
  assert.ok(b.from >= a.from + (a.samples.length - Math.round(0.3 * SR)) / SR - 1e-6, "line 2 starts where line 1's clip stopped, or later");
});

test("11: cutLineSamples: a tight gap stops the clip 20 ms before the next word, with a fade, and the next clip starts there", () => {
  // line 1 is still sounding at 1.29 s; line 2 starts at 1.3 s: the cut falls at 1.28 s.
  const request = voice(3, [{ from: 0.1, to: 1.29 }, { from: 1.3, to: 2.2, decaySec: 0.2 }]);
  const edges = [{ start: 0.1, end: 1.0 }, { start: 1.3, end: 2.2 }];
  const [a, b] = cutLineSamples(request, SR, { edges, spans: cutSpans(edges, 3) });
  const kept = a.samples.length - Math.round(0.3 * SR);
  assert.ok(Math.abs(a.from + kept / SR - 1.28) < 0.002, `line 1 stops at 1.28 s, kept to ${a.from + kept / SR}`);
  assert.ok(peak(a.samples, kept - Math.round(0.001 * SR), kept) < 0.02, "the cut is the end of a 30 ms fade");
  assert.ok(Math.abs(b.from - (a.from + kept / SR)) < 0.002, "line 2 starts where line 1 stopped");
});

test("11: fadeIn brings the first sample to zero and rises over the fade", () => {
  const x = Float32Array.from({ length: 4800 }, () => 0.5);
  fadeIn(x, SR);
  assert.equal(x[0], 0);
  assert.ok(x[479] > 0.2 && x[479] < 0.3, "half way up after 10 ms of a 20 ms fade");
  assert.equal(x[4799], 0.5);
});

test("11: perceived level: K-weighting follows BS.1770 (a 1 kHz tone at -20 dBFS peak reads -23.7 LUFS; 30 Hz is far under)", () => {
  const tone = (hz) => Float32Array.from({ length: SR }, (_, i) => 0.1 * Math.sin((2 * Math.PI * hz * i) / SR));
  const at1k = levelLufs(kWeight(tone(1000), SR), SR / 2, SR);
  assert.ok(Math.abs(at1k - (-0.691 + 10 * Math.log10(0.005) + 0.7)) < 0.3, `1 kHz ${at1k}`);
  assert.ok(levelLufs(kWeight(tone(30), SR), SR / 2, SR) < at1k - 6, "low frequencies count for much less");
});

test("11: edge gate by perceived level: a line that stops at its own loudness is TAIL, a natural release and a quiet room are not", () => {
  const natural = voice(1.6, [{ from: 0.05, to: 1.0, decaySec: 0.3 }]);
  assert.equal(waveformFlag(findClipDefects(natural, SR)), null, "a clean clip passes");

  const cutEnd = voice(1.6, [{ from: 0.05, to: 1.0 }]);
  const cutFacts = findClipDefects(cutEnd, SR);
  assert.equal(cutFacts.edges.tail.cut, true);
  assert.equal(waveformFlag(cutFacts), "TAIL");
  assert.match(describeDefects(cutFacts).join(" "), /TAIL cut \(the sound stops/);

  const withMurmur = voice(1.6, [{ from: 0.05, to: 1.0, decaySec: 0.3 }, { from: 0, to: 1.6, amp: 0.001 }]);
  assert.equal(waveformFlag(findClipDefects(withMurmur, SR)), null, "a room tone 54 dB under the line is not heard");
});

test("11: edge gate: sound already audible at the start is HEAD (a cut start, or the previous line's end); a soft start is not", () => {
  const cutStart = voice(1.6, [{ from: 0, to: 1.0, decaySec: 0.3 }], 0);
  const facts = findClipDefects(cutStart, SR);
  assert.equal(facts.edges.head.abrupt, true);
  assert.equal(waveformFlag(facts), "HEAD");
  assert.match(describeDefects(facts).join(" "), /HEAD cut \(sound/);
  const leftover = voice(2, [{ from: 0, to: 0.1 }, { from: 0.4, to: 1.5, decaySec: 0.3 }], 0.02);
  assert.equal(waveformFlag(findClipDefects(leftover, SR)), "HEAD");
  const soft = voice(1.6, [{ from: 0.06, to: 1.0, decaySec: 0.3 }]);
  assert.equal(waveformFlag(findClipDefects(soft, SR)), null);
});

test("11: a bed under the clip raises the floor: the same cut is not audible where a loud mix masks it", () => {
  const cutEnd = voice(1.6, [{ from: 0.05, to: 1.0 }]);
  assert.equal(edgeAudibility(cutEnd, SR).tail.cut, true);
  assert.equal(edgeAudibility(cutEnd, SR, { tailMaskLufs: -5 }).tail.cut, false, "a bed at -5 LUFS hides everything under it");
});

test("11: no STT result clears a waveform flag; a retake that adds one is not kept", () => {
  assert.equal(keepsRetake({ newCer: 0, oldCer: 0.1, oldFlag: null, newFlag: "TAIL" }), false);
  assert.equal(keepsRetake({ newCer: 0.1, oldCer: 0.1, oldFlag: "TAIL", newFlag: null }), true);
  assert.equal(keepsRetake({ newCer: 0.2, oldCer: 0.1, oldFlag: "TAIL", newFlag: null }), false);
  assert.equal(keepsRetake({ newCer: 0.05, oldCer: 0.1, oldFlag: null, newFlag: null }), true);
});

test("11: a made line with a cut end gets voiceFlag TAIL and a WARN, whatever the transcript says", async () => {
  const dir = tmp();
  try {
    const paths = reelPaths(dir);
    const provider = {
      async synth(args) {
        fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
        writeWavPCM16(args.outPath, [voice(1.5, [{ from: 0.2, to: 1.5 }])], SR);
        return { wavPath: args.outPath };
      },
    };
    let result;
    const out = await captureStdout(async () => {
      result = await synthesizeAll({ dir, paths, provider, providerName: "none", voiceCfg: { levelLines: false }, lang: "en-US", gapMs: 250, sttEnabled: false, lines: [{ id: "l1", text: "one" }] });
    });
    assert.equal(result.timings.lines[0].voiceFlag, "TAIL");
    assert.match(out, /WARN line "l1": TAIL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("11: trimmed clips get a 20 ms fade-in and a 30 ms fade-out", () => {
  assert.deepEqual(edgeFadeArgs(0.04), []);
  assert.deepEqual(edgeFadeArgs(1), ["-af", "afade=t=in:st=0:d=0.02,afade=t=out:st=0.970000:d=0.03"]);
});

// --- 12: cue fades -------------------------------------------------------------------------

test("12: resolveCueFades: short default, 0.6 s when the cue ends at a cut (at most half the cue), explicit values win", () => {
  const f = resolveCueFades([
    { trimSec: 5, atSec: 0 },
    { trimSec: 5, atSec: 10, endsAtCut: true },
    { trimSec: 0.5, atSec: 20, endsAtCut: true },
    { trimSec: 5, atSec: 30, endsAtCut: true, fadeOutSec: 1.5, fadeInSec: 0.15 },
  ]);
  assert.deepEqual(f[0], { trimSec: 5, fadeInSec: 0, fadeOutSec: 0.03 });
  assert.equal(f[1].fadeOutSec, CUT_FADE_OUT_SEC);
  assert.equal(f[2].fadeOutSec, 0.25);
  assert.deepEqual(f[3], { trimSec: 5, fadeInSec: 0.15, fadeOutSec: 1.5 });
});

test("12: resolveCueFades: crossfade with the next cue on the same track; other tracks and far cues do not", () => {
  const f = resolveCueFades([
    { trimSec: 2, atSec: 0, track: "m", crossfadeSec: 0.2 },
    { trimSec: 3, atSec: 2, track: "m" },
    { trimSec: 2, atSec: 10, track: "x", crossfadeSec: 0.2 },
    { trimSec: 2, atSec: 12, track: "y" },
    { trimSec: 2, atSec: 20, track: "m", crossfadeSec: 0.2 },
    { trimSec: 2, atSec: 30, track: "m" },
  ]);
  assert.ok(Math.abs(f[0].trimSec - 2.2) < 1e-9, "runs 0.2 s past the next cue's start");
  assert.equal(f[0].fadeOutSec, 0.2);
  assert.equal(f[1].fadeInSec, 0.2);
  assert.equal(f[2].fadeOutSec, 0.03, "another track: no crossfade");
  assert.equal(f[3].fadeInSec, 0);
  assert.equal(f[4].trimSec, 2, "the next cue starts long after this one ends: a plain fade-out");
  assert.equal(f[5].fadeInSec, 0);
});

test("12: buildCueMixFilter: the level is applied before the fades, the fade-in and the crossfade tail are in the graph", () => {
  const { filterComplex } = buildCueMixFilter({
    narrationIndex: 0,
    hasSfx: false,
    cues: [
      { trimSec: 2, peakDb: -12, atSec: 0, track: "m", crossfadeSec: 0.2 },
      { trimSec: 3, peakDb: -3, atSec: 2, track: "m" },
    ],
  });
  const cue0 = /\[1:a\]([^;]*)\[cue0\]/.exec(filterComplex)[1];
  assert.match(cue0, /^atrim=0:2\.2,.*volume=6dB,afade=t=out:st=2:d=0\.2,adelay=0/);
  const cue1 = /\[2:a\]([^;]*)\[cue1\]/.exec(filterComplex)[1];
  assert.match(cue1, /volume=-3dB,afade=t=in:st=0:d=0\.2,afade=t=out:st=2\.97:d=0\.03/);
});

test("12: fade fields pass from a plan cue through cues.json to the mix; fields a cue leaves out stay out", () => {
  assert.deepEqual(cueFadeFields({ asset: "a", fadeOutSec: 0.6, track: "m", maxSec: 3 }), { fadeOutSec: 0.6, track: "m" });
  assert.deepEqual(cueFadeFields({ asset: "a" }), {});
});

// --- 13: dub placement keeps the lead ------------------------------------------------------

test("13: fitAllLines places the trimmed clip after the slot start by its trimmed lead; words follow the clip", () => {
  const base = [{ id: "l1", start: 0, end: 1.0 }, { id: "l2", start: 1.0, end: 2.0 }];
  const voiceLines = [{ id: "l1", text: "a", start: 0, end: 0.7, words: [{ w: "a", start: 0.15, end: 0.4 }] }, { id: "l2", text: "b", start: 1.0, end: 1.6, words: [] }];
  const trims = new Map([["l1", { leadTrimSec: 0.05 }]]);
  const shifted = shiftForTrim(voiceLines, trims);
  assert.equal(shifted[0].leadTrimSec, 0.05);
  const fit = fitAllLines(base, shifted, new Map([["l1", 0.4], ["l2", 0.6]]), 2.0);
  const l1 = fit.lines[0];
  assert.ok(Math.abs(l1.start - 0.05) < 1e-9, "the trimmed clip starts its lead after the slot start");
  assert.ok(Math.abs(l1.end - 0.45) < 1e-9);
  assert.ok(Math.abs(l1.words[0].start - 0.15) < 1e-9, "the word sits where the voice's own timings put it");
  assert.equal(fit.lines[1].start, 1.0, "no trimmed lead: nothing moves");
});

test("13: the lead is never more than the room left in the slot", () => {
  const base = [{ id: "l1", start: 0, end: 1.0 }];
  const fit = fitAllLines(base, [{ id: "l1", text: "a", start: 0.4, end: 1, leadTrimSec: 0.4, words: [] }], new Map([["l1", 1.0]]), 1.0);
  const line = fit.lines[0];
  assert.ok(line.start > 0 && line.start < 0.4 / 1.1, "cut down to the room the slot has left");
  assert.ok(Math.abs(line.end - 1.0) < 1e-9, "the line ends with its slot, not past it");
});

test("13: the track puts a line's first sound where the voice's own timings put it, not early by the trimmed lead", async () => {
  const dir = tmp();
  try {
    const voiceDir = path.join(dir, "voice");
    fs.mkdirSync(voiceDir);
    const clip = new Float32Array(Math.round(1.6 * SR));
    for (let i = Math.round(0.3 * SR); i < Math.round(1.1 * SR); i++) clip[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / SR);
    writeWavPCM16(path.join(voiceDir, "line-a.wav"), [clip], SR);
    fs.writeFileSync(path.join(voiceDir, "timings.json"), JSON.stringify({ duration: 4, lines: [{ id: "a", text: "a", start: 0, end: 1.6, words: [] }] }));
    const picture = path.join(dir, "picture.timings.json");
    fs.writeFileSync(picture, JSON.stringify({ duration: 4, lines: [{ id: "a", start: 0, end: 1.5 }] }));
    await captureStdout(async () => {
      await fitTrack({ timingsPath: picture, voiceDir, outPath: path.join(dir, "track.wav") });
    });
    const pcm = await decodeMonoPcm(path.join(dir, "track.wav"), SR);
    const onset = pcm.findIndex((v) => Math.abs(v) > 0.05) / SR;
    assert.ok(Math.abs(onset - 0.3) < 0.02, `first sound at ${onset} s (the clip's own 0.3 s lead)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 14: --stt-only word times ---------------------------------------------------------------

test("14: --stt-only takes speech-to-text word times only for a line whose words were never measured", () => {
  const stt = [{ w: "a", start: 0.1, end: 0.2 }];
  assert.equal(sttOnlyWords({ wordsMeasured: 3 }, false, stt), null);
  assert.equal(sttOnlyWords({ wordsMeasured: 0 }, true, stt), null);
  assert.equal(sttOnlyWords({ wordsMeasured: 0 }, false, stt), stt);
  assert.equal(sttOnlyWords({}, false, undefined), null);
});

// --- 15: raw take provenance -----------------------------------------------------------------

test("15: a staged raw take replaces voice/raw only when committed; status says current, stale, missing or unrecorded", () => {
  const dir = tmp();
  try {
    const wav = path.join(dir, "take.wav");
    writeWavPCM16(wav, [voice(0.3, [{ from: 0, to: 0.3 }])], SR);
    const first = stageRawTake(dir, "a", wav, "synth");
    commitRawTake(first);
    const line = { id: "a", rawTake: first.record };
    assert.equal(rawTakeStatus(dir, line), "current");
    assert.equal(rawTakeStatus(dir, { id: "a" }), "unrecorded");
    assert.equal(rawTakeStatus(dir, { id: "zz" }), "missing");

    writeWavPCM16(wav, [voice(0.4, [{ from: 0, to: 0.4 }])], SR);
    const second = stageRawTake(dir, "a", wav, "takes/a-2.wav");
    assert.equal(rawTakeStatus(dir, line), "current", "staged only: the raw file is untouched");
    discardRawTake(second);
    assert.equal(fs.existsSync(second.stagedPath), false);
    const third = stageRawTake(dir, "a", wav, "takes/a-2.wav");
    commitRawTake(third);
    assert.equal(rawTakeStatus(dir, line), "stale", "the record of the earlier take no longer matches");
    assert.equal(rawTakeStatus(dir, { id: "a", rawTake: third.record }), "current");
    assert.deepEqual(rawTakeProblems(dir, [line, { id: "a", rawTake: third.record }]), [{ id: "a", status: "stale" }]);
    assert.match(rawTakeWarning([{ id: "a", status: "stale" }]), /do not rebuild these lines from voice\/raw.*stale|not the one the clip was made from: a/);
    assert.equal(rawTakeWarning([]), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const RAW_BASE = { providerName: "none", voiceCfg: {}, lang: "ko-KR", gapMs: 250, sttEnabled: false };
const RAW_LINES = [{ id: "a", text: "가나다라마바사아자차카타파하" }, { id: "b", text: "다음 줄" }, { id: "c", text: "마지막 줄" }];

test("15: voice.mjs records each clip's raw take; a re-made line replaces its raw take and record; a refused take keeps both", async () => {
  const dir = tmp();
  try {
    const paths = reelPaths(dir);
    const args = { ...RAW_BASE, dir, paths, provider: none };
    let first;
    await captureStdout(async () => {
      first = await synthesizeAll({ ...args, lines: RAW_LINES });
    });
    fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
    for (const l of first.timings.lines) {
      assert.equal(l.rawTake.sha256, fingerprintFile(path.join(paths.voiceDir, "raw", `${l.id}.wav`)).sha256);
      assert.equal(l.rawTake.source, "synth");
      assert.equal(rawTakeStatus(paths.voiceDir, l), "current");
    }
    let again;
    await captureStdout(async () => {
      again = await synthesizeAll({ ...args, lines: [{ ...RAW_LINES[0], text: "가나다라마바사아자차카타파하가나다" }, ...RAW_LINES.slice(1)], onlyLineIds: ["a"], keepTiming: false });
    });
    const byId = (r, id) => r.timings.lines.find((l) => l.id === id);
    assert.notEqual(byId(again, "a").rawTake.sha256, byId(first, "a").rawTake.sha256, "line a has a new raw take");
    assert.equal(byId(again, "b").rawTake.sha256, byId(first, "b").rawTake.sha256, "line b keeps its record");
    assert.equal(rawTakeStatus(paths.voiceDir, byId(again, "a")), "current");
    assert.equal(rawTakeStatus(paths.voiceDir, byId(first, "a")), "stale");
    fs.writeFileSync(paths.timingsJson, JSON.stringify(again.timings));
    const out = await captureStdout(async () => {
      try {
        await main([dir, "--raw-status"]);
      } finally {
        process.exitCode = 0;
      }
    });
    assert.match(out, /raw takes: 3 of 3 line\(s\) current/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 16: --pick keeps the slot length exactly -------------------------------------------------

test("16: a take fitted to a slot comes out with exactly the slot's sample count (longer or shorter by a few samples)", async () => {
  const slotSamples = 163654;
  const slot = { slotSec: 4, oldClipSec: slotSamples / SR };
  for (const delta of [2, -5, 0]) {
    const dir = tmp();
    try {
      const wav = path.join(dir, "line-p.wav");
      writeWavPCM16(wav, [new Float32Array(slotSamples + delta).fill(0.1)], SR);
      let res;
      await captureStdout(async () => {
        res = await fitRetake("p", wav, slot, { borrow: true });
      });
      assert.equal(res.ok, true);
      assert.equal(readWav(wav).samples.length, slotSamples, `delta ${delta}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(slotLengthFilters(10), ["apad=whole_len=10", "atrim=end_sample=10"]);
});

// --- 17: packet-copy joins --------------------------------------------------------------------

test("17: concatMp4 keeps every copied packet byte for byte (no parameter sets added to keyframes)", async () => {
  const dir = tmp();
  try {
    const mk = async (name, color) => {
      const p = path.join(dir, name);
      await ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=30:d=2`, "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", p]);
      return p;
    };
    const a = await mk("a.mp4", "red");
    const b = await mk("b.mp4", "blue");
    const out = path.join(dir, "out.mp4");
    await concatMp4([a, b], out, 30);
    const sizes = (f) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size", "-of", "csv=p=0", f]).stdout.toString().trim().split("\n").map(Number);
    assert.deepEqual(sizes(out), [...sizes(a), ...sizes(b)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 18: a changed effect keeps the others' sounds ---------------------------------------------

await import(path.join(here, "..", "scripts", "engine", "reel-audio.js"));
const RA = globalThis.ReelAudio;

test("18: a pinned cue takes the place of the variant it replaces: every other cue keeps its sound", () => {
  const pools = {
    thud: [{ gen: "thud" }, { gen: "thud", rate: 0.9 }, { gen: "thud", rate: 1.1 }],
    click: [{ gen: "click" }, { gen: "click", rate: 1.2 }],
  };
  const cues = () => Array.from({ length: 14 }, (_, i) => ({ kind: "thud", at: i * 0.5 }));
  const before = RA.sfxPool(pools, { seed: "film" }).assign(cues());
  const changed = cues();
  const idx = 5;
  changed[idx] = { kind: "click", at: idx * 0.5, pin: { variant: 1, holds: before[idx].variant, holdsKind: "thud" } };
  const after = RA.sfxPool(pools, { seed: "film" }).assign(changed);
  assert.equal(after[idx].sound, "click-1");
  before.forEach((c, i) => {
    if (i !== idx) assert.equal(after[i].sound, c.sound, `cue ${i} keeps its sound`);
  });
  const unpinned = cues();
  unpinned[idx] = { kind: "click", at: idx * 0.5 };
  const reshuffled = RA.sfxPool(pools, { seed: "film" }).assign(unpinned);
  assert.ok(before.some((c, i) => i !== idx && reshuffled[i].sound !== c.sound), "without the pin the later thuds change");
});
