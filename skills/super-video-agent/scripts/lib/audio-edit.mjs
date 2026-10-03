/** Local PCM pause edits. Detection supplies evidence, never an automatic edit decision. */
import { rmsWindow } from './audio-analysis.mjs';
import { quietestSample } from '../voice/line-edit.mjs';

const QUIET_DB = -50;
const MAX_FRAMES = 0x3fffffff;

function finite(value, name, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a finite number >= ${min}`);
  }
  return value;
}

function frames(value, sampleRate, name) {
  const count = Math.round(finite(value, name) * sampleRate);
  if (!Number.isSafeInteger(count) || count > MAX_FRAMES) throw new Error(`${name} exceeds PCM size limit`);
  return count;
}

function validatePcm(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error('nonempty Float32Array required');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new Error('invalid sample rate');
  for (const value of samples) if (!Number.isFinite(value)) throw new Error('PCM contains nonfinite sample');
}

/** Return RMS-based quiet candidates, including leading/trailing quiet spans. */
export function inspectQuiet(samples, sampleRate) {
  validatePcm(samples, sampleRate);
  const window = Math.max(1, Math.round(sampleRate * 0.01));
  const limit = 10 ** (QUIET_DB / 20);
  const candidates = [];
  let start = null;
  for (let i = 0; i < samples.length; i += window) {
    const quiet = rmsWindow(samples, i, window) <= limit;
    if (quiet && start === null) start = i;
    if (!quiet && start !== null) {
      candidates.push({ start: start / sampleRate, end: i / sampleRate });
      start = null;
    }
  }
  if (start !== null) candidates.push({ start: start / sampleRate, end: samples.length / sampleRate });
  return { advisory: true, thresholdDb: QUIET_DB, windowSec: window / sampleRate,
    durationSec: samples.length / sampleRate,
    candidates: candidates.map((p) => ({ ...p, quietestPoint: quietestSample(samples, sampleRate, p.start, p.end) / sampleRate })) };
}

function normalizeEdits(edits, samples, sampleRate) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw new Error('edits must be an object');
  const allowed = new Set(['pauses', 'padStartSec', 'padEndSec', 'tempo']);
  for (const key of Object.keys(edits)) if (!allowed.has(key)) throw new Error(`unknown edit field: ${key}`);
  if (edits.pauses !== undefined && !Array.isArray(edits.pauses)) throw new Error('pauses must be an array');
  const duration = samples.length / sampleRate;
  const pauses = (edits.pauses || []).map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('invalid pause');
    for (const key of Object.keys(p)) if (!['start', 'end', 'duration'].includes(key)) throw new Error(`unknown pause field: ${key}`);
    finite(p.start, 'pause.start'); finite(p.end, 'pause.end'); finite(p.duration, 'pause.duration');
    if (p.end <= p.start || p.end > duration) throw new Error('pause outside input or empty');
    const start = frames(p.start, sampleRate, 'pause.start');
    const end = frames(p.end, sampleRate, 'pause.end');
    if (end <= start) throw new Error('pause is shorter than one sample');
    return { start, end, sourceStart: p.start, sourceEnd: p.end, duration: frames(p.duration, sampleRate, 'pause.duration') };
  }).sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  let previousSourceEnd = 0;
  for (const pause of pauses) {
    if (pause.start < previousEnd || pause.sourceStart < previousSourceEnd) throw new Error('overlapping pauses');
    previousSourceEnd = pause.sourceEnd;
    previousEnd = pause.end;
    for (let i = pause.start; i < pause.end; i++) {
      if (Math.abs(samples[i]) > 10 ** (QUIET_DB / 20)) throw new Error('pause intersects nonquiet audio');
    }
  }
  const tempo = finite(edits.tempo ?? 1, 'tempo', Number.MIN_VALUE);
  if (tempo < 0.5 || tempo > 2) throw new Error('tempo must be between 0.5 and 2');
  return { pauses, tempo, padStart: frames(edits.padStartSec ?? 0, sampleRate, 'padStartSec'),
    padEnd: frames(edits.padEndSec ?? 0, sampleRate, 'padEndSec') };
}

function replacePauses(samples, pauses) {
  const length = samples.length + pauses.reduce((sum, p) => sum + p.duration - (p.end - p.start), 0);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FRAMES) throw new Error('invalid edited PCM length');
  const output = new Float32Array(length);
  let inputAt = 0;
  let outputAt = 0;
  const map = [];
  for (const p of pauses) {
    output.set(samples.subarray(inputAt, p.start), outputAt);
    outputAt += p.start - inputAt;
    map.push({ ...p, outputStart: outputAt, outputEnd: outputAt + p.duration });
    outputAt += p.duration;
    inputAt = p.end;
  }
  output.set(samples.subarray(inputAt), outputAt);
  return { samples: output, map };
}

function mapFrame(frame, map) {
  let low = 0;
  let high = map.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (map[mid].start <= frame) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return frame;
  const p = map[low - 1];
  if (frame < p.end) return p.outputStart + (frame - p.start) * p.duration / (p.end - p.start);
  return p.outputEnd + frame - p.end;
}

function remapWords(words, inputLength, map, config, sampleRate) {
  if (!Array.isArray(words)) throw new Error('words must be an array');
  let previousEnd = 0;
  return words.map((word) => {
    if (!word || typeof word.w !== 'string' || !word.w.trim()) throw new Error('word.w must be nonempty text');
    finite(word.start, 'word.start'); finite(word.end, 'word.end');
    if (word.end <= word.start || word.end > inputLength / sampleRate || word.start < previousEnd) {
      throw new Error('word timings must be ordered, nonoverlapping, positive, and inside input');
    }
    previousEnd = word.end;
    const start = (mapFrame(word.start * sampleRate, map) / config.tempo + config.padStart) / sampleRate;
    const end = (mapFrame(word.end * sampleRate, map) / config.tempo + config.padStart) / sampleRate;
    if (!(end > start)) throw new Error(`edit collapses word: ${word.w}`);
    return { ...word, start, end };
  });
}

/** Prepare explicit quiet-only replacements and word mapping; no I/O or tempo engine runs here. */
export function editPcm(samples, sampleRate, edits, words = []) {
  validatePcm(samples, sampleRate);
  const config = normalizeEdits(edits, samples, sampleRate);
  const replaced = replacePauses(samples, config.pauses);
  const outputLength = Math.ceil(replaced.samples.length / config.tempo) + config.padStart + config.padEnd;
  if (!Number.isSafeInteger(outputLength) || outputLength > MAX_FRAMES) throw new Error('output exceeds PCM size limit');
  return { ...replaced, ...config, sampleRate,
    inputDurationSec: samples.length / sampleRate,
    words: remapWords(words, samples.length, replaced.map, config, sampleRate) };
}

/** Add final-duration padding after an injected tempo adapter; never silently clamp word ends. */
export function finishEdit(plan, tempoSamples = plan.samples) {
  validatePcm(tempoSamples, plan.sampleRate);
  const speechEnd = (plan.padStart + tempoSamples.length) / plan.sampleRate;
  for (const word of plan.words) {
    if (word.end > speechEnd) throw new Error('tempo output ends before a mapped word; edit rejected');
  }
  const length = plan.padStart + tempoSamples.length + plan.padEnd;
  if (!Number.isSafeInteger(length) || length > MAX_FRAMES) throw new Error('output exceeds PCM size limit');
  const samples = new Float32Array(length);
  samples.set(tempoSamples, plan.padStart);
  const report = { inputDurationSec: plan.inputDurationSec, outputDurationSec: length / plan.sampleRate,
    sampleRate: plan.sampleRate, tempo: plan.tempo, padStartSec: plan.padStart / plan.sampleRate,
    padEndSec: plan.padEnd / plan.sampleRate, thresholdDb: QUIET_DB, words: plan.words,
    pauses: plan.map.map((p) => ({ start: p.start / plan.sampleRate, end: p.end / plan.sampleRate,
      duration: p.duration / plan.sampleRate, outputStart: (p.outputStart / plan.tempo + plan.padStart) / plan.sampleRate,
      outputEnd: (p.outputEnd / plan.tempo + plan.padStart) / plan.sampleRate })) };
  return { samples, report };
}

/** Apply a prepared edit with an injected, pitch-preserving tempo function. */
export async function applyAudioEdits({ samples, sampleRate, edits, words }, { tempoPcm } = {}) {
  const plan = editPcm(samples, sampleRate, edits, words);
  if (plan.tempo === 1) return finishEdit(plan);
  if (typeof tempoPcm !== 'function') throw new Error('tempo adapter required');
  return finishEdit(plan, await tempoPcm(plan.samples, sampleRate, plan.tempo));
}
