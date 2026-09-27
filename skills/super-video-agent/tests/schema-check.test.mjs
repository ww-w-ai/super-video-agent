// plan.json schema validation (scripts/validate-plan.mjs contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/lib/schema-check.mjs";
import { readJson } from "../scripts/lib/reeldir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));

function validPlan() {
  return {
    meta: {
      title: "Demo",
      lang: "ko-KR",
      ratio: "9:16",
      fps: 30,
      voice: { provider: "say" },
      gapMs: 250,
    },
    lines: [{ id: "l1", text: "hello" }],
  };
}

test("validate: accepts a minimal valid plan", () => {
  const { valid, errors } = validate(validPlan(), schema);
  assert.equal(valid, true, errors.join("; "));
});

test("validate: accepts the optional `say` field on a line", () => {
  const plan = validPlan();
  plan.lines[0].say = "엠씨피";
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, true, errors.join("; "));
});

test("validate: rejects a missing required field (lines[].text)", () => {
  const plan = validPlan();
  delete plan.lines[0].text;
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("lines[0]") && e.includes("text")));
});

test("validate: rejects an unknown ratio", () => {
  const plan = validPlan();
  plan.meta.ratio = "3:2";
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("meta.ratio")));
});

test("validate: rejects an unknown top-level property (additionalProperties:false)", () => {
  const plan = validPlan();
  plan.extra = true;
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("extra")));
});

test("validate: rejects an empty lines array (minItems:1)", () => {
  const plan = validPlan();
  plan.lines = [];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("minItems")));
});

// ---- lines[].cues (design.md §2.5) ----------------------------------

test("validate: accepts a line with a full cues entry", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ asset: "stamp-1", at: "end", offsetMs: -50, gainDb: -3, maxSec: 1.2, play: "both" }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, true, errors.join("; "));
});

test("validate: accepts cues[].at as word:<text>", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ asset: "stamp-1", at: "word:hello" }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, true, errors.join("; "));
});

test("validate: rejects cues[] missing required asset", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ at: "start" }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("asset")));
});

test("validate: rejects cues[].at that doesn't match start|end|word:<text>", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ asset: "stamp-1", at: "middle" }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("pattern")));
});

test("validate: rejects cues[].maxSec <= 0", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ asset: "stamp-1", at: "start", maxSec: 0 }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("exclusiveMinimum")));
});

test("validate: rejects cues[].play outside sound|picture|both", () => {
  const plan = validPlan();
  plan.lines[0].cues = [{ asset: "stamp-1", at: "start", play: "loop" }];
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("enum")));
});

test("validate: accepts meta.distribution personal|public, rejects other values", () => {
  const plan = validPlan();
  plan.meta.distribution = "personal";
  assert.equal(validate(plan, schema).valid, true);
  plan.meta.distribution = "commercial";
  assert.equal(validate(plan, schema).valid, false);
});

import { cueWordErrors } from "../scripts/validate-plan.mjs";

test("validate-plan: a word cue must name a word in its line text", () => {
  const plan = { lines: [
    { id: "a", text: "and drops it in right on the beat.", cues: [{ asset: "x", at: "word:right" }] },
    { id: "b", text: "Write it down.", cues: [{ asset: "x", at: "word:유월로" }, { asset: "x", at: "end" }] },
  ] };
  const errs = cueWordErrors(plan);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /lines\[1\]\.cues\[0\]/);
});
