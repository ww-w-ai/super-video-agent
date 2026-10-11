// meta.minBreathMs: the shortest silence after a line is a plan setting (default 0.5 s);
// a line's own pauseAfterMs is a designated silence kept as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeAll } from "../scripts/voice.mjs";
import { previousSlots, planRetakeFit, retakeFitMessage } from "../scripts/voice/line-edit.mjs";
import { minBreathSecOf, MIN_BREATH_SEC, fitAllLines } from "../scripts/lib/dub-timing.mjs";
import { breathFacts, estimateLength } from "../scripts/validate-plan.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import * as none from "../scripts/voice/none.mjs";

const LINES = [{ id: "l1", text: "패스", pauseAfterMs: 900 }, { id: "l2", text: "슛" }, { id: "l3", text: "들어갑니다" }];

async function lay(meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-breath-"));
  const gapMs = meta.gapMs == null ? 700 : meta.gapMs;
  const { timings } = await synthesizeAll({
    dir, paths: reelPaths(dir), provider: none, providerName: "none", voiceCfg: {}, lang: "ko-KR",
    gapMs, minBreathSec: minBreathSecOf(meta), sttEnabled: false, lines: LINES,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return timings;
}

const gaps = (t) => t.lines.slice(1).map((l, i) => +(l.start - t.lines[i].end).toFixed(3));

test("minBreathSecOf: the plan value in seconds, else the 0.5 s default", () => {
  assert.equal(minBreathSecOf(undefined), MIN_BREATH_SEC);
  assert.equal(minBreathSecOf({}), 0.5);
  assert.equal(minBreathSecOf({ minBreathMs: 200 }), 0.2);
  assert.equal(minBreathSecOf({ minBreathMs: 0 }), 0);
  assert.equal(minBreathSecOf({ minBreathMs: -5 }), 0.5);
});

test("voice: with minBreathMs 200 a 250 ms gap stays 250 ms; a designated pauseAfterMs is kept", async () => {
  const t = await lay({ gapMs: 250, minBreathMs: 200 });
  assert.deepEqual(gaps(t), [0.9, 0.25]);
});

test("voice: without minBreathMs the same plan is raised to 0.5 s, as before", async () => {
  const t = await lay({ gapMs: 250 });
  assert.deepEqual(gaps(t), [0.9, 0.5]);
});

test("voice: an absent key lays out the same timings as the explicit 500 ms default", async () => {
  const a = await lay({ gapMs: 300 });
  const b = await lay({ gapMs: 300, minBreathMs: 500 });
  assert.deepEqual(a.lines.map((l) => [l.start, l.end]), b.lines.map((l) => [l.start, l.end]));
  assert.equal(a.duration, b.duration);
});

test("retake fit: the slot carries the plan's minimum breath into the fit and the message", () => {
  const prev = [{ id: "a", start: 0, end: 2 }, { id: "b", start: 2.5, end: 4 }];
  const slots = previousSlots(prev, [{ id: "a" }, { id: "b" }], 250, 0.2);
  const slot = slots.get("a");
  assert.equal(slot.minBreathSec, 0.2);
  // A 2.3 s take in a 2.5 s slot leaves 0.2 s: enough for a 0.2 s breath, short of a 0.5 s one.
  assert.equal(planRetakeFit(2.3, slot).breathShort, false);
  assert.equal(planRetakeFit(2.3, { ...slot, minBreathSec: undefined }).breathShort, true);
  // 2.6 s at the 1.1x limit is 2.36 s: it fits the slot but leaves under 0.2 s.
  const fit = planRetakeFit(2.6, slot);
  assert.match(retakeFitMessage("a", 2.6, slot, fit), /under the 0\.2s breath/);
  assert.equal(previousSlots(prev, [], 700).get("a").minBreathSec, 0.5);
});

test("dub fit: minBreathSec reaches fitAllLines' breath warnings", () => {
  const base = [{ id: "a", start: 0, end: 1.6 }, { id: "b", start: 2, end: 3 }];
  const voice = [{ id: "a", start: 0, end: 1.7, words: [] }, { id: "b", start: 0, end: 0.9, words: [] }];
  const clips = new Map([["a", 1.7], ["b", 0.9]]);
  const short = fitAllLines(base, voice, clips, 4, 1.1, { minBreathSec: 0.2 });
  const dflt = fitAllLines(base, voice, clips, 4, 1.1);
  assert.equal(short.ok, true);
  assert.equal(short.breathWarnings.length, 0);
  assert.ok(dflt.breathWarnings.some((w) => w.id === "a"));
});

test("validate-plan: breath facts and the estimate follow the plan's minimum breath", () => {
  const plan = { meta: { lang: "ko-KR", gapMs: 250 }, lines: LINES.map((l) => ({ ...l })) };
  assert.match(breathFacts(plan).join("\n"), /meta\.gapMs 250 is under the minimum breath 500 ms/);
  assert.deepEqual(breathFacts({ ...plan, meta: { ...plan.meta, minBreathMs: 200 } }), []);
  const slow = estimateLength(plan, { rate: 5 });
  const fast = estimateLength({ ...plan, meta: { ...plan.meta, minBreathMs: 200 } }, { rate: 5 });
  assert.ok(Math.abs(slow.pauseSec - 1.4) < 1e-9, `pauseSec ${slow.pauseSec}`);
  assert.ok(Math.abs(fast.pauseSec - 1.15) < 1e-9, `pauseSec ${fast.pauseSec}`);
});
