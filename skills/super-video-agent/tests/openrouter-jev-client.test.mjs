// Request/response contract tests for scripts/lib/openrouter-jev-client.mjs.
// [verify] fallback: OpenRouter's model page for typesafe/jev-1.13 returned
// HTTP 404 when fetched (2026-09-29), so parseChatResponse is exercised
// only against a synthetic example here, not a recorded real response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, parseChatResponse, OPENROUTER_ENDPOINT, OPENROUTER_MODEL } from "../scripts/lib/openrouter-jev-client.mjs";

const CARD = {
  id: "s1",
  at: 4.2,
  event: "a rubber stamp slams down on the page",
  intent: "heavy, decisive, official",
  world: "a small-business promo, warm and homemade",
  recipe: { kind: "kit", kit: "thud" },
  measured: null,
};

test("buildChatRequest: posts to the chat/completions endpoint with typesafe/jev-1.13", () => {
  const req = buildChatRequest(CARD, { apiKey: "or-test" });
  assert.equal(req.url, OPENROUTER_ENDPOINT);
  assert.equal(req.body.model, OPENROUTER_MODEL);
  assert.equal(req.headers.Authorization, "Bearer or-test");
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.messages[0].role, "system");
  assert.match(req.body.messages[1].content, /rubber stamp/);
});

test("buildChatRequest: requires an apiKey", () => {
  assert.throws(() => buildChatRequest(CARD, {}));
});

test("parseChatResponse: extracts fit and reason from a JSON object embedded in message content", () => {
  const response = {
    choices: [{ message: { content: '{"fit": 6, "reason": "sounds fine but generic"}' } }],
  };
  const { fit, reason } = parseChatResponse(response);
  assert.equal(fit, 6);
  assert.equal(reason, "sounds fine but generic");
});

test("parseChatResponse: tolerates surrounding prose around the JSON object", () => {
  const response = {
    choices: [{ message: { content: 'Sure, here is my judgment:\n{"fit": 9, "reason": "tight match"}\nHope that helps!' } }],
  };
  assert.equal(parseChatResponse(response).fit, 9);
});

test("parseChatResponse: clamps fit to [1, 10]", () => {
  assert.equal(parseChatResponse({ choices: [{ message: { content: '{"fit": 0}' } }] }).fit, 1);
  assert.equal(parseChatResponse({ choices: [{ message: { content: '{"fit": 99}' } }] }).fit, 10);
});

test("parseChatResponse: throws when there is no message content or no JSON object", () => {
  assert.throws(() => parseChatResponse({ choices: [] }));
  assert.throws(() => parseChatResponse({ choices: [{ message: { content: "no json here" } }] }));
  assert.throws(() => parseChatResponse({ choices: [{ message: { content: '{"reason": "no fit field"}' } }] }));
});
