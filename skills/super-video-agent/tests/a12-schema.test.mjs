// A12: plan schema and contracts — pauseBeforeMs (30), doc/schema mismatch facts (L8/78), sayWhy / stale-say threshold,
// line notes, page-contract mirror, style.fonts, the overlay-key scan, and the A3 review fixes in voice.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/lib/schema-check.mjs";
import { readJson, reelPaths } from "../scripts/lib/reeldir.mjs";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";
import { staleSayWarnings, noteWordWarnings, docSchemaMismatches, scanLabelKeys, missingOverlayKeys, estimateLength } from "../scripts/validate-plan.mjs";
import { synthesizeAll, main, foldPauseBefore } from "../scripts/voice.mjs";
import * as none from "../scripts/voice/none.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readJson(path.join(HERE, "..", "scripts", "plan.schema.json"));
const VALIDATE_MJS = path.join(HERE, "..", "scripts", "validate-plan.mjs");
const tmp = (p = "sva-a12-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const plan = (lines, meta = {}) => ({ meta: { title: "t", lang: "en-US", ...meta }, lines });

async function quiet(fn) {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  // The test runner's own events are binary chunks on stdout: pass them through, capture only text.
  process.stdout.write = (c, ...rest) => {
    if (typeof c !== "string") return write(c, ...rest);
    out += c;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

// --- schema --------------------------------------------------------------------------------

test("30 / carry a: pauseBeforeMs, sayWhy and notes validate; wrong shapes are named", () => {
  const ok = plan([{ id: "a", text: "Hello there", say: "Hello thar", sayWhy: "dialect", pauseBeforeMs: 1200, notes: [{ at: "start", text: "n" }, { at: "word:there", text: "m", corner: "bl", holdSec: 2 }] }]);
  assert.deepEqual(validate(ok, SCHEMA).errors, []);
  const bad = plan([{ id: "a", text: "Hi", pauseBeforeMs: -1, sayWhy: "", notes: [{ at: "middle", text: "x", corner: "center" }, { at: "start" }] }]);
  const errors = validate(bad, SCHEMA).errors.join("\n");
  assert.match(errors, /lines\[0\]\.pauseBeforeMs: -1 < minimum 0/);
  assert.match(errors, /lines\[0\]\.sayWhy: string shorter than minLength/);
  assert.match(errors, /lines\[0\]\.notes\[0\]\.at: "middle" does not match pattern/);
  assert.match(errors, /lines\[0\]\.notes\[0\]\.corner: value "center" not in enum/);
  assert.match(errors, /lines\[0\]\.notes\[1\]: missing required property "text"/);
});

test("L8/78: meta.filmKey and meta.id (read by the templates) are in the schema", () => {
  assert.deepEqual(validate(plan([{ id: "a", text: "x" }], { filmKey: "basketball", id: "f1" }), SCHEMA).errors, []);
});

test("carry d: style.fonts is a map of font lists; a non-string list is named", () => {
  const good = plan([{ id: "a", text: "x" }]);
  good.style = { fonts: { ko: "'Pretendard'", caption: "Inter", default: "sans-serif" } };
  assert.deepEqual(validate(good, SCHEMA).errors, []);
  good.style.fonts.body = 4;
  assert.match(validate(good, SCHEMA).errors.join("\n"), /\$\.style\.fonts\.body: expected string, got number/);
});

test("carry d: the window.__reel mirror checks regions, holds, captionFonts and langSpans (in: layer | scene)", () => {
  const page = {
    regions: [{ id: "face", kind: "key", box: [0, 0, 100, 100] }, { id: "logo", kind: "overlay", box: [10, 10, 40, 40], outline: 4, from: 0, to: 9 }],
    holds: [{ from: 1, to: 2, reason: "slow-mo" }],
    captionFonts: { ko: "'Pretendard'", "*": "sans-serif" },
    langSpans: [{ start: 1, end: 2 }, { start: 3, end: 4, in: "scene" }],
  };
  assert.deepEqual(validate(page, SCHEMA, "#/definitions/pageContract").errors, []);
  const bad = { regions: [{ id: "x", kind: "wall", box: [0, 0, 1] }], langSpans: [{ start: 1, end: 2, in: "camera" }] };
  const errors = validate(bad, SCHEMA, "#/definitions/pageContract").errors.join("\n");
  assert.match(errors, /regions\[0\]\.kind: value "wall" not in enum/);
  assert.match(errors, /regions\[0\]\.box: array shorter than minItems 4/);
  assert.match(errors, /langSpans\[0\]\.in: value "camera" not in enum/);
});

test("L4: the sfxCue definition documents card: true", () => {
  assert.deepEqual(validate({ kind: "pop", at: 1.5, id: "p1", card: true }, SCHEMA, "#/definitions/sfxCue").errors, []);
  assert.match(validate({ kind: "pop", at: 1, card: "yes" }, SCHEMA, "#/definitions/sfxCue").errors.join("\n"), /card: expected boolean/);
});

// --- validate-plan ---------------------------------------------------------------------------

test("carry b: a respelling stays quiet; a say from an older text warns; sayWhy silences it", () => {
  const p = plan([
    { id: "close", text: "We shipped the new editor today.", say: "We shipped the new editer today." },
    { id: "old", text: "We shipped the new editor today.", say: "A completely different sentence about cats." },
    { id: "why", text: "We shipped the new editor today.", say: "A completely different sentence about cats.", sayWhy: "on purpose" },
  ]);
  const warns = staleSayWarnings(p);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^"old" CER \d\.\d\d/);
});

test("carry c: a note word that is not in the line text is a warning naming it", () => {
  const p = plan([{ id: "a", text: "The | quick fox", notes: [{ at: "word:quick", text: "ok" }, { at: "word:slow", text: "no" }, { at: "start", text: "s" }] }]);
  const warns = noteWordWarnings(p);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /lines\[0\]\.notes\[1\]\.at: "word:slow" matches no word in line "a"/);
});

test("L8/78: an unexpected field that a doc names prints doc/schema mismatch; one named nowhere does not", () => {
  const errors = ['$.meta: unexpected property "mood"', '$.lines[2]: unexpected property "beat"', '$.meta: unexpected property "nowhere"'];
  const docs = [["references/x.md", "Set `meta.mood` to calm. A line has `line.beat` too."]];
  const facts = docSchemaMismatches({ errors, schema: SCHEMA, sources: [], docs });
  assert.deepEqual(facts.map((f) => f.split(" — ")[0]), ["doc/schema mismatch: $.meta.mood", "doc/schema mismatch: $.lines[2].beat"]);
  assert.match(facts[0], /named in references\/x\.md but rejected by plan\.schema\.json; check which is right/);
});

test("L8/78: a meta field the page reads that the schema lacks is listed", () => {
  const facts = docSchemaMismatches({ errors: [], schema: SCHEMA, sources: [["reel.html", "var meta = (plan && plan.meta) || {};\nvar k = meta.filmKey || meta.title || meta.sparkle;"]], docs: [] });
  assert.equal(facts.length, 1);
  assert.match(facts[0], /^doc\/schema mismatch: meta\.sparkle — read by reel\.html/);
});

test("L8/78: the shipped templates read no meta field the schema lacks", () => {
  const dir = path.join(HERE, "..", "assets", "template");
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
  assert.deepEqual(docSchemaMismatches({ errors: [], schema: SCHEMA, sources, docs: [] }), []);
});

test("e: label keys are scanned from literal calls and checked per dub plan", () => {
  const src = [["reel.html", `
    ctx.fillText(Reel.pictureText("brand", "Morning"), 1, 2);
    Reel.pictureText('wall', 'x');
    const t = Reel.overlayText(plan.meta.overlay, "endCard", "Thanks", { dub });
    Reel.overlayText("title", "T");
    Reel.pictureText(keyVar, "x");
  `]];
  const keys = scanLabelKeys(src);
  assert.deepEqual(keys.picture, ["brand", "wall"]);
  assert.deepEqual(keys.overlay, ["endCard", "title"]);
  assert.equal(keys.notScanned, 1);
  const facts = missingOverlayKeys(keys, [
    { code: "ko", plan: { meta: { overlay: { title: "제목", endCard: "감사", picture: { brand: "아침" } } } } },
    { code: "ja", plan: { meta: {} } },
  ]);
  assert.equal(facts.length, 2);
  assert.match(facts[0], /^overlay keys \(dub\/ko\): Reel\.pictureText "wall" \(meta\.overlay\.picture\) missing in dub\/ko\/plan\.json/);
  assert.match(facts[1], /dub\/ja.*pictureText "brand", "wall".*overlayText "endCard", "title"/);
});

test("e: validate-plan prints the missing keys of a dub and a mismatch for a page-read meta field; exit stays 0", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan([{ id: "a", text: "x" }])));
  fs.writeFileSync(path.join(dir, "reel.html"), 'Reel.pictureText("brand", "B");\nconst meta = plan.meta;\nconst z = meta.sparkle;');
  fs.mkdirSync(path.join(dir, "dub", "ko"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dub", "ko", "plan.json"), JSON.stringify(plan([{ id: "a", text: "엑스" }], { lang: "ko" })));
  const res = spawnSync(process.execPath, [VALIDATE_MJS, dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^ok\n/);
  assert.match(res.stdout, /doc\/schema mismatch: meta\.sparkle — read by reel\.html/);
  assert.match(res.stdout, /overlay keys \(dub\/ko\): Reel\.pictureText "brand"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("L8/78: validate-plan on a plan with a rejected field still fails, with the schema's own message", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan([{ id: "a", text: "x" }], { notAField: 1 })));
  const res = spawnSync(process.execPath, [VALIDATE_MJS, dir], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unexpected property "notAField"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("30: --estimate counts pauseBeforeMs in the pauses and moves the line's start", () => {
  const base = estimateLength(plan([{ id: "a", text: "one two three" }, { id: "b", text: "four five six" }]), { rate: 3, leadSec: 0 });
  const withPause = estimateLength(plan([{ id: "a", text: "one two three" }, { id: "b", text: "four five six", pauseBeforeMs: 2000 }]), { rate: 3, leadSec: 0 });
  assert.ok(Math.abs(withPause.totalSec - base.totalSec - 2) < 1e-9);
  assert.ok(Math.abs(withPause.lines[1].start - base.lines[1].start - 2) < 1e-9);
});

// --- voice.mjs: pauseBeforeMs -------------------------------------------------------------------

const BASE = { providerName: "none", voiceCfg: { levelLines: false }, lang: "ko-KR", gapMs: 250, sttEnabled: false };
const A_TEXT = "가나다라마바사아자차카타파하"; // none.mjs: 7 characters per second, 14 = 2.0 s

async function firstRun(lines) {
  const dir = tmp();
  const paths = reelPaths(dir);
  const args = { ...BASE, dir, paths, provider: none };
  let first;
  const out = await quiet(async () => {
    first = await synthesizeAll({ ...args, lines });
  });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  return { dir, paths, args, first, out };
}

test("30: pauseBeforeMs puts that much silence before the line; narration and timings agree", async (t) => {
  const lines = [{ id: "a", text: "가나다라마바사" }, { id: "b", text: "하나 둘 셋 넷", pauseBeforeMs: 1500 }];
  const plain = await firstRun(lines.map(({ id, text }) => ({ id, text })));
  const { dir, paths, first } = await firstRun(lines);
  t.after(() => [dir, plain.dir].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const [a, b] = first.timings.lines;
  const [, pb] = plain.first.timings.lines;
  assert.ok(Math.abs(b.start - pb.start - 1.5) < 1e-6, `b starts ${b.start}, without the pause ${pb.start}`);
  assert.equal(b.pauseBeforeSec, 1.5);
  assert.equal(a.pauseBeforeSec, undefined);
  assert.ok(Math.abs(first.timings.duration - plain.first.timings.duration - 1.5) < 1e-6);
  assert.ok(Math.abs((await probeDuration(paths.narrationWav)) - first.timings.duration) < 0.05, "narration.wav is as long as timings.duration");
  assert.equal(fs.readdirSync(paths.voiceDir).filter((f) => f.startsWith("_silence")).length, 0, "no silence temp file is left");
});

test("30: a pause before the first line comes after the head; the silence gate lists the stretch as planned", async (t) => {
  const lines = [{ id: "a", text: "가나다라마바사", pauseBeforeMs: 2000 }, { id: "b", text: "하나 둘 셋 넷", pauseBeforeMs: 2500 }];
  const { dir, first, out } = await firstRun(lines);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(first.timings.lines[0].start >= 2.0, `a starts ${first.timings.lines[0].start}`);
  assert.match(out, /silence gate: no unplanned gap over 1 s/);
  const folded = foldPauseBefore([{ id: "a" }, { id: "b", pauseBeforeMs: 2500 }], 700);
  assert.equal(folded[0].pauseAfterMs, 3200);
  assert.equal(folded[1].pauseAfterMs, undefined);
});

test("30: re-making the line before a pauseBeforeMs line leaves that line where it was", async (t) => {
  const lines = [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄", pauseBeforeMs: 1000 }];
  const { dir, args, first } = await firstRun(lines);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let run;
  await quiet(async () => {
    run = await synthesizeAll({ ...args, lines: [{ id: "a", text: A_TEXT, say: "가".repeat(15) }, lines[1]], onlyLineIds: ["a"] });
  });
  assert.deepEqual(run.refused, []);
  assert.deepEqual(run.moved, []);
  assert.ok(Math.abs(run.timings.lines[1].start - first.timings.lines[1].start) < 1e-6);
});

// --- voice.mjs: A3 review fixes ---------------------------------------------------------------

/** none.mjs wrapped as a batch provider that writes the clip in place, as typecast / fish / elevenlabs do. */
const inPlaceBatch = {
  async synthBatch(items) {
    const out = [];
    for (const it of items) out.push({ ...(await none.synth({ text: it.text, outPath: it.outPath })), id: it.id });
    return out;
  },
};

test("review 1 (HIGH): a refused re-take by a batch provider restores the old clip, not the new raw take", async (t) => {
  const lines = [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄" }];
  const { dir, paths, args, first } = await firstRun(lines);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"));
  let run;
  await quiet(async () => {
    run = await synthesizeAll({ ...args, provider: inPlaceBatch, lines: [{ id: "a", text: A_TEXT, say: "가".repeat(20) }, lines[1]], onlyLineIds: ["a"] });
  });
  assert.deepEqual(run.refused, ["a"]);
  assert.ok(before.equals(fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"))), "the old clip is back byte for byte");
  assert.deepEqual(run.timings.lines.map((l) => [l.start, l.end]), first.timings.lines.map((l) => [l.start, l.end]));
  assert.equal(fs.readdirSync(paths.voiceDir).filter((f) => f.includes(".old-")).length, 0, "no temp copy is left");
});

test("review 1: a batch that throws puts the old clips back", async (t) => {
  const lines = [{ id: "a", text: A_TEXT }, { id: "b", text: "다음 줄" }];
  const { dir, paths, args } = await firstRun(lines);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"));
  const failing = {
    async synthBatch(items) {
      fs.writeFileSync(items[0].outPath, "half a file");
      throw new Error("boom");
    },
  };
  await assert.rejects(quiet(() => synthesizeAll({ ...args, provider: failing, lines, onlyLineIds: ["a"] })), /boom/);
  assert.ok(before.equals(fs.readFileSync(path.join(paths.voiceDir, "line-a.wav"))));
  assert.equal(fs.readdirSync(paths.voiceDir).filter((f) => f.includes(".old-")).length, 0);
});

function reelWithTakes() {
  const dir = tmp("sva-a12-takes-");
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: { lang: "ko-KR", gapMs: 250, voice: { levelLines: false } }, lines: [{ id: "l1", text: A_TEXT }, { id: "l2", text: "다음 줄" }] }));
  return dir;
}

async function longTake(file, sec) {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=200:duration=${sec}`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", file]);
}

/** Runs main with process.exit turned into a throw, so a failing step can be asserted. */
async function runMain(argv) {
  const exit = process.exit;
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  try {
    return await quiet(() => main(argv));
  } finally {
    process.exit = exit;
  }
}

test("carry f: a refused tone pick leaves plan.json without the tone", async (t) => {
  const dir = reelWithTakes();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  await runMain([dir, "--provider", "none", "--no-stt"]);
  await runMain([dir, "--provider", "none", "--lines", "l1", "--takes", "confident,calm", "--no-stt"]);
  await longTake(path.join(paths.voiceDir, "takes", "l1-2.wav"), 5);
  const planBefore = fs.readFileSync(path.join(dir, "plan.json"), "utf8");
  await assert.rejects(runMain([dir, "--provider", "none", "--pick", "l1=2", "--no-stt"]), /exit 1/);
  assert.equal(fs.readFileSync(path.join(dir, "plan.json"), "utf8"), planBefore, "the refused pick wrote nothing to plan.json");
});

test("review 3: --pick-by with every take over the slot keeps the installed clip and exits 0; an explicit --pick of one still exits 1", async (t) => {
  const dir = reelWithTakes();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  await runMain([dir, "--provider", "none", "--no-stt"]);
  await runMain([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);
  for (const k of [1, 2]) await longTake(path.join(paths.voiceDir, "takes", `l1-${k}.wav`), 5);
  const clip = fs.readFileSync(path.join(paths.voiceDir, "line-l1.wav"));
  const timings = fs.readFileSync(paths.timingsJson, "utf8");
  const out = await runMain([dir, "--provider", "none", "--lines", "l1", "--pick-by", "length:2", "--no-stt"]);
  assert.match(out, /no take of "l1" fits its slot.*the installed clip stays/);
  assert.match(out, /installed clip kept/);
  assert.ok(clip.equals(fs.readFileSync(path.join(paths.voiceDir, "line-l1.wav"))));
  assert.equal(fs.readFileSync(paths.timingsJson, "utf8"), timings);
  await assert.rejects(runMain([dir, "--provider", "none", "--pick", "l1=1", "--no-stt"]), /exit 1/);
});

test("review 2: an unreadable take is reported as unchecked and never chosen", async (t) => {
  const dir = reelWithTakes();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  await runMain([dir, "--provider", "none", "--no-stt"]);
  await runMain([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);
  fs.writeFileSync(path.join(paths.voiceDir, "takes", "l1-2.wav"), "not a wav");
  const out = await runMain([dir, "--provider", "none", "--lines", "l1", "--pick-by", "length:0.1", "--no-stt"]);
  assert.match(out, /l1: take 2 unchecked \(unreadable: .*\) — not chosen/);
  assert.doesNotMatch(out, /installed take\(s\): l1=2/);
});

test("review 4: --pick-by length measures a take and the installed clip on the same trimmed length", async (t) => {
  const dir = reelWithTakes();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = reelPaths(dir);
  await runMain([dir, "--provider", "none", "--no-stt"]);
  await runMain([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);
  const timings = readJson(paths.timingsJson).lines[0];
  const installed = timings.end - timings.start;
  // Take 1: 1.5 s of tone with 1 s of silence at both ends. Raw 3.5 s; trimmed to the voice plus pads (0.05 s head, 0.3 s tail) ~1.85 s.
  const take1 = path.join(paths.voiceDir, "takes", "l1-1.wav");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=1.5", "-af", "adelay=1000:all=1,apad=pad_dur=1", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", take1]);
  const out = await runMain([dir, "--provider", "none", "--lines", "l1", "--pick-by", `length:${installed.toFixed(3)}`, "--no-stt"]);
  const row = out.split("\n").find((l) => /^l1\t1\t/.test(l)).split("\t");
  const [raw, trimmed] = [row[4], row[5]].map((c) => Number(c.replace("s", "")));
  assert.ok(raw > 3.4, `raw duration ${raw}`);
  assert.ok(Math.abs(trimmed - 1.85) < 0.15, `take length ${trimmed}: the trimmed clip an install would make, not the raw ${raw}`);
});
