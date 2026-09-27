// Pure-function tests for scripts/lib/audio-analysis.mjs's onset/silence
// math — synthetic Float32Array buffers, no ffmpeg involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rmsWindow,
  longestSilenceAfterFirstSound,
  findOnsetOffsetMs,
} from "../scripts/lib/audio-analysis.mjs";

const SR = 48000;

function silence(sec) {
  return new Float32Array(Math.round(sec * SR));
}

function toneBurst(freq, durSec, sr) {
  const n = Math.round(durSec * sr);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return buf;
}

function concat(...bufs) {
  const len = bufs.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(len);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

test("rmsWindow: constant-amplitude sine has RMS ~= amplitude/sqrt(2)", () => {
  const buf = toneBurst(1000, 0.1, SR);
  const r = rmsWindow(buf, 1000, 480); // one 10ms window well inside the tone
  assert.ok(Math.abs(r - 1 / Math.sqrt(2)) < 0.02, `rms=${r}`);
});

test("rmsWindow: out-of-range window returns 0, not NaN", () => {
  const buf = silence(0.01);
  assert.equal(rmsWindow(buf, buf.length + 100, 480), 0);
});

test("longestSilenceAfterFirstSound: reports 0 and null firstSound for an all-silent buffer", () => {
  const buf = silence(1);
  const result = longestSilenceAfterFirstSound(buf, SR, {});
  assert.equal(result.longestSilenceSec, 0);
  assert.equal(result.firstSoundSec, null);
});

test("longestSilenceAfterFirstSound: finds first sound and the longest gap after it", () => {
  // 0.2s silence, 0.1s tone (first sound), 0.9s silence (the long gap), 0.1s tone, 0.05s silence.
  const buf = concat(silence(0.2), toneBurst(1000, 0.1, SR), silence(0.9), toneBurst(1000, 0.1, SR), silence(0.05));
  const result = longestSilenceAfterFirstSound(buf, SR, { thresholdDb: -50 });
  assert.ok(Math.abs(result.firstSoundSec - 0.2) < 0.02, `firstSoundSec=${result.firstSoundSec}`);
  assert.ok(Math.abs(result.longestSilenceSec - 0.9) < 0.03, `longestSilenceSec=${result.longestSilenceSec}`);
});

test("findOnsetOffsetMs: onset exactly at the mark reports ~0ms offset", () => {
  const markAt = 1.0;
  const buf = concat(silence(markAt), toneBurst(1000, 0.2, SR));
  const offset = findOnsetOffsetMs(buf, SR, markAt, 0.15);
  assert.ok(offset != null, "expected an onset within the search window");
  assert.ok(Math.abs(offset) <= 15, `offset=${offset}ms, expected close to 0`);
});

test("findOnsetOffsetMs: a late onset reports a positive offset in ms", () => {
  const markAt = 1.0;
  const lagSec = 0.06; // 60ms late
  const buf = concat(silence(markAt + lagSec), toneBurst(1000, 0.2, SR));
  const offset = findOnsetOffsetMs(buf, SR, markAt, 0.15);
  assert.ok(offset != null);
  assert.ok(offset > 30 && offset < 90, `offset=${offset}ms, expected ~${lagSec * 1000}ms`);
});

test("findOnsetOffsetMs: no rise anywhere in the window returns null", () => {
  const buf = silence(2);
  const offset = findOnsetOffsetMs(buf, SR, 1.0, 0.15);
  assert.equal(offset, null);
});
