// Sentence-end audit on the waveform: did the installed clip keep the end of its last syllable?
// An installed clip is its raw take (voice/raw/<id>.wav) cut to the voiced span, sped up, leveled
// and faded. Its last syllable must sound as long as it does in the raw take. Pure: samples in, facts out.
//  - endCutFacts aligns the clip's envelope to the raw take's (tempo and gain found by search, so any
//    install path works), then compares the raw take's final syllable frame by frame.
//  - END_CUT = the raw take is audible where the clip lost it or faded it far under (a cut install;
//    re-install from the raw take), or the raw take itself stops while still speaking (re-synthesize).
// A waveform level reading alone cannot tell a fast natural release from a cut; the raw take can.

const HOP_SEC = 0.01;
/** A raw frame within this many dB of the line's level is part of an audible syllable. */
export const AUDIBLE_BELOW_LEVEL_DB = 45;
/** The clip lost a frame when it sits this many dB under the aligned raw take. */
export const END_CUT_LOST_DB = 20;
/** END_CUT when the lost audible frames add up to at least this much raw time (s). */
export const END_CUT_MIN_LOST_SEC = 0.02;
/** The release after the sound end is compared too, as long as the take stays above the audible floor. */
const RELEASE_SEC = 0.1;
/** A 10 ms level this low is digital silence: a fade to zero, never a take's own noise. */
const DIGITAL_SILENCE_DB = -100;
/** The sound ends where the envelope falls this far under the line's level. */
const SOUND_END_BELOW_LEVEL_DB = 30;
/** A take is cut at its own end when its last 40 ms of sound is this close to the line's level. */
const RAW_CUT_BELOW_LEVEL_DB = 30;
const RAW_CUT_WINDOW_SEC = 0.04;
/** The final syllable starts at the last envelope dip this deep inside the last word. */
const SYLLABLE_DIP_DB = 6;
const FINAL_SEARCH_SEC = 0.6;
/** Stretch of raw sound before the final syllable used to align the clip. */
const MATCH_SEC = 1.0;
/** Raw frames this close to the level carry the alignment (quieter ones are noise and breath). */
const MATCH_BELOW_LEVEL_DB = 35;
const TEMPO_MIN = 0.7;
const TEMPO_MAX = 1.6;
const TEMPO_STEP = 0.005;
/** The clip's end region searched for the alignment (s). */
const CLIP_SEARCH_SEC = 5;

/** 10 ms RMS levels in dBFS (-120 for digital silence). */
export function envelopeDb(samples, rate) {
  const win = Math.max(1, Math.round(rate * HOP_SEC));
  const n = Math.floor(samples.length / win);
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * win; i < (f + 1) * win; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / win);
    db[f] = rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
  }
  return db;
}

/** The line's loud level: the 90th percentile of its 10 ms levels. */
export function lineLevelDb(db) {
  const sorted = Float64Array.from(db).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)))];
}

/** Frame index just past the last frame within SOUND_END_BELOW_LEVEL_DB of the level; 0 when none. */
export function soundEndFrame(db, level) {
  for (let f = db.length - 1; f >= 0; f--) if (db[f] > level - SOUND_END_BELOW_LEVEL_DB) return f + 1;
  return 0;
}

/** Onset frame of the final syllable: the last dip of SYLLABLE_DIP_DB or more before the sound end. */
export function finalSyllableOnset(db, endFrame) {
  const from = Math.max(1, endFrame - Math.round(FINAL_SEARCH_SEC / HOP_SEC));
  const smooth = (f) => (db[f - 1] + db[f] + db[Math.min(db.length - 1, f + 1)]) / 3;
  let best = -1;
  for (let f = from + 1; f < endFrame - 2; f++) {
    const v = smooth(f);
    if (v > smooth(f - 1) || v > smooth(f + 1)) continue;
    let left = -Infinity;
    for (let k = Math.max(from, f - 15); k < f; k++) left = Math.max(left, smooth(k));
    let right = -Infinity;
    for (let k = f + 1; k < endFrame; k++) right = Math.max(right, smooth(k));
    if (Math.min(left, right) - v >= SYLLABLE_DIP_DB) best = f;
  }
  return best >= 0 ? best : Math.max(0, endFrame - Math.round(0.2 / HOP_SEC));
}

/** Whether the take stops while it is still speaking: its last 40 ms of sound before trailing silence is loud. */
export function takeEndsLoud(db, level) {
  let last = db.length - 1;
  while (last >= 0 && db[last] <= -119) last--;
  if (last < 0) return false;
  const frames = Math.round(RAW_CUT_WINDOW_SEC / HOP_SEC);
  let loudest = -Infinity;
  for (let f = Math.max(0, last - frames + 1); f <= last; f++) loudest = Math.max(loudest, db[f]);
  return loudest > level - RAW_CUT_BELOW_LEVEL_DB && last >= soundEndFrame(db, level) - 1;
}

function sampleAt(db, x) {
  if (x < 0 || x > db.length - 1) return -120;
  const i = Math.floor(x);
  const t = x - i;
  return i + 1 < db.length ? db[i] * (1 - t) + db[i + 1] * t : db[i];
}

/** Best tempo and position of `raw`'s match stretch inside `clip`, with the gain between them. */
export function alignEnding(raw, clip, matchFrom, onset, rawLevel) {
  const frames = [];
  for (let k = matchFrom; k < onset; k++) if (raw[k] > rawLevel - MATCH_BELOW_LEVEL_DB) frames.push(k);
  if (frames.length < 5) return null;
  const searchFrom = Math.max(0, clip.length - Math.round(CLIP_SEARCH_SEC / HOP_SEC));
  let best = null;
  for (let tempo = TEMPO_MIN; tempo <= TEMPO_MAX + 1e-9; tempo += TEMPO_STEP) {
    for (let at = searchFrom; at <= clip.length; at++) {
      const diffs = frames.map((k) => sampleAt(clip, at + (k - onset) / tempo) - raw[k]);
      const gain = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const err = diffs.reduce((a, d) => a + Math.abs(d - gain), 0) / diffs.length;
      if (!best || err < best.err) best = { tempo, at, gain, err };
    }
  }
  return best;
}

/**
 * END_CUT facts of one installed clip against its raw take. Null when the take holds too little sound
 * to compare. `cut` is the gate: the clip lost the take's final syllable (`lostSec` of audible raw
 * time, `maxDeficitDb` the worst frame), or the raw take itself ends while speaking (`rawCut`, a new
 * take is needed; re-installing cannot help).
 * @param {Float32Array} rawSamples mono
 * @param {Float32Array} clipSamples mono
 * @param {number} rate the clip's sample rate
 * @param {number} [rawRate] the raw take's, when it differs
 * @returns {{cut:boolean, rawCut:boolean, lostSec:number, maxDeficitDb:number, tempo:number, rawEndSec:number, clipEndSec:number}|null}
 */
export function endCutFacts(rawSamples, clipSamples, rate, rawRate = rate) {
  const raw = envelopeDb(rawSamples, rawRate);
  const clip = envelopeDb(clipSamples, rate);
  if (raw.length < 10 || clip.length < 10) return null;
  const rawLevel = lineLevelDb(raw);
  if (rawLevel <= -90) return null;
  const rawEnd = soundEndFrame(raw, rawLevel);
  const onset = finalSyllableOnset(raw, rawEnd);
  const matchFrom = Math.max(0, onset - Math.round(MATCH_SEC / HOP_SEC));
  const rawCut = takeEndsLoud(raw, rawLevel);
  const fit = alignEnding(raw, clip, matchFrom, onset, rawLevel);
  if (!fit) return null;
  let lost = 0;
  let maxDeficit = 0;
  const until = Math.min(raw.length, rawEnd + Math.round(RELEASE_SEC / HOP_SEC));
  for (let k = onset; k < until; k++) {
    if (raw[k] <= rawLevel - AUDIBLE_BELOW_LEVEL_DB) continue;
    const x = fit.at + (k - onset) / fit.tempo;
    // The loudest clip frame within one frame either side: a release is steep, and a one-frame
    // slip of the alignment is not a loss. Digital silence where the take still sounds always is.
    const kept = Math.max(sampleAt(clip, x - 1), sampleAt(clip, x), sampleAt(clip, x + 1));
    const deficit = raw[k] + fit.gain - kept;
    const nearest = Math.round(x);
    const silent = nearest >= clip.length || (nearest >= 0 && clip[nearest] <= DIGITAL_SILENCE_DB);
    maxDeficit = Math.max(maxDeficit, deficit);
    if (deficit > END_CUT_LOST_DB || silent) lost++;
  }
  const lostSec = round3(lost * HOP_SEC);
  return {
    cut: rawCut || lostSec >= END_CUT_MIN_LOST_SEC - 1e-9,
    rawCut,
    lostSec,
    maxDeficitDb: Math.round(maxDeficit * 10) / 10,
    tempo: round3(fit.tempo),
    rawEndSec: round3(rawEnd * HOP_SEC),
    clipEndSec: round3((fit.at + (rawEnd - onset) / fit.tempo) * HOP_SEC),
  };
}

/** One phrase for the END_CUT finding, or null when the end is whole. */
export function describeEndCut(facts) {
  if (!facts || !facts.cut) return null;
  if (facts.rawCut) return "END_CUT (the raw take itself stops while still speaking: make a new take)";
  return `END_CUT (the last syllable lost ${(facts.lostSec * 1000).toFixed(0)} ms of sound the raw take has, up to ${facts.maxDeficitDb} dB under it, near ${facts.clipEndSec.toFixed(2)} s: re-install from the raw take)`;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
