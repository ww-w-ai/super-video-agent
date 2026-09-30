// Pure-function tests for scripts/lib/sfx-features.mjs, on synthetic
// signals — no ffmpeg, no browser, so these run everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  peakDb,
  durationSec,
  attackMs,
  brightnessHz,
  noisiness,
  pitchTrend,
  measureFeatures,
} from "../scripts/lib/sfx-features.mjs";

const SR = 48000;

function sine(freq, secs, sampleRate, amp = 0.8) {
  const n = Math.round(secs * sampleRate);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return buf;
}

function risingSine(f0, f1, secs, sampleRate, amp = 0.8) {
  const n = Math.round(secs * sampleRate);
  const buf = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = f0 + (f1 - f0) * u;
    phase += (2 * Math.PI * f) / sampleRate;
    buf[i] = amp * Math.sin(phase);
  }
  return buf;
}

function whiteNoise(secs, sampleRate, seed = 1, amp = 0.8) {
  const n = Math.round(secs * sampleRate);
  const buf = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return buf;
}

function click(secs, sampleRate, amp = 0.9) {
  const n = Math.round(secs * sampleRate);
  const buf = new Float32Array(n);
  buf[Math.floor(n / 10)] = amp; // a single impulse near the start
  return buf;
}

test("durationSec: samples / sampleRate", () => {
  assert.equal(durationSec(new Float32Array(48000), 48000), 1);
  assert.equal(durationSec(new Float32Array(24000), 48000), 0.5);
});

test("peakDb: full-scale sine reads ~0dBFS, a quiet one reads well under", () => {
  const full = sine(440, 0.1, SR, 1.0);
  assert.ok(peakDb(full) > -0.5, `expected ~0dBFS, got ${peakDb(full)}`);
  const quiet = sine(440, 0.1, SR, 0.1);
  assert.ok(peakDb(quiet) < -18, `expected < -18dBFS, got ${peakDb(quiet)}`);
});

test("peakDb: silence is -Infinity", () => {
  assert.equal(peakDb(new Float32Array(1000)), -Infinity);
});

test("attackMs: an impulse click has a near-zero attack", () => {
  const buf = click(0.05, SR);
  const ms = attackMs(buf, SR);
  assert.ok(ms < 2, `expected a near-instant attack, got ${ms}ms`);
});

test("attackMs: a slow linear fade-in has a long attack", () => {
  const n = Math.round(0.2 * SR);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = (i / n) * Math.sin((2 * Math.PI * 300 * i) / SR);
  const ms = attackMs(buf, SR);
  assert.ok(ms > 50, `expected a slow swell-in, got ${ms}ms`);
});

test("noisiness: white noise reads high, a pure tone reads low", () => {
  const noise = whiteNoise(0.2, SR, 7);
  const tone = sine(440, 0.2, SR);
  const noiseScore = noisiness(noise, SR);
  const toneScore = noisiness(tone, SR);
  assert.ok(noiseScore > 0.5, `expected white noise noisiness > 0.5, got ${noiseScore}`);
  assert.ok(toneScore < noiseScore, `expected a pure tone to read less noisy than white noise (tone=${toneScore}, noise=${noiseScore})`);
});

test("brightnessHz: a higher-frequency tone reads a higher centroid", () => {
  const low = sine(200, 0.1, SR);
  const high = sine(4000, 0.1, SR);
  assert.ok(brightnessHz(high, SR) > brightnessHz(low, SR));
});

test("pitchTrend: a sine sweeping up reads rising, sweeping down reads falling", () => {
  const up = risingSine(200, 2000, 0.3, SR);
  const down = risingSine(2000, 200, 0.3, SR);
  assert.equal(pitchTrend(up, SR), "rising");
  assert.equal(pitchTrend(down, SR), "falling");
});

test("pitchTrend: a steady tone reads flat", () => {
  assert.equal(pitchTrend(sine(440, 0.3, SR), SR), "flat");
});

test("pitchTrend: white noise (no clear periodicity) reads none", () => {
  assert.equal(pitchTrend(whiteNoise(0.3, SR, 3), SR), "none");
});

test("measureFeatures: returns every field with the right shape", () => {
  const f = measureFeatures(sine(440, 0.3, SR), SR);
  assert.equal(typeof f.durationSec, "number");
  assert.equal(typeof f.peakDb, "number");
  assert.equal(typeof f.attackMs, "number");
  assert.equal(typeof f.brightnessHz, "number");
  assert.equal(typeof f.noisiness, "number");
  assert.ok(["rising", "falling", "flat", "none"].includes(f.pitchTrend));
});
