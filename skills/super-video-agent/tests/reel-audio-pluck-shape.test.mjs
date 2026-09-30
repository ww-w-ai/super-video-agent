// Pure-function tests: ReelAudio.sfx.pluck now takes the same call shape as
// every other kit effect (sampleRate, opts), matching sfxStems()'s generic
// `gen(sampleRate, {seed: ...})` call — the old shape (freq, vel,
// sampleRate) still works for backward compatibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-audio.js"));
const ReelAudio = globalThis.ReelAudio;
const SR = 48000;

test("pluck: new shape (sampleRate, {freq, vel}) matches the old shape (freq, vel, sampleRate) for the same values", () => {
  const oldShape = ReelAudio.sfx.pluck(440, 0.8, SR);
  const newShape = ReelAudio.sfx.pluck(SR, { freq: 440, vel: 0.8 });
  assert.deepEqual(Array.from(oldShape), Array.from(newShape));
});

test("pluck: new shape called the same way every other kit effect is called — gen(sampleRate, opts) — does not throw", () => {
  const buf = ReelAudio.sfx.pluck(SR, { seed: "pluck:1.0" });
  assert.ok(buf.length > 0);
  for (let i = 0; i < buf.length; i++) assert.ok(Number.isFinite(buf[i]));
});

test("pluck: new shape defaults freq/vel when omitted, and is deterministic", () => {
  const a = ReelAudio.sfx.pluck(SR);
  const b = ReelAudio.sfx.pluck(SR, {});
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("pluck: new shape's opts (decayMul, partials) still reach pluckBuf", () => {
  const short = ReelAudio.sfx.pluck(SR, { freq: 440, vel: 1, decayMul: 0.3 });
  const long = ReelAudio.sfx.pluck(SR, { freq: 440, vel: 1, decayMul: 3 });
  assert.notEqual(short.length, long.length); // decayMul changes tau -> changes buffer length
});
