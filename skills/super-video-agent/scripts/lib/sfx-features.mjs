// Pure feature-extraction functions for scripts/sfx-cards.mjs's `measure`
// (references/sound.md "Sound cards"). Every function takes decoded PCM
// (Float32Array, one channel) and a sampleRate, and returns a plain number
// or string — no ffmpeg, no I/O, so each is unit-testable on a synthetic
// signal built in the test file. `measureLufs` is the one exception (needs
// ffmpeg's ebur128, lib/audio-analysis.mjs) and lives in sfx-cards.mjs.

/** Peak sample amplitude, in dBFS (20*log10(peak)); -Infinity for silence. */
export function peakDb(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-12) return -Infinity;
  return 20 * Math.log10(peak);
}

/** Length of the buffer in seconds. */
export function durationSec(samples, sampleRate) {
  return samples.length / sampleRate;
}

/**
 * Time from the first sample past `thresholdRatio` of the eventual peak to
 * the peak itself, in milliseconds — how percussive vs. how slow-swelling
 * the onset is (sound.md "1.5ms onset ramps"; a `click`/`tick` should read
 * a few ms, a `whoosh` tens of ms).
 */
export function attackMs(samples, sampleRate, thresholdRatio = 0.1) {
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) {
      peak = a;
      peakIdx = i;
    }
  }
  if (peak < 1e-12) return 0;
  const threshold = peak * thresholdRatio;
  let onsetIdx = peakIdx;
  for (let i = 0; i <= peakIdx; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      onsetIdx = i;
      break;
    }
  }
  return ((peakIdx - onsetIdx) / sampleRate) * 1000;
}

// ---------------------------------------------------------------------
// spectral analysis: a plain iterative radix-2 FFT over FFT_SIZE-sample
// frames, magnitudes averaged across frames spread over the whole buffer
// (a buffer shorter than one frame is zero-padded). One frame at the start
// is not enough: library MP3s open with tens of ms of encoder silence, and
// a silent first frame read as brightness 0 Hz and noisiness 1.00.
// ---------------------------------------------------------------------

const FFT_SIZE = 2048;
const MAX_FRAMES = 64;
const FLATNESS_MIN_HZ = 60;
const FLATNESS_MAX_HZ = 12000;

/** Start indexes of the frames to average: non-overlapping, at most MAX_FRAMES, evenly spread. */
function frameStarts(length) {
  const count = Math.floor(length / FFT_SIZE);
  if (count <= 1) return [0];
  const used = Math.min(count, MAX_FRAMES);
  const starts = [];
  for (let k = 0; k < used; k++) starts.push(Math.floor((k * (count - 1)) / Math.max(1, used - 1)) * FFT_SIZE);
  return starts;
}

/** In-place iterative Cooley-Tukey FFT. `re`/`im` are Float64Array of length a power of 2. */
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

/**
 * Average magnitude spectrum of `samples` over Hann-windowed FFT_SIZE
 * frames spread across the buffer (frameStarts), first half only — the
 * real-signal Nyquist half — and the bin width in Hz, for centroid,
 * flatness and peak pitch. Silent frames add nothing, so loud frames
 * dominate; a buffer shorter than one frame is zero-padded.
 * @returns {{mags: Float64Array, binHz: number}}
 */
function magnitudeSpectrum(samples, sampleRate) {
  const n = FFT_SIZE;
  const half = n / 2;
  const mags = new Float64Array(half);
  const starts = frameStarts(samples.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (const start of starts) {
    re.fill(0);
    im.fill(0);
    const take = Math.min(n, samples.length - start);
    for (let i = 0; i < take; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (take - 1 || 1)); // Hann
      re[i] = samples[start + i] * w;
    }
    fftInPlace(re, im);
    for (let i = 0; i < half; i++) mags[i] += Math.hypot(re[i], im[i]) / starts.length;
  }
  return { mags, binHz: sampleRate / n };
}

/**
 * Spectral centroid ("brightness") in Hz: the magnitude-weighted mean
 * frequency of `samples`' average spectrum. 0 for silence.
 */
export function brightnessHz(samples, sampleRate) {
  const { mags, binHz } = magnitudeSpectrum(samples, sampleRate);
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < mags.length; i++) {
    weighted += mags[i] * (i * binHz);
    total += mags[i];
  }
  if (total < 1e-9) return 0;
  return weighted / total;
}

/**
 * Spectral flatness (geometric mean / arithmetic mean of the power
 * spectrum), 0..1 — near 0 for a pure tone or resonant body, near 1 for
 * white/flat noise. This is `noisiness`. Measured over 60 Hz–12 kHz only:
 * lossy library files are low-passed near 16 kHz, and their empty top bins
 * would otherwise read any recording as a pure tone.
 */
export function noisiness(samples, sampleRate) {
  const { mags, binHz } = magnitudeSpectrum(samples, sampleRate);
  const EPS = 1e-12;
  const lo = Math.max(1, Math.floor(FLATNESS_MIN_HZ / binHz));
  const hi = Math.min(mags.length - 1, Math.ceil(FLATNESS_MAX_HZ / binHz));
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    const power = mags[i] * mags[i] + EPS;
    logSum += Math.log(power);
    sum += power;
    n++;
  }
  if (n === 0 || sum < 1e-9) return 0;
  const geoMean = Math.exp(logSum / n);
  const arithMean = sum / n;
  const flatness = geoMean / arithMean;
  return Math.max(0, Math.min(1, flatness));
}

/**
 * Dominant pitch (Hz) of a window: the frequency of the tallest bin in its
 * magnitude spectrum, restricted to [minHz, maxHz]. Autocorrelation was
 * tried first and dropped — its raw or normalized correlation is highest
 * at the smallest lag searched for any smooth signal (adjacent samples of
 * a sine or a sweep are always near-identical over a lag far shorter than
 * one period), which misreads a chirp's instantaneous pitch as whatever
 * the search floor allows. A spectral peak has no such bias. Returns null
 * when the window has no clear peak (its own `noisiness` reads high — a
 * noise burst like thud's exciter, or plain silence): sound.md's kit has
 * no siren tone, so "no clear pitch" is expected on those, not a bug.
 */
function spectralPeakHz(samples, sampleRate, opts = {}) {
  const minHz = opts.minHz || 60;
  const maxHz = opts.maxHz || 6000;
  const { mags, binHz } = magnitudeSpectrum(samples, sampleRate);
  let total = 0;
  let peakMag = 0;
  let peakBin = -1;
  const minBin = Math.max(1, Math.floor(minHz / binHz));
  const maxBin = Math.min(mags.length - 1, Math.ceil(maxHz / binHz));
  for (let i = 0; i < mags.length; i++) total += mags[i];
  if (total < 1e-9) return null;
  for (let i = minBin; i <= maxBin; i++) {
    if (mags[i] > peakMag) {
      peakMag = mags[i];
      peakBin = i;
    }
  }
  if (peakBin < 0) return null;
  // A noise burst has energy smeared across every bin instead of one tall
  // peak: require the peak bin to carry a meaningfully larger share of the
  // in-range energy than a flat spectrum would give any single bin.
  let inRangeTotal = 0;
  for (let i = minBin; i <= maxBin; i++) inRangeTotal += mags[i];
  if (inRangeTotal < 1e-9 || peakMag / inRangeTotal < 3 / (maxBin - minBin + 1)) return null;
  return peakBin * binHz;
}

/**
 * "rising" | "falling" | "flat" | "none" — compares the dominant spectral
 * pitch of the buffer's first third against its last third (sound.md's
 * whoosh sweeps its filter cutoff upward; a struck resonator like thud/tick
 * stays flat or has no clear pitch at all -> "none").
 */
export function pitchTrend(samples, sampleRate) {
  const third = Math.floor(samples.length / 3);
  if (third < Math.floor(sampleRate / 2000)) return "none"; // too short to say anything
  const first = samples.subarray(0, third);
  const last = samples.subarray(samples.length - third);
  const f1 = spectralPeakHz(first, sampleRate);
  const f2 = spectralPeakHz(last, sampleRate);
  if (f1 == null || f2 == null) return "none";
  if (f2 > f1 * 1.05) return "rising";
  if (f2 < f1 * 0.95) return "falling";
  return "flat";
}

/**
 * Every feature `measure` needs from one decoded mono PCM buffer, except
 * `lufs` (ffmpeg-only, added by the caller when the clip is long enough —
 * review.mjs's own loudness gate uses the same ~0.4s floor).
 * @returns {{durationSec:number, peakDb:number, attackMs:number, brightnessHz:number, pitchTrend:string, noisiness:number}}
 */
export function measureFeatures(samples, sampleRate) {
  return {
    durationSec: durationSec(samples, sampleRate),
    peakDb: peakDb(samples),
    attackMs: attackMs(samples, sampleRate),
    brightnessHz: brightnessHz(samples, sampleRate),
    pitchTrend: pitchTrend(samples, sampleRate),
    noisiness: noisiness(samples, sampleRate),
  };
}
