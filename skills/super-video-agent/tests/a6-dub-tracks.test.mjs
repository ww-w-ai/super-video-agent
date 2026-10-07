// Sprint A6: shared language-neutral spans (N10), audio-only track + stale
// output guard (2), span audio splice (26), time insert (52). Local ffmpeg
// only; no network, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";
import { frameHashes } from "../scripts/render.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";
import { writeWavMono16 } from "../scripts/voice/line-edit.mjs";
import { spliceSpan } from "../scripts/lib/audio-edit.mjs";
import {
  planCaptionSpans,
  langFrameRanges,
  promoteSharedSpan,
  shiftSrt,
  shiftPlacedTimings,
  formatTimeInsertReport,
} from "../scripts/lib/dub-timing.mjs";
import { assembleSpans, pngDrawsPixels, dub, insertTime, verifyFreshOutput, publishFresh, uniqueTempPath } from "../scripts/dub.mjs";

const AUDIO_CLI = fileURLToPath(new URL("../scripts/audio-edit.mjs", import.meta.url));
const DUB_CLI = fileURLToPath(new URL("../scripts/dub.mjs", import.meta.url));

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sva-a6-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- N10: span split ----------------------------------------------------

test("N10 planCaptionSpans: spans tile the film; caption chunks and labelSpans are language spans, the rest shared", () => {
  const plan = planCaptionSpans({ lines: [{ start: 2, end: 4 }, { start: 10, end: 12 }], duration: 30, fps: 10, lastLineHolds: false });
  assert.deepEqual(plan.spans.map((s) => [s.kind, s.startFrame, s.endFrame]),
    [["shared", 0, 20], ["lang", 20, 40], ["shared", 40, 100], ["lang", 100, 120], ["shared", 120, 300]]);
  assert.equal(plan.langFrames + plan.sharedFrames, plan.totalFrames);

  const labelled = planCaptionSpans({ lines: [{ start: 2, end: 4 }], duration: 30, fps: 10, lastLineHolds: false, labelSpans: [{ start: 15, end: 16 }] });
  assert.deepEqual(langFrameRanges(labelled), [[20, 40], [150, 160]]);
});

test("N10 planCaptionSpans: the last caption holds to the film's end; a short neutral gap folds into the language span", () => {
  const held = planCaptionSpans({ lines: [{ start: 2, end: 4 }, { start: 10, end: 12 }], duration: 30, fps: 10 });
  assert.deepEqual(held.spans.at(-1), { startFrame: 100, endFrame: 300, kind: "lang" });
  const folded = planCaptionSpans({ lines: [{ start: 2, end: 4 }, { start: 4.5, end: 6 }], duration: 20, fps: 10, lastLineHolds: false });
  assert.deepEqual(langFrameRanges(folded), [[20, 60]]);
  const none = planCaptionSpans({ lines: [], duration: 3, fps: 10 });
  assert.deepEqual(none.spans, [{ startFrame: 0, endFrame: 30, kind: "shared" }]);
});

test("N10 promoteSharedSpan makes a shared span a language span and merges neighbours", () => {
  const plan = planCaptionSpans({ lines: [{ start: 2, end: 4 }], duration: 10, fps: 10, lastLineHolds: false });
  const promoted = promoteSharedSpan(plan, 2);
  assert.deepEqual(promoted.spans.map((s) => s.kind), ["shared", "lang"]);
  assert.equal(promoted.spans[1].endFrame, 100);
  assert.equal(promoted.langFrames + promoted.sharedFrames, 100);
});

async function makePicture(file, seconds, fps) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc2=size=64x64:rate=${fps}:duration=${seconds}`, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", file]);
}

async function makeCaptionFrames(dir, from, to, colour) {
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${colour}@0.8:size=64x64:rate=10,format=rgba`, "-frames:v", String(to - from),
    "-start_number", String(from), path.join(dir, "frame-%05d.png")]);
}

test("N10 assembleSpans: shared spans are encoded once and reused by the next language; language spans differ per language", async (t) => {
  const dir = tmp(t, "spans");
  const picture = path.join(dir, "picture.mp4");
  await makePicture(picture, 6, 10);
  const plan = planCaptionSpans({ lines: [{ start: 2, end: 4 }], duration: 6, fps: 10, lastLineHolds: false });
  assert.deepEqual(plan.spans.map((s) => s.kind), ["shared", "lang", "shared"]);
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir);
  const build = async (name, colour) => {
    const captionsDir = path.join(dir, `captions-${name}`);
    await makeCaptionFrames(captionsDir, 20, 40, colour);
    const outPath = path.join(dir, `${name}.mp4`);
    await assembleSpans({ plan, pictureMp4: picture, gridPictureMp4: picture, captionsDir, fps: 10, workDir: dir, outDir, outPath });
    return outPath;
  };
  const ko = await build("ko", "red");
  const shared = fs.readdirSync(path.join(outDir, "shared-spans")).filter((f) => !f.startsWith("."));
  assert.equal(shared.length, 2, "one file per shared span");
  const stamps = shared.map((f) => fs.statSync(path.join(outDir, "shared-spans", f)).mtimeMs);
  const en = await build("en", "blue");
  assert.deepEqual(fs.readdirSync(path.join(outDir, "shared-spans")).filter((f) => !f.startsWith(".")).sort(), shared.sort());
  assert.deepEqual(shared.map((f) => fs.statSync(path.join(outDir, "shared-spans", f)).mtimeMs), stamps, "second language reuses, does not rebuild");

  const [koFrames, enFrames] = [await frameHashes(ko), await frameHashes(en)];
  assert.equal(koFrames.length, 60);
  assert.equal(enFrames.length, 60);
  assert.deepEqual(koFrames.slice(0, 20), enFrames.slice(0, 20), "shared head identical in both languages");
  assert.deepEqual(koFrames.slice(40), enFrames.slice(40), "shared tail identical in both languages");
  assert.notDeepEqual(koFrames.slice(20, 40), enFrames.slice(20, 40), "language span differs");
  const sharedHead = await frameHashes(path.join(outDir, "shared-spans", shared.find((f) => f.endsWith("-0-20.mp4"))));
  assert.deepEqual(koFrames.slice(0, 20), sharedHead, "the final's shared span is the cached file's frames");
});

test("N10 pngDrawsPixels: a fully transparent caption frame is blank, any visible pixel is not", async (t) => {
  const dir = tmp(t, "alpha");
  const make = async (name, filter) => {
    const file = path.join(dir, name);
    await ffmpeg(["-y", "-f", "lavfi", "-i", filter, "-frames:v", "1", file]);
    return fs.readFileSync(file);
  };
  assert.equal(await pngDrawsPixels(await make("clear.png", "color=c=black@0.0:size=64x64,format=rgba")), false);
  assert.equal(await pngDrawsPixels(await make("dot.png", "color=c=black@0.0:size=64x64,format=rgba[a];color=c=red:size=2x2,format=rgba[b];[a][b]overlay=3:3:format=auto")), true);
});

// ---- 2: stale outputs, audio-only --------------------------------------

test("2 verifyFreshOutput: a file older than the run, an empty file, a missing file and a wrong length are never a result", async (t) => {
  const dir = tmp(t, "fresh");
  const wav = path.join(dir, "a.wav");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", wav]);
  const startedMs = Date.now() + 5000;
  await assert.rejects(verifyFreshOutput({ filePath: wav, startedMs, expectedSec: 1, toleranceSec: 0.1 }), /older than this run/);
  assert.equal(fs.existsSync(wav), false, "stale file is removed so it cannot be picked up later");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", wav]);
  await assert.rejects(verifyFreshOutput({ filePath: wav, startedMs: Date.now() - 5000, expectedSec: 3, toleranceSec: 0.1 }), /expected 3\.000s/);
  await assert.rejects(verifyFreshOutput({ filePath: path.join(dir, "missing.wav"), startedMs: 0, expectedSec: 1, toleranceSec: 1 }), /was not written/);
  fs.writeFileSync(path.join(dir, "empty.wav"), "");
  await assert.rejects(verifyFreshOutput({ filePath: path.join(dir, "empty.wav"), startedMs: 0, expectedSec: 1, toleranceSec: 1 }), /empty/);
});

test("2 publishFresh keeps an existing file of the same name and uses unique temp names", async (t) => {
  const dir = tmp(t, "publish");
  const a = uniqueTempPath(dir, "x", ".wav");
  const b = uniqueTempPath(dir, "x", ".wav");
  assert.notEqual(a, b);
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=1", a]);
  fs.writeFileSync(path.join(dir, "final.wav"), "old");
  const out = await publishFresh({ tempPath: a, outDir: dir, stem: "final", ext: ".wav", startedMs: Date.now() - 5000, expectedSec: 1, toleranceSec: 0.1 });
  assert.equal(path.basename(out), "final-2.wav");
  assert.equal(fs.readFileSync(path.join(dir, "final.wav"), "utf8"), "old");
});

async function makeAudioReel(dir) {
  const voiceDir = path.join(dir, "dub/en/voice");
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out/picture.timings.json"), JSON.stringify({ duration: 3, lines: [{ id: "a", text: "Hello", start: 0.2, end: 1.6 }, { id: "b", text: "World", start: 1.8, end: 2.9 }] }));
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=200:sample_rate=48000:duration=3", path.join(dir, "out/picture.bed.wav")]);
  fs.writeFileSync(path.join(dir, "dub/en/plan.json"), JSON.stringify({ meta: { lang: "en" }, lines: [{ id: "a", text: "Hello" }, { id: "b", text: "World" }] }));
  fs.writeFileSync(path.join(voiceDir, "timings.json"), JSON.stringify({ duration: 1, lines: [{ id: "a", text: "Hello", start: 0, end: 1, words: [{ w: "Hello", start: 0.05, end: 0.9 }] }, { id: "b", text: "World", start: 1, end: 2, words: [{ w: "World", start: 1.05, end: 1.9 }] }] }));
  for (const id of ["a", "b"]) {
    await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=1", path.join(voiceDir, `line-${id}.wav`)]);
  }
}

test("2 --audio-only writes an audio track as long as the picture, with no picture file needed and no video", async (t) => {
  const dir = tmp(t, "audio-only");
  await makeAudioReel(dir);
  const result = await dub({ dir, lang: "en", audioOnly: true, audioFormat: "m4a" });
  assert.match(path.basename(result.outPath), /^audio-en\.m4a$/);
  assert.ok(Math.abs(await probeDuration(result.outPath) - 3) < 0.1);
  assert.match(path.basename(fs.realpathSync(result.outPath)), /^audio-en-\d{8}-\d{6}\.m4a$/);
  assert.equal(fs.readdirSync(path.join(dir, "out")).some((f) => f.startsWith("final-")), false);
  assert.equal(fs.readdirSync(path.join(dir, "out")).some((f) => f.startsWith(".")), false, "no temp files left");
  const wav = await dub({ dir, lang: "en", audioOnly: true, audioFormat: "wav" });
  assert.ok(Math.abs(await probeDuration(wav.outPath) - 3) < 0.01);
});

test("2 CLI: --audio-only conflicts are refused; an unknown --audio-format is refused", async (t) => {
  const dir = tmp(t, "cli-audio");
  const run = (args) => { try { execFileSync(process.execPath, [DUB_CLI, dir, ...args], { stdio: "pipe" }); return null; } catch (e) { return e.stderr.toString(); } };
  assert.match(run(["--lang", "en", "--audio-only", "--min-gap", "1"]), /cannot combine/);
  assert.match(run(["--lang", "en", "--audio-only", "--audio-format", "mp3"]), /m4a or wav/);
});

// ---- 26: span splice ----------------------------------------------------

function sine(length, hz, amp = 0.5) {
  return Float32Array.from({ length }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / 48000));
}

test("26 spliceSpan: identical length, base untouched outside the span, replacement in the middle, 20 ms equal-power edges", () => {
  const base = sine(48000, 220);
  const take = sine(24000, 880);
  const start = 12000;
  const { samples, report } = spliceSpan(base, take, start, 48000);
  assert.equal(samples.length, base.length);
  assert.deepEqual(samples.subarray(0, start), base.subarray(0, start));
  assert.deepEqual(samples.subarray(start + take.length), base.subarray(start + take.length));
  const mid = start + 12000;
  assert.equal(samples[mid], take[12000]);
  assert.equal(report.fadeSamples, 960);
  assert.equal(samples[start], base[start], "span starts on the base's own sample");
  assert.ok(Math.abs(samples[start + 1] - base[start + 1]) < 0.01, "no click entering the span");
  assert.ok(Math.abs(samples[start + take.length - 1] - base[start + take.length - 1]) < 0.01, "no click leaving the span");
  assert.deepEqual([...base], [...sine(48000, 220)], "input not modified");
});

test("26 spliceSpan: refuses a span past the end, a span shorter than two crossfades, and bad input", () => {
  const base = sine(1000, 220);
  assert.throws(() => spliceSpan(base, sine(500, 880), 600, 48000), /past the input length/);
  assert.throws(() => spliceSpan(sine(48000, 220), sine(1000, 880), 0, 48000), /two crossfades/);
  assert.throws(() => spliceSpan(base, new Float32Array(0), 0, 48000), /nonempty/);
  assert.throws(() => spliceSpan(base, sine(100, 880), -1, 48000), /non-negative/);
});

test("26 audio-edit.mjs --splice: output has exactly the input's samples; existing outputs are not overwritten", async (t) => {
  const dir = tmp(t, "splice");
  const input = path.join(dir, "line.wav");
  const take = path.join(dir, "take.wav");
  const out = path.join(dir, "new.wav");
  writeWavMono16(input, Int16Array.from(sine(96000, 220, 0.4), (v) => Math.round(v * 32767)), 48000);
  writeWavMono16(take, Int16Array.from(sine(48000, 660, 0.4), (v) => Math.round(v * 32767)), 48000);
  const stdout = execFileSync(process.execPath, [AUDIO_CLI, input, "--splice", take, "--at", "0.5", "--out", out], { encoding: "utf8" });
  const summary = JSON.parse(stdout);
  assert.equal(summary.samples, 96000);
  assert.equal((await decodeMonoPcm(out, 48000)).length, 96000);
  assert.equal(JSON.parse(fs.readFileSync(`${out}.json`, "utf8")).fadeSamples, 960);
  assert.throws(() => execFileSync(process.execPath, [AUDIO_CLI, input, "--splice", take, "--at", "0.5", "--out", out], { stdio: "pipe" }), /already exists/);
  assert.throws(() => execFileSync(process.execPath, [AUDIO_CLI, input, "--splice", take, "--out", path.join(dir, "b.wav")], { stdio: "pipe" }), /--at/);
  assert.throws(() => execFileSync(process.execPath, [AUDIO_CLI, input, "--splice", take, "--at", "1.5", "--out", path.join(dir, "c.wav")], { stdio: "pipe" }), /past the input length/);
});

// ---- 52: time insert ----------------------------------------------------

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:06,500\nB\n";

test("52 shiftSrt / shiftPlacedTimings: later cues and lines move, earlier stay, a straddling one throws", () => {
  const { text, shifted } = shiftSrt(SRT, 3, 2.5);
  assert.equal(shifted, 1);
  assert.match(text, /00:00:01,000 --> 00:00:02,000/);
  assert.match(text, /00:00:07,500 --> 00:00:09,000/);
  assert.throws(() => shiftSrt(SRT, 1.5, 1), /straddles/);
  const placed = { duration: 10, lines: [{ id: "a", start: 1, end: 2, words: [{ w: "x", start: 1, end: 2 }] }, { id: "b", start: 5, end: 6, words: [{ w: "y", start: 5, end: 6 }] }] };
  const moved = shiftPlacedTimings(placed, 3, 2);
  assert.equal(moved.duration, 12);
  assert.deepEqual([moved.lines[0].start, moved.lines[1].start, moved.lines[1].words[0].end], [1, 7, 8]);
  assert.equal(placed.lines[1].start, 5, "input not modified");
  assert.throws(() => shiftPlacedTimings(placed, 5.5, 2), /straddles/);
});

test("52 formatTimeInsertReport says whether the languages end on the same length", () => {
  assert.equal(formatTimeInsertReport([{ lang: "ko", before: 10, after: 12, lines: 1, srt: 1 }, { lang: "en", before: 10, after: 12, lines: 1, srt: 1 }]).equal, true);
  const off = formatTimeInsertReport([{ lang: "ko", before: 10, after: 12, lines: 1, srt: 0 }, { lang: "en", before: 10.5, after: 12.5, lines: 1, srt: 0 }]);
  assert.equal(off.equal, false);
  assert.match(off.text, /LENGTHS DIFFER/);
});

function makeInsertReel(dir, enDuration) {
  const lines = (a) => [{ id: "a", text: "t", start: 1, end: 2, words: [{ w: "t", start: 1, end: 2 }] }, { id: "b", text: "u", start: a, end: a + 1 }];
  for (const [code, d] of [["ko", 10], ["en", enDuration]]) {
    fs.mkdirSync(path.join(dir, "dub", code), { recursive: true });
    fs.writeFileSync(path.join(dir, "dub", code, "timings.placed.json"), JSON.stringify({ duration: d, lines: lines(5) }));
  }
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out/captions-ko.srt"), SRT);
  fs.writeFileSync(path.join(dir, "dub/en/en.srt"), SRT);
  fs.writeFileSync(path.join(dir, "out/other.srt"), SRT);
}

test("52 insertTime: every language's placed timings and every SRT move together; lengths are reported", (t) => {
  const dir = tmp(t, "insert");
  makeInsertReel(dir, 10);
  const result = insertTime({ dir, at: 3, seconds: 2 });
  assert.equal(result.equal, true);
  for (const code of ["ko", "en"]) {
    const placed = JSON.parse(fs.readFileSync(path.join(dir, "dub", code, "timings.placed.json"), "utf8"));
    assert.equal(placed.duration, 12);
    assert.equal(placed.lines[1].start, 7);
  }
  assert.match(fs.readFileSync(path.join(dir, "out/captions-ko.srt"), "utf8"), /00:00:07,000 --> 00:00:08,500/);
  assert.match(fs.readFileSync(path.join(dir, "dub/en/en.srt"), "utf8"), /00:00:07,000 --> 00:00:08,500/);
  assert.equal(result.rows.find((r) => r.lang === "ko").srt, 1);
  assert.equal(result.unassignedSrt.length, 1);
  assert.match(result.text, /all languages are the same length/);
  assert.equal(fs.readdirSync(path.join(dir, "out")).some((f) => f.startsWith(".")), false, "no temp files left");
});

test("52 insertTime: a language that was already a different length is reported; a straddling line stops everything before any write", (t) => {
  const dir = tmp(t, "insert-off");
  makeInsertReel(dir, 10.5);
  assert.match(insertTime({ dir, at: 3, seconds: 2 }).text, /LENGTHS DIFFER/);

  const dir2 = tmp(t, "insert-straddle");
  makeInsertReel(dir2, 10);
  const before = fs.readFileSync(path.join(dir2, "dub/ko/timings.placed.json"), "utf8");
  assert.throws(() => insertTime({ dir: dir2, at: 1.5, seconds: 1 }), /straddles/);
  assert.equal(fs.readFileSync(path.join(dir2, "dub/ko/timings.placed.json"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(dir2, "out/other.srt"), "utf8"), SRT);
});

test("copied dub checks refuse malformed existing base JSON before audio work", async (t) => {
  const dir = tmp(t, "bad-base-plan");
  await makeAudioReel(dir);
  fs.writeFileSync(path.join(dir, "plan.json"), "{");
  await assert.rejects(dub({ dir, lang: "en", audioOnly: true }), /invalid JSON.*plan.json/);
});
