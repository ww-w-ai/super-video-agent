import { test } from "node:test";
import assert from "node:assert/strict";
import { staleDubText, formatStaleDubText } from "../scripts/lib/dub-copy-check.mjs";

function inputs() {
  return { dubPlan: { meta: { lang: "ko-KR" }, lines: [{ id: "a", text: "new" }] }, dubTimings: { lines: [{ id: "a", text: "old" }] }, basePlan: { meta: { lang: "ko" }, lines: [{ id: "a", text: "new" }] }, baseTimings: { lines: [{ id: "a", text: "new" }] } };
}

test("same-language stale copy is compared to both plan and current base narration", () => {
  const findings = staleDubText(inputs());
  assert.deepEqual(findings.map((row) => row.source), ["dub plan", "base voice timings"]);
  assert.match(formatStaleDubText(findings), /copied "old", current "new"/);
});

test("a plan copied along with stale timings still reports current base text", () => {
  const data = inputs(); data.dubPlan.lines[0].text = "old";
  assert.deepEqual(staleDubText(data).map((row) => row.source), ["base voice timings"]);
});

test("intentional translations are checked only against their own plan", () => {
  const data = inputs(); data.dubPlan.meta.lang = "en"; data.dubTimings.lines[0].text = "new";
  assert.deepEqual(staleDubText(data), []);
  data.dubTimings.lines[0].text = "old";
  assert.deepEqual(staleDubText(data).map((row) => row.source), ["dub plan"]);
});

test("per-line languages determine matching; scripts are not conflated", () => {
  const data = inputs(); data.dubPlan.meta.lang = "en"; data.dubPlan.lines[0].lang = "ko";
  assert.equal(staleDubText(data).length, 2);
  data.basePlan.lines[0].lang = "en";
  assert.equal(staleDubText(data).length, 1);
  data.dubPlan.lines[0].lang = "zh-Hant"; data.basePlan.lines[0].lang = "zh-Hans";
  assert.equal(staleDubText(data).length, 1);
});

test("missing and extra IDs are reported; inputs are preserved", () => {
  const data = inputs(); data.dubTimings.lines = [{ id: "extra", text: "old" }];
  const before = JSON.stringify(data);
  assert.deepEqual(staleDubText(data).map((row) => row.reason), ["timing line is absent from the plan", "plan line is absent from copied timings"]);
  assert.equal(JSON.stringify(data), before);
  data.baseTimings = null;
  assert.equal(staleDubText(data).length, 2);
});

test("missing base plan uses live narration language and still checks the dub plan", () => {
  const data = inputs();
  data.basePlan = null; data.baseTimings.lang = "ko";
  assert.deepEqual(staleDubText(data).map((row) => row.source), ["dub plan", "base voice timings"]);
  data.baseTimings = null;
  assert.deepEqual(staleDubText(data).map((row) => row.source), ["dub plan"]);
});
