// Request/response contract tests for scripts/lib/jev-client.mjs, against a
// recorded example in the shape of the official docs (docs.typesafe.ai,
// 2026-09-29) — no network here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecideRequest, parseDecideResponse, JEV_ENDPOINT, fitStateText } from "../scripts/lib/jev-client.mjs";
import { JEV_FIT_CRITERIA } from "../scripts/lib/sfx-judge-rubric.mjs";

const CARD = {
  id: "s1",
  at: 4.2,
  event: "a rubber stamp slams down on the page",
  intent: "heavy, decisive, official",
  world: "a small-business promo, warm and homemade",
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
};

test("buildDecideRequest: posts to /v1/systemone with a Bearer auth header", () => {
  const req = buildDecideRequest(CARD, { apiKey: "jv_live_test" });
  assert.equal(req.url, JEV_ENDPOINT);
  assert.equal(req.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(req.headers.Authorization, "Bearer jv_live_test");
  assert.equal(req.headers["Content-Type"], "application/json");
});

test("buildDecideRequest: a single 'fit' score question with Jev's two-level criteria", () => {
  const req = buildDecideRequest(CARD, { apiKey: "k" });
  assert.equal(req.body.questions.fit.type, "score");
  assert.deepEqual(req.body.questions.fit.criteria, JEV_FIT_CRITERIA);
  assert.equal(req.body.questions.fit.criteria.length, 2);
});

test("buildDecideRequest: requires an apiKey", () => {
  assert.throws(() => buildDecideRequest(CARD, {}));
});

test("fitStateText: carries the event, intent, world and measured features", () => {
  const text = fitStateText(CARD);
  assert.match(text, /rubber stamp/);
  assert.match(text, /small-business promo/);
  assert.match(text, /noisiness 0\.71/);
});

test("parseDecideResponse: a recorded example (0.87) -> score 0.87, fit 8.7, passes JEV_PASS*10", () => {
  const recorded = {
    model: "jev-1.13.0",
    answers: {
      fit: { type: "score", score: 0.87, confidence: 1.0, probabilities: { "0": 0.0, "1": 1.0 } },
    },
    usage: { input_tokens: 62 },
  };
  const { score, fit, confidence } = parseDecideResponse(recorded);
  assert.equal(score, 0.87);
  assert.equal(fit, 8.7);
  assert.equal(confidence, 1.0);
});

test("parseDecideResponse: a score of 0.76 -> fit 7.6, below the 8 pass line", () => {
  const { score, fit } = parseDecideResponse({ answers: { fit: { score: 0.76 } } });
  assert.equal(score, 0.76);
  assert.equal(fit, 7.6);
});

test("parseDecideResponse: a 0..1 score of 0 -> fit 0, a score of 1 -> fit 10", () => {
  assert.equal(parseDecideResponse({ answers: { fit: { score: 0 } } }).fit, 0);
  assert.equal(parseDecideResponse({ answers: { fit: { score: 1 } } }).fit, 10);
});

test("parseDecideResponse: score is clamped to [0, 1] even on an out-of-range value", () => {
  assert.equal(parseDecideResponse({ answers: { fit: { score: -5 } } }).fit, 0);
  assert.equal(parseDecideResponse({ answers: { fit: { score: 50 } } }).fit, 10);
});

test("parseDecideResponse: throws on a response with no answers.fit.score", () => {
  assert.throws(() => parseDecideResponse({ answers: {} }));
  assert.throws(() => parseDecideResponse({}));
});
