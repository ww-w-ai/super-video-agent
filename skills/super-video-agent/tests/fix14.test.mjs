// FIX14: a borrowed breath survives rebuilds; --pick beside new lines; layout child/highlight gates;
// kit effects (seeded pop and ding, variant pools, fixed master drive); corner reserve.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeAll, main } from "../scripts/voice.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import { ffmpeg } from "../scripts/lib/ffmpeg.mjs";
import * as none from "../scripts/voice/none.mjs";
import { borrowedPauseRecord, carriedBorrowedGap, splitPlanByAudio } from "../scripts/voice/line-edit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p = "sva-fix14-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

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

// --- 5: borrowed breath ---------------------------------------------------------------------

const BASE = { providerName: "none", voiceCfg: {}, lang: "ko-KR", gapMs: 250, sttEnabled: false };
const A_TEXT = "가나다라마바사아자차카타파하"; // none.mjs: 7 characters per second, 14 = 2.0 s
const LINES = [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄" }, { id: "c", text: "마지막 줄" }];

async function borrowedRun() {
  const dir = tmp();
  const paths = reelPaths(dir);
  const args = { ...BASE, dir, paths, provider: none };
  const first = await synthesizeAll({ ...args, lines: LINES });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  const longA = [{ id: "a", text: A_TEXT, say: "가".repeat(17) }, ...LINES.slice(1)];
  let run;
  await captureStdout(async () => {
    run = await synthesizeAll({ ...args, lines: longA, onlyLineIds: ["a"] });
  });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(run.timings));
  return { dir, paths, args, first, run, longA };
}

const startOf = (timings, id) => timings.lines.find((l) => l.id === id).start;

test("5: a take that borrowed breath records the pause it laid in timings.json", async (t) => {
  const { dir, run, first } = await borrowedRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = run.timings.lines[0];
  assert.ok(a.borrowedPause, "borrowedPause on the borrowing line");
  assert.equal(a.borrowedPause.plannedSec, 0.25, "the plan's pause, before the 0.5 s minimum breath");
  assert.ok(Math.abs(startOf(run.timings, "b") - startOf(first.timings, "b")) < 1e-6);
  assert.equal(run.timings.lines[1].borrowedPause, undefined);
});

test("5: --lines \"\" (no line re-made) lays the borrowed pause again: later lines stay", async (t) => {
  const { dir, args, run, longA } = await borrowedRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let again;
  await captureStdout(async () => {
    again = await synthesizeAll({ ...args, lines: longA, onlyLineIds: [] });
  });
  for (const id of ["b", "c"]) assert.ok(Math.abs(startOf(again.timings, id) - startOf(run.timings, id)) < 1e-6, `${id} keeps its start`);
  assert.deepEqual(again.moved, []);
  assert.deepEqual(again.timings.lines[0].borrowedPause, run.timings.lines[0].borrowedPause);
});

test("5: a --retime run of another line keeps the borrowed pause of the reused one", async (t) => {
  const { dir, args, run, longA } = await borrowedRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let again;
  await captureStdout(async () => {
    again = await synthesizeAll({ ...args, lines: longA, onlyLineIds: ["c"], keepTiming: false });
  });
  assert.ok(Math.abs(startOf(again.timings, "b") - startOf(run.timings, "b")) < 1e-6);
});

test("5: a changed plan pause after the borrowing line wins: the borrowed one is dropped", async (t) => {
  const { dir, args, run, longA } = await borrowedRun();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const edited = longA.map((l) => (l.id === "a" ? { ...l, pauseAfterMs: 1500 } : l));
  let again;
  await captureStdout(async () => {
    again = await synthesizeAll({ ...args, lines: edited, onlyLineIds: [] });
  });
  assert.equal(again.timings.lines[0].borrowedPause, undefined);
  assert.ok(startOf(again.timings, "b") > startOf(run.timings, "b") + 0.5, "b moves later by the new pause");
});

test("5: carriedBorrowedGap reads the record only while the plan pause is the one it was borrowed from", () => {
  const rec = borrowedPauseRecord(0.5, 0.07);
  assert.equal(carriedBorrowedGap({ borrowedPause: rec }, 0.5), 0.07);
  assert.equal(carriedBorrowedGap({ borrowedPause: rec }, 0.5004), 0.07);
  assert.equal(carriedBorrowedGap({ borrowedPause: rec }, 0.9), null);
  assert.equal(carriedBorrowedGap({}, 0.5), null);
  assert.equal(carriedBorrowedGap(undefined, 0.5), null);
});

// --- 6: --pick beside new lines -------------------------------------------------------------

test("6: splitPlanByAudio leaves out a line with no clip that is not picked", () => {
  const plan = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const have = new Set(["a", "b"]);
  const r = splitPlanByAudio(plan, ["c"], (id) => have.has(id));
  assert.deepEqual(r.lines.map((l) => l.id), ["a", "b", "c"]);
  assert.deepEqual(r.waiting, ["d"]);
});

test("6: --pick installs the picked take while a new line has no audio yet, and names the new line", async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  const first = await synthesizeAll({ ...BASE, dir, paths, provider: none, lines: LINES.slice(0, 2) });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  fs.writeFileSync(paths.planJson, JSON.stringify({ meta: { title: "t", gapMs: 250, voice: { provider: "none" } }, lines: LINES }));
  fs.mkdirSync(path.join(paths.voiceDir, "takes"), { recursive: true });
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=1.9", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", path.join(paths.voiceDir, "takes", "a-1.wav")]);
  const out = await captureStdout(async () => {
    await main([dir, "--pick", "a=1", "--no-stt"]);
  });
  assert.match(out, /no audio yet for c — left out of this rebuild; make it next with --lines c/);
  assert.match(out, /installed take\(s\): a=1/);
  assert.deepEqual(readJson(paths.timingsJson).lines.map((l) => l.id), ["a", "b"]);
});

// --- 7, 8: layout gates ---------------------------------------------------------------------

await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
await import(path.join(here, "..", "scripts", "engine", "reel-layout.js"));
const Reel = globalThis.Reel;
const RL = globalThis.ReelLayout;
const measure = (s) => s.length * 10;
const issueTypes = () => Reel.issues().map((i) => i.type);

test("7: layoutChips packs by measured width into centred rows, all inside the box, no issue", () => {
  Reel.clearIssues();
  const box = { x: 100, y: 200, w: 800, h: 300 };
  const names = ["alpha", "beta tool", "gamma", "delta tool kit", "epsilon", "zeta", "eta tool", "theta", "iota", "kappa tool", "lambda", "mu", "nu tool", "xi"];
  const r = RL.layoutChips(measure, names, box);
  assert.equal(r.fits, true);
  assert.ok(r.rows >= 2, `rows ${r.rows}`);
  assert.equal(r.chips.length, names.length);
  for (const c of r.chips) assert.ok(c.x >= 128 && c.x + c.w <= 872 && c.y >= 200 && c.y + c.h <= 500, `${c.text} inside`);
  for (let row = 0; row < r.rows; row++) {
    const cs = r.chips.filter((c) => c.row === row);
    const left = cs[0].x - 100;
    const right = 900 - (cs[cs.length - 1].x + cs[cs.length - 1].w);
    assert.ok(Math.abs(left - right) <= 1, `row ${row} centred: ${left} vs ${right}`);
  }
  assert.deepEqual(issueTypes(), []);
});

test("7: a chip wider than the box records child-outside-box with its text, and fits is false", () => {
  Reel.clearIssues();
  const r = RL.layoutChips(measure, ["short", "a very very very very long tool label that cannot fit"], { x: 0, y: 0, w: 300, h: 200 });
  assert.equal(r.fits, false);
  assert.deepEqual(r.overflow.map((c) => c.text), ["a very very very very long tool label that cannot fit"]);
  const issue = Reel.issues().find((i) => i.type === "child-outside-box");
  assert.equal(issue.id, "a very very very very long tool label that cannot fit");
  assert.ok(issue.over.right > 0 || issue.over.left > 0);
});

test("7: too many rows for the box height record the chips that leave it", () => {
  Reel.clearIssues();
  const r = RL.layoutChips(measure, Array.from({ length: 12 }, (_, i) => "chip number " + i), { x: 0, y: 0, w: 300, h: 100 });
  assert.equal(r.fits, false);
  assert.ok(Reel.issues().some((i) => i.type === "child-outside-box" && i.over.bottom + i.over.top > 0));
});

test("7: checkInside reports the sides crossed; a child on the edge is inside; a malformed rect throws", () => {
  Reel.clearIssues();
  assert.equal(RL.checkInside("edge", [10, 10, 110, 60], [10, 10, 110, 60]).inside, true);
  const out = RL.checkInside("wide", { left: 0, top: 20, right: 130, bottom: 40 }, [10, 10, 110, 60]);
  assert.equal(out.inside, false);
  assert.deepEqual(out.over, { left: 10, top: 0, right: 20, bottom: 0 });
  assert.deepEqual(issueTypes(), ["child-outside-box"]);
  assert.throws(() => RL.checkInside("bad", [1, 2, 3], [0, 0, 5, 5]), /must be \{x, y, w, h\}/);
});

test("7: the review layout gate counts child-outside-box (it is not an engine fact)", async () => {
  const { splitEngineFacts } = await import("../scripts/lib/browser.mjs");
  Reel.clearIssues();
  RL.checkInside("c", [0, 0, 50, 10], [0, 0, 20, 10]);
  const { layout, facts } = splitEngineFacts(Reel.issues());
  assert.equal(layout.length, 1);
  assert.equal(facts.length, 0);
});

test("8: a frame must enclose its target; a frame that stops short records highlight-misses-target", () => {
  Reel.clearIssues();
  assert.equal(RL.checkHighlight({ id: "f1", kind: "frame", rect: [90, 90, 310, 210], target: [100, 100, 300, 200] }).ok, true);
  const miss = RL.checkHighlight({ id: "f2", kind: "frame", rect: [90, 90, 250, 210], target: [100, 100, 300, 200] });
  assert.equal(miss.ok, false);
  assert.equal(miss.issue.type, "highlight-misses-target");
  assert.equal(miss.issue.mode, "enclose");
  assert.deepEqual(issueTypes(), ["highlight-misses-target"]);
});

test("8: a bracket or arrow must sit near its target (24 px), a label 300 px away does not", () => {
  Reel.clearIssues();
  assert.equal(RL.checkHighlight({ id: "b1", kind: "bracket", rect: [60, 100, 90, 200], target: [100, 100, 300, 200] }).ok, true);
  const far = RL.checkHighlight({ id: "b2", kind: "arrow", rect: [0, 100, 20, 200], target: [320, 100, 520, 200] });
  assert.equal(far.ok, false);
  assert.equal(far.issue.gap, 300);
  assert.equal(RL.checkHighlight({ id: "b3", kind: "arrow", rect: [0, 100, 20, 200], target: [320, 100, 520, 200], reach: 400 }).ok, true);
  assert.equal(RL.checkHighlight({ id: "o1", kind: "frame", mode: "overlap", rect: [250, 150, 400, 260], target: [100, 100, 300, 200] }).ok, true);
  assert.throws(() => RL.checkHighlight({ id: "m", kind: "frame", mode: "inside", rect: [0, 0, 1, 1], target: [0, 0, 1, 1] }), /highlight mode/);
});

test("8: drawLog reports a highlight drawn before its target, and one whose target was never drawn", () => {
  Reel.clearIssues();
  const ok = RL.drawLog();
  ok.target("clip", [0, 0, 400, 300]);
  ok.highlight("clip-frame", "clip", [-5, -5, 405, 305], { kind: "frame" });
  assert.deepEqual(ok.check(), []);

  const wrong = RL.drawLog();
  wrong.highlight("under", "clip", [-5, -5, 405, 305], { kind: "frame" });
  wrong.target("clip", [0, 0, 400, 300]);
  wrong.highlight("ghost", "nothing", [0, 0, 5, 5], { kind: "bracket" });
  assert.deepEqual(wrong.check().map((i) => i.type), ["highlight-under-target", "highlight-target-missing"]);
  assert.deepEqual(issueTypes(), ["highlight-under-target", "highlight-target-missing"]);
});

// --- 9: kit effects ---------------------------------------------------------------------------

await import(path.join(here, "..", "scripts", "engine", "reel-audio.js"));
const RA = globalThis.ReelAudio;
const SR = 48000;
const sameBuf = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const crossings = (buf, n) => {
  let c = 0;
  for (let i = 1; i < Math.min(n, buf.length); i++) if (buf[i - 1] < 0 !== buf[i] < 0) c++;
  return c;
};

test("9: pop and ding honour their seed: one seed repeats, two seeds differ, no seed is unchanged", () => {
  for (const kind of ["pop", "ding"]) {
    const a1 = RA.sfx[kind](SR, { seed: "a" });
    assert.ok(sameBuf(a1, RA.sfx[kind](SR, { seed: "a" })), `${kind}: same seed, same samples`);
    assert.ok(!sameBuf(a1, RA.sfx[kind](SR, { seed: "b" })), `${kind}: two seeds differ`);
    assert.ok(sameBuf(RA.sfx[kind](SR), RA.sfx[kind](SR)), `${kind}: no seed is stable`);
  }
});

test("9: a seed moves pitch within +-3 semitones; an explicit freq keeps its pitch while the timbre varies", () => {
  const rates = ["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => crossings(RA.sfx.pop(SR, { seed: s }), 4000));
  assert.ok(Math.max(...rates) > Math.min(...rates), "seeded pops differ in pitch");
  const exact = ["s1", "s2", "s3"].map((s) => RA.sfx.pop(SR, { seed: s, freq: 700 }));
  const zc = exact.map((b) => crossings(b, 4000));
  assert.ok(Math.max(...zc) - Math.min(...zc) <= 3, `explicit freq keeps pitch: ${zc}`);
  assert.ok(!sameBuf(exact[0], exact[1]), "timbre still varies with the seed");
});

const POOLS = {
  pop: [{ gen: "pop" }, { gen: "pop", rate: 1.12 }, { gen: "pop", rate: 0.89 }, { file: "ping", like: "pop" }],
  ding: [{ file: "ding-a", like: "ding" }, { file: "ding-b", like: "ding" }],
};

function popCues(n) {
  return Array.from({ length: n }, (_, i) => ({ kind: "pop", at: i * 0.5 }));
}

test("9: sfxPool.assign never puts the same variant of a kind next to itself and spreads the use", () => {
  const cues = popCues(40);
  RA.sfxPool(POOLS, { seed: "film" }).assign(cues);
  for (let i = 1; i < cues.length; i++) assert.notEqual(cues[i].sound, cues[i - 1].sound, `neighbours at ${i}`);
  const counts = {};
  for (const c of cues) counts[c.sound] = (counts[c.sound] || 0) + 1;
  assert.deepEqual(Object.keys(counts).sort(), ["pop-0", "pop-1", "pop-2", "ping"].sort());
  assert.ok(Math.max(...Object.values(counts)) <= 11, JSON.stringify(counts));
});

test("9: sfxPool.assign works in time order on an unsorted list, per kind, and is the same for the same seed", () => {
  const cues = [{ kind: "ding", at: 3 }, { kind: "pop", at: 2 }, { kind: "ding", at: 1 }, { kind: "pop", at: 0 }, { kind: "ding", at: 2 }, { kind: "whoosh", at: 0.5 }];
  const run = (seed) => RA.sfxPool(POOLS, { seed }).assign(cues.map((c) => ({ ...c }))).map((c) => c.sound);
  assert.deepEqual(run("x"), run("x"));
  const out = RA.sfxPool(POOLS, { seed: "x" }).assign(cues.map((c) => ({ ...c })));
  const dings = out.filter((c) => c.kind === "ding").sort((a, b) => a.at - b.at).map((c) => c.sound);
  assert.equal(new Set(dings).size, 2, "three dings over two files: the first two differ");
  assert.notEqual(dings[0], dings[1]);
  assert.notEqual(dings[1], dings[2]);
  assert.equal(out.find((c) => c.kind === "whoosh").sound, undefined, "a kind without a pool is left alone");
});

test("9: sfxPool.buffer levels a library file to its kind's own peak, mixes with synth variants, and caches", () => {
  const files = { ping: { rate: 44100, data: Float32Array.from({ length: 4410 }, (_, i) => 0.05 * Math.sin(i / 7)) }, "ding-a": { rate: SR, data: Float32Array.from({ length: 9600 }, (_, i) => 0.9 * Math.sin(i / 5)) } };
  const pool = RA.sfxPool(POOLS, { seed: "film" });
  const cues = popCues(8);
  pool.assign(cues);
  const fileCue = cues.find((c) => c.sound === "ping");
  const synthCue = cues.find((c) => c.sound === "pop-1");
  const peak = (b) => b.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  assert.ok(Math.abs(peak(pool.buffer(fileCue, SR, files)) - peak(RA.sfx.pop(SR, { seed: "pop:ref" }))) < 1e-3, "file at the pop's own peak");
  assert.ok(pool.buffer(synthCue, SR, files).length < RA.sfx.pop(SR, { seed: "pop-1" }).length, "rate 1.12 plays shorter");
  assert.equal(pool.buffer(fileCue, SR, files), pool.buffer(fileCue, SR, files), "cached per sound and rate");
  assert.equal(pool.buffer({ kind: "whoosh", at: 0 }, SR, files), null);
  assert.throws(() => RA.sfxPool(POOLS, { seed: "film" }).buffer(fileCue, SR, {}), /no loaded file "ping"/);
});

test("9: master has a fixed drive: adding a loud hit elsewhere leaves another hit's level unchanged", () => {
  const hit = RA.sfx.click(SR);
  const render = (extra) => {
    const m = RA.mix(1, SR);
    m.add(hit, 0.1, 0.5, 0);
    if (extra) m.add(RA.sfx.thud(SR), 0.6, 3, 0);
    return RA.master(m, { peakDb: -15 });
  };
  const alone = render(false);
  const withLoud = render(true);
  const win = (m) => m.L.slice(Math.round(0.1 * SR), Math.round(0.2 * SR));
  assert.ok(sameBuf(win(alone), win(withLoud)), "the click is the same sample for sample");
  assert.throws(() => RA.master(RA.mix(1, SR), { refPeak: 0 }), /refPeak/);
});

test("9: a sample at refPeak lands on peakDb", () => {
  const m = RA.mix(1, SR);
  m.add(Float32Array.from([0.35]), 0.1, 1, -1);
  RA.master(m, { peakDb: -6 });
  assert.ok(Math.abs(Math.abs(m.L[Math.round(0.1 * SR)]) - Math.pow(10, -6 / 20)) < 1e-6);
});

test("9: assets search finds library chimes for 'ding' and for 'chime'", async () => {
  const { loadLibrary, searchAssetsRanked } = await import("../scripts/lib/library.mjs");
  const dir = tmp("sva-fix14-lib-");
  const entry = (id, desc, tags) => ({ id, role: "sfx", kind: "audio", path: `sfx/made/${id}.wav`, description: desc, tags, durationSec: 0.9, hasAudio: true, license: { kind: "user", commercialSafe: true } });
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ version: 1, assets: [
    entry("chime-glass", "effect: chime, a high glass note", ["glass", "ding", "chime", "notification"]),
    entry("chime-bell", "effect: chime, a small bell", ["bell", "ding", "chime"]),
    entry("thud-1", "effect: a low thud", ["thud"]),
  ] }));
  const lib = loadLibrary(dir);
  for (const q of ["ding", "chime"]) assert.deepEqual(searchAssetsRanked(lib, q, { role: "sfx" }).map((r) => r.asset.id).sort(), ["chime-bell", "chime-glass"], q);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 10: corner reserve ------------------------------------------------------------------------

test("10: plan.json meta.corners validates: four named corners with a box, an optional label", async () => {
  const { validate } = await import("../scripts/lib/schema-check.mjs");
  const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));
  const plan = (corners) => ({ meta: { title: "t", corners }, lines: [{ id: "a", text: "x" }] });
  assert.equal(validate(plan({ tl: { box: [0, 0, 300, 120], label: "Series" }, br: { box: [800, 1700, 1080, 1920] } }), schema).valid, true);
  assert.equal(validate(plan({ center: { box: [0, 0, 1, 1] } }), schema).valid, false);
  assert.equal(validate(plan({ tl: { box: [0, 0, 300] } }), schema).valid, false);
  assert.equal(validate(plan({ tl: { label: "no box" } }), schema).valid, false);
});

test("10: Reel.cornerRegions turns meta.corners into reserve regions the engine accepts", () => {
  const regions = Reel.cornerRegions({ tr: { box: [700, 0, 1080, 140] }, tl: { box: [0, 0, 300, 120], label: "Series" } });
  assert.deepEqual(regions.map((r) => r.id), ["corner-tl", "corner-tr"]);
  assert.ok(regions.every((r) => r.kind === "reserve"));
  assert.equal(regions[0].text, "Series");
  assert.equal(regions[1].text, undefined);
  assert.equal(Reel.checkRegions(regions).length, 2);
  assert.deepEqual(Reel.cornerRegions(undefined), []);
});

const frame = (n, texts) => ({ frame: n, texts: texts.map(([text, box, alpha = 1]) => ({ text, box, alpha, font: "20px x" })) });

test("10: reserveIntrusions lists picture text inside a reserved box, not the label itself nor text outside", async () => {
  const { reserveIntrusions, reserveScope } = await import("../scripts/lib/state-checks.mjs");
  const regions = [{ id: "corner-tl", kind: "reserve", box: [0, 0, 300, 120], text: "Series" }];
  const frames = [
    frame(0, [["Series", [20, 20, 200, 60]], ["Title", [400, 20, 700, 60]]]),
    frame(1, [["Series", [20, 20, 200, 60]], ["Caption over corner", [100, 80, 500, 140]]]),
    frame(2, [["Caption over corner", [100, 80, 500, 140]], ["faint", [10, 10, 100, 40], 0.01]]),
    frame(3, [["Title", [400, 20, 700, 60]]]),
  ];
  assert.equal(reserveScope(regions), 1);
  const found = reserveIntrusions(frames, regions, { fps: 10, duration: 1 });
  assert.equal(found.length, 1);
  assert.deepEqual({ ...found[0], sharePx: undefined }, { reserve: "corner-tl", text: "Caption over corner", from: 0.1, to: 0.3, frames: 2, sharePx: undefined });
  assert.equal(found[0].sharePx, 200 * 40);
});

test("10: a reserve is active only inside its from/to window", async () => {
  const { reserveIntrusions } = await import("../scripts/lib/state-checks.mjs");
  const regions = [{ id: "corner-bl", kind: "reserve", box: [0, 1800, 300, 1920], from: 0.2, to: 0.3 }];
  const frames = [0, 1, 2, 3].map((n) => frame(n, [["note", [10, 1810, 200, 1850]]]));
  const found = reserveIntrusions(frames, regions, { fps: 10, duration: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].frames, 1);
  assert.equal(found[0].from, 0.2);
});

test("10: a key region overlapping a reserved corner is reported by covers; the report names the intruders", async () => {
  const { regionCovers, regionScope, formatStateChecks } = await import("../scripts/lib/state-checks.mjs");
  const regions = [{ id: "corner-tl", kind: "reserve", box: [0, 0, 300, 120] }, { id: "chart", kind: "key", box: [200, 60, 900, 600] }];
  const covers = regionCovers(regions, { duration: 5 });
  assert.equal(covers.length, 1);
  assert.equal(covers[0].label, "corner-tl");
  assert.equal(covers[0].key, "chart");
  assert.deepEqual(regionScope(regions), { keys: 1, covering: 1 });
  const text = formatStateChecks({ sampledFrames: 3, reserve: [{ reserve: "corner-tl", text: "Title", from: 0.1, to: 0.3, frames: 2, sharePx: 800 }], reserveCorners: 1 });
  assert.match(text, /picture text inside a reserved corner: 1\n  "Title" in corner-tl: 0\.100–0\.300 s \(2 frames, up to 800 px²\)/);
  assert.match(formatStateChecks({ sampledFrames: 3, reserve: [], reserveCorners: 2 }), /checked 2 reserved corners, 0 intruders/);
  assert.equal(formatStateChecks({ sampledFrames: 3, reserve: [], reserveCorners: 0 }).includes("reserved corner"), false);
});
