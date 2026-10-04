// The silence gate shared by voice.mjs (right after the narration is placed),
// fit-track.mjs / dub.mjs (the fitted track) and review.mjs (the final mp4):
// every pause between voiced audio over SILENCE_GATE_SEC is listed with the
// line ids around it. A pause the plan asks for (a line's pauseAfterMs, or
// meta.gapMs when that is itself long) is "planned", not a failure.
// Measurement is silenceGaps in audio-analysis.mjs (one method, one
// threshold); this file classifies and formats. No I/O except the decode in
// measureNarrationGaps.
import { decodeMonoPcm, silenceGaps, SILENCE_GATE_SEC, SILENCE_THRESHOLD_DB } from "./audio-analysis.mjs";

/** Tail/head clip padding (0.3 s tail + 0.05 s head) and window rounding can lengthen a planned pause by this much. */
export const PLANNED_PAUSE_SLACK_SEC = 0.4;

/**
 * Split gaps into the ones the plan asks for and the rest, naming the lines
 * around each.
 * @param {{startSec:number,endSec:number,durationSec:number}[]} gaps from silenceGaps
 * @param {{id:string,start:number,end:number}[]} lines the narration's timings lines
 * @param {{id:string,pauseAfterMs?:number}[]} [planLines] plan.json lines (pauseAfterMs)
 * @param {{gapMs?:number}} [opts] meta.gapMs, the pause after a line with no pauseAfterMs
 * @returns {{planned:object[], unplanned:object[]}} each item: {startSec,endSec,durationSec,afterId,beforeId,inside,plannedSec}
 */
export function classifyGaps(gaps, lines, planLines = [], opts = {}) {
  const planById = new Map((planLines || []).map((l) => [l.id, l]));
  const sorted = [...(lines || [])].sort((a, b) => a.start - b.start);
  const planned = [];
  const unplanned = [];
  for (const g of gaps) {
    const prev = [...sorted].reverse().find((l) => l.start <= g.startSec + 1e-6) || null;
    const next = sorted.find((l) => l.start >= g.endSec - PLANNED_PAUSE_SLACK_SEC / 2) || null;
    const inside = prev != null && prev.end > g.endSec + 1e-6;
    const own = prev ? planById.get(prev.id) : null;
    const plannedMs = own && own.pauseAfterMs != null ? own.pauseAfterMs : opts.gapMs;
    const plannedSec = plannedMs != null ? plannedMs / 1000 : 0;
    const item = { ...g, afterId: prev ? prev.id : null, beforeId: inside ? (prev ? prev.id : null) : next ? next.id : null, inside, plannedSec };
    const isPlanned = !inside && plannedSec > 0 && g.durationSec <= plannedSec + PLANNED_PAUSE_SLACK_SEC;
    (isPlanned ? planned : unplanned).push(item);
  }
  return { planned, unplanned };
}

/**
 * The pause plan for a track fitted to a picture: the picture's own pause
 * after a base line (its end to the next line's start) is intended when it is
 * itself over the gate; a plan line's pauseAfterMs counts too (the larger wins).
 * @param {{id:string,start:number,end:number}[]} baseLines the picture's timings lines
 * @param {{id:string,pauseAfterMs?:number}[]} [planLines]
 * @returns {{id:string,pauseAfterMs:number}[]}
 */
export function pictureGapPlan(baseLines, planLines = []) {
  const planById = new Map((planLines || []).map((l) => [l.id, l.pauseAfterMs ?? 0]));
  return (baseLines || []).map((l, i) => {
    const own = i < baseLines.length - 1 ? (baseLines[i + 1].start - l.end) * 1000 : 0;
    return { id: l.id, pauseAfterMs: Math.max(planById.get(l.id) ?? 0, own > SILENCE_GATE_SEC * 1000 ? own : 0) };
  });
}

/**
 * Gaps over the gate in `samples`, classified.
 * @returns {{planned:object[], unplanned:object[], gateSec:number, thresholdDb:number}}
 */
export function gapsFromPcm(samples, sampleRate, lines, planLines, opts = {}) {
  const gateSec = opts.gateSec == null ? SILENCE_GATE_SEC : opts.gateSec;
  const gaps = silenceGaps(samples, sampleRate, { minSec: gateSec + 1e-9, thresholdDb: SILENCE_THRESHOLD_DB });
  return { ...classifyGaps(gaps, lines, planLines, opts), gateSec, thresholdDb: SILENCE_THRESHOLD_DB };
}

/** Decode `wavPath` and run gapsFromPcm. */
export async function measureNarrationGaps(wavPath, lines, planLines, opts = {}) {
  const sampleRate = 48000;
  const samples = await decodeMonoPcm(wavPath, sampleRate);
  return gapsFromPcm(samples, sampleRate, lines, planLines, opts);
}

const t = (s) => `${s.toFixed(2)}s`;

function describe(g) {
  const where = g.inside ? `inside line "${g.afterId}"` : `between line "${g.afterId ?? "start"}" and "${g.beforeId ?? "end"}"`;
  return `  ${t(g.startSec)}-${t(g.endSec)} (${t(g.durationSec)}) ${where}`;
}

/**
 * The text voice.mjs / fit-track.mjs / dub.mjs print. Unplanned gaps start with WARN.
 * @param {{planned:object[], unplanned:object[], gateSec:number}} report
 */
export function formatSilenceReport(report) {
  let out = "";
  if (report.unplanned.length) {
    out +=
      `WARN: ${report.unplanned.length} silence gap(s) over ${report.gateSec} s between voiced audio:\n` +
      report.unplanned.map(describe).join("\n") +
      `\nhint: the cause is usually dead air at a line's head or tail, or a slot much longer than the line — re-make the named line, or add pauseAfterMs where the pause is meant\n`;
  } else {
    out += `silence gate: no unplanned gap over ${report.gateSec} s\n`;
  }
  if (report.planned.length) {
    out += `planned pause(s):\n${report.planned.map((g) => `${describe(g)} (plan: ${t(g.plannedSec)})`).join("\n")}\n`;
  }
  return out;
}
