// Pure-function tests for scripts/lib/sfx-judge-sheet.mjs (the manual
// scoring sheet written when no TYPESAFE_API_KEY/OPENROUTER_API_KEY is
// set — the normal case now).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgeSheet, buildScoresTemplate } from "../scripts/lib/sfx-judge-sheet.mjs";
import { FIT_THRESHOLD, FIT_CRITERIA } from "../scripts/lib/sfx-judge-rubric.mjs";

const CARDS = [
  {
    id: "s1",
    at: 4.2,
    event: "a rubber stamp slams down",
    intent: "heavy, decisive",
    world: "a kitchen promo, warm and bouncy",
    recipe: { kind: "kit", kit: "thud" },
    measured: {
      durationSec: 0.35,
      peakDb: -0.4,
      attackMs: 1.2,
      brightnessHz: 340,
      pitchTrend: "none",
      noisiness: 0.71,
      lufs: -14.2,
    },
  },
  {
    id: "s2",
    at: 9.0,
    event: "a badge pops in",
    intent: "light, playful",
    world: "a kitchen promo, warm and bouncy",
    recipe: { kind: "asset", assetId: "sfx-pack120-091" },
  },
];

test("buildJudgeSheet: is self-contained — carries the rubric table and every card's own fields", () => {
  const sheet = buildJudgeSheet(CARDS);
  assert.match(sheet, /# Sound card scoring sheet/);
  // the full 10-level rubric table, in order
  for (let i = 0; i < FIT_CRITERIA.length; i++) {
    assert.match(sheet, new RegExp(`\\| ${i + 1} \\| ${escapeRe(FIT_CRITERIA[i])} \\|`));
  }
  assert.match(sheet, new RegExp(`under ${FIT_THRESHOLD}`));
  // every card present with its own event/world/recipe
  for (const card of CARDS) {
    assert.match(sheet, new RegExp(`### ${card.id}`));
    assert.match(sheet, new RegExp(escapeRe(card.event)));
    assert.match(sheet, new RegExp(escapeRe(card.world)));
    assert.match(sheet, new RegExp(escapeRe(JSON.stringify(card.recipe))));
  }
});

test("buildJudgeSheet: an unmeasured card reads '(not measured)' rather than throwing", () => {
  const sheet = buildJudgeSheet(CARDS);
  assert.match(sheet, /\(not measured\)/); // s2 has no `measured`
});

test("buildJudgeSheet: no novelty/history language leaked in (owner dropped that scope)", () => {
  const sheet = buildJudgeSheet(CARDS);
  assert.doesNotMatch(sheet, /novelty/i);
  assert.doesNotMatch(sheet, /history/i);
});

test("buildScoresTemplate: one row per card, fit unset, backend 'manual'", () => {
  const template = buildScoresTemplate(CARDS);
  assert.equal(template.length, CARDS.length);
  assert.deepEqual(
    template.map((t) => t.id),
    CARDS.map((c) => c.id)
  );
  for (const row of template) {
    assert.equal(row.fit, null);
    assert.equal(row.backend, "manual");
  }
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
