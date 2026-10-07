// Pure-function tests for scripts/engine/reel-audio.js. Side-effect-only
// script (no import/export) that attaches globalThis.ReelAudio; importing
// it here executes it exactly as the browser would.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-audio.js"));
const ReelAudio = globalThis.ReelAudio;
const SR = 48000;

function assertNoNaN(buf, label) {
  for (let i = 0; i < buf.length; i++) {
    assert.ok(Number.isFinite(buf[i]), `${label}[${i}] is not finite: ${buf[i]}`);
  }
}

function rms(buf, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(buf.length, end);
  let sum = 0;
  for (let i = s; i < e; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, e - s));
}

const SFX_KINDS = ["click", "type", "thud", "stamp", "whoosh", "pop", "tick", "ding"];

test("sfx determinism: same kind + args produces the same buffer twice", () => {
  for (const kind of SFX_KINDS) {
    const a = ReelAudio.sfx[kind](SR);
    const b = ReelAudio.sfx[kind](SR);
    assert.deepEqual(Array.from(a), Array.from(b), `${kind} not deterministic`);
  }
  const p1 = ReelAudio.sfx.pluck(440, 0.8, SR);
  const p2 = ReelAudio.sfx.pluck(440, 0.8, SR);
  assert.deepEqual(Array.from(p1), Array.from(p2));
});

test("sfx determinism: different seeds diverge", () => {
  const a = ReelAudio.sfx.click(SR, { seed: "a" });
  const b = ReelAudio.sfx.click(SR, { seed: "b" });
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test("onset ramp: applyAttackRamp zeroes sample 0 and rises linearly over >=1.5ms", () => {
  const n = Math.round(0.05 * SR);
  const flat = new Float32Array(n).fill(1);
  const rampMs = 1.5;
  ReelAudio.applyAttackRamp(flat, SR, rampMs);
  const rampSamples = Math.round((rampMs / 1000) * SR);
  assert.equal(flat[0], 0); // hard zero at t=0: no gain jump
  // strictly increasing across the ramp (linear i/N on a constant input)
  for (let i = 1; i < rampSamples; i++) {
    assert.ok(flat[i] > flat[i - 1], `sample ${i} did not rise (${flat[i - 1]} -> ${flat[i]})`);
  }
  // fully open after the ramp
  assert.ok(Math.abs(flat[rampSamples] - 1) < 1e-6);
});

test("onset ramp: every sfx generator's first sample is exactly 0 (no gain jump)", () => {
  for (const kind of SFX_KINDS) {
    const buf = ReelAudio.sfx[kind](SR);
    assert.equal(buf[0], 0, `${kind}[0] should be 0`);
  }
  assert.equal(ReelAudio.sfx.pluck(440, 1, SR)[0], 0);
});

test("no NaN: every sfx kind, pluck, musicBed, master, duck stay finite", () => {
  for (const kind of SFX_KINDS) {
    assertNoNaN(ReelAudio.sfx[kind](SR), kind);
  }
  assertNoNaN(ReelAudio.sfx.pluck(220, 0.3, SR), "pluck");

  const bed = ReelAudio.musicBed(2.5, SR, { bpm: 120, key: "G" });
  assertNoNaN(bed.L, "musicBed.L");
  assertNoNaN(bed.R, "musicBed.R");

  const m = ReelAudio.mix(2.5, SR);
  m.add(ReelAudio.sfx.thud(SR), 0.2, 0.9, -0.5);
  m.addStereo(bed, 0, 1);
  ReelAudio.master(m, { peakDb: -3 });
  assertNoNaN(m.L, "master.L");
  assertNoNaN(m.R, "master.R");

  ReelAudio.duck(bed, [{ start: 0.5, end: 1.2 }], { depthDb: -10, rampMs: 120 });
  assertNoNaN(bed.L, "duck.L");
  assertNoNaN(bed.R, "duck.R");
});

test("master: a hot input is soft-clipped to at most 2.4 dB over the requested peakDb (default -3 dBFS)", () => {
  const m = ReelAudio.mix(1, SR);
  m.add(ReelAudio.sfx.thud(SR), 0.1, 5, 0); // deliberately hot input
  m.add(ReelAudio.sfx.click(SR), 0.3, 5, -1);
  ReelAudio.master(m, { peakDb: -3 });
  const ceiling = Math.pow(10, -3 / 20) / Math.tanh(1);
  let peak = 0;
  for (let i = 0; i < m.L.length; i++) peak = Math.max(peak, Math.abs(m.L[i]), Math.abs(m.R[i]));
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak} exceeds the ceiling ${ceiling}`);
  assert.ok(peak > ceiling - 0.05); // not silently under-driven either
});

test("musicBed: no sustained tones — RMS after each bar's onset decays well below its peak before the bar ends", () => {
  const bpm = 120;
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const bed = ReelAudio.musicBed(barSec * 2, SR, { bpm, key: "C", gain: 0.3 });
  // Sample RMS in a short window right at a bar's downbeat (loud, onset)
  // and again near the very end of that bar (should have decayed: no note
  // sustains for a full bar — pluck envelopes, not pads).
  const win = Math.round(0.02 * SR); // 20ms window
  const onsetRms = rms(bed.L, 0, win);
  const barEndIdx = Math.round(barSec * SR) - win - Math.round(0.01 * SR);
  const tailRms = rms(bed.L, barEndIdx, barEndIdx + win);
  assert.ok(onsetRms > 0, "onset should have signal");
  assert.ok(
    tailRms < onsetRms * 0.5,
    `bed did not decay within a bar: onset=${onsetRms} tail=${tailRms}`
  );
});

test("duck: lowers bed RMS inside a narration window by >= 6 dB", () => {
  const bed = ReelAudio.musicBed(3, SR, { bpm: 120, key: "C", gain: 0.3 });
  const before = rms(bed.L, Math.round(1.0 * SR), Math.round(2.0 * SR));
  ReelAudio.duck(bed, [{ start: 0.5, end: 2.5 }], { depthDb: -10, rampMs: 120 });
  const after = rms(bed.L, Math.round(1.0 * SR), Math.round(2.0 * SR));
  assert.ok(before > 0, "bed should have signal before ducking");
  const dropDb = 20 * Math.log10(after / before);
  assert.ok(dropDb <= -6, `duck only dropped ${dropDb} dB, expected <= -6 dB`);
});

test("mix: L/R length is exactly round(duration * sampleRate) — the renderSfx length contract", () => {
  const cases = [
    { duration: 5, sampleRate: 48000 },
    { duration: 2.333, sampleRate: 48000 },
    { duration: 0.1, sampleRate: 44100 },
  ];
  for (const { duration, sampleRate } of cases) {
    const m = ReelAudio.mix(duration, sampleRate);
    const expected = Math.round(duration * sampleRate);
    assert.equal(m.L.length, expected);
    assert.equal(m.R.length, expected);
    // master must not change length (renderSfx returns mix.L/R post-master)
    m.add(ReelAudio.sfx.click(sampleRate), duration - 0.01, 1, 0);
    ReelAudio.master(m, { peakDb: -3 });
    assert.equal(m.L.length, expected);
    assert.equal(m.R.length, expected);
  }
});

test("kit sound decreases retain their existing natural decay before the buffer ends", () => {
  for (const kind of [...SFX_KINDS, "pluck"]) {
    const buffer = ReelAudio.sfx[kind](SR);
    const win = Math.max(1, Math.round(buffer.length / 20));
    let loudest = 0;
    for (let i = 0; i + win <= buffer.length; i += win) loudest = Math.max(loudest, rms(buffer, i, i + win));
    assert.ok(rms(buffer, buffer.length - win, buffer.length) < loudest * 0.15,
      `${kind} must decay before its natural end`);
  }
});

test("engine duck decreases the bed through its default ramp, without a gain step", () => {
  const bed = {sampleRate:SR,L:new Float32Array(SR).fill(1),R:new Float32Array(SR).fill(1)};
  ReelAudio.duck(bed, [{start:0.4,end:0.7}]);
  assert.equal(bed.L[Math.round(0.27*SR)], 1);
  assert.ok(bed.L[Math.round(0.34*SR)] < 1 && bed.L[Math.round(0.34*SR)] > bed.L[Math.round(0.4*SR)]);
  let maxStep = 0;
  for (let i = 1; i < bed.L.length; i++) maxStep = Math.max(maxStep, Math.abs(bed.L[i] - bed.L[i-1]));
  assert.ok(maxStep < 0.001, `default decrease must be a ramp, got step ${maxStep}`);
});
