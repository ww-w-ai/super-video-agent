// Pure-function tests for scripts/lib/sfx-cards-schema.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCard, validateCards } from "../scripts/lib/sfx-cards-schema.mjs";

function baseCard(overrides = {}) {
  return {
    id: "s1",
    at: 4.2,
    event: "a stamp lands on the page",
    intent: "a heavy, decisive thud",
    world: "a kitchen promo, warm and bouncy",
    recipe: { kind: "kit", kit: "thud" },
    ...overrides,
  };
}

test("validateCard: a minimal valid card (no measured yet) passes", () => {
  assert.deepEqual(validateCard(baseCard()), []);
});

test("validateCard: missing required fields are each reported", () => {
  const errors = validateCard({ recipe: { kind: "kit", kit: "thud" } });
  assert.ok(errors.some((e) => e.includes(".id:")));
  assert.ok(errors.some((e) => e.includes(".at:")));
  assert.ok(errors.some((e) => e.includes(".event:")));
  assert.ok(errors.some((e) => e.includes(".intent:")));
});

test("validateCard: recipe.kind determines which recipe field is required", () => {
  assert.ok(validateCard(baseCard({ recipe: { kind: "kit" } })).some((e) => e.includes(".recipe.kit:")));
  assert.ok(validateCard(baseCard({ recipe: { kind: "asset" } })).some((e) => e.includes(".recipe.assetId:")));
  assert.ok(validateCard(baseCard({ recipe: { kind: "custom" } })).some((e) => e.includes(".recipe.custom:")));
  assert.deepEqual(validateCard(baseCard({ recipe: { kind: "asset", assetId: "sfx-1" } })), []);
  assert.deepEqual(validateCard(baseCard({ recipe: { kind: "custom", custom: "detuned bell, 2 layers" } })), []);
});

test("validateCard: an unknown recipe.kind is rejected", () => {
  assert.ok(validateCard(baseCard({ recipe: { kind: "magic" } })).some((e) => e.includes(".recipe.kind:")));
});

test("validateCard: measured, when present, requires every numeric field and a valid pitchTrend", () => {
  const good = baseCard({
    measured: {
      durationSec: 0.5,
      peakDb: -3,
      attackMs: 2,
      brightnessHz: 1200,
      pitchTrend: "flat",
      noisiness: 0.2,
      lufs: -18,
    },
  });
  assert.deepEqual(validateCard(good), []);

  const bad = baseCard({ measured: { durationSec: "oops", pitchTrend: "up" } });
  const errors = validateCard(bad);
  assert.ok(errors.some((e) => e.includes(".measured.durationSec:")));
  assert.ok(errors.some((e) => e.includes(".measured.pitchTrend:")));
  assert.ok(errors.some((e) => e.includes(".measured.peakDb:")));
});

test("validateCard: measured absent (not yet measured) is fine", () => {
  assert.deepEqual(validateCard(baseCard({ measured: undefined })), []);
});

test("validateCards: must be an array", () => {
  const { valid, errors } = validateCards({ not: "an array" });
  assert.equal(valid, false);
  assert.ok(errors[0].includes("must be a JSON array"));
});

test("validateCards: reports a duplicate id", () => {
  const { valid, errors } = validateCards([baseCard({ id: "dup" }), baseCard({ id: "dup" })]);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('duplicate id "dup"')));
});

test("validateCards: a fully valid list passes with no errors", () => {
  const { valid, errors } = validateCards([baseCard({ id: "a" }), baseCard({ id: "b", recipe: { kind: "asset", assetId: "x" } })]);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});
