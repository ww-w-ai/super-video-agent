// Super Video Agent audio engine — browser-side, no imports, no network, no wall-clock.
// Deterministic sample synthesis into Float32Array buffers. Every generator
// is a pure function of its explicit arguments (or of a seed string), so the
// same cue list renders identical audio on every run (design.md's
// determinism contract, extended to sound). Attaches globalThis.ReelAudio.
// Inlined verbatim into each reel.html by new-reel.mjs, next to reel-engine.js.
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // hash + seeded RNG (self-contained copy of reel-engine.js's algorithm —
  // this file carries no imports, so it cannot reuse globalThis.Reel).
  // ---------------------------------------------------------------------

  function hashStr(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFor(seedKey) {
    return mulberry32(hashStr(seedKey));
  }

  // ---------------------------------------------------------------------
  // per-film character (every film's kit sounded the same — the first film
  // was a basketball promo, and every later film's sounds carried that same
  // character; measured across 34 reels: pop in 13, thud in 6, whoosh/tick/
  // ding in 5 each — because every kind's default seed was the literal kind
  // name. references/sound.md "Kit").
  // setFilmKey(key), called once at page load, gives each kind's *default*
  // seed a film-specific prefix and derives small deterministic offsets
  // (pitch, decay, brightness/filter) per kind from that same key, so the
  // same kind still sounds like itself but differs film to film. An
  // explicit `seed` (or, for pop/ding, an explicit `freq`) from the caller
  // is never touched: default-only, same film -> identical samples, same
  // key across renders (seek is still a pure function of t).
  // ---------------------------------------------------------------------
  var filmKey = "";

  function setFilmKey(key) {
    filmKey = key == null ? "" : String(key);
  }

  function defaultSeed(kind) {
    return filmKey ? filmKey + ":" + kind : kind;
  }

  var IDENTITY_CHARACTER = { pitchSemi: 0, decayMul: 1, brightMul: 1 };

  // Deterministic per-(film, kind) offsets: pitch +-4 semitones, decay and
  // brightness/filter each +-30%. No film key set (filmKey === "") ->
  // identity, so behavior is unchanged for every existing render.
  function filmCharacter(kind) {
    if (!filmKey) return IDENTITY_CHARACTER;
    var rng = rngFor(filmKey + ":char:" + kind);
    return {
      pitchSemi: (rng() * 2 - 1) * 4,
      decayMul: 1 + (rng() * 2 - 1) * 0.3,
      brightMul: 1 + (rng() * 2 - 1) * 0.3,
    };
  }

  function semitoneRatio(semitones) {
    return Math.pow(2, semitones / 12);
  }

  // Per-seed character for pop and ding: an explicit `seed` varies pitch (+-3 semitones), decay and
  // brightness (+-25%) from the seed alone, so two seeds sound like two different hits and one seed
  // always sounds the same. An explicit `freq` keeps its pitch exact; the seed then varies the timbre.
  function seedCharacter(seed) {
    var rng = rngFor("seed-char:" + seed);
    return {
      pitchSemi: (rng() * 2 - 1) * 3,
      decayMul: 1 + (rng() * 2 - 1) * 0.25,
      brightMul: 1 + (rng() * 2 - 1) * 0.25,
    };
  }

  // The character a pitched effect (pop, ding) plays with: its seed's, else the film's for the kind
  // (identity when the caller gave an explicit freq).
  function pitchedCharacter(kind, o) {
    if (o.seed != null) return seedCharacter(kind + ":" + o.seed);
    return o.freq != null ? IDENTITY_CHARACTER : filmCharacter(kind);
  }

  // ---------------------------------------------------------------------
  // buffer utilities
  // ---------------------------------------------------------------------

  // Linear-ramp the first `rampMs` of `buf` from 0 -> its own value, in
  // place, and return it. Every sfx onset uses this: a hard sample jump at
  // t=0 rings in the AAC codec (riso-windowseat "Mix and master").
  function applyAttackRamp(buf, sampleRate, rampMs) {
    const ms = rampMs == null ? 1.5 : rampMs;
    const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
    const lim = Math.min(n, buf.length);
    for (let i = 0; i < lim; i++) {
      buf[i] = i === 0 ? 0 : buf[i] * (i / n); // avoid -0 when the raw sample is negative
    }
    return buf;
  }

  // Scale `buf` in place so its peak absolute sample equals `target` (0..1).
  // Silent buffers are left untouched (no division by ~0).
  function normalizePeak(buf, target) {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-9) return buf;
    const g = target / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
    return buf;
  }

  function scaleBuf(buf, g) {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g;
    return out;
  }

  function sumMono(buffers) {
    let len = 0;
    for (const b of buffers) if (b.length > len) len = b.length;
    const out = new Float32Array(len);
    for (const b of buffers) {
      for (let i = 0; i < b.length; i++) out[i] += b[i];
    }
    return out;
  }

  function noiseBurst(seedKey, durSec, sampleRate) {
    const rng = rngFor(seedKey);
    const n = Math.max(1, Math.round(durSec * sampleRate));
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = rng() * 2 - 1;
    return buf;
  }

  // One struck-material resonator: a 2-pole filter whose impulse response is
  // a decaying sinusoid at `freqHz` with time constant `tauSec` (sound.md
  // "Material is the timbre" — exciter -> resonator -> body). `outLenSec` is
  // the tail length rendered past the exciter.
  function resonate(exciter, freqHz, tauSec, sampleRate, outLenSec) {
    const outN = Math.max(exciter.length, Math.round(outLenSec * sampleRate));
    const out = new Float32Array(outN);
    const r = Math.exp(-1 / (tauSec * sampleRate));
    const w = (2 * Math.PI * freqHz) / sampleRate;
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < outN; i++) {
      const x = i < exciter.length ? exciter[i] : 0;
      const y = x + a1 * y1 + a2 * y2;
      out[i] = y;
      y2 = y1;
      y1 = y;
    }
    return out;
  }

  // Finish a raw sfx buffer: normalize to `peak`, then apply the onset ramp.
  // Shared tail for every sfx generator below.
  function finishSfx(buf, sampleRate, peak, rampMs) {
    normalizePeak(buf, peak == null ? 0.9 : peak);
    applyAttackRamp(buf, sampleRate, rampMs == null ? 1.5 : rampMs);
    return buf;
  }

  // ---------------------------------------------------------------------
  // sfx kit — each returns a mono Float32Array
  // ---------------------------------------------------------------------

  function sfxClick(sampleRate, opts) {
    const o = opts || {};
    const explicitSeed = o.seed != null;
    const seed = o.seed || defaultSeed("click");
    const character = explicitSeed ? IDENTITY_CHARACTER : filmCharacter("click");
    const exciter = noiseBurst(seed, 0.0005, sampleRate); // 0.5ms noise exciter
    const freq = 2800 * semitoneRatio(character.pitchSemi);
    const tau = 0.01 * character.decayMul;
    const buf = resonate(exciter, freq, tau, sampleRate, 0.03); // short band-pass body
    return finishSfx(buf, sampleRate, 0.9, 1.5);
  }

  function sfxType(sampleRate, opts) {
    const o = opts || {};
    const explicitSeed = o.seed != null;
    const seed = o.seed || defaultSeed("type");
    const character = explicitSeed ? IDENTITY_CHARACTER : filmCharacter("type");
    const click = sfxClick(sampleRate, { seed: seed + ":click" });
    const bodyExciter = noiseBurst(seed + ":body", 0.001, sampleRate);
    const bodyFreq = 550 * semitoneRatio(character.pitchSemi);
    const bodyTau = 0.02 * character.decayMul;
    const body = scaleBuf(resonate(bodyExciter, bodyFreq, bodyTau, sampleRate, 0.05), 0.35);
    return finishSfx(sumMono([click, body]), sampleRate, 0.85, 1.5);
  }

  function sfxThud(sampleRate, opts) {
    const o = opts || {};
    const explicitSeed = o.seed != null;
    const seed = o.seed || defaultSeed("thud");
    const character = explicitSeed ? IDENTITY_CHARACTER : filmCharacter("thud");
    const exciter = noiseBurst(seed, 0.02, sampleRate); // 20ms low exciter, the "쾅"
    const freq = 95 * semitoneRatio(character.pitchSemi); // 80-120Hz body
    const tau = 0.14 * character.decayMul;
    const buf = resonate(exciter, freq, tau, sampleRate, 0.35);
    return finishSfx(buf, sampleRate, 0.95, 1.5);
  }

  function sfxWhoosh(sampleRate, opts) {
    const o = opts || {};
    const explicitSeed = o.seed != null;
    const seed = o.seed || defaultSeed("whoosh");
    const character = explicitSeed ? IDENTITY_CHARACTER : filmCharacter("whoosh");
    const durSec = o.durSec || 0.28;
    const rng = rngFor(seed);
    const n = Math.round(durSec * sampleRate);
    const buf = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const cutoffHz = (250 + u * 2600) * character.brightMul; // sweeps upward through the burst
      const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
      const x = rng() * 2 - 1;
      lp = (1 - a) * x + a * lp;
      buf[i] = lp * Math.sin(Math.PI * u); // rise-then-fall envelope, no drone
    }
    return finishSfx(buf, sampleRate, 0.8, 1.5);
  }

  function pluckBuf(freq, vel, sampleRate, opts) {
    const o = opts || {};
    const v = vel == null ? 1 : vel;
    const decayMul = o.decayMul == null ? 1 : o.decayMul;
    const tau = 0.45 * Math.sqrt(440 / freq) * decayMul; // music-box recipe
    const durSec = Math.max(0.25, tau * 6);
    const n = Math.round(durSec * sampleRate);
    const buf = new Float32Array(n);
    const pingTau = 0.012; // strike ping dies in ~60ms (5 time constants)
    const partials = o.partials || [1, 2, 3];
    const partialGains = o.partialGains || [1.0, 0.35, 0.12];
    const pingGain = o.pingGain == null ? 0.08 : o.pingGain;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let body = 0;
      for (let p = 0; p < partials.length; p++) {
        body += partialGains[p] * Math.sin(2 * Math.PI * freq * partials[p] * t);
      }
      const bodyEnv = Math.exp(-t / tau);
      const ping = pingGain * Math.sin(2 * Math.PI * freq * 5.4 * t) * Math.exp(-t / pingTau);
      buf[i] = (body * bodyEnv + ping) * v;
    }
    return finishSfx(buf, sampleRate, 0.9, 2); // 2ms linear attack per recipe
  }

  function sfxPop(sampleRate, opts) {
    const o = opts || {};
    const character = pitchedCharacter("pop", o);
    const pitchSemi = o.freq != null ? 0 : character.pitchSemi;
    const freq = (o.freq || 700) * semitoneRatio(pitchSemi);
    return pluckBuf(freq, o.vel == null ? 0.5 : o.vel, sampleRate, {
      pingGain: 0.05 * (o.seed != null ? character.brightMul : 1),
      decayMul: character.decayMul,
    });
  }

  function sfxTick(sampleRate, opts) {
    const o = opts || {};
    const explicitSeed = o.seed != null;
    const seed = o.seed || defaultSeed("tick");
    const character = explicitSeed ? IDENTITY_CHARACTER : filmCharacter("tick");
    const exciter = noiseBurst(seed, 0.0004, sampleRate);
    const freq = 4200 * semitoneRatio(character.pitchSemi);
    const tau = 0.004 * character.decayMul;
    const buf = resonate(exciter, freq, tau, sampleRate, 0.015);
    return finishSfx(buf, sampleRate, 0.5, 1.5);
  }

  function partialTone(freq, ratios, gains, tau, sampleRate, durSec) {
    const n = Math.round(durSec * sampleRate);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let s = 0;
      for (let p = 0; p < ratios.length; p++) {
        s += gains[p] * Math.sin(2 * Math.PI * freq * ratios[p] * t);
      }
      buf[i] = s * Math.exp(-t / tau);
    }
    return buf;
  }

  function sfxDing(sampleRate, opts) {
    const o = opts || {};
    const character = pitchedCharacter("ding", o);
    const pitchSemi = o.freq != null ? 0 : character.pitchSemi;
    const freq = (o.freq || 523.2511) * semitoneRatio(pitchSemi); // C5
    const tau = 1.2 * character.decayMul;
    const bright = o.seed != null ? character.brightMul : 1; // a seed also tilts the upper partials
    const buf = partialTone(freq, [1, 2, 3, 4.2], [1.0, 0.4 * bright, 0.2 * bright, 0.1 * bright], tau, sampleRate, tau * 5);
    return finishSfx(buf, sampleRate, 0.85, 2);
  }

  // sfxPluck(sampleRate, opts) — same call shape as every other kit effect
  // (sampleRate first, an opts object second: {freq, vel, ...pluckBuf's
  // decayMul/partials/partialGains/pingGain}). The old positional shape,
  // sfxPluck(freq, vel, sampleRate), is still accepted for backward
  // compatibility: a numeric third argument means the old shape was used.
  function sfxPluck(a, b, c) {
    if (typeof c === "number") {
      return pluckBuf(a, b, c, {}); // old shape: (freq, vel, sampleRate)
    }
    const sampleRate = a;
    const o = b || {};
    const freq = o.freq == null ? 440 : o.freq;
    const vel = o.vel == null ? 1 : o.vel;
    return pluckBuf(freq, vel, sampleRate, o);
  }

  // ---------------------------------------------------------------------
  // mix — the sample buffer a whole reel's sfx + bed are written into
  // ---------------------------------------------------------------------

  // mix(duration, sampleRate) -> {L, R, add, addStereo, sampleRate, duration}.
  // `L`/`R` are exactly round(duration*sampleRate) samples — the length
  // render.mjs writes into the muxed wav, so the reel's audio track is
  // always exactly `duration` seconds regardless of what onsets land near
  // the end.
  function mix(duration, sampleRate) {
    const n = Math.max(0, Math.round(duration * sampleRate));
    const L = new Float32Array(n);
    const R = new Float32Array(n);

    function add(buffer, atSec, gain, pan) {
      const g = gain == null ? 1 : gain;
      const p = pan == null ? 0 : pan; // -1 (left) .. 1 (right), equal-power
      const angle = ((p + 1) * Math.PI) / 4;
      const gL = Math.cos(angle);
      const gR = Math.sin(angle);
      const start = Math.round((atSec || 0) * sampleRate);
      for (let i = 0; i < buffer.length; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= n) continue;
        L[idx] += buffer[i] * g * gL;
        R[idx] += buffer[i] * g * gR;
      }
    }

    // addStereo(stereoBuf, atSec, gain) — mixes a {L,R} buffer (e.g. a
    // musicBed) in directly, no panning (the bed is already centred).
    function addStereo(stereoBuf, atSec, gain) {
      const g = gain == null ? 1 : gain;
      const start = Math.round((atSec || 0) * sampleRate);
      const len = Math.min(stereoBuf.L.length, stereoBuf.R.length);
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= n) continue;
        L[idx] += stereoBuf.L[i] * g;
        R[idx] += stereoBuf.R[i] * g;
      }
    }

    return { L, R, add, addStereo, sampleRate, duration };
  }

  // ---------------------------------------------------------------------
  // musicBed — quiet music-box bed, no sustained tones (music-recipe.md)
  // ---------------------------------------------------------------------

  const KEY_OFFSETS = { C: 0, G: 7, D: 2 };
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const PENTATONIC_DEGREES = [0, 1, 2, 4, 5]; // scale indices for 1 2 3 5 6
  const CHORD_DEGREES = [0, 3, 4, 0]; // I IV V I, one per bar of a 4-bar phrase
  const ARP_OFFSETS = [0, 7, 4, 7]; // 1-5-3-5, semitones from the chord root

  function noteFreq(semitoneFromC4) {
    return 261.6255653005986 * Math.pow(2, semitoneFromC4 / 12);
  }

  // musicBed(duration, sampleRate, {bpm=120, key="C", gain}) -> stereo mix
  // object (same shape as mix()). Major key, I-IV-V-I one chord per bar,
  // triplet-eighth 1-5-3-5 arpeggio, pentatonic melody in 4-bar
  // question/answer pairs (question ends on the 5th, answer resolves on the
  // root). Every note is a pluck: attack + pure exponential decay, so the
  // bed never holds a sustained tone (music-recipe.md's central ban).
  function musicBed(duration, sampleRate, opts) {
    const o = opts || {};
    const bpm = o.bpm || 120;
    const key = o.key && KEY_OFFSETS[o.key] != null ? o.key : "C";
    const keyOffset = KEY_OFFSETS[key];
    const bedGain = o.gain == null ? 0.22 : o.gain;
    const beatSec = 60 / bpm;
    const barSec = beatSec * 4;
    const tripletSec = beatSec / 3;
    const barCount = Math.max(1, Math.ceil(duration / barSec));
    const m = mix(duration, sampleRate);

    for (let bar = 0; bar < barCount; bar++) {
      const phraseBar = bar % 4;
      const chordDeg = CHORD_DEGREES[phraseBar];
      const chordRoot = MAJOR_SCALE[chordDeg] + keyOffset;
      const barStart = bar * barSec;

      const bassFreq = noteFreq(chordRoot - 24);
      const bassBuf = pluckBuf(bassFreq, 0.5, sampleRate, {
        partials: [1, 2],
        partialGains: [1.0, 0.35],
        pingGain: 0,
      });
      m.add(bassBuf, barStart, bedGain, 0);

      for (let k = 0; k < 12; k++) {
        const t = barStart + k * tripletSec;
        const semis = chordRoot + ARP_OFFSETS[k % 4];
        const vel = k % 3 === 0 ? 1.0 : 0.7; // strong beats vs the rest
        const buf = pluckBuf(noteFreq(semis), vel, sampleRate, {});
        m.add(buf, t, bedGain * 0.55, 0);
      }

      for (let beat = 0; beat < 4; beat++) {
        const t = barStart + beat * beatSec;
        const idxInPhrase = phraseBar * 4 + beat; // 0..15 across the 4-bar phrase
        let degIdx;
        if (idxInPhrase === 7) degIdx = 3; // question ends on the 5th (over V)
        else if (idxInPhrase === 15) degIdx = 0; // answer resolves on the root (over I)
        else {
          const rng = rngFor("sva-bed-melody:" + bar + ":" + beat);
          degIdx = PENTATONIC_DEGREES[Math.floor(rng() * PENTATONIC_DEGREES.length)];
        }
        const semis = MAJOR_SCALE[degIdx] + keyOffset + 12;
        const buf = pluckBuf(noteFreq(semis), 0.8, sampleRate, {});
        m.add(buf, t, bedGain * 0.75, 0);
      }
    }

    return m;
  }

  // ---------------------------------------------------------------------
  // master + duck
  // ---------------------------------------------------------------------

  // master(mixObj, {peakDb=-3, refPeak=0.35}) — tanh soft-clip with a FIXED drive of 1 / refPeak, then
  // one fixed gain: a sample whose pre-master level is `refPeak` comes out at `peakDb`, a louder one is
  // soft-clipped (at most 2.4 dB above `peakDb`), a quieter one stays proportionally lower. The drive does
  // not depend on the mix, so adding or removing a hit never changes the level of any other hit. 0.35 is a music-box bed's own peak. Set `refPeak` to the pre-master peak of the
  // mix you want mastered to `peakDb` (measure it once), and keep it when the cue list changes.
  // Mutates and returns mixObj.L/R.
  const DEFAULT_MASTER_REF_PEAK = 0.35;
  function master(mixObj, opts) {
    const o = opts || {};
    const peakDb = o.peakDb == null ? -3 : o.peakDb;
    const refPeak = o.refPeak == null ? DEFAULT_MASTER_REF_PEAK : o.refPeak;
    if (!(refPeak > 0)) throw new Error("ReelAudio.master: refPeak must be a number > 0");
    const drive = 1 / refPeak;
    const finalGain = Math.pow(10, peakDb / 20) / Math.tanh(1);
    for (const c of [mixObj.L, mixObj.R]) {
      for (let i = 0; i < c.length; i++) c[i] = Math.tanh(c[i] * drive) * finalGain;
    }
    return mixObj;
  }

  // duck(bed, narrationWindows, {depthDb=-10, rampMs=120}) — lowers `bed`'s
  // L/R in place under each {start,end} window (narration seconds), with a
  // linear ramp in/out so the gain change is inaudible as a jump. Mutates
  // and returns `bed`.
  function duck(bed, narrationWindows, opts) {
    const o = opts || {};
    const depthDb = o.depthDb == null ? -10 : o.depthDb;
    const rampMs = o.rampMs == null ? 120 : o.rampMs;
    const sampleRate = bed.sampleRate;
    const duckGain = Math.pow(10, depthDb / 20);
    const rampN = Math.max(1, Math.round((rampMs / 1000) * sampleRate));
    const n = bed.L.length;
    const gainCurve = new Float32Array(n).fill(1);

    for (const win of narrationWindows || []) {
      const s = Math.max(0, Math.round(win.start * sampleRate));
      const e = Math.min(n, Math.round(win.end * sampleRate));
      for (let i = s; i < e; i++) gainCurve[i] = Math.min(gainCurve[i], duckGain);
      for (let i = 1; i <= rampN; i++) {
        const idx = s - i;
        if (idx < 0) break;
        const u = 1 - i / rampN;
        gainCurve[idx] = Math.min(gainCurve[idx], 1 + (duckGain - 1) * u);
      }
      for (let i = 0; i < rampN; i++) {
        const idx = e + i;
        if (idx >= n) break;
        const u = i / rampN;
        gainCurve[idx] = Math.min(gainCurve[idx], duckGain + (1 - duckGain) * u);
      }
    }

    for (let i = 0; i < n; i++) {
      bed.L[i] *= gainCurve[i];
      bed.R[i] *= gainCurve[i];
    }
    return bed;
  }

  // ---------------------------------------------------------------------
  // sfxPool — several sounds per effect kind, so a kind that returns many times does not repeat
  // ---------------------------------------------------------------------

  function peakOf(buf) {
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
  }

  // `src` played at `rate` (above 1 = higher and shorter), linear interpolation.
  function resample(src, rate) {
    if (rate === 1) return src;
    const n = Math.max(1, Math.floor(src.length / rate));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * rate;
      const j = Math.floor(x);
      const f = x - j;
      out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f;
    }
    return out;
  }

  const variantId = (kind, i, v) => (v.file ? v.file : kind + "-" + i);

  // sfxPool(pools, {seed}) -> {assign(cues), buffer(cue, sampleRate, files)}
  // `pools` maps an effect kind to its variants: {gen, seed?, rate?} (the kit synth `gen`, run with `seed`,
  // default the variant's id such as "pop-2", and played at pitch `rate`, 1 = as made) or {file, like} (a library file, levelled to the peak of the
  // kit's own `like` effect so it sits with the rest of the kind). Both kinds mix in one pool.
  //   assign(cues)  cues = [{kind, at, ...}] in any order. In time order each cue of a pooled kind gets
  //                 `variant` (the pool index) and `sound` (an id): the least-used variant of its kind that
  //                 is not the one just before it of that kind, and, among equals, not the one before that;
  //                 ties go round-robin from a start index derived from `seed` and the kind (same seed,
  //                 same assignment). A kind without a pool is left alone. A cue with
  //                 `pin: {variant, holds, holdsKind?}` takes pool variant `variant` of its own kind and
  //                 takes the place of variant `holds` of `holdsKind` (default its own kind) in the
  //                 rotation, so every other cue keeps the sound it had before the cue was changed.
  //   buffer(cue, sampleRate, files)  the cue's samples (cached per sound and rate); `files` maps a
  //                 variant's file name to {rate, data: Float32Array} the page loaded. null when the cue has
  //                 no assigned variant (the caller falls back to ReelAudio.sfx[kind]).
  function sfxPool(pools, opts) {
    const poolSeed = opts && opts.seed != null ? String(opts.seed) : "";
    const cache = {};

    function assign(cues) {
      const used = {};
      const last = {};
      // A pinned cue keeps the sound it was given and counts as the held variant in the rotation,
      // so replacing one hit does not change the sound of the cues after it.
      function pinCue(c) {
        const pin = c.pin;
        const own = pools[c.kind];
        if (own && own[pin.variant]) {
          c.variant = pin.variant;
          c.sound = variantId(c.kind, pin.variant, own[pin.variant]);
        }
        const heldKind = pin.holdsKind || c.kind;
        const held = pools[heldKind];
        if (!held || !held[pin.holds]) return;
        const id = variantId(heldKind, pin.holds, held[pin.holds]);
        used[id] = (used[id] || 0) + 1;
        last[heldKind] = [id, (last[heldKind] || [null])[0]];
      }
      cues
        .map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
        .forEach(({ c }) => {
          if (c.pin) return pinCue(c);
          const pool = pools[c.kind];
          if (!pool || !pool.length) return;
          const prev = last[c.kind] || [null, null];
          const best = pickVariant(c.kind, pool, used, prev);
          c.variant = best;
          c.sound = variantId(c.kind, best, pool[best]);
          used[c.sound] = (used[c.sound] || 0) + 1;
          last[c.kind] = [c.sound, prev[0]];
        });
      return cues;
    }

    function pickVariant(kind, pool, used, prev) {
      const n = pool.length;
      const start = hashStr(poolSeed + ":" + kind) % n;
      let best = -1;
      let bestScore = Infinity;
      pool.forEach((v, i) => {
        const id = variantId(kind, i, v);
        if (id === prev[0] && n > 1) return;
        const score = (used[id] || 0) * 10 + (id === prev[1] ? 5 : 0) + ((i - start + n) % n) * 0.01;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      });
      return best;
    }

    function buffer(cue, sampleRate, files) {
      const pool = pools[cue.kind];
      const v = pool && cue.variant >= 0 ? pool[cue.variant] : null;
      if (!v) return null;
      const key = cue.sound + "@" + sampleRate;
      if (!cache[key]) cache[key] = v.file ? fileBuffer(v, sampleRate, files) : synthBuffer(v, sampleRate, cue.sound);
      return cache[key];
    }

    // A synth variant without its own seed takes its id ("pop-2"), so variants of one kind differ.
    function synthBuffer(v, sampleRate, id) {
      const made = Float32Array.from(sfxKinds[v.gen](sampleRate, { seed: v.seed || id }));
      return resample(made, v.rate || 1);
    }

    function fileBuffer(v, sampleRate, files) {
      const f = files && files[v.file];
      if (!f) throw new Error("ReelAudio.sfxPool: no loaded file \"" + v.file + "\"");
      const raw = resample(f.data, f.rate / sampleRate);
      const ref = peakOf(sfxKinds[v.like](sampleRate, { seed: v.like + ":ref" }));
      return scaleBuf(raw, ref / (peakOf(raw) || 1));
    }

    return { assign, buffer };
  }

  // ---------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------

  const sfxKinds = {
    click: sfxClick,
    type: sfxType,
    thud: sfxThud,
    stamp: sfxThud,
    whoosh: sfxWhoosh,
    pop: sfxPop,
    tick: sfxTick,
    ding: sfxDing,
    pluck: sfxPluck,
  };

  globalThis.ReelAudio = {
    mix,
    master,
    duck,
    musicBed,
    applyAttackRamp,
    normalizePeak,
    setFilmKey,
    sfxPool,
    sfx: sfxKinds,
  };
})();
