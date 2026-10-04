// The opening lead (plan.json meta.lead): seconds before the first story line.
// Pure helpers shared by validate-plan.mjs, voice.mjs and the silence gates.
import { HEAD_SILENCE_SEC } from "./timing.mjs";

/** Seconds of lead when meta.lead is `true`. */
export const LEAD_DEFAULT_SEC = 3;

/** Lead length in seconds for a plan's meta (or timings): number as given, `true` = 3, else 0. */
export function leadSec(meta) {
  const v = meta && meta.lead;
  if (v === true) return LEAD_DEFAULT_SEC;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Plan lines marked `lead: true`. */
export function leadLines(plan) {
  return ((plan && plan.lines) || []).filter((l) => l && l.lead === true);
}

/**
 * Cue time (seconds, film clock) estimated from the plan alone: the first lead line starts
 * after the head silence; the first story line starts after head + lead.
 * @returns {number|null} null when the cue's line is neither of those
 */
function estimatedCueStart(line, offsetMs, lead, isLeadLine) {
  const base = isLeadLine ? HEAD_SILENCE_SEC : HEAD_SILENCE_SEC + lead;
  return base + (offsetMs || 0) / 1000;
}

/**
 * Which kinds of sound a lead carries: `bed` (meta.sound.bed), `cue` (a line cue that sounds
 * before the first story line), `line` (a line marked lead: true).
 * @returns {{bed:boolean, cue:boolean, line:boolean}}
 */
export function leadSound(plan) {
  const lead = leadSec(plan && plan.meta);
  const lines = (plan && plan.lines) || [];
  const firstStory = lines.find((l) => l.lead !== true);
  const window = HEAD_SILENCE_SEC + lead;
  let cue = false;
  for (const l of lines) {
    const isLead = l.lead === true;
    if (!isLead && l !== firstStory) continue;
    for (const c of l.cues || []) {
      if (c.play === "picture") continue;
      const t = estimatedCueStart(l, c.offsetMs, lead, isLead);
      // A lead line's end/word cues sound inside the lead whenever the line does.
      const inside = isLead ? (c.at === "start" ? t >= 0 && t < window : true) : c.at === "start" && t >= 0 && t < window;
      if (inside) cue = true;
    }
  }
  return { bed: !!(plan && plan.meta && plan.meta.sound && plan.meta.sound.bed === true), cue, line: leadLines(plan).length > 0 };
}

/** Validation errors for a plan's lead: none without a lead; a lead needs sound, and lead lines must open the plan. */
export function leadErrors(plan) {
  const errors = [];
  const lead = leadSec(plan && plan.meta);
  const lines = (plan && plan.lines) || [];
  const marked = lines.map((l, i) => (l && l.lead === true ? i : -1)).filter((i) => i >= 0);
  if (!lead) {
    if (marked.length) errors.push(`lines[${marked[0]}].lead: a lead line needs meta.lead (seconds, or true for ${LEAD_DEFAULT_SEC} s)`);
    return errors;
  }
  marked.forEach((idx, k) => {
    if (idx !== k) errors.push(`lines[${idx}].lead: lead lines must be the first lines of the plan`);
  });
  if (marked.length === lines.length && lines.length) errors.push("lines: every line is a lead line; the story needs at least one line after the lead");
  const s = leadSound(plan);
  if (!s.bed && !s.cue && !s.line) {
    errors.push(`meta.lead: the ${lead} s lead has no sound — add a music bed from t=0 (meta.sound.bed: true), a sound cue inside the lead, or an opening line with lead: true`);
  }
  return errors;
}

/**
 * Plan lines for the silence gate: the last lead line's pause to the story counts as planned,
 * since the lead span is not dead air.
 * @param {{id:string,lead?:boolean,pauseAfterMs?:number}[]} planLines
 * @param {{id:string,start:number,end:number}[]} timingsLines
 */
export function withLeadHandover(planLines, timingsLines) {
  const byId = new Map((timingsLines || []).map((l) => [l.id, l]));
  return (planLines || []).map((l, i) => {
    const next = planLines[i + 1];
    if (!l.lead || !next || next.lead) return l;
    const a = byId.get(l.id);
    const b = byId.get(next.id);
    if (!a || !b) return l;
    return { ...l, pauseAfterMs: Math.max(l.pauseAfterMs ?? 0, Math.round((b.start - a.end) * 1000)) };
  });
}

/** One report line for voice.mjs / fit-track.mjs / dub.mjs: the lead and what sounds in it. */
export function formatLeadReport(plan) {
  const lead = leadSec(plan && plan.meta);
  if (!lead) return "";
  const s = leadSound(plan);
  const kinds = Object.entries({ "music bed": s.bed, "sound cue": s.cue, "opening line": s.line }).filter(([, on]) => on).map(([k]) => k);
  return kinds.length
    ? `lead: ${lead} s with sound (${kinds.join(", ")}); planned span, not dead air\n`
    : `WARN: lead ${lead} s has no sound (no music bed, sound cue or opening line)\n`;
}
