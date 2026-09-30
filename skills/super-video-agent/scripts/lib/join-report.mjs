// Pure report math for scripts/join.mjs — loudness spread across parts, the
// click check (a join's own sample jump against each part's typical
// maximum), and the frame-match check (mean pixel diff across a cut). No
// ffmpeg here: join.mjs measures, this module only judges the numbers and
// formats the report. join.mjs never blocks on any of these — they are
// facts, not gates.
const LOUDNESS_SPREAD_WARN_LU = 1;
const CLICK_RATIO_WARN = 2;

/** min/max/spread across each part's own integrated loudness (LU units —
 * same scale as an LUFS difference). Warns above 1 LU. */
export function loudnessSpread(perPartLufs) {
  const finite = perPartLufs.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: null, max: null, spreadLu: null, warn: false };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const spreadLu = max - min;
  return { min, max, spreadLu, warn: spreadLu > LOUDNESS_SPREAD_WARN_LU };
}

/** Largest absolute sample-to-sample delta in samples[startIdx..endIdx). */
export function maxStepInRange(samples, startIdx, endIdx) {
  let max = 0;
  const s = Math.max(1, startIdx);
  const e = Math.min(samples.length, endIdx);
  for (let i = s; i < e; i++) {
    const d = Math.abs(samples[i] - samples[i - 1]);
    if (d > max) max = d;
  }
  return max;
}

/** The sample-index window +/-windowMs around joinTimeSec, in the joined
 * file's own sample-rate space. */
export function joinWindowIndices(sampleRate, joinTimeSec, windowMs = 20) {
  const center = Math.round(joinTimeSec * sampleRate);
  const half = Math.round((windowMs / 1000) * sampleRate);
  return { start: Math.max(0, center - half), end: center + half };
}

/** A part's own "normal" max step, away from any cut: the max step inside
 * [rangeStart, rangeEnd) with marginSamples excluded at each end (the
 * region nearest this part's own join boundaries). Falls back to the
 * whole range when the part is too short for that margin. */
export function typicalMaxStep(samples, rangeStart, rangeEnd, marginSamples) {
  const s = rangeStart + marginSamples;
  const e = rangeEnd - marginSamples;
  if (e <= s) return maxStepInRange(samples, rangeStart, rangeEnd);
  return maxStepInRange(samples, s, e);
}

/**
 * @param {{joinTimeSec:number, windowMaxStep:number, partTypicalMaxStep:number, factor?:number}} args
 * @returns {{joinTimeSec:number, windowMaxStep:number, partTypicalMaxStep:number, ratio:number, flagged:boolean}}
 *   flagged when the join window's step exceeds the parts' own typical
 *   ceiling by more than `factor` (default 2) — a jump the parts' own
 *   material would not produce on its own.
 */
export function analyzeJoinClick({ joinTimeSec, windowMaxStep, partTypicalMaxStep, factor = CLICK_RATIO_WARN }) {
  const ratio =
    partTypicalMaxStep > 0 ? windowMaxStep / partTypicalMaxStep : windowMaxStep > 0 ? Infinity : 1;
  return { joinTimeSec, windowMaxStep, partTypicalMaxStep, ratio, flagged: ratio > factor };
}

/** Mean absolute per-sample difference between two equal-shaped frame
 * buffers (greyscale bytes). Low = a match cut; high = a hard cut — this
 * only measures, it does not classify one as wrong. */
export function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/**
 * @param {{outPath:string, totalDurationSec:number, parts:object[], loudnessSpread:object, joins:object[]}} report
 * @param {{json?:boolean}} opts
 * @returns {string}
 */
export function formatReport(report, opts = {}) {
  if (opts.json) return JSON.stringify(report, null, 2);

  const lines = [];
  lines.push(`wrote ${report.outPath} (${report.totalDurationSec.toFixed(3)}s, ${report.parts.length} parts)`);
  for (const p of report.parts) {
    const lufs = p.integratedLufs == null ? "n/a" : `${p.integratedLufs.toFixed(1)} LUFS`;
    const peak = p.truePeakDb == null ? "n/a" : `${p.truePeakDb.toFixed(1)} dBFS`;
    lines.push(`  part ${p.index} ${p.source} — ${p.durationSec.toFixed(3)}s, ${lufs}, peak ${peak}`);
  }
  const spread = report.loudnessSpread;
  if (spread.spreadLu == null) {
    lines.push("  loudness spread: n/a (no measurable parts)");
  } else {
    const flag = spread.warn ? "WARNING: over 1 LU" : "ok";
    lines.push(`  loudness spread: ${spread.spreadLu.toFixed(2)} LU (${flag})`);
  }

  for (const j of report.joins) {
    lines.push(`join ${j.index} @ ${j.atSec.toFixed(3)}s (part ${j.betweenParts[0]} -> part ${j.betweenParts[1]})`);
    const c = j.click;
    const ratioStr = Number.isFinite(c.ratio) ? `${c.ratio.toFixed(2)}x` : "inf";
    const clickFlag = c.flagged ? "WARNING: click risk" : "ok";
    lines.push(
      `  click: window max step ${c.windowMaxStep.toFixed(4)} vs part typical ${c.partTypicalMaxStep.toFixed(4)} (${ratioStr}) — ${clickFlag}`
    );
    const diffStr = j.meanPixelDiff == null ? "n/a" : j.meanPixelDiff.toFixed(2);
    lines.push(`  frame match: mean pixel diff ${diffStr} (0-255 greyscale)`);
  }
  return lines.join("\n");
}

export const LOUDNESS_SPREAD_WARN_LU_DEFAULT = LOUDNESS_SPREAD_WARN_LU;
export const CLICK_RATIO_WARN_DEFAULT = CLICK_RATIO_WARN;
