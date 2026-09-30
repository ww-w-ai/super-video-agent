// Per-line loudness leveling (voice.mjs, dub.mjs): a single measured gain
// per line — never dynamic compression — so a narration's lines stop
// jumping in loudness and delivery line to line (references/voice.md
// "Delivery marks" / meta.voice.levelLines).
import fs from "node:fs";
import { ffmpeg } from "./ffmpeg.mjs";
import { measureLoudness } from "./audio-analysis.mjs";

export const LINE_TARGET_LUFS = -16;
export const LINE_MAX_TRUE_PEAK_DB = -1.5;

/**
 * The gain (dB) that brings a clip measured at `integratedLufs` to
 * `targetLufs`, capped at LINE_MAX_BOOST_DB. Peaks it pushes past the ceiling
 * are caught by a limiter (lineNeedsLimiter). Pure — no ffmpeg, no I/O.
 * @param {{integratedLufs:number|null}} measured
 * @param {{targetLufs?:number}} [opts]
 * @returns {number}
 */
export function computeLineGainDb(measured, opts = {}) {
  const targetLufs = opts.targetLufs ?? LINE_TARGET_LUFS;
  const { integratedLufs } = measured || {};
  if (integratedLufs == null || !Number.isFinite(integratedLufs)) return 0;
  return Math.min(targetLufs - integratedLufs, LINE_MAX_BOOST_DB);
}

/** Largest boost applied to one line: keeps a near-silent take from being raised into noise. */
export const LINE_MAX_BOOST_DB = 12;

/**
 * Whether the gained clip's true peak would pass the ceiling, so a peak
 * limiter must follow the gain. The peak never caps the gain itself: a quiet
 * line with one sharp consonant would otherwise stay quiet, which is the jump
 * leveling exists to remove. Pure.
 * @param {{truePeakDb:number|null}} measured
 * @param {number} gainDb
 * @param {{maxTruePeakDb?:number}} [opts]
 */
export function lineNeedsLimiter(measured, gainDb, opts = {}) {
  const maxTruePeakDb = opts.maxTruePeakDb ?? LINE_MAX_TRUE_PEAK_DB;
  const peak = measured && measured.truePeakDb;
  if (peak == null || !Number.isFinite(peak)) return true;
  return peak + gainDb > maxTruePeakDb;
}

/**
 * ffmpeg filter for one line: the static gain, then (only when needed) a fast
 * peak limiter 0.5 dB under the ceiling, since alimiter limits sample peaks,
 * not true peaks. Pure.
 */
export function lineLevelFilter(gainDb, limit, opts = {}) {
  const maxTruePeakDb = opts.maxTruePeakDb ?? LINE_MAX_TRUE_PEAK_DB;
  const vol = `volume=${gainDb.toFixed(4)}dB`;
  if (!limit) return vol;
  const lin = Math.pow(10, (maxTruePeakDb - 0.5) / 20).toFixed(4);
  return `${vol},alimiter=limit=${lin}:attack=5:release=50:level=disabled`;
}

/**
 * Measures `wavPath`'s loudness, applies the single computed gain in place
 * (ffmpeg's `volume` filter — a static gain, not loudnorm's dynamic
 * compression, so the delivery stays natural), and reports before/after
 * integrated LUFS for logging. A no-op (no re-encode) when the computed
 * gain is negligible.
 * @param {string} wavPath
 * @param {{targetLufs?:number, maxTruePeakDb?:number}} [opts]
 * @returns {Promise<{beforeLufs:number|null, afterLufs:number|null, gainDb:number}>}
 */
export async function levelLineWav(wavPath, opts = {}) {
  const before = await measureLoudness(wavPath);
  const gainDb = computeLineGainDb(before, opts);
  if (Math.abs(gainDb) < 0.05) {
    return { beforeLufs: before.integratedLufs, afterLufs: before.integratedLufs, gainDb: 0 };
  }
  const tmpPath = wavPath + ".prelevel.wav";
  fs.renameSync(wavPath, tmpPath);
  await ffmpeg(["-y", "-i", tmpPath, "-filter:a", lineLevelFilter(gainDb, lineNeedsLimiter(before, gainDb, opts), opts), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
  fs.rmSync(tmpPath, { force: true });
  const after = await measureLoudness(wavPath);
  return { beforeLufs: before.integratedLufs, afterLufs: after.integratedLufs, gainDb };
}
