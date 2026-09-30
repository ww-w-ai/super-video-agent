// Pure priority-order test for voice.mjs's provider auto-choice
// (scripts/lib/choose-provider.mjs) — file > qwen3 > fish > elevenlabs >
// melotts; nothing set up gives no provider.
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

test("chooseProvider: picks nothing when no provider is set up, and says what to set up", () => {
  const { provider, reason } = chooseProvider({});
  assert.equal(provider, null);
  assert.match(reason, /SVA_QWEN3_PYTHON/);
  assert.match(reason, /ELEVENLABS_API_KEY/);
});
