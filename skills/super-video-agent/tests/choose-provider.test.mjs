// Pure priority-order test for voice.mjs's provider auto-choice
// (scripts/lib/choose-provider.mjs) — file > qwen3 > fish > elevenlabs >
// melotts > say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseProvider } from "../scripts/lib/choose-provider.mjs";

test("chooseProvider: file wins when voice/in/ has audio, regardless of anything else", () => {
  const { provider } = chooseProvider({
    hasVoiceInDir: true,
    qwen3PythonFound: true,
    refAudioSet: true,
    fishKeySet: true,
    elevenKeySet: true,
    melottsPythonFound: true,
  });
  assert.equal(provider, "file");
});

test("chooseProvider: qwen3 requires BOTH python found AND refAudio set", () => {
  assert.equal(chooseProvider({ qwen3PythonFound: true, refAudioSet: false, fishKeySet: true }).provider, "fish");
  assert.equal(chooseProvider({ qwen3PythonFound: false, refAudioSet: true, fishKeySet: true }).provider, "fish");
  assert.equal(chooseProvider({ qwen3PythonFound: true, refAudioSet: true }).provider, "qwen3");
});

test("chooseProvider: fish before elevenlabs before melotts", () => {
  assert.equal(chooseProvider({ fishKeySet: true, elevenKeySet: true, melottsPythonFound: true }).provider, "fish");
  assert.equal(chooseProvider({ fishKeySet: false, elevenKeySet: true, melottsPythonFound: true }).provider, "elevenlabs");
  assert.equal(chooseProvider({ fishKeySet: false, elevenKeySet: false, melottsPythonFound: true }).provider, "melotts");
});

test("chooseProvider: falls back to say when nothing else is available", () => {
  const { provider, reason } = chooseProvider({});
  assert.equal(provider, "say");
  assert.ok(reason.length > 0);
});
