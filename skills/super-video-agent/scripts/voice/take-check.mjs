// Facts about a take that the STT check cannot hear. Pure: samples in, facts out; the caller
// reports them and never stops a run (references/voice.md). Two checks:
//  - findClipDefects: a start that is cut or carries the previous line's end (HEAD) and a line that stops at
//    its own loudness (TAIL), both judged by perceived level (perceived-level.mjs) and together the gate
//    (waveformFlag); a level drop inside the line (DIP); a silence inside the voiced span (PAUSE).
//  - pitchTrack / endContour / wordContours: where the voice's pitch goes at the end of a line and
//    across each word. A tool can measure the contour; whether it is the right one for the language
//    (a question's rise, a tone, a Vietnamese tone contour) is the reader's judgement.
import { SILENCE_THRESHOLD_DB } from "../lib/audio-analysis.mjs";
import { edgeAudibility } from "../lib/perceived-level.mjs";

const ENV_HOP_SEC = 0.01;
/** HEAD: the voiced span's first 150 ms. */
const HEAD_SEC = 0.15;
/** The first voiced 10 ms already this close to the loudest level = the engine cut the onset. */
const HEAD_ABRUPT_DB = 9;
/** The loudest 10 ms of the first 150 ms this far under the body level = a swallowed start. */
const HEAD_WEAK_DB = 18;
/** DIP: a 150 ms stretch this far under the line's median level, not silent, with sound on both sides. */
const DIP_DB = 15;
const DIP_WIN_SEC = 0.15;
/** PAUSE: silence inside the voiced span at least this long (s). */
export const INNER_PAUSE_SEC = 0.35;
/** Voiced = within this many dB of the line's loud level. */
const VOICED_BELOW_PEAK_DB = 30;

function envelopeDb(samples, rate) {
  const win = Math.max(1, Math.round(rate * ENV_HOP_SEC));
  const n = Math.floor(samples.length / win);
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * win; i < (f + 1) * win; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / win);
    db[f] = rms > 0 ? 20 * Math.log10(rms) : -120;
  }
  return db;
}

function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function voicedSpan(db, peakDb) {
  const floor = Math.max(SILENCE_THRESHOLD_DB, peakDb - VOICED_BELOW_PEAK_DB);
  let first = -1;
  let last = -1;
  for (let f = 0; f < db.length; f++) {
    if (db[f] < floor) continue;
    if (first < 0) first = f;
    last = f;
  }
  return first < 0 ? null : { first, last };
}

function headFacts(db, span, peakDb) {
  const end = Math.min(span.last + 1, span.first + Math.round(HEAD_SEC / ENV_HOP_SEC));
  const firstDb = db[span.first];
  const loudest = Math.max(...db.subarray(span.first, end));
  return { firstDb: round1(firstDb), loudestDb: round1(loudest), abrupt: firstDb >= peakDb - HEAD_ABRUPT_DB, weak: loudest < peakDb - HEAD_WEAK_DB };
}

/** Runs of frames in [from, to] where `test(db)` holds, as {atSec, sec}. */
function runsOf(db, from, to, test, minSec) {
  const out = [];
  let start = -1;
  for (let f = from; f <= to + 1; f++) {
    const hit = f <= to && test(db[f]);
    if (hit && start < 0) start = f;
    if (!hit && start >= 0) {
      const sec = (f - start) * ENV_HOP_SEC;
      if (sec >= minSec - 1e-9) out.push({ atSec: round3(start * ENV_HOP_SEC), sec: round3(sec) });
      start = -1;
    }
  }
  return out;
}

function dipFacts(db, span, medianDb) {
  const frames = Math.round(DIP_WIN_SEC / ENV_HOP_SEC);
  const quiet = (v) => v > SILENCE_THRESHOLD_DB && v <= medianDb - DIP_DB;
  const found = runsOf(db, span.first, span.last, quiet, DIP_WIN_SEC);
  return found.filter((r) => {
    const f = Math.round(r.atSec / ENV_HOP_SEC);
    const end = f + Math.round(r.sec / ENV_HOP_SEC);
    return f - frames >= span.first && end + frames <= span.last + 1 && Math.max(...db.subarray(f - frames, f)) > medianDb - DIP_DB && Math.max(...db.subarray(end, end + frames)) > medianDb - DIP_DB;
  });
}

/**
 * HEAD / TAIL / DIP / PAUSE facts of one clip (mono samples). Null when the clip holds no sound.
 * `edges` is the perceived-level reading of the clip's start and end (perceived-level.mjs
 * edgeAudibility): HEAD and TAIL are the gate, from it. `mask` raises the floor at an edge to the level
 * of what plays under the clip (the mix's bed), when the caller has one.
 * @param {Float32Array} samples
 * @param {number} rate
 * @param {{headMaskLufs?:number, tailMaskLufs?:number}} [mask]
 */
export function findClipDefects(samples, rate, mask = {}) {
  const db = envelopeDb(samples, rate);
  if (!db.length) return null;
  const peakDb = percentile(db, 0.95);
  const span = voicedSpan(db, peakDb);
  if (!span || peakDb <= SILENCE_THRESHOLD_DB) return null;
  const voiced = Array.from(db.subarray(span.first, span.last + 1)).filter((v) => v > SILENCE_THRESHOLD_DB);
  const medianDb = median(voiced);
  return {
    head: headFacts(db, span, peakDb),
    edges: edgeAudibility(samples, rate, mask),
    dips: dipFacts(db, span, medianDb),
    pauses: runsOf(db, span.first, span.last, (v) => v <= SILENCE_THRESHOLD_DB, INNER_PAUSE_SEC),
  };
}

/**
 * The gate result of a clip's facts: "TAIL" when the line's sound stops at about the line's own
 * loudness (a cut), "HEAD" when audible sound near the line's loudness is already there in the first
 * 15 ms (a cut start, or the end of the previous line); else null. Perceived-level evidence only: the
 * speech-to-text check judges whether the words came out wrong and never clears this.
 * @returns {"TAIL"|"HEAD"|null}
 */
export function waveformFlag(defects) {
  const edges = defects && defects.edges;
  if (!edges) return null;
  if (edges.tail.cut) return "TAIL";
  return edges.head.abrupt ? "HEAD" : null;
}

/** One short phrase per defect found, empty when the clip is clean. */
export function describeDefects(defects) {
  if (!defects) return [];
  const out = [];
  const edges = defects.edges;
  if (edges && edges.head.abrupt) out.push(`HEAD cut (sound ${Math.abs(edges.head.relLine)} LU under the line's loudness is already audible at ${(edges.head.audibleAtSec * 1000).toFixed(0)} ms: the start is cut, or carries the end of the previous line)`);
  if (edges && edges.tail.cut) out.push(`TAIL cut (the sound stops ${Math.abs(edges.tail.relLine)} LU under the line's loudness at ${(edges.tail.audibleUntilSec * 1000).toFixed(0)} ms: a natural release dies away well under it)`);
  for (const d of defects.dips) out.push(`DIP ${d.sec.toFixed(2)} s quiet at ${d.atSec.toFixed(2)} s`);
  for (const p of defects.pauses) out.push(`PAUSE ${p.sec.toFixed(2)} s of silence at ${p.atSec.toFixed(2)} s`);
  return out;
}

/** Short codes for the takes table: HEAD-cut, TAIL-cut, DIP@1.20s, PAUSE@2.10s+0.40s. */
export function defectCodes(defects) {
  if (!defects) return [];
  return [
    ...(defects.edges?.head.abrupt ? ["HEAD-cut"] : []),
    ...(defects.edges?.tail.cut ? ["TAIL-cut"] : []),
    ...defects.dips.map((d) => `DIP@${d.atSec.toFixed(2)}s`),
    ...defects.pauses.map((p) => `PAUSE@${p.atSec.toFixed(2)}s+${p.sec.toFixed(2)}s`),
  ];
}

// --- pitch ----------------------------------------------------------------------------------

export const F0_MIN_HZ = 70;
export const F0_MAX_HZ = 400;
const PITCH_RATE = 16000;
const PITCH_FRAME_SEC = 0.04;
const MIN_CORRELATION = 0.45;
/** A frame is analysed when its level is within this share of the loud level (amplitude). */
const PITCH_LEVEL_SHARE = 0.1;
/** A smaller peak than the best one is preferred when it is a shorter lag (octave-down guard). */
const OCTAVE_KEEP = 0.9;

function decimate(samples, rate) {
  const step = Math.max(1, Math.round(rate / PITCH_RATE));
  const n = Math.floor(samples.length / step);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < step; k++) sum += samples[i * step + k];
    out[i] = sum / step;
  }
  return { samples: out, rate: rate / step };
}

function bestLag(x, from, len, minLag, maxLag) {
  let e0 = 0;
  for (let i = 0; i < len; i++) e0 += x[from + i] * x[from + i];
  if (e0 <= 0) return null;
  const r = new Float64Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i < len; i++) {
      c += x[from + i] * x[from + i + lag];
      e1 += x[from + i + lag] * x[from + i + lag];
    }
    r[lag] = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
    if (r[lag] > best) best = r[lag];
  }
  if (best < MIN_CORRELATION) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] >= OCTAVE_KEEP * best && r[lag] >= r[lag - 1] && r[lag] >= (r[lag + 1] || 0)) return lag;
  }
  return null;
}

/**
 * Pitch of voiced 40 ms frames every 10 ms (normalized autocorrelation, 70-400 Hz).
 * @param {Float32Array} samples mono
 * @param {number} rate
 * @returns {{t:number, hz:number|null}[]} hz null where the frame is quiet or has no clear pitch
 */
export function pitchTrack(samples, rate) {
  const d = decimate(samples, rate);
  const len = Math.round(PITCH_FRAME_SEC * d.rate);
  const hop = Math.round(ENV_HOP_SEC * d.rate);
  const minLag = Math.floor(d.rate / F0_MAX_HZ);
  const maxLag = Math.ceil(d.rate / F0_MIN_HZ);
  const level = percentile(Float32Array.from(d.samples, Math.abs), 0.95);
  const track = [];
  for (let from = 0; from + len + maxLag + 1 <= d.samples.length; from += hop) {
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d.samples[from + i]));
    const lag = peak >= PITCH_LEVEL_SHARE * level ? bestLag(d.samples, from, len, minLag, maxLag) : null;
    track.push({ t: round3((from + len / 2) / d.rate), hz: lag ? round1(d.rate / lag) : null });
  }
  return track;
}

const toSemitones = (hz) => 12 * Math.log2(hz / 100);

function voicedIn(track, from, to) {
  return track.filter((p) => p.hz && p.t >= from && p.t < to).map((p) => toSemitones(p.hz));
}

/** End-of-line contour thresholds: this many semitones is a rise or a fall. */
export const END_MOVE_SEMITONES = 2;
const END_TAIL_SEC = 0.15;
const END_REF_FROM_SEC = 0.55;
const END_REF_TO_SEC = 0.2;
const MIN_FRAMES = 3;

/**
 * Pitch at the end of the line against the voiced stretch before it.
 * @param {{t:number, hz:number|null}[]} track
 * @returns {{endSec:number, deltaSemitones:number, direction:"rise"|"fall"|"level"}|null} null when too little is voiced near the end
 */
export function endContour(track) {
  const voiced = track.filter((p) => p.hz);
  if (!voiced.length) return null;
  const endSec = voiced[voiced.length - 1].t;
  const tail = voicedIn(track, endSec - END_TAIL_SEC, endSec + ENV_HOP_SEC);
  const ref = voicedIn(track, endSec - END_REF_FROM_SEC, endSec - END_REF_TO_SEC);
  if (tail.length < MIN_FRAMES || ref.length < MIN_FRAMES) return null;
  const delta = round1(median(tail) - median(ref));
  return { endSec, deltaSemitones: delta, direction: delta >= END_MOVE_SEMITONES ? "rise" : delta <= -END_MOVE_SEMITONES ? "fall" : "level" };
}

/** A within-word move this large (semitones) is part of the word's shape. */
export const WORD_MOVE_SEMITONES = 1.5;
const MIN_WORD_FRAMES = 4;

function thirds(values) {
  const k = Math.max(1, Math.floor(values.length / 3));
  return [median(values.slice(0, k)), median(values.slice(k, values.length - k)) ?? median(values), median(values.slice(values.length - k))];
}

function wordShape(first, mid, last) {
  const up1 = mid - first;
  const up2 = last - mid;
  const T = WORD_MOVE_SEMITONES;
  if (up1 <= -T && up2 >= T) return "dipping";
  if (up1 >= T && up2 <= -T) return "peaking";
  if (last - first >= T) return "rising";
  if (last - first <= -T) return "falling";
  return "level";
}

/**
 * Each word's pitch shape from its first, middle and last third. One word is one syllable in
 * languages written syllable by syllable (Vietnamese, Chinese), so this is also the tone contour.
 * @param {{t:number, hz:number|null}[]} track
 * @param {{w:string, start:number, end:number}[]} words clip-relative seconds
 * @returns {{w:string, shape:"rising"|"falling"|"level"|"dipping"|"peaking"|"unvoiced", semitones:{first:number, mid:number, last:number}|null}[]}
 */
export function wordContours(track, words) {
  return words.map((word) => {
    const values = voicedIn(track, word.start, word.end);
    if (values.length < MIN_WORD_FRAMES) return { w: word.w, shape: "unvoiced", semitones: null };
    const [first, mid, last] = thirds(values).map(round1);
    return { w: word.w, shape: wordShape(first, mid, last), semitones: { first, mid, last } };
  });
}

/** What a pitch report can and cannot say; printed once under every report. */
export const PITCH_LIMITS =
  "pitch report: measured pitch only. It cannot tell whether a rise, fall or tone is the right one for the language " +
  "(question intonation, tonal-language tones, Vietnamese tone contours need the reader's judgement); " +
  "frames without a clear pitch (breathy, whispered, very short words) are 'unvoiced'; an octave error can fake a jump.";

/** Median pitch and range of one clip's voiced frames. */
export function pitchSummary(track) {
  const values = track.filter((p) => p.hz).map((p) => toSemitones(p.hz));
  if (!values.length) return { voicedShare: 0, medianHz: null, rangeSemitones: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    voicedShare: round3(values.length / track.length),
    medianHz: round1(100 * 2 ** (median(values) / 12)),
    rangeSemitones: round1(sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.05 * (sorted.length - 1))]),
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
