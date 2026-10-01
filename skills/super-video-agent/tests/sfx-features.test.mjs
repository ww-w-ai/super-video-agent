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

// whiteNoise's LCG loses precision in floating point and turns periodic
// past ~0.2 s; mulberry32 stays noise-like for the 1 s buffers below.
function longNoise(secs, sampleRate, seed = 1, amp = 0.8) {
  const n = Math.round(secs * sampleRate);
  const buf = new Float32Array(n);
  let a = seed >>> 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    buf[i] = amp * ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  }
  return buf;
}

function withLeadingSilence(buf, secs, sampleRate) {
  const pad = Math.round(secs * sampleRate);
  const out = new Float32Array(pad + buf.length);
  out.set(buf, pad);
  return out;
}

// Library MP3s open with encoder silence; the spectrum used to read only
// the first 2048 samples, so such a file measured brightness 0 Hz and
// noisiness 1.00 whatever it held.
test("brightness/noisiness/pitch: 100 ms of leading silence does not blank the spectrum", () => {
  const tone = withLeadingSilence(sine(1000, 1, SR), 0.1, SR);
  const noise = withLeadingSilence(longNoise(1, SR, 5), 0.1, SR);
  const b = brightnessHz(tone, SR);
  assert.ok(b > 800 && b < 1300, `expected a ~1 kHz centroid, got ${b}`);
  assert.ok(noisiness(tone, SR) < 0.2, `expected a tone to read tonal, got ${noisiness(tone, SR)}`);
  assert.ok(noisiness(noise, SR) > 0.5, `expected noise to read noisy, got ${noisiness(noise, SR)}`);
  assert.equal(pitchTrend(withLeadingSilence(risingSine(300, 1500, 1, SR), 0.1, SR), SR), "rising");
});

test("noisiness: noise with nothing above 16 kHz (an MP3 low-pass) still reads noisy", () => {
  // Blackman windowed-sinc low-pass at 15 kHz, 127 taps: flat below, about -70 dB above 16 kHz
  const raw = longNoise(1, SR, 9);
  const taps = 127;
  const fc = 15000 / SR;
  const h = [];
  for (let k = 0; k < taps; k++) {
    const m = k - (taps - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
    h.push(sinc * w);
  }
  const lp = new Float32Array(raw.length);
  for (let i = taps; i < raw.length; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) acc += h[k] * raw[i - k];
    lp[i] = acc;
  }
  assert.ok(noisiness(lp, SR) > 0.3, `expected low-passed noise to read noisy, got ${noisiness(lp, SR)}`);
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
