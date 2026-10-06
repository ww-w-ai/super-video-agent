// FIX4: cut-out rig helper + joint check, mouth schedule, drift guard, tempo, TTS usage in dub/<code>/voice/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { amplitudeSpans, steadySpans, rmsEnvelope, buildSchedule, scheduleLines } from "../scripts/lib/mouth.mjs";
import { resolveOptions, main as mouthMain } from "../scripts/mouth.mjs";
import { fitTempo, tempoLines, fittedTimeline } from "../scripts/lib/tempo.mjs";
import { loadInput, main as tempoMain } from "../scripts/tempo.mjs";
import { sampleTimes } from "../scripts/rig-check.mjs";
import { driftReportLines } from "../scripts/lib/browser.mjs";
import { ttsUsageFor, formatReport, reportFor } from "../scripts/runner/cost-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-rig.js"));
await import(path.join(here, "..", "scripts", "engine", "reel-drift.js"));
const { ReelRig, ReelDrift } = globalThis;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fix4-"));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ---- 1 cut-out rig ---------------------------------------------------------------------------------

const PARTS = [
  { id: "torso", pivot: [10, 10], size: [20, 40], z: 0 },
  { id: "arm", parent: "torso", pivot: [0, 0], anchor: [20, 5], size: [8, 30], z: 1, limits: [-90, 90] },
  { id: "hand", parent: "arm", pivot: [0, 0], anchor: [0, 30], size: [6, 6], z: -1 },
];
const rig = () => ReelRig.makeRig(PARTS);

test("makeRig throws on a duplicate id, an unknown parent and a parent loop", () => {
  assert.throws(() => ReelRig.makeRig([{ id: "a" }, { id: "a" }]), /used twice/);
  assert.throws(() => ReelRig.makeRig([{ id: "a", parent: "zz" }]), /unknown parent/);
  assert.throws(() => ReelRig.makeRig([{ id: "a", parent: "b" }, { id: "b", parent: "a" }]), /loops/);
});

test("keyed eases between keys and holds before the first and after the last", () => {
  const keys = [{ t: 1, v: 0 }, { t: 3, v: 10 }];
  assert.equal(ReelRig.keyed(keys, 0), 0);
  assert.equal(ReelRig.keyed(keys, 5), 10);
  near(ReelRig.keyed(keys, 2), 5);
  assert.ok(ReelRig.keyed(keys, 1.5) < 2.5, "smoothstep starts slower than linear");
});

test("a child's joint follows the parent through its rotation", () => {
  const calls = [];
  const ctx = { save() {}, restore() {}, transform: (...m) => calls.push(m), drawImage() {} };
  ReelRig.draw(ctx, rig(), { torso: { rot: 90, dx: 100, dy: 200 } }, { torso: {}, arm: {}, hand: {} });
  // draw order is by z: hand (-1), torso (0), arm (1). The arm's pivot is its matrix translation.
  const arm = calls[2];
  near(arm[4], 105);
  near(arm[5], 210);
});

test("draw paints in z order and uses part.draw over an image", () => {
  const order = [];
  const parts = [{ id: "a", z: 2, draw: () => order.push("a") }, { id: "b", z: 1, draw: () => order.push("b") }, { id: "c", z: 1, draw: () => order.push("c") }];
  ReelRig.draw({ save() {}, restore() {}, transform() {}, drawImage() { order.push("image"); } }, ReelRig.makeRig(parts), {});
  assert.deepEqual(order, ["b", "c", "a"]);
});

test("joint check: attached joints report a gap of 0 and every joint is listed", () => {
  const r = ReelRig.jointCheck(rig(), () => ({ torso: { rot: 30, dx: 50, dy: 50 }, arm: { rot: 45 } }), [0, 0.5, 1]);
  assert.deepEqual(r.joints.map((j) => j.joint), ["arm>torso", "hand>arm"]);
  for (const j of r.joints) near(j.maxGapPx, 0);
  assert.equal(r.rows.length, 0);
  assert.match(r.lines[0], /^joint arm>torso: max gap 0\.0 px at t=0\.00 \(0 of 3 samples over 2 px\)/);
});

test("joint check: a part moved off its joint reports the gap in px and the time", () => {
  const poseFn = (t) => ({ torso: { dx: 10, dy: 10 }, arm: { dx: t >= 1 ? 30 : 0, dy: t >= 1 ? 40 : 0 } });
  const r = ReelRig.jointCheck(rig(), poseFn, [0, 1, 2]);
  const arm = r.joints.find((j) => j.joint === "arm>torso");
  near(arm.maxGapPx, 50);
  assert.equal(arm.atT, 1);
  assert.equal(arm.over, 2);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((row) => row.joint === "arm>torso" && Math.abs(row.gapPx - 50) < 1e-6));
});

test("joint check: a parent's scale scales the reported gap", () => {
  const r = ReelRig.jointCheck(rig(), () => ({ torso: { scale: 2 }, arm: { dx: 3, dy: 4 } }), [0]);
  near(r.joints[0].maxGapPx, 10);
});

test("joint check: an angle outside the limits is reported, not thrown", () => {
  const r = ReelRig.jointCheck(rig(), () => ({ arm: { rot: 120 } }), [0, 1]);
  const arm = r.joints[0];
  assert.equal(arm.angleOver, 2);
  assert.match(r.lines[0], /2 outside the angle limits/);
  assert.equal(r.rows[0].outsideLimits, true);
});

test("joint check never throws: a pose function that throws becomes a note", () => {
  const r = ReelRig.jointCheck(rig(), () => { throw new Error("pose broke"); }, [0]);
  assert.ok(r.notes.some((n) => /pose broke/.test(n)));
  assert.ok(r.lines.some((l) => /could not run/.test(l)));
  const bad = ReelRig.jointCheck(null, () => ({}), [0]);
  assert.ok(bad.notes.length > 0);
});

test("mouthTrack reads a schedule as a pure function of t", () => {
  const f = ReelRig.mouthTrack({ lines: [{ spans: [{ from: 1, to: 2, open: 0.8 }] }, { spans: [{ from: 0, to: 0.5, open: 1 }] }] });
  assert.equal(f(0.25), 1);
  assert.equal(f(0.75), 0);
  assert.equal(f(1.5), 0.8);
  assert.equal(f(2.5), 0);
  assert.equal(ReelRig.mouthTrack([{ from: 0, to: 1 }])(0.5), 1);
});

// ---- 2 mouth schedule ------------------------------------------------------------------------------

const SR = 8000;
/** A mono signal of `sec` seconds, 200 Hz bursts of `amp` over each [from, to] span. */
function signal(sec, bursts, amp = 0.5) {
  const x = new Float32Array(Math.round(sec * SR));
  for (const [a, b] of bursts) for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) x[i] = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
  return x;
}
const spansOf = (x) => amplitudeSpans(rmsEnvelope(x, SR, 0.04), 0.04);

test("amplitude spans: a burst opens the mouth for its length and silence closes it", () => {
  const s = spansOf(signal(1, [[0.2, 0.6]]));
  assert.equal(s.length, 1);
  near(s[0].from, 0.2, 0.001);
  near(s[0].to, 0.6, 0.001);
  assert.ok(s[0].open > 0.9);
});

test("amplitude spans do not depend on how loud the line was recorded", () => {
  assert.deepEqual(spansOf(signal(1, [[0.2, 0.6]], 0.5)), spansOf(signal(1, [[0.2, 0.6]], 0.05)));
});

test("amplitude spans: a closed gap under 50 ms is bridged and a blip under 60 ms is dropped", () => {
  const s = spansOf(signal(1, [[0.2, 0.4], [0.44, 0.6], [0.8, 0.83]]));
  assert.equal(s.length, 1);
  near(s[0].from, 0.2, 0.001);
  near(s[0].to, 0.6, 0.001);
});

test("amplitude spans: a longer gap keeps two spans and a silent line has none", () => {
  assert.equal(spansOf(signal(1, [[0.1, 0.3], [0.5, 0.7]])).length, 2);
  assert.deepEqual(spansOf(signal(1, [])), []);
});

test("steady spans alternate at the rate and stop at the end of the line", () => {
  const s = steadySpans(2, 3, 5);
  assert.equal(s.length, 5);
  assert.deepEqual(s[0], { from: 2, to: 2.1, open: 1 });
  assert.deepEqual(s[1], { from: 2.2, to: 2.3, open: 1 });
  assert.ok(s.every((x) => x.to <= 3));
});

function voiceFolder() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "dub", "es", "voice"), { recursive: true });
  const voice = path.join(dir, "dub", "es", "voice");
  writeWavPCM16(path.join(voice, "line-a.wav"), [signal(1, [[0.2, 0.6]])], SR);
  fs.writeFileSync(path.join(voice, "timings.json"), JSON.stringify({ duration: 6, lines: [{ id: "a", start: 3, end: 4 }, { id: "b", start: 4.5, end: 5.5 }] }));
  return { dir, voice };
}

test("buildSchedule places a line's spans at its start and lists a line with no clip", () => {
  const { voice } = voiceFolder();
  const timings = JSON.parse(fs.readFileSync(path.join(voice, "timings.json"), "utf8"));
  const sch = buildSchedule({ timings, voiceDir: voice });
  near(sch.lines[0].spans[0].from, 3.2, 0.001);
  near(sch.lines[0].spans[0].to, 3.6, 0.001);
  assert.equal(sch.lines[0].clipSec, 1);
  assert.deepEqual(sch.skipped, [{ id: "b", reason: "no line-b.wav" }]);
  assert.match(scheduleLines(sch).join("\n"), /b: skipped \(no line-b\.wav\)/);
});

test("buildSchedule steady mode needs no audio and covers every line", () => {
  const sch = buildSchedule({ timings: { lines: [{ id: "a", start: 0, end: 1 }, { id: "b", start: 2, end: 3 }] }, voiceDir: "/nonexistent", mode: "steady", rateHz: 4 });
  assert.equal(sch.skipped.length, 0);
  assert.equal(sch.lines[1].spans[0].from, 2);
});

test("mouth.mjs --dub reads dub/<code>/voice/timings.json and writes mouth.json beside it", () => {
  const { dir, voice } = voiceFolder();
  mouthMain([dir, "--dub", "es"]);
  const out = JSON.parse(fs.readFileSync(path.join(voice, "mouth.json"), "utf8"));
  assert.equal(out.mode, "amplitude");
  assert.equal(out.lines[0].id, "a");
  assert.throws(() => resolveOptions([dir], { mode: "phoneme" }), /amplitude or steady/);
  assert.throws(() => resolveOptions([dir], { threshold: "2" }), /in range/);
});

// ---- 3 drift guard ---------------------------------------------------------------------------------

const TIMELINE = { duration: 10, steps: [{ id: "s1", start: 0, end: 4 }, { id: "s2", start: 4, end: 10 }] };
const FACTS = { duration: 10, fps: 30 };

test("drift guard passes a consistent timeline and keeps the report", () => {
  const r = ReelDrift.guard(TIMELINE, FACTS);
  assert.deepEqual([r.errors, r.notes, r.steps], [[], [], 2]);
  assert.deepEqual(ReelDrift.report(), r);
});

test("drift guard throws on a definite mismatch, naming the step", () => {
  const cases = [
    [{ duration: 10, steps: [{ id: "s1", start: 0, end: 4 }, { id: "s2", start: 3, end: 10 }] }, /s2 starts at 3 s, inside s1/],
    [{ duration: 10, steps: [{ id: "s1", start: 5, end: 8 }, { id: "s2", start: 2, end: 10 }] }, /s2 .*order is broken/],
    [{ duration: 10, steps: [{ id: "s1", start: 0, end: 11 }] }, /s1 ends at 11 s, beyond the film's 10 s/],
    [{ duration: 10, steps: [{ id: "s1", start: -1, end: 4 }] }, /s1 has start -1/],
    [{ duration: 10, steps: [{ id: "s1", start: 3, end: 3 }] }, /s1 has start 3 and end 3/],
    [{ duration: 10, steps: [{ id: "s1", start: 0, end: 4 }, { id: "s1", start: 4, end: 9 }] }, /s1 appears twice/],
    [{ duration: 12, steps: [{ id: "s1", start: 0, end: 4 }] }, /duration 12 s differs from the page's 10 s/],
    [{ duration: 10, steps: [] }, /no steps/],
  ];
  for (const [tl, re] of cases) assert.throws(() => ReelDrift.guard(tl, FACTS), re);
});

test("drift guard compares page step ids with the timeline", () => {
  assert.throws(() => ReelDrift.guard(TIMELINE, { ...FACTS, pageStepIds: ["s1", "s9"] }), /page step s9 is not in the timeline/);
  assert.throws(() => ReelDrift.guard(TIMELINE, { ...FACTS, pageStepIds: ["s1"] }), /page has 1 steps, the timeline 2/);
});

test("drift guard: an offset from the voice line inside the tolerance is a note, beyond it a throw", () => {
  const timings = { lines: [{ id: "l1", start: 0.2 }, { id: "l2", start: 4 }] };
  const tl = { duration: 10, steps: [{ id: "s1", start: 0, end: 4, line: "l1" }, { id: "s2", start: 4, end: 10, line: "l2" }] };
  const r = ReelDrift.guard(tl, { ...FACTS, timings });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.notes, ["step s1 starts -0.20 s from line l1"]);
  assert.throws(() => ReelDrift.guard(tl, { ...FACTS, timings: { lines: [{ id: "l1", start: 1 }, { id: "l2", start: 4 }] } }), /s1 starts -1\.00 s from line l1, more than the 0\.5 s tolerance/);
  assert.throws(() => ReelDrift.guard(tl, { ...FACTS, timings: { lines: [{ id: "l2", start: 4 }] } }), /names line l1, which is not in the voice timings/);
});

test("drift guard: a step too short to read is a note, not a throw", () => {
  const r = ReelDrift.guard({ duration: 10, steps: [{ id: "s1", start: 0, end: 0.2 }, { id: "s2", start: 0.2, end: 10 }] }, FACTS);
  assert.deepEqual(r.errors, []);
  assert.match(r.notes[0], /s1 lasts 0\.20 s/);
});

test("render and verify print the page's graded drift notes", () => {
  assert.deepEqual(driftReportLines(null), []);
  assert.deepEqual(driftReportLines({ errors: [], notes: [], steps: 3 }), ["drift guard: 3 steps checked, no drift"]);
  assert.deepEqual(driftReportLines({ notes: ["step s1 starts 0.30 s from line l1"], steps: 3 }),
    ["drift guard: 3 steps checked, 1 graded note(s) for you to judge", "drift note: step s1 starts 0.30 s from line l1"]);
});

// ---- 4 tempo ---------------------------------------------------------------------------------------

const STAGES = [{ id: "a", start: 0, end: 10 }, { id: "b", start: 10, end: 14 }, { id: "c", start: 14, end: 20 }];

test("tempo is natural over target and every stage shrinks by it", () => {
  const r = fitTempo({ stages: STAGES, natural: 20, target: 10 });
  assert.equal(r.tempo, 2);
  assert.equal(r.appliedTempo, 2);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end, s.factor]), [[0, 5, 2], [5, 7, 2], [7, 10, 2]]);
  assert.equal(r.outOfRange, true);
  assert.match(tempoLines(r).join("\n"), /tempo 2 \(above 1 = faster\)[\s\S]*outside 0\.7-1\.5/);
});

test("a slower target gives a tempo under 1 and stays in range near 1", () => {
  const r = fitTempo({ stages: STAGES, natural: 20, target: 25 });
  assert.equal(r.tempo, 0.8);
  assert.equal(r.outOfRange, false);
  assert.equal(r.segments[2].end, 25);
});

test("a floor keeps short stages at the floor and the others take the rest", () => {
  const r = fitTempo({ stages: STAGES, natural: 20, target: 10, floorSec: 3 });
  const b = r.segments[1];
  assert.equal(b.atFloor, true);
  assert.equal(b.end - b.start, 3);
  assert.ok(r.appliedTempo > r.tempo);
  near(r.segments[2].end, 10, 0.002);
  assert.match(tempoLines(r).join("\n"), /at the floor: b/);
});

test("a target the floors make unreachable is reported, with stages at their floors", () => {
  const r = fitTempo({ stages: STAGES, natural: 20, target: 5, floorSec: 3 });
  assert.equal(r.feasible, false);
  assert.equal(r.appliedTempo, null);
  assert.equal(r.minTotalSec, 9);
  assert.deepEqual(r.segments.map((s) => s.end - s.start), [3, 3, 3]);
  assert.match(tempoLines(r).join("\n"), /target not reachable: .* 9 s/);
});

test("pauses between stages shrink with the tempo", () => {
  const stages = [{ id: "a", start: 0, end: 5 }, { id: "b", start: 7, end: 10 }];
  const r = fitTempo({ stages, natural: 10, target: 5 });
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0, 2.5], [3.5, 5]]);
});

test("fittedTimeline writes new times, the target length and the applied tempo", () => {
  const tl = { duration: 20, steps: STAGES.map((s) => ({ ...s, parts: [s.id] })) };
  const out = fittedTimeline(tl, fitTempo({ stages: STAGES, natural: 20, target: 10 }));
  assert.equal(out.duration, 10);
  assert.equal(out.tempo, 2);
  assert.deepEqual(out.steps[1], { id: "b", start: 5, end: 7, parts: ["b"] });
  assert.equal(tl.steps[1].start, 10, "the input object is not changed");
});

test("tempo.mjs reports without writing unless --out is given, and --out needs a timeline", () => {
  const dir = tmp();
  const tlPath = path.join(dir, "timeline.json");
  fs.writeFileSync(tlPath, JSON.stringify({ duration: 20, steps: STAGES }));
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    tempoMain(["--timeline", tlPath, "--target", "10"]);
    assert.equal(fs.readFileSync(tlPath, "utf8").includes('"tempo"'), false);
    tempoMain(["--timeline", tlPath, "--target", "10", "--out", path.join(dir, "fit.json")]);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "fit.json"), "utf8")).duration, 10);
  const timingsPath = path.join(dir, "timings.json");
  fs.writeFileSync(timingsPath, JSON.stringify({ duration: 8, lines: [{ id: "x", start: 0, end: 8 }] }));
  const input = loadInput({ timings: timingsPath });
  assert.deepEqual([input.natural, input.isTimeline, input.stages.length], [8, false, 1]);
});

// ---- 5 rig-check sampling and the cost report's second location ------------------------------------

test("sampleTimes runs from 0 in steps and ends on the film's end", () => {
  assert.deepEqual(sampleTimes(0.35, 0.1), [0, 0.1, 0.2, 0.3, 0.35]);
  assert.deepEqual(sampleTimes(0.3, 0.1), [0, 0.1, 0.2, 0.3]);
});

test("cost report finds tts-usage.jsonl in dub/<code>/voice/ and in dub/<code>/", () => {
  const film = tmp();
  fs.mkdirSync(path.join(film, "dub", "es", "voice"), { recursive: true });
  fs.mkdirSync(path.join(film, "dub", "fr"), { recursive: true });
  fs.writeFileSync(path.join(film, "dub", "es", "voice", "tts-usage.jsonl"), JSON.stringify({ provider: "p", chars: 70, seconds: 4, cost: 0.2 }) + "\n");
  fs.writeFileSync(path.join(film, "dub", "fr", "tts-usage.jsonl"), JSON.stringify({ provider: "q", chars: 30, seconds: 2, cost: 0.1 }) + "\n");
  const t = ttsUsageFor(film);
  assert.equal(t.logged, true);
  assert.equal(t.files, 2);
  assert.deepEqual(t.rows.map((r) => [r.scope, r.provider, r.chars]), [["dub/es/voice", "p", 70], ["dub/fr", "q", 30]]);
  assert.match(formatReport(reportFor(film)), /dub\/es\/voice \| p \| 1 \| 70 \| 4\.0 \| 0\.2000/);
});
