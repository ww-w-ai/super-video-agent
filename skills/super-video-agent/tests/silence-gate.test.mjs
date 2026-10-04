// The silence gate (scripts/lib/silence-gate.mjs): a pause over 1 s between
// voiced audio is reported with the line ids around it; a pause the plan asks
// for is planned, not a failure — in the voice stage and in review.mjs alike.
// Synthetic PCM only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gapsFromPcm, classifyGaps, formatSilenceReport, pictureGapPlan } from "../scripts/lib/silence-gate.mjs";
import { silenceGaps } from "../scripts/lib/audio-analysis.mjs";
import { narrationSilenceCheck } from "../scripts/review.mjs";
import { synthesizeAll } from "../scripts/voice.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";

const SR = 16000;

function tones(totalSec, spans, amp = 0.5) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const [from, to] of spans) {
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) out[i] = amp * Math.sin((2 * Math.PI * 300 * i) / SR);
  }
  return out;
}

const LINES = [
  { id: "a", start: 0.4, end: 0.9 },
  { id: "b", start: 3.37, end: 3.87 },
];
// 2.47 s of silence between line a and line b (the Russian dub's longest voice gap).
const LONG_GAP = tones(4.3, [[0.4, 0.9], [3.37, 3.87]]);

test("silenceGaps: leading and trailing silence are not gaps; only silence between voiced audio is", () => {
  const gaps = silenceGaps(LONG_GAP, SR, { minSec: 1 });
  assert.equal(gaps.length, 1);
  assert.ok(Math.abs(gaps[0].durationSec - 2.47) < 0.03, `gap ${gaps[0].durationSec}`);
});

test("gate: a gap over 1 s is reported with the line ids around it, and the text says WARN", () => {
  const report = gapsFromPcm(LONG_GAP, SR, LINES, []);
  assert.equal(report.unplanned.length, 1);
  assert.equal(report.planned.length, 0);
  assert.equal(report.unplanned[0].afterId, "a");
  assert.equal(report.unplanned[0].beforeId, "b");
  const text = formatSilenceReport(report);
  assert.match(text, /^WARN: 1 silence gap\(s\) over 1 s/);
  assert.match(text, /between line "a" and "b"/);
});

test("gate: a 0.9 s pause is under the gate and is not listed", () => {
  const samples = tones(3, [[0.2, 0.7], [1.6, 2.1]]);
  const report = gapsFromPcm(samples, SR, [{ id: "a", start: 0.2, end: 0.7 }, { id: "b", start: 1.6, end: 2.1 }], []);
  assert.equal(report.unplanned.length + report.planned.length, 0);
  assert.match(formatSilenceReport(report), /no unplanned gap/);
});

test("gate: a pause the plan asks for (pauseAfterMs) is planned, not a failure", () => {
  // the iPhone long-form's intended 2.74 s pause
  const samples = tones(5, [[0.2, 0.7], [3.64, 4.14]]);
  const lines = [{ id: "a", start: 0.2, end: 0.7 }, { id: "b", start: 3.64, end: 4.14 }];
  const planned = gapsFromPcm(samples, SR, lines, [{ id: "a", pauseAfterMs: 2740 }, { id: "b" }]);
  assert.equal(planned.unplanned.length, 0);
  assert.equal(planned.planned.length, 1);
  assert.match(formatSilenceReport(planned), /planned pause/);
  // the same audio with no pauseAfterMs is a failure
  assert.equal(gapsFromPcm(samples, SR, lines, [{ id: "a" }, { id: "b" }]).unplanned.length, 1);
});

test("gate: a pause longer than the plan asked for still fails", () => {
  const report = gapsFromPcm(LONG_GAP, SR, LINES, [{ id: "a", pauseAfterMs: 1000 }]);
  assert.equal(report.unplanned.length, 1);
});

test("gate: a long meta.gapMs makes the pause after every line planned", () => {
  const report = gapsFromPcm(LONG_GAP, SR, LINES, [], { gapMs: 2400 });
  assert.equal(report.unplanned.length, 0);
  assert.equal(report.planned.length, 1);
});

test("gate: a pause inside one line is never planned", () => {
  const samples = tones(5, [[0.2, 0.7], [3.0, 3.5]]);
  const report = classifyGaps(silenceGaps(samples, SR, { minSec: 1 }), [{ id: "a", start: 0.2, end: 3.5 }], [{ id: "a", pauseAfterMs: 5000 }]);
  assert.equal(report.unplanned.length, 1);
  assert.equal(report.unplanned[0].inside, true);
});

test("pictureGapPlan: the picture's own pause over the gate is intended; shorter ones are not", () => {
  const plan = pictureGapPlan([
    { id: "a", start: 0, end: 1 },
    { id: "b", start: 3, end: 4 },
    { id: "c", start: 4.5, end: 5 },
  ]);
  assert.deepEqual(plan.map((p) => p.pauseAfterMs), [2000, 0, 0]);
});

test("review.mjs: the same exemption — an unplanned gap fails the audio check, a planned one passes", () => {
  const samples = tones(5, [[0.2, 0.7], [3.64, 4.14]]);
  const timingsLines = [{ id: "a", start: 0.2, end: 0.7 }, { id: "b", start: 3.64, end: 4.14 }];
  const withPlan = narrationSilenceCheck({ pcm: samples, sampleRate: SR, timingsLines, plan: { meta: {}, lines: [{ id: "a", pauseAfterMs: 2740 }, { id: "b" }] } });
  assert.equal(withPlan.silenceGaps.unplanned.length, 0);
  assert.equal(withPlan.silenceGaps.planned.length, 1);
  assert.ok(withPlan.silence.longestSilenceSec > 2.7, "the longest silence is still measured");
  const without = narrationSilenceCheck({ pcm: samples, sampleRate: SR, timingsLines, plan: null });
  assert.equal(without.silenceGaps.unplanned.length, 1);
  assert.equal(without.silenceGaps.unplanned[0].afterId, "a");
});

// --- voice stage: edge trim + gate, end to end through synthesizeAll ---------

const SR48 = 48000;

/** A clip with `lead` s of dead air, `tone` s of voice, `tail` s of dead air. */
function deadAirClip(lead, tone, tail) {
  const out = new Float32Array(Math.round((lead + tone + tail) * SR48));
  for (let i = Math.round(lead * SR48); i < Math.round((lead + tone) * SR48); i++) out[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / SR48);
  return out;
}

test("voice stage: lines are trimmed to the voiced span (0.05 s head, 0.3 s tail), the raw clip is kept, a planned pause is listed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-gate-"));
  try {
    const paths = reelPaths(dir);
    const provider = {
      async synth(args) {
        fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
        writeWavPCM16(args.outPath, [deadAirClip(0.4, 0.6, 0.5)], SR48);
        return { wavPath: args.outPath };
      },
    };
    const lines = [{ id: "l1", text: "one", pauseAfterMs: 2000 }, { id: "l2", text: "two" }, { id: "l3", text: "three" }];
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s, ...rest) => (out.push(String(s)), true);
    let result;
    try {
      result = await synthesizeAll({ dir, paths, provider, providerName: "none", voiceCfg: { levelLines: false }, lang: "en-US", gapMs: 250, sttEnabled: false, lines });
    } finally {
      process.stdout.write = orig;
    }
    const clip = await decodeMonoPcm(path.join(paths.voiceDir, "line-l1.wav"), SR48);
    assert.ok(Math.abs(clip.length / SR48 - 0.95) < 0.03, `trimmed clip ${clip.length / SR48}s (voiced 0.6 + 0.05 + 0.3)`);
    const raw = await decodeMonoPcm(path.join(paths.voiceDir, "raw", "l1.wav"), SR48);
    assert.ok(Math.abs(raw.length / SR48 - 1.5) < 0.01, "the untrimmed clip is kept once");
    assert.equal(result.silence.unplanned.length, 0, out.join(""));
    assert.equal(result.silence.planned.length, 1);
    assert.equal(result.silence.planned[0].afterId, "l1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("voice stage: dead air left in a clip's middle is reported with its line id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-gate-"));
  try {
    const paths = reelPaths(dir);
    const provider = {
      async synth(args) {
        fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
        const a = deadAirClip(0, 0.5, 1.6);
        const b = deadAirClip(0, 0.5, 0);
        const both = new Float32Array(a.length + b.length);
        both.set(a);
        both.set(b, a.length);
        writeWavPCM16(args.outPath, [both], SR48);
        return { wavPath: args.outPath };
      },
    };
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => (out.push(String(s)), true);
    let result;
    try {
      result = await synthesizeAll({ dir, paths, provider, providerName: "none", voiceCfg: { levelLines: false }, lang: "en-US", gapMs: 250, sttEnabled: false, lines: [{ id: "x", text: "one" }] });
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(result.silence.unplanned.length, 1);
    assert.equal(result.silence.unplanned[0].inside, true);
    assert.equal(result.silence.unplanned[0].afterId, "x");
    assert.match(out.join(""), /WARN: 1 silence gap\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
