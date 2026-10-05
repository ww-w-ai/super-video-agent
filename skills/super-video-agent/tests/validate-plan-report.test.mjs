// validate-plan.mjs: meta.overlay (free-form), --estimate and --listener
// reports (report only, exit code unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/lib/schema-check.mjs";
import { readJson } from "../scripts/lib/reeldir.mjs";
import { spokenUnits, estimateLength, loadRateSource, listenerReport, lineEnding, formatEstimate, parseLeadFlag } from "../scripts/validate-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "validate-plan.mjs");
const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));

function reelWith(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-vp-"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  return dir;
}

test("schema: a dub plan with a free-form meta.overlay object is valid", () => {
  const plan = {
    meta: { title: "t", lang: "en-US", overlay: { endCard: "See you", stickers: { a: "Hi" }, n: 3 } },
    lines: [{ id: "l1", text: "Hello there." }],
  };
  assert.deepEqual(validate(plan, schema).errors, []);
});

test("schema: a misspelled known meta key still fails next to meta.overlay", () => {
  const plan = { meta: { title: "t", overlays: {}, tailsec: 1 }, lines: [{ id: "l1", text: "x" }] };
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"overlays"')));
  assert.ok(errors.some((e) => e.includes('"tailsec"')));
});

test("schema: meta.overlay must be an object", () => {
  const plan = { meta: { title: "t", overlay: "End" }, lines: [{ id: "l1", text: "x" }] };
  assert.equal(validate(plan, schema).valid, false);
});

test("spokenUnits: Hangul syllables, digits, English vowel groups; marks and '|' do not count", () => {
  assert.equal(spokenUnits("안녕하세요!"), 5);
  assert.equal(spokenUnits("2026"), 4);
  assert.equal(spokenUnits("Hello there, make it."), 5); // hel-lo there make it
  assert.equal(spokenUnits("こんにちは"), 5);
});

test("estimate: a known plan at a given rate (ko, 9:16 speed 1.1)", () => {
  const plan = {
    meta: { title: "t", lang: "ko-KR", ratio: "9:16", gapMs: 500, tailSec: 1 },
    lines: [
      { id: "a", text: "가나다라마바사아자차" }, // 10 units
      { id: "b", text: "가나다라마 | 바사아자차카타", pauseAfterMs: 900 }, // 12 units
      { id: "c", say: "{happy} 가나다", text: "ABC", rate: 2.2 }, // 3 units at speed 2.2
    ],
  };
  // --rate 6.6 is heard at speed 1.1 -> 6 units/s at 1.0.
  const e = estimateLength(plan, { rate: 6.6 });
  const expected = 0.4 + 10 / 6.6 + 12 / 6.6 + 3 / (6 * 2.2) + 0.5 + 0.9 + 1;
  assert.equal(e.units, 25);
  assert.ok(Math.abs(e.totalSec - expected) / expected < 0.01, `${e.totalSec} vs ${expected}`);
  assert.equal(e.gaps, 2);
});

test("estimate --rate-from: timings made at a known rate give back that length within 1%", () => {
  const plan = {
    meta: { title: "t", lang: "en-US", ratio: "16:9", gapMs: 700 },
    lines: [
      { id: "l1", text: "Make it quick and make it clear." },
      { id: "l2", text: "Every line should land on time." },
      { id: "l3", text: "Then the picture follows the voice." },
    ],
  };
  const units = plan.lines.map((l) => spokenUnits(l.text));
  let t = 0.4;
  const lines = plan.lines.map((l, i) => {
    const start = t;
    const end = start + units[i] / 3.5;
    t = end + (i < plan.lines.length - 1 ? 0.7 : 0);
    return { id: l.id, text: l.text, start, end };
  });
  const timings = { duration: t + 0.4, lines };
  const e = estimateLength(plan, { rateFrom: { timings, plan } });
  assert.ok(Math.abs(e.totalSec - timings.duration) / timings.duration < 0.01, `${e.totalSec} vs ${timings.duration}`);
  assert.ok(Math.abs(e.heardRate - 3.5) < 1e-9);
});

test("estimate --rate-from another film: measured on that film's own lines, not this plan's ids", () => {
  // Two films share ids l1..l3 but not their text. The other film's voice
  // spoke at 6 units/s; pairing by id with this plan would give another rate.
  const other = {
    meta: { title: "other", lang: "ko-KR", ratio: "16:9" },
    lines: [
      { id: "l1", text: "가나다라마바사아자차카타" }, // 12 units
      { id: "l2", text: "가나다라마바" }, // 6
      { id: "l3", text: "가나다라마바사아자" }, // 9
    ],
  };
  const current = {
    meta: { title: "this", lang: "ko-KR", ratio: "16:9" },
    lines: [
      { id: "l1", text: "가나다" },
      { id: "l2", text: "가나다라마바사아자차카타파하" },
      { id: "l3", text: "가나" },
    ],
  };
  let t = 0.4;
  const lines = other.lines.map((l) => {
    const start = t;
    const end = start + spokenUnits(l.text) / 6;
    t = end + 0.7;
    return { id: l.id, text: l.text, start, end };
  });
  const otherDir = reelWith(other);
  fs.mkdirSync(path.join(otherDir, "voice"));
  const timingsPath = path.join(otherDir, "voice", "timings.json");
  fs.writeFileSync(timingsPath, JSON.stringify({ duration: t, lines }));

  const withPlan = estimateLength(current, { rateFrom: loadRateSource(timingsPath) });
  assert.ok(Math.abs(withPlan.heardRate - 6) < 1e-9, `${withPlan.heardRate}`);
  assert.match(withPlan.rateSource, /plan\.json/);

  // No plan beside the timings: the text stored in the timings gives the same rate.
  fs.rmSync(path.join(otherDir, "plan.json"));
  const fromText = estimateLength(current, { rateFrom: loadRateSource(timingsPath) });
  assert.ok(Math.abs(fromText.heardRate - 6) < 1e-9, `${fromText.heardRate}`);
  assert.match(fromText.rateSource, /text in that timings file/);

  // Neither: it says it cannot measure and falls back to the language default.
  fs.writeFileSync(timingsPath, JSON.stringify({ duration: t, lines: lines.map(({ id, start, end }) => ({ id, start, end })) }));
  const none = estimateLength(current, { rateFrom: loadRateSource(timingsPath) });
  assert.match(none.rateSource, /cannot measure/);
  assert.match(none.rateSource, /default for "ko"/);
  assert.equal(none.baseRate, 6.0);
});

test("estimate: no rate given uses the language's starting value and says so", () => {
  const e = estimateLength({ meta: { title: "t", lang: "ja-JP" }, lines: [{ id: "a", text: "こんにちは" }] });
  assert.match(e.rateSource, /default for "ja"/);
});

test("listener: 13 lines with the same ending are reported, with 12 adjacent pairs (ko)", () => {
  const lines = Array.from({ length: 13 }, (_, i) => ({ id: "l" + (i + 1), text: `오늘 ${i}번째 이야기예요.` }));
  const r = listenerReport({ meta: { title: "t", lang: "ko-KR" }, lines });
  assert.deepEqual(r.endings, [{ ending: "요", count: 13 }]);
  assert.equal(r.adjacent.length, 12);
});

test("listener: endings are last words in English; ! and commas counted per line", () => {
  const plan = {
    meta: { title: "t", lang: "en-US" },
    lines: [
      { id: "a", text: "Wow, look at this, right!" },
      { id: "b", text: "It is ready, right?" },
      { id: "c", text: "Done." },
    ],
  };
  const r = listenerReport(plan);
  assert.deepEqual(r.lines.map((l) => l.ending), ["right", "right", "done"]);
  assert.deepEqual(r.adjacent, [{ ending: "right", ids: ["a", "b"] }]);
  assert.equal(r.lines[0].exclamations, 1);
  assert.equal(r.lines[0].commas, 2);
  assert.equal(r.exclamations, 1);
  assert.equal(lineEnding("다 됐다!!"), "다");
});

test("CLI: --estimate <dir> and --listener print reports and exit 0", () => {
  const dir = reelWith({ meta: { title: "t", lang: "en-US" }, lines: [{ id: "a", text: "Hello there!" }] });
  const r = spawnSync(process.execPath, [script, "--estimate", dir, "--listener", "--rate", "4"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok\n/);
  assert.match(r.stdout, /estimated length/);
  assert.match(r.stdout, /listener \(report only\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("estimate --lead: the lead is added to the head and moves every start; --starts lists them", () => {
  const plan = {
    meta: { title: "t", lang: "ko-KR", ratio: "16:9", gapMs: 500, tailSec: 1 },
    lines: [{ id: "a", text: "가나다라마바" }, { id: "b", text: "가나다" }],
  };
  const plain = estimateLength(plan, { rate: 6 });
  const led = estimateLength(plan, { rate: 6, leadSec: 3 });
  assert.equal(led.leadSec, 3);
  assert.ok(Math.abs(led.totalSec - plain.totalSec - 3) < 1e-9);
  assert.ok(Math.abs(led.lines[0].start - plain.lines[0].start - 3) < 1e-9);
  assert.ok(Math.abs(led.lines[1].start - (led.lines[0].start + 1 + 0.5)) < 1e-9);
  assert.equal(estimateLength({ ...plan, meta: { ...plan.meta, lead: 2 } }, { rate: 6, leadSec: 0 }).leadSec, 0);
  const text = formatEstimate(led, { starts: true });
  assert.match(text, /lead 3\.0 s included/);
  assert.match(text, /per line \(id {2}units {2}sec {2}start\):\n {4}a {2}6 {2}1\.0 {2}\d+\.\d\n/);
  assert.doesNotMatch(formatEstimate(led), /start\)/);
  assert.equal(parseLeadFlag(undefined), null);
  assert.equal(parseLeadFlag("2.5"), 2.5);
  assert.throws(() => parseLeadFlag("-1"), /--lead takes seconds/);
  assert.throws(() => parseLeadFlag(true), /--lead takes seconds/);
});

test("CLI: --estimate --lead 3 --starts prints start times", () => {
  const dir = reelWith({ meta: { title: "t", lang: "en-US" }, lines: [{ id: "a", text: "Hello there!" }, { id: "b", text: "Bye." }] });
  const r = spawnSync(process.execPath, [script, dir, "--estimate", "--lead", "3", "--starts", "--rate", "4"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lead 3\.0 s included/);
  assert.match(r.stdout, /id {2}units {2}sec {2}start/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: an invalid plan still exits 1 with the reports printed", () => {
  const dir = reelWith({ meta: { title: "t", tittle: "x" }, lines: [{ id: "a", text: "Hello!" }] });
  const r = spawnSync(process.execPath, [script, dir, "--listener"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tittle/);
  assert.match(r.stdout, /listener/);
  fs.rmSync(dir, { recursive: true, force: true });
});
