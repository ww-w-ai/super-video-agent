// Fallback judge backend for scripts/sfx-cards.mjs `judge`, used when only
// OPENROUTER_API_KEY is set (no TYPESAFE_API_KEY): OpenRouter's
// `typesafe/jev-1.13` model through its standard OpenAI-compatible chat
// completions endpoint. [verify] — the official docs (docs.typesafe.ai; see
// jev-client.mjs) describe the direct /v1/systemone contract in full;
// OpenRouter's model page for `typesafe/jev-1.13` returned 404 when
// fetched (2026-09-29), so this asks for a JSON object in the chat
// response instead of Jev's typed `score` question, and is unconfirmed
// against a real response — parseChatResponse is written defensively and
// unit-tested against a synthetic example, not a recorded real one.
import { FIT_INSTRUCTIONS, describeMeasured } from "./sfx-judge-rubric.mjs";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "typesafe/jev-1.13";

function userContent(card) {
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
export function buildChatRequest(card, opts) {
  if (!opts || !opts.apiKey) throw new Error("buildChatRequest requires opts.apiKey");
  return {
    url: OPENROUTER_ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: {
      model: opts.model || OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content:
            FIT_INSTRUCTIONS +
            ' Reply with strict JSON only, no other text: {"fit": <1-10 number>, "reason": "<one sentence>"}.',
        },
        { role: "user", content: userContent(card) },
      ],
    },
  };
}

/**
 * @param {object} json the decoded JSON body of a chat/completions response
 * @returns {{fit:number, reason:string}}
 */
export function parseChatResponse(json) {
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error("openrouter response missing choices[0].message.content: " + JSON.stringify(json));
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("openrouter response content has no JSON object: " + content);
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.fit !== "number" || Number.isNaN(parsed.fit)) {
    throw new Error("parsed JSON missing a numeric fit: " + match[0]);
  }
  return { fit: Math.max(1, Math.min(10, parsed.fit)), reason: parsed.reason || "" };
}
