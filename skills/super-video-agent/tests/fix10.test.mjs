import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildClock, realVoiceIn, writeSilentWav } from "../scripts/lib/silent-clock.mjs";
import { edlFromRuns } from "../scripts/lib/timeline-diff.mjs";
import { masterGainReport, formatMasterCap, loudnessUnderTarget } from "../scripts/lib/audio-mix.mjs";
import { silenceNote } from "../scripts/lib/silence-gate.mjs";
import { longestSilenceAfterFirstSound } from "../scripts/lib/audio-analysis.mjs";
import { checkedNothingReasons } from "../scripts/lib/state-checks.mjs";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sva-fix10-"));
const run = (script, args) => spawnSync(process.execPath, [path.join(scripts, script), ...args], { encoding: "utf8" });
const STEPS = { duration: 6, steps: [{ id: "s1", start: 0, end: 2 }, { id: "s2", start: 2, end: 4.5 }, { id: "end", start: 4.5, end: 6 }] };

// ---- W1/G1: the silent clock ----

test("buildClock: one silent line per item with the exact starts and ends, and the film's duration", () => {
  const { timings, facts } = buildClock(STEPS, { fps: 30 });
  assert.equal(timings.duration, 6);
  assert.deepEqual(timings.lines.map((l) => [l.id, l.text, l.start, l.end, l.words]), [["s1", "", 0, 2, []], ["s2", "", 2, 4.5, []], ["end", "", 4.5, 6, []]]);
  assert.deepEqual(facts, []);
});

test("buildClock stops on a repeated id, an item that is not a span, overlap, order, or an end past the duration", () => {
  const s = (steps, duration) => () => buildClock({ duration, steps });
  assert.throws(s([{ id: "a", start: 0, end: 1 }, { id: "a", start: 1, end: 2 }]), /used twice/);
  assert.throws(s([{ id: "a", start: 1, end: 1 }]), /do not make a span/);
  assert.throws(s([{ id: "a", start: 0, end: 2 }, { id: "b", start: 1, end: 3 }]), /before the item above it ends/);
  assert.throws(s([{ id: "a", start: 2, end: 3 }, { id: "b", start: 0, end: 1 }]), /before the item above it/);
  assert.throws(s([{ id: "a", start: 0, end: 3 }], 2), /after the timeline's duration/);
  assert.throws(() => buildClock({ nothing: [] }), /has none of/);
});

test("buildClock reports gaps, a late first item, a tail and off-grid edges as facts, and does not stop", () => {
  const { timings, facts } = buildClock({ duration: 5, scenes: [{ id: "a", start: 0.5, end: 1.01 }, { id: "b", start: 2, end: 3 }] }, { fps: 30 });
  assert.equal(timings.lines.length, 2);
  assert.ok(facts.some((f) => /first item starts at 0.5/.test(f)));
  assert.ok(facts.some((f) => /gap 0.990 s after "a"/.test(f)));
  assert.ok(facts.some((f) => /runs 2.000 s past/.test(f)));
  assert.ok(facts.some((f) => /not on the 30 fps frame grid/.test(f)));
});

test("writeSilentWav writes silence of exactly the duration; realVoiceIn tells a silent clock from a real voice", () => {
  const dir = tmp();
  const wav = path.join(dir, "n.wav");
  const frames = writeSilentWav(wav, 2.5);
  assert.equal(frames, 120000);
  assert.equal(fs.statSync(wav).size, 44 + frames * 2);
  assert.ok(fs.readFileSync(wav).subarray(44).every((b) => b === 0));
  const t = path.join(dir, "t.json");
  fs.writeFileSync(t, JSON.stringify(buildClock(STEPS).timings));
  assert.equal(realVoiceIn(t), false);
  fs.writeFileSync(t, JSON.stringify({ lines: [{ id: "a", text: "hello", start: 0, end: 1, words: [] }] }));
  assert.equal(realVoiceIn(t), true);
});

test("silent-clock.mjs writes voice/timings.json and voice/narration.wav; it will not replace a real voice without --force", () => {
  const dir = tmp();
  const tl = path.join(dir, "timeline.json");
  fs.writeFileSync(tl, JSON.stringify(STEPS));
  const ok = run("silent-clock.mjs", [dir, "--timeline", tl, "--fps", "30"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /3 silent lines, 6.000 s/);
  const timings = JSON.parse(fs.readFileSync(path.join(dir, "voice/timings.json"), "utf8"));
  assert.equal(timings.lines[1].start, 2);
  assert.equal(fs.statSync(path.join(dir, "voice/narration.wav")).size, 44 + 6 * 48000 * 2);
  const again = run("silent-clock.mjs", [dir, "--timeline", tl]);
  assert.equal(again.status, 0, "a silent clock may be written again");
  fs.writeFileSync(path.join(dir, "voice/timings.json"), JSON.stringify({ duration: 1, lines: [{ id: "a", text: "words", start: 0, end: 1, words: [] }] }));
  const refused = run("silent-clock.mjs", [dir, "--timeline", tl]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /real narration/);
  assert.equal(run("silent-clock.mjs", [dir, "--timeline", tl, "--force"]).status, 0);
  assert.notEqual(run("silent-clock.mjs", [dir]).status, 0);
});

// ---- D2/W5/G4: an EDL that takes new frames from a draft ----

const RUNS = [
  { kind: "keep", oldFrom: 0, oldTo: 120, newFrom: 0, newTo: 120, ids: ["a"] },
  { kind: "new", newFrom: 712, newTo: 805, ids: ["s2"], reason: "changed" },
];

test("edlFromRuns maps a changed run to the draft's own frames: film frame - frameStart", () => {
  const edl = edlFromRuns(RUNS, { oldFilm: "out/old.mp4", newClips: [{ src: "out/drafts/s2.mp4", frameStart: 697, frameEnd: 820 }] });
  assert.deepEqual(edl.entries[1], { src: "out/drafts/s2.mp4", from: 15, to: 108, new: true });
});

test("edlFromRuns takes a run across two drafts, and stops on a run no clip holds", () => {
  const edl = edlFromRuns(RUNS, { oldFilm: "o.mp4", newClips: [{ src: "d1.mp4", frameStart: 700, frameEnd: 760 }, { src: "d2.mp4", frameStart: 750, frameEnd: 820 }] });
  assert.deepEqual(edl.entries.slice(1).map((e) => [e.src, e.from, e.to]), [["d1.mp4", 12, 60], ["d2.mp4", 10, 55]]);
  assert.throws(() => edlFromRuns(RUNS, { oldFilm: "o.mp4", newClips: [{ src: "d.mp4", frameStart: 730, frameEnd: 820 }] }), /no new clip holds the film's frames \[712,805\)/);
});

test("changed-spans.mjs --edl-out reads the draft sidecar, so the EDL fits the draft's frames", () => {
  const dir = tmp();
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  w("old.json", { duration: 10, fps: 30, lines: [{ id: "a", text: "a", start: 0, end: 4 }, { id: "s2", text: "x", start: 4, end: 7 }, { id: "c", text: "c", start: 7, end: 10 }] });
  w("new.json", { duration: 11, fps: 30, lines: [{ id: "a", text: "a", start: 0, end: 4 }, { id: "s2", text: "y", start: 4, end: 8 }, { id: "c", text: "c", start: 8, end: 11 }] });
  fs.mkdirSync(path.join(dir, "out/drafts"), { recursive: true });
  w("out/drafts/s2.json", { id: "s2", frameStart: 105, frameEnd: 255, slotFrameStart: 120, slotFrameEnd: 240 });
  const edlOut = path.join(dir, "edl.json");
  const args = [path.join(dir, "old.json"), path.join(dir, "new.json"), "--edl-out", edlOut, "--old-film", path.join(dir, "out/old.mp4"), "--new-film", path.join(dir, "out/drafts/s2.mp4"), "--reel", dir];
  const r = run("changed-spans.mjs", args);
  assert.equal(r.status, 0, r.stderr);
  const edl = JSON.parse(fs.readFileSync(edlOut, "utf8"));
  assert.deepEqual(edl.entries.map((e) => [e.src, e.from, e.to]), [["out/old.mp4", 0, 120], [path.join("out/drafts/s2.mp4"), 15, 135], ["out/old.mp4", 210, 300]]);
  w("out/drafts/s2.json", { id: "s2", frameStart: 130, frameEnd: 255 });
  const bad = run("changed-spans.mjs", args);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no new clip holds/);
});

test("changed-spans.mjs --edl-out with a full-length new film keeps the old meaning: frame n is frame n", () => {
  const dir = tmp();
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  w("old.json", { duration: 2, fps: 30, lines: [{ id: "a", text: "a", start: 0, end: 1 }, { id: "b", text: "b", start: 1, end: 2 }] });
  w("new.json", { duration: 2, fps: 30, lines: [{ id: "a", text: "a", start: 0, end: 1 }, { id: "b", text: "c", start: 1, end: 2 }] });
  const edlOut = path.join(dir, "edl.json");
  const r = run("changed-spans.mjs", [path.join(dir, "old.json"), path.join(dir, "new.json"), "--edl-out", edlOut, "--old-film", "old.mp4", "--new-film", "new.mp4"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(edlOut, "utf8")).entries.map((e) => [e.src, e.from, e.to]), [["old.mp4", 0, 30], ["new.mp4", 30, 60]]);
});

// ---- D1: the master gain cap ----

test("masterGainReport: a mix that needs more than the +12 dB cap is capped and short by the rest", () => {
  const r = masterGainReport({ integratedLufs: -33.8 });
  assert.equal(r.capped, true);
  assert.equal(r.gainDb, 12);
  assert.ok(Math.abs(r.shortDb - 5.8) < 1e-9);
  assert.match(formatMasterCap(r, { integratedLufs: -33.8 }), /capped at \+12 dB.*-33\.8 LUFS.*5\.8 dB under -16 LUFS/);
  const ok = masterGainReport({ integratedLufs: -20 });
  assert.equal(ok.capped, false);
  assert.equal(formatMasterCap(ok, { integratedLufs: -20 }), "");
  assert.equal(masterGainReport({ integratedLufs: null }), null);
});

test("loudnessUnderTarget states the gap in dB and the cap; within half a dB it says nothing", () => {
  const n = loudnessUnderTarget(-21.8);
  assert.ok(Math.abs(n.underDb - 5.8) < 1e-9);
  assert.match(n.text, /5\.8 dB under the -16 LUFS master target.*capped at \+12 dB/);
  assert.equal(loudnessUnderTarget(-16.3), null);
  assert.equal(loudnessUnderTarget(-14), null);
  assert.equal(loudnessUnderTarget(null), null);
});

// ---- G3: why a long silence still passes ----

test("longestSilenceAfterFirstSound reports the silence that runs to the end", () => {
  const sr = 8000;
  const buf = new Float32Array(sr * 4);
  for (let i = 0; i < sr * 0.5; i++) buf[i] = 0.3 * Math.sin(i / 5);
  const r = longestSilenceAfterFirstSound(buf, sr, { thresholdDb: -50 });
  assert.ok(Math.abs(r.longestSilenceSec - 3.5) < 0.03);
  assert.ok(Math.abs(r.trailingSilenceSec - 3.5) < 0.03);
});

test("silenceNote: says why a silence over the gate passes, and says nothing when the gate fails or is met", () => {
  const none = { planned: [], unplanned: [] };
  assert.match(silenceNote({ longestSilenceSec: 2.6, trailingSilenceSec: 2.6 }, none, 1), /tail after the last sound/);
  assert.match(silenceNote({ longestSilenceSec: 2.6, trailingSilenceSec: 0.2 }, { planned: [{}], unplanned: [] }, 1), /planned pause/);
  assert.match(silenceNote({ longestSilenceSec: 2.6, trailingSilenceSec: 0.2 }, none, 1), /no pause between two sounds was found/);
  assert.equal(silenceNote({ longestSilenceSec: 2.6, trailingSilenceSec: 0 }, { planned: [], unplanned: [{}] }, 1), null);
  assert.equal(silenceNote({ longestSilenceSec: 0.8, trailingSilenceSec: 0.8 }, none, 1), null);
});

// ---- G2: text drawn at load ----

test("the glyph check that saw no text says where text it cannot see comes from", () => {
  const r = checkedNothingReasons({ frames: [{ texts: [] }], checks: ["glyphs"], hasLayerHook: false });
  assert.match(r[0].reason, /offscreen canvas.*fillText during seek\(\) on a canvas in the document/);
});
