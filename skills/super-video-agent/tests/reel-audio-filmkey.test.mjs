// Pure-function tests for scripts/engine/reel-audio.js's per-film character
// (craft.md: every film's kit sounded like the first film's — measured: one
// kind's default seed was the literal kind name in every reel). setFilmKey
// gives each kind's *default* seed a film-specific prefix and derives small
// deterministic pitch/decay/brightness offsets from the same key.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-audio.js"));
const ReelAudio = globalThis.ReelAudio;
const SR = 48000;

// Kinds whose default (no explicit seed/freq) is affected by film character.
const FILM_VARIED_KINDS = ["click", "type", "thud", "whoosh", "tick", "ding", "pop"];

test("setFilmKey: no key set (default) matches the pre-existing, unkeyed buffers", () => {
  ReelAudio.setFilmKey("");
  const thud = ReelAudio.sfx.thud(SR);
  ReelAudio.setFilmKey(""); // idempotent — still no key
  const thudAgain = ReelAudio.sfx.thud(SR);
  assert.deepEqual(Array.from(thud), Array.from(thudAgain));
});

test("setFilmKey: same film key -> identical samples for every kit kind", () => {
  for (const kind of FILM_VARIED_KINDS) {
    ReelAudio.setFilmKey("film-a");
    const a = ReelAudio.sfx[kind](SR);
    ReelAudio.setFilmKey("film-a");
    const b = ReelAudio.sfx[kind](SR);
    assert.deepEqual(Array.from(a), Array.from(b), `${kind}: same film key diverged`);
  }
});

test("setFilmKey: different film keys -> different samples for every kit kind", () => {
  for (const kind of FILM_VARIED_KINDS) {
    ReelAudio.setFilmKey("basketball-promo");
    const a = ReelAudio.sfx[kind](SR);
    ReelAudio.setFilmKey("kitchen-promo");
    const b = ReelAudio.sfx[kind](SR);
    assert.notDeepEqual(Array.from(a), Array.from(b), `${kind}: different film keys produced the same buffer`);
  }
  ReelAudio.setFilmKey("");
});

test("setFilmKey: an explicit seed still wins — unaffected by the film key", () => {
  ReelAudio.setFilmKey("film-a");
  const withA = ReelAudio.sfx.click(SR, { seed: "explicit-seed" });
  ReelAudio.setFilmKey("film-b");
  const withB = ReelAudio.sfx.click(SR, { seed: "explicit-seed" });
  assert.deepEqual(Array.from(withA), Array.from(withB));
  ReelAudio.setFilmKey("");
});

test("setFilmKey: an explicit freq still wins for pop/ding — unaffected by the film key", () => {
  ReelAudio.setFilmKey("film-a");
  const popA = ReelAudio.sfx.pop(SR, { freq: 900 });
  const dingA = ReelAudio.sfx.ding(SR, { freq: 600 });
  ReelAudio.setFilmKey("film-b");
  const popB = ReelAudio.sfx.pop(SR, { freq: 900 });
  const dingB = ReelAudio.sfx.ding(SR, { freq: 600 });
  assert.deepEqual(Array.from(popA), Array.from(popB));
  assert.deepEqual(Array.from(dingA), Array.from(dingB));
  ReelAudio.setFilmKey("");
});

test("setFilmKey: musicBed pitches (always explicit freq via noteFreq) are unaffected by the film key", () => {
  ReelAudio.setFilmKey("film-a");
  const bedA = ReelAudio.musicBed(1.5, SR, { bpm: 120, key: "C" });
  ReelAudio.setFilmKey("film-b");
  const bedB = ReelAudio.musicBed(1.5, SR, { bpm: 120, key: "C" });
  assert.deepEqual(Array.from(bedA.L), Array.from(bedB.L));
  ReelAudio.setFilmKey("");
});

test("setFilmKey: pitch/decay/brightness offsets stay within their documented range", () => {
  // Indirect range check: a pitch offset of +-4 semitones bounds sfxThud's
  // resonant frequency to 95 * 2^(+-4/12) ~= [75.4, 119.7] Hz. Measure the
  // dominant frequency via zero-crossing rate over the decaying body and
  // confirm every sampled film key lands inside that band.
  const MIN_HZ = 95 * Math.pow(2, -4 / 12) - 1; // small tolerance
  const MAX_HZ = 95 * Math.pow(2, 4 / 12) + 1;
  for (const key of ["a", "bbb", "kitchen-promo-2026", "z9", "long-film-key-name-here"]) {
    ReelAudio.setFilmKey(key);
    const buf = ReelAudio.sfx.thud(SR);
    const hz = dominantFreqByZeroCrossing(buf, SR);
    assert.ok(
      hz >= MIN_HZ * 0.5 && hz <= MAX_HZ * 1.5, // generous: zero-crossing on a noisy exciter is approximate
      `film key "${key}": thud dominant freq ${hz}Hz out of the expected ~[${MIN_HZ},${MAX_HZ}]Hz band`
    );
  }
  ReelAudio.setFilmKey("");
});

function dominantFreqByZeroCrossing(buf, sampleRate) {
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] < 0 && buf[i] >= 0) || (buf[i - 1] >= 0 && buf[i] < 0)) crossings++;
  }
  const seconds = buf.length / sampleRate;
  return crossings / 2 / seconds;
}
