import { test } from "node:test";
import assert from "node:assert/strict";
import { qwenLanguage } from "../scripts/voice/qwen3.mjs";

test("qwenLanguage maps BCP 47 primary subtags to Qwen3-TTS names", () => {
  assert.equal(qwenLanguage("ko-KR"), "Korean");
  assert.equal(qwenLanguage("en-US"), "English");
  assert.equal(qwenLanguage("zh-Hant"), "Chinese");
  assert.equal(qwenLanguage("ja"), "Japanese");
  assert.equal(qwenLanguage("es-419"), "Spanish");
  assert.equal(qwenLanguage("pt-BR"), "Portuguese");
  assert.equal(qwenLanguage("de"), "German");
  assert.equal(qwenLanguage("fr-FR"), "French");
  assert.equal(qwenLanguage("ru"), "Russian");
  assert.equal(qwenLanguage("it"), "Italian");
});

test("qwenLanguage falls back to Auto", () => {
  assert.equal(qwenLanguage("hi-IN"), "Auto");
  assert.equal(qwenLanguage(undefined), "Auto");
});
