// Sprint A7: bed duck swing + gentle defaults (8), silence/cut checks (29, 40),
// one-clip filter (N17), fit-track --draft (N12), termination guard, picture
// pair, neutral-span probe density. Local ffmpeg only; no network, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import {
  DUCK_DB_DEFAULT,
  DUCK_RAMP_SEC_DEFAULT,
  HOLD_GAP_SEC,
  mergeDuckWindows,
  measureDuckSwing,
  formatDuckSwingReport,
} from "../scripts/lib/duck.mjs";
import { findWaveformCuts, formatCutReport } from "../scripts/lib/audio-analysis.mjs";
import { buildNarrationFilter, trackSamples, buildNarrationTrack, fitDraft } from "../scripts/lib/fit-track.mjs";
import { fitAllLines } from "../scripts/lib/dub-timing.mjs";
import { fitTrack } from "../scripts/fit-track.mjs";
import { planCaptionSpans } from "../scripts/lib/dub-timing.mjs";
import { createTerminationGuard, uniqueTempPath, probeFramesOf, settleSharedSpans, dub } from "../scripts/dub.mjs";

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sva-a7-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- 8: bed duck ---------------------------------------------------------

test("8 duck defaults are the gentle owner-approved ones: -2.5 dB, 0.8 s ramps, gaps under 1.5 s merge", () => {
  assert.equal(DUCK_DB_DEFAULT, -2.5);
  assert.equal(DUCK_RAMP_SEC_DEFAULT, 0.8);
  assert.equal(HOLD_GAP_SEC, 1.5);
  assert.deepEqual(mergeDuckWindows([{ start: 0, end: 1 }, { start: 2.4, end: 3 }]), [{ start: 0, end: 3 }]);
  assert.equal(mergeDuckWindows([{ start: 0, end: 1 }, { start: 2.5, end: 3 }]).length, 2);
});

test("8 measureDuckSwing: the page duck and the dub duck on the same lines sum; with no dub windows only the page duck remains", () => {
  const windows = [{ start: 2, end: 6 }];
  const stacked = measureDuckSwing({ pageWindows: windows, dubWindows: windows, durationSec: 10 });
  assert.ok(Math.abs(stacked.deepestDb - -12.5) < 0.05, `deepest ${stacked.deepestDb}`);
  assert.ok(stacked.stackedSec > 3, `stacked ${stacked.stackedSec}`);
  const pageOnly = measureDuckSwing({ pageWindows: windows, dubWindows: [], durationSec: 10 });
  assert.ok(Math.abs(pageOnly.deepestDb - -10) < 0.05);
  assert.equal(pageOnly.stackedSec, 0);
  assert.match(formatDuckSwingReport(stacked), /deepest combined drop -12\.5 dB/);
});

// ---- 40: waveform cut check ---------------------------------------------

const RATE = 48000;
const tone = (seconds, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * 300 * i) / RATE));
function place(total, parts) {
  const out = new Float32Array(Math.round(total * RATE));
  for (const [at, samples] of parts) out.set(samples, Math.round(at * RATE));
  return out;
}
const faded = (seconds) => {
  const s = tone(seconds);
  const n = Math.round(0.05 * RATE);
  for (let i = 0; i < n; i++) {
    s[i] *= i / n;
    s[s.length - 1 - i] *= i / n;
  }
  return s;
};

test("40 findWaveformCuts with spans: a line cut mid-voice is flagged at both edges, a faded line is not", () => {
  const samples = place(4, [[0.5, tone(1)], [2.5, faded(1)]]);
  const cuts = findWaveformCuts(samples, RATE, { spans: [{ id: "cut", start: 0.5, end: 1.5 }, { id: "ok", start: 2.5, end: 3.5 }] });
  assert.deepEqual(cuts.map((c) => [c.id, c.edge]), [["cut", "start"], ["cut", "end"]]);
  assert.match(formatCutReport(cuts), /WARN: 2 abrupt cut\(s\)[\s\S]*line "cut" end at 1\.50s/);
});

test("40 findWaveformCuts without spans: a 30 dB step at an audible level is a cut; a fade is not; silence is not judged", () => {
  const cuts = findWaveformCuts(place(4, [[1, tone(1)]]), RATE);
  assert.deepEqual(cuts.map((c) => c.edge), ["start", "end"]);
  assert.ok(Math.abs(cuts[0].atSec - 1) < 0.01 && Math.abs(cuts[1].atSec - 2) < 0.01);
  assert.deepEqual(findWaveformCuts(place(4, [[1, faded(1)]]), RATE), []);
  assert.deepEqual(findWaveformCuts(new Float32Array(RATE), RATE), []);
  assert.match(formatCutReport([]), /no abrupt start or end/);
});

// ---- N17: one-clip filter ------------------------------------------------

test("N17 buildNarrationFilter: one clip goes straight into apad (no empty filter name); two clips are mixed first", () => {
  const one = buildNarrationFilter([{ startSec: 0.5 }], 96000);
  assert.ok(!/\[ln0\],/.test(one), one);
  assert.ok(one.includes("[ln0]apad=whole_len=96000"), one);
  const two = buildNarrationFilter([{ startSec: 0 }, { startSec: 1 }], 96000);
  assert.ok(two.includes("amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=96000"), two);
});

test("N17 buildNarrationTrack with one clip runs in ffmpeg and has the exact length", async (t) => {
  const dir = tmp(t, "one");
  const clip = path.join(dir, "c.wav");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", clip]);
  const out = path.join(dir, "track.wav");
  const { samples } = await buildNarrationTrack({ clips: [{ path: clip, startSec: 0.5 }], durationSec: 2, outPath: out });
  assert.equal(samples, 96000);
  assert.equal(await trackSamples(out), 96000);
});

// ---- N12: --draft --------------------------------------------------------

const baseLines = [{ id: "a", text: "A", start: 0, end: 2 }, { id: "b", text: "B", start: 3, end: 5 }];
const voiceLines = [{ id: "a", text: "A", start: 0, end: 2, words: [] }, { id: "b", text: "B", start: 0, end: 4, words: [] }];

test("N12 fitDraft: a line over the speed limit is placed at the limit and marked; the other line is unchanged", () => {
  const clips = new Map([["a", 2.0], ["b", 3.9]]);
  assert.equal(fitAllLines(baseLines, voiceLines, clips, 6, 1.1).ok, false);
  const fit = fitDraft(baseLines, voiceLines, clips, 6, 1.1);
  assert.equal(fit.lines.length, 2);
  assert.equal(fit.lines.find((l) => l.id === "a").draft, undefined);
  const b = fit.lines.find((l) => l.id === "b");
  assert.equal(b.draft, true);
  assert.equal(b.atempoFactor, 1.1);
  assert.deepEqual(fit.overflow.map((o) => o.id), ["b"]);
  assert.ok(fit.overflow[0].requiredFactor > 1.1);
  assert.ok(Math.abs(b.end - (3 + 3.9 / 1.1)) < 1e-9);
  assert.throws(() => fitDraft(baseLines, voiceLines, new Map([["a", 2.0]]), 6, 1.1), /cannot be placed even as a draft/);
});

test("N12 fit-track --draft writes the track and lists the line; without it the same input throws", async (t) => {
  const dir = tmp(t, "draft");
  const voice = path.join(dir, "voice");
  fs.mkdirSync(voice);
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=48000:duration=3", path.join(voice, "line-a.wav")]);
  fs.writeFileSync(path.join(voice, "timings.json"), JSON.stringify({ duration: 3, lines: [{ id: "a", text: "A", start: 0, end: 3, words: [] }] }));
  const timings = path.join(dir, "picture.timings.json");
  fs.writeFileSync(timings, JSON.stringify({ duration: 2, lines: [{ id: "a", text: "A", start: 0, end: 2 }] }));
  const args = { timingsPath: timings, voiceDir: voice, outPath: path.join(dir, "track.wav") };
  await assert.rejects(fitTrack(args), /do not fit their slot/);
  const result = await fitTrack({ ...args, draft: true });
  assert.equal(result.samples, 96000);
  assert.equal(result.fit.overflow.length, 1);
  assert.equal(fs.existsSync(args.outPath), true);
});

// ---- SIGTERM -------------------------------------------------------------

test("SIGTERM guard: children are ended, this run's temp files are removed, the exit code is 128+n; uninstall drops the listeners", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a7-term-"));
  const work = path.join(dir, ".work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "x"), "1");
  const kept = path.join(dir, "keep.txt");
  fs.writeFileSync(kept, "1");
  const calls = [];
  const guard = createTerminationGuard({ temps: new Set([work]), kill: () => calls.push("kill"), exit: (c) => calls.push(`exit ${c}`), write: () => {} });
  guard.handle("SIGTERM");
  guard.handle("SIGINT");
  assert.deepEqual(calls, ["kill", "exit 143", "kill", "exit 130"]);
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.existsSync(kept), true);
  const before = process.listenerCount("SIGTERM");
  guard.install();
  assert.equal(process.listenerCount("SIGTERM"), before + 1);
  guard.uninstall();
  assert.equal(process.listenerCount("SIGTERM"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SIGTERM guard: a unique temp name made by this run is removed too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-a7-term2-"));
  const temp = uniqueTempPath(dir, "final-en", ".mp4");
  fs.writeFileSync(temp, "partial");
  createTerminationGuard({ kill: () => {}, exit: () => {}, write: () => {} }).handle("SIGTERM");
  assert.equal(fs.existsSync(temp), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- picture pair --------------------------------------------------------

test("A4 pair: dub refuses a picture whose timings are another length than the picture and bed", async (t) => {
  const dir = tmp(t, "pair");
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(out, "picture.mp4")]);
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=200:sample_rate=48000:duration=3", path.join(out, "picture.bed.wav")]);
  fs.writeFileSync(path.join(out, "picture.timings.json"), JSON.stringify({ duration: 5, lines: [{ id: "a", text: "A", start: 0, end: 1 }] }));
  await assert.rejects(dub({ dir, lang: "en" }), /not one render[\s\S]*timings duration is 5s/);
});

// ---- neutral-span probe --------------------------------------------------

test("probeFramesOf: every frame in a span under 10 s; at least every 0.25 s in a longer one; always the last frame", () => {
  const short = probeFramesOf({ startFrame: 10, endFrame: 60 }, 10);
  assert.equal(short.length, 50);
  const long = probeFramesOf({ startFrame: 0, endFrame: 300 }, 10);
  assert.ok(long.every((f, i) => i === 0 || (f - long[i - 1]) / 10 <= 0.25 + 1e-9));
  assert.equal(long.at(-1), 299);
});

test("a 0.5 s label inside a neutral span makes that span language-dependent (probe cannot skip it)", async (t) => {
  const dir = tmp(t, "probe");
  const make = async (name, filter) => {
    const file = path.join(dir, name);
    await ffmpeg(["-y", "-f", "lavfi", "-i", filter, "-frames:v", "1", file]);
    return fs.readFileSync(file);
  };
  const clear = await make("clear.png", "color=c=black@0.0:size=16x16,format=rgba");
  const dot = await make("dot.png", "color=c=black@0.0:size=16x16,format=rgba[a];color=c=red:size=4x4,format=rgba[b];[a][b]overlay=3:3:format=auto");
  // 10 fps, label on screen 2.5 s - 3.0 s (frames 25-29), well between the old 2 s probes
  const capture = async (_page, sec) => {
    const frame = Math.round(sec * 10);
    return frame >= 25 && frame <= 29 ? dot : clear;
  };
  const plan = planCaptionSpans({ lines: [{ start: 0, end: 1 }], duration: 6, fps: 10, lastLineHolds: false });
  assert.deepEqual(plan.spans.map((s) => s.kind), ["lang", "shared"]);
  const framesDir = path.join(dir, "frames");
  fs.mkdirSync(framesDir);
  const settled = await settleSharedSpans({ page: null, framesDir, plan, fps: 10, declaredCount: 0, capture });
  assert.equal(settled.sharedFrames, 0, "the span with the label is encoded per language");
  assert.equal(fs.existsSync(path.join(framesDir, fs.readdirSync(framesDir)[0])), true, "its frames were captured");
  const clean = await settleSharedSpans({ page: null, framesDir, plan, fps: 10, declaredCount: 0, capture: async () => clear });
  assert.equal(clean.sharedFrames, 50, "a span that draws nothing stays shared");
});
