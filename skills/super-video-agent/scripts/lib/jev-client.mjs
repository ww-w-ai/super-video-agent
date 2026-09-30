// Request building + response parsing for Jev (TypeSafe AI's typed-judgment
// model, OpenRouter id `typesafe/jev-1.13`), used by scripts/sfx-cards.mjs
// `judge` when TYPESAFE_API_KEY is set. Pure functions (no fetch here) so
// the request/response contract is unit-testable against a recorded
// example with no network.
//
// Format per the official docs (https://docs.typesafe.ai): POST
// https://api.typesafe.ai/v1/systemone, Authorization: Bearer <key>,
// body {model, state, questions};
// a "score" question takes an ordered `criteria` array (low to high) and
// the response gives a 0..1 fractional score plus a confidence and a
// probability distribution. This client uses Jev's own two-level fit
// question (JEV_FIT_CRITERIA) rather than the 10-level rubric used by the
// other judge backends — see sfx-judge-rubric.mjs.
import { setDefaultAutoSelectFamily } from "node:net";
import { JEV_FIT_CRITERIA, JEV_FIT_INSTRUCTIONS, describeMeasured } from "./sfx-judge-rubric.mjs";

// Node's fetch (undici) defaults to Happy-Eyeballs connects
// (`autoSelectFamily: true`), which can time out reaching this host's IPv6
// route in some network environments even though a plain IPv4 connection
// (Node's own `https` module, curl) succeeds immediately — confirmed
// 2026-09-30: sfx-cards.mjs's `judge` command saw a bare "fetch failed" for
// every request until this was disabled process-wide, with the request
// itself unchanged. This is a connect-family issue, not a bad request or a
// wrong endpoint/body shape.
setDefaultAutoSelectFamily(false);

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The `state` text Jev judges against — everything a human judge would need, minus the rubric itself (that's `questions.fit.criteria`). */
export function fitStateText(card) {
  const lines = [
    `Event: ${card.event}`,
    `Intent: ${card.intent}`,
    card.world ? `This film's world/topic: ${card.world}` : `This film's world/topic: (not given)`,
    `Sound recipe: ${JSON.stringify(card.recipe)}`,
    `Measured: ${describeMeasured(card.measured)}`,
  ];
  return lines.join("\n");
}

/**
 * @param {object} card a sound-cards.json entry
 * @param {{apiKey:string, model?:string}} opts
 * @returns {{url:string, headers:object, body:object}}
 */
export function buildDecideRequest(card, opts) {
  if (!opts || !opts.apiKey) throw new Error("buildDecideRequest requires opts.apiKey");
  return {
    url: JEV_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: {
      model: opts.model || "jev-latest",
      state: fitStateText(card),
      questions: {
        fit: {
          type: "score",
          instructions: JEV_FIT_INSTRUCTIONS,
          criteria: JEV_FIT_CRITERIA,
        },
      },
    },
  };
}

/**
 * @param {object} json the decoded JSON body of a /v1/systemone response
 * @returns {{score:number, fit:number, confidence:number|null}} score is Jev's raw 0..1;
 *   fit = score * 10 puts it on the same 1..10-style scale as the other judge backends, so
 *   FIT_THRESHOLD (8) applies unchanged (JEV_PASS 0.8 * 10 = fit 8).
 */
export function parseDecideResponse(json) {
  const answer = json && json.answers && json.answers.fit;
  if (!answer || typeof answer.score !== "number") {
    throw new Error("jev response missing answers.fit.score: " + JSON.stringify(json));
  }
  const score = Math.max(0, Math.min(1, answer.score));
  const fit = Math.round(score * 1000) / 100;
  return { score, fit, confidence: answer.confidence == null ? null : answer.confidence };
}
