// FIX8: page-made cue facts (C11), content check of copied segments + timeline diff (C24, G22),
// draft stamps (C59), take ratio against its slot (C42), page mix level against a voice line (G7).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { run } from "../scripts/lib/ffmpeg.mjs";
import { checkPageMarks, formatPageCues } from "../scripts/lib/cue-check.mjs";
import { diffTimelines, spanFlag, edlFromRuns } from "../scripts/lib/timeline-diff.mjs";
import { parseEdl } from "../scripts/lib/segments.mjs";
import { clipVersusPage } from "../scripts/lib/segment-verify.mjs";
import { reelStamp, compareDraft, draftSidecar, draftsDir, slotProbeFrames } from "../scripts/lib/drafts.mjs";
import { retimeRatioMessage, pictureSlotSecs } from "../scripts/voice/line-edit.mjs";
import { mixOffset, medianLufs } from "../scripts/lib/mix-level.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(here, "..", "scripts", name);
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sva-fix8-${tag}-`));
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });

const timings = {
  duration: 6,
  lines: [
    { id: "a", text: "alpha beta", start: 0.5, end: 3, words: [{ w: "alpha", start: 0.5, end: 1 }, { w: "beta", start: 2.0, end: 2.4 }] },
    { id: "b", text: "gamma", start: 3.5, end: 5, words: [{ w: "gamma", start: 3.5, end: 4 }] },
  ],
};

// ---- C11 -------------------------------------------------------------------------------------------

test("C11 checkPageMarks: facts per page sound event; a named word that moved, is missing or lies outside the timeline warns", () => {
  const r = checkPageMarks([
    { at: 2.0, kind: "pop" },
    { at: 2.3, kind: "ding", word: "beta" },
    { at: 3.6, kind: "tick", word: "zzz", line: "b" },
    { at: 99, kind: "late" },
  ], timings);
  assert.deepEqual(r.cues[0], { at: 2.0, kind: "pop", lineId: "a", word: "beta", wordStart: 2.0, offsetMs: 0 });
  assert.deepEqual(r.warnings.map((w) => w.type), ["page-cue-moved", "page-cue-word-missing", "page-cue-outside-timeline"]);
  assert.match(r.warnings[0].detail, /\+300 ms/);
  assert.equal(r.cues[3].lineId, null);
  const text = formatPageCues(r);
  assert.match(text, /^4 page sound events read\n/);
  assert.match(text, /2\.000 s pop: a, nearest word "beta" at 2\.000 s \(0 ms\)/);
  assert.match(formatPageCues({ cues: [], warnings: [] }), /none read/);
});

test("C11 cue-check.mjs --marks: page events are read, counted and written; no word cue is not 'checked nothing' then", () => {
  const dir = tmp("c11");
  try {
    fs.mkdirSync(path.join(dir, "voice"));
    fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(timings));
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ lines: [{ id: "a", text: "alpha beta" }] }));
    fs.writeFileSync(path.join(dir, "marks.json"), JSON.stringify({ marks: [{ at: 2.3, kind: "ding", word: "beta" }] }));
    const r = node([script("cue-check.mjs"), dir, "--marks", path.join(dir, "marks.json")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 page sound event read/);
    assert.match(r.stdout, /page-cue-moved/);
    assert.doesNotMatch(r.stdout, /checked nothing/);
    const j = JSON.parse(fs.readFileSync(path.join(dir, "out", "cue-check.json"), "utf8"));
    assert.equal(j.pageCueCount, 1);
    assert.equal(j.checkedNothing, false);
    assert.equal(j.pageWarnings[0].type, "page-cue-moved");
    const none = node([script("cue-check.mjs"), dir]);
    assert.match(none.stdout, /checked nothing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- C24 / G22 -------------------------------------------------------------------------------------

const FPS = 10;
const oldTl = { duration: 6, lines: [{ id: "a", start: 0, text: "one" }, { id: "b", start: 2, text: "two" }, { id: "c", start: 4, text: "three" }] };
const newTl = { duration: 7, lines: [{ id: "a", start: 0, text: "one" }, { id: "x", start: 2, text: "new" }, { id: "b", start: 3, text: "two changed" }, { id: "c", start: 5, text: "three" }] };

test("C24/G22 diffTimelines: kept runs map old frames to new places, changed and added runs are the spans to draw", () => {
  const d = diffTimelines(oldTl, newTl, FPS);
  assert.deepEqual(d.runs, [
    { kind: "keep", newFrom: 0, newTo: 20, oldFrom: 0, oldTo: 20, ids: ["a"] },
    { kind: "new", newFrom: 20, newTo: 50, ids: ["x", "b"], reason: "changed" },
    { kind: "keep", newFrom: 50, newTo: 70, oldFrom: 40, oldTo: 60, ids: ["c"] },
  ]);
  assert.deepEqual(d.frames, { kept: 40, new: 30, shifted: 20 });
  assert.deepEqual(d.removed, []);
  assert.equal(spanFlag(d.runs, FPS), "2-5");
  assert.deepEqual(diffTimelines(oldTl, oldTl, FPS).runs.map((r) => r.kind), ["keep"]);
  assert.equal(spanFlag(diffTimelines(oldTl, oldTl, FPS).runs, FPS), "");
  const gone = diffTimelines(oldTl, { duration: 4, lines: [{ id: "a", start: 0, text: "one" }, { id: "c", start: 2, text: "three" }] }, FPS);
  assert.deepEqual(gone.removed, ["b"]);
});

test("C24/G22 edlFromRuns: the EDL parses with parseEdl and tiles the new film", () => {
  const edl = edlFromRuns(diffTimelines(oldTl, newTl, FPS).runs, { oldFilm: "out/old.mp4", newFilm: "out/new.mp4" });
  const entries = parseEdl(edl);
  assert.deepEqual(entries.map((e) => [e.src, e.from, e.to, e.fresh]), [["out/old.mp4", 0, 20, false], ["out/new.mp4", 20, 50, true], ["out/old.mp4", 40, 60, false]]);
  assert.equal(entries.reduce((n, e) => n + e.to - e.from, 0), 70);
});

test("C24/G22 changed-spans.mjs: prints the spans, writes the report and the EDL; a missing fps stops", () => {
  const dir = tmp("c24");
  try {
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify(oldTl));
    fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify(newTl));
    const edlPath = path.join(dir, "edl.json");
    const r = node([script("changed-spans.mjs"), path.join(dir, "old.json"), path.join(dir, "new.json"), "--fps", String(FPS), "--out", path.join(dir, "r.json"), "--edl-out", edlPath, "--old-film", path.join(dir, "out", "old.mp4"), "--new-film", path.join(dir, "out", "new.mp4"), "--reel", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /new     2\.000-5\.000 s  x,b  changed/);
    assert.match(r.stdout, /keep    new frames \[50,70\) = old frames \[40,60\)  shift 10/);
    assert.match(r.stdout, /--span 2-5\n/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "r.json"), "utf8")).span, "2-5");
    assert.equal(JSON.parse(fs.readFileSync(edlPath, "utf8")).entries[0].src, path.join("out", "old.mp4"));
    const noFps = node([script("changed-spans.mjs"), path.join(dir, "old.json"), path.join(dir, "new.json")]);
    assert.equal(noFps.status, 1);
    assert.match(noFps.stderr, /pass --fps/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function colorClip(file, color) {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=10:d=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
}
async function colorPng(color) {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
  return stdout;
}

test("C24 clipVersusPage: a copied clip that holds what the page draws passes; another picture is reported with its share of pixels", async () => {
  const dir = tmp("cvp");
  try {
    const mp4 = path.join(dir, "seg.mp4");
    await colorClip(mp4, "red");
    const items = (png) => [0, 5, 9].map((index) => ({ index, image: png }));
    assert.deepEqual(await clipVersusPage({ mp4, items: items(await colorPng("red")), width: 160, height: 90 }), []);
    const bad = await clipVersusPage({ mp4, items: items(await colorPng("blue")), width: 160, height: 90 });
    assert.deepEqual(bad.map((b) => b.index), [0, 5, 9]);
    assert.ok(bad[0].fraction > 0.9, `fraction ${bad[0].fraction}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- C59 -------------------------------------------------------------------------------------------

test("C59 reelStamp: follows content of the page's files, not mtime and not out/", () => {
  const dir = tmp("stamp");
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), "<html>one</html>");
    fs.mkdirSync(path.join(dir, "out"));
    const s1 = reelStamp(dir);
    fs.writeFileSync(path.join(dir, "out", "x.txt"), "render output");
    fs.utimesSync(path.join(dir, "reel.html"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    assert.equal(reelStamp(dir), s1);
    fs.writeFileSync(path.join(dir, "reel.html"), "<html>two</html>");
    assert.notEqual(reelStamp(dir), s1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C59 draftSidecar + compareDraft: current, slot-unchanged, stale, stamp-moved and unstamped are told apart", () => {
  const segment = { id: "b", frameStart: 60, frameEnd: 120 };
  const span = { frameStart: 45, frameEnd: 135, handleBefore: 15, handleAfter: 15 };
  const sidecar = draftSidecar({ segment, span, fps: 30, handleSec: 0.5, quality: "final", width: 1, height: 1, stamp: "S1", probes: ["p0", "p1", "p2"] });
  assert.equal(sidecar.stamp, "S1");
  assert.deepEqual(slotProbeFrames(segment), [60, 89, 119]);
  assert.equal(compareDraft({ sidecar, stamp: "S1", probes: null }).state, "current");
  assert.equal(compareDraft({ sidecar, stamp: "S2", probes: ["p0", "p1", "p2"] }).state, "slot-unchanged");
  const stale = compareDraft({ sidecar, stamp: "S2", probes: ["p0", "pX", "p2"] });
  assert.equal(stale.state, "stale");
  assert.match(stale.detail, /probe frame 1 differs/);
  assert.equal(compareDraft({ sidecar, stamp: "S2", probes: null }).state, "stamp-moved");
  const old = draftSidecar({ segment, span, fps: 30, handleSec: 0.5, quality: "final", width: 1, height: 1 });
  assert.equal(compareDraft({ sidecar: old, stamp: "S1", probes: null }).state, "unstamped");
});

test("C59 draft-check.mjs: reports each draft against the stamp (page opened only when a stamp moved); no draft is 'checked nothing'", () => {
  const dir = tmp("dc");
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), "<html>one</html>");
    const none = node([script("draft-check.mjs"), dir]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /checked nothing: no draft/);
    const segment = { id: "b", frameStart: 60, frameEnd: 120 };
    const span = { frameStart: 45, frameEnd: 135, handleBefore: 15, handleAfter: 15 };
    const d = draftsDir(path.join(dir, "out"));
    fs.mkdirSync(d, { recursive: true });
    const write = (id, extra) => fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ ...draftSidecar({ segment: { ...segment, id }, span, fps: 30, handleSec: 0.5, quality: "final", width: 1, height: 1 }), ...extra }));
    write("fresh", { stamp: reelStamp(dir), probes: ["a", "b", "c"] });
    write("old", {});
    const r = node([script("draft-check.mjs"), dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /current        fresh/);
    assert.match(r.stdout, /unstamped      old/);
    const j = JSON.parse(fs.readFileSync(path.join(dir, "out", "draft-check.json"), "utf8"));
    assert.deepEqual(j.drafts.map((x) => x.state), ["current", "unstamped"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- C42 -------------------------------------------------------------------------------------------

test("C42 retimeRatioMessage: the take's length against its picture slot, as a ratio", () => {
  assert.equal(retimeRatioMessage("z4", 3.21, 2.37, "--retime"), "z4: take 3.21s against slot 2.37s = 1.354x (35.4% over its slot); installed at its own length (--retime)");
  assert.match(retimeRatioMessage("z4", 1.8, 2.4, "dub folder"), /= 0\.750x \(25\.0% under its slot\)/);
});

test("C42 pictureSlotSecs: a reel's own slots, or the base reel's line slots in a dub folder", () => {
  const reel = tmp("c42");
  try {
    const own = pictureSlotSecs(reel, new Map([["a", { slotSec: 2.5, oldClipSec: 2 }]]));
    assert.deepEqual([...own], [["a", 2.5]]);
    fs.mkdirSync(path.join(reel, "voice"));
    fs.writeFileSync(path.join(reel, "voice", "timings.json"), JSON.stringify({ duration: 10, lines: [{ id: "a", start: 1 }, { id: "b", start: 4 }] }));
    const dub = path.join(reel, "dub", "zh-Hant");
    fs.mkdirSync(dub, { recursive: true });
    assert.deepEqual([...pictureSlotSecs(dub, new Map())], [["a", 3], ["b", 6]]);
    const lone = tmp("c42b");
    try {
      fs.mkdirSync(path.join(lone, "dub", "xx"), { recursive: true });
      assert.equal(pictureSlotSecs(path.join(lone, "dub", "xx"), new Map()).size, 0);
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(reel, { recursive: true, force: true });
  }
});

// ---- G7 --------------------------------------------------------------------------------------------

test("G7 mixOffset: gap, offset for a wanted gap, and the true peak after it", () => {
  const r = mixOffset({ integratedLufs: -30, truePeakDb: -12 }, -16, { underDb: 10 });
  assert.equal(r.gapDb, 14);
  assert.equal(r.offsetDb, 4);
  assert.equal(r.truePeakAfterDb, -8);
  assert.equal(r.overPeakDb, null);
  const hot = mixOffset({ integratedLufs: -30, truePeakDb: -3 }, -16, { underDb: 6 });
  assert.equal(hot.offsetDb, 8);
  assert.equal(hot.overPeakDb, 6);
  assert.equal(mixOffset({ integratedLufs: -30, truePeakDb: -12 }, -16).offsetDb, null);
  assert.throws(() => mixOffset({ integratedLufs: null, truePeakDb: null }, -16), /no measurable loudness/);
  assert.equal(medianLufs([-18, -16, null, -14, -20]), -17);
});

function sine(amp, sec = 3, hz = 1000, sr = 48000) {
  const x = new Float32Array(sr * sec);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return x;
}

test("G7 mix-level.mjs: page sound 20 dB under a voice line reads 20 dB; --under 12 gives +8 dB; missing inputs stop with the file they need", () => {
  const dir = tmp("g7");
  try {
    fs.mkdirSync(path.join(dir, "voice"));
    fs.mkdirSync(path.join(dir, "out"));
    writeWavPCM16(path.join(dir, "voice", "line-a.wav"), [sine(0.25)], 48000);
    writeWavPCM16(path.join(dir, "out", "picture.bed.wav"), [sine(0.025)], 48000);
    const plain = node([script("mix-level.mjs"), dir]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /the page sits 20\.0 dB under the voice/);
    assert.match(plain.stdout, /no --under <dB> given/);
    const r = node([script("mix-level.mjs"), dir, "--under", "12"]);
    assert.match(r.stdout, /add \+8\.0 dB to the page's level/);
    const j = JSON.parse(fs.readFileSync(path.join(dir, "out", "mix-level.json"), "utf8"));
    assert.ok(Math.abs(j.offsetDb - 8) < 0.2, `offset ${j.offsetDb}`);
    const given = node([script("mix-level.mjs"), dir, "--voice-lufs", "-16", "--under", "12"]);
    assert.equal(given.status, 0, given.stderr);
    fs.rmSync(path.join(dir, "out", "picture.bed.wav"));
    const noBed = node([script("mix-level.mjs"), dir]);
    assert.equal(noBed.status, 1);
    assert.match(noBed.stderr, /no page sound at .*picture\.bed\.wav/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
