// How each dub line sits in its base slot (dub.mjs): the silence after the
// line (gapAfter) is what the ear judges, and it is judged against a range
// set by that line's own scene (slot), whatever the language — never
// against the base language's gap. Under the range the line is crammed: no
// breath before the next one. Over it the line is sparse: the scene sits in
// silence. A line that needed atempo, or runs past its slot, was already
// squeezed to fit. All of these mean the wording doesn't match the
// picture's pace in that language. Report only: dub.mjs still writes the
// film either way (references/pipeline.md "Picture first"). The last
// line's slot runs to the film's end under the end card, so it gets no gap
// and no gap warning. A pause the plan or the picture declared is planned silence and is not
// a warning either. No I/O.
import { allowedGapSec } from "./dub-timing.mjs";

export const FULL_FILL_THRESHOLD = 1.0;
/** Shortest gap that still leaves a breath (SKILL.md "Picture first": about 0.5 s). */
export const GAP_MIN_SEC = 0.4;
/**
 * Longest gap, as a share of the slot: a quarter of the scene in silence is
 * where a viewer notices the voice has stopped — the same line the earlier
 * low-fill warning drew at 75 % fill.
 */
export const GAP_MAX_SHARE = 0.25;
/** In a short slot the share is tiny; the range never closes below this. */
export const GAP_MAX_FLOOR_SEC = 1.0;

/**
 * The allowed silence after a line in a slot of `slotDur` seconds. A pause the plan or the
 * picture declared (`plannedGapSec`) is planned silence and widens the range to include it.
 * @param {number} slotDur
 * @param {number} [plannedGapSec]
 * @returns {{min:number, max:number}}
 */
export function gapRange(slotDur, plannedGapSec = 0) {
  return { min: GAP_MIN_SEC, max: Math.max(GAP_MAX_SHARE * slotDur, GAP_MAX_FLOOR_SEC, plannedGapSec) };
}

/**
 * @param {{id:string, start:number, end:number, atempoFactor?:number}[]} fittedLines fitAllLines' `.lines`
 * @param {{id:string, start:number, end:number}[]} slots computeSlots' output, same ids as fittedLines
 * @param {{id:string, start:number, end:number}[]} [baseLines] picture.timings.json lines — gives each base line's own gap (shown for reference only)
 * @param {Map<string,number>} [plannedGaps] id -> seconds of silence the plan or picture declared after that line (plannedGapMap)
 * @returns {{id:string, fill:number|null, atempoFactor:number, gapAfter:number|null, gapMin:number|null, gapMax:number|null, gapState:"ok"|"crammed"|"sparse"|null, baseGap:number|null, last:boolean, fillWarn:boolean, gapWarn:boolean, warn:boolean}[]}
 */
export function reportLineFill(fittedLines, slots, baseLines = [], plannedGaps = null) {
  const slotList = slots || [];
  const slotById = new Map(slotList.map((s) => [s.id, s]));
  const lastSlotId = slotList.length ? slotList[slotList.length - 1].id : null;
  const baseGapById = baseLineGaps(baseLines || []);
  return (fittedLines || []).map((line) => {
    const slot = slotById.get(line.id);
    const last = slot != null && slot.id === lastSlotId;
    const slotDur = slot ? slot.end - slot.start : null;
    const fill = slotDur != null && slotDur > 0 ? (line.end - line.start) / slotDur : null;
    const atempoFactor = line.atempoFactor ?? 1;
    const gapAfter = slot && !last ? slot.end - line.end : null;
    const range = gapAfter != null ? gapRange(slotDur, allowedGapSec(plannedGaps, line.id)) : null;
    const gapState = range == null ? null : gapAfter < range.min ? "crammed" : gapAfter > range.max ? "sparse" : "ok";
    const baseGap = baseGapById.get(line.id) ?? null;
    const overFill = fill != null && fill > FULL_FILL_THRESHOLD;
    const fillWarn = overFill || atempoFactor !== 1;
    const gapWarn = gapState === "crammed" || gapState === "sparse";
    return {
      id: line.id, fill, atempoFactor, gapAfter,
      gapMin: range ? range.min : null, gapMax: range ? range.max : null, gapState,
      baseGap, last, fillWarn, gapWarn, warn: fillWarn || gapWarn,
    };
  });
}

/**
 * Every line's fill and gap after, one row each (dub.mjs --table).
 * @param {ReturnType<typeof reportLineFill>} report
 */
export function formatFillTable(report) {
  const rows = (report || []).map((r) => {
    const fill = r.fill == null ? "n/a" : `${(r.fill * 100).toFixed(0)}%`;
    const gap = r.gapAfter == null ? "-" : `${r.gapAfter.toFixed(2)}s`;
    const range = r.gapMin == null ? "-" : `${r.gapMin.toFixed(2)}-${r.gapMax.toFixed(2)}s`;
    const state = r.last ? "last" : r.gapState || "-";
    const atempo = r.atempoFactor !== 1 ? ` atempo ${r.atempoFactor.toFixed(2)}x` : "";
    return `  ${r.id}  ${fill}  ${gap}  ${range}  ${state}${atempo}`;
  });
  return `fill and gap after (id  fill  gapAfter  allowed  state):\n${rows.join("\n")}\n`;
}

/** id -> the base line's own pause before the next base line (none for the last). */
function baseLineGaps(baseLines) {
  const gaps = new Map();
  for (let i = 0; i < baseLines.length - 1; i++) gaps.set(baseLines[i].id, baseLines[i + 1].start - baseLines[i].end);
  return gaps;
}

/**
 * The WARN block dub.mjs prints for lines a fill report flags — "" when
 * nothing needs a look.
 * @param {ReturnType<typeof reportLineFill>} report reportLineFill's output
 */
export function formatFillWarnings(report) {
  const rows = report || [];
  const fillRows = rows.filter((r) => r.fillWarn ?? r.warn);
  const crammed = rows.filter((r) => r.gapWarn && r.gapState !== "sparse");
  const sparse = rows.filter((r) => r.gapWarn && r.gapState === "sparse");
  const gapLine = (r) => {
    const notes = [];
    if (r.gapMin != null) notes.push(`allowed ${r.gapMin.toFixed(2)}-${r.gapMax.toFixed(2)}s`);
    if (r.baseGap != null) notes.push(`base line's own gap ${r.baseGap.toFixed(2)}s`);
    return `  ${r.id}: gap after ${r.gapAfter.toFixed(2)}s${notes.length ? ` (${notes.join("; ")})` : ""}`;
  };
  let out = "";
  if (fillRows.length) {
    const lines = fillRows
      .map((r) => {
        const fillStr = r.fill == null ? "n/a" : `${(r.fill * 100).toFixed(0)}%`;
        const atempoStr = r.atempoFactor !== 1 ? `, atempo ${r.atempoFactor.toFixed(2)}x` : "";
        return `  ${r.id}: fill ${fillStr}${atempoStr}`;
      })
      .join("\n");
    out +=
      `WARN: line(s) squeezed to fit their slot (sped up, or running past it):\n${lines}\n` +
      `hint: rewrite these lines' wording and re-make them with voice.mjs --lines\n`;
  }
  if (crammed.length) {
    out +=
      `WARN: line(s) crammed into their scene — too little silence before the next line (sounds rushed):\n${crammed.map(gapLine).join("\n")}\n` +
      `hint: shorten the wording, or widen these slots with dub.mjs --min-gap <sec> (about 0.5)\n`;
  }
  if (sparse.length) {
    out +=
      `WARN: line(s) too sparse for their scene — the scene sits in silence after the line:\n${sparse.map(gapLine).join("\n")}\n` +
      `hint: say more in these lines (or slow them a little) and re-make them with voice.mjs --lines\n`;
  }
  return out;
}
