// How each dub line sits in its base slot (dub.mjs): the silence after the
// line (gapAfter) is what the ear judges — a line that fills its slot but
// leaves almost no pause before the next one sounds rushed. Fill is the
// guide: a low fill leaves the scene sitting in silence, and a line that
// needed atempo was already sped up to fit. All of these mean the wording
// doesn't match the picture's pace in that language. Report only: dub.mjs
// still writes the film either way (references/pipeline.md "Picture
// first"). The last line's slot runs to the film's end under the end card,
// so it gets no gap and no low-fill warning. No I/O.

export const LOW_FILL_THRESHOLD = 0.75;
export const FULL_FILL_THRESHOLD = 1.0;
export const SHORT_GAP_SEC = 0.4;

/**
 * @param {{id:string, start:number, end:number, atempoFactor?:number}[]} fittedLines fitAllLines' `.lines`
 * @param {{id:string, start:number, end:number}[]} slots computeSlots' output, same ids as fittedLines
 * @param {{id:string, start:number, end:number}[]} [baseLines] picture.timings.json lines — gives each base line's own gap
 * @returns {{id:string, fill:number|null, atempoFactor:number, gapAfter:number|null, baseGap:number|null, last:boolean, fillWarn:boolean, gapWarn:boolean, warn:boolean}[]}
 */
export function reportLineFill(fittedLines, slots, baseLines = []) {
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
    const baseGap = baseGapById.get(line.id) ?? null;
    const lowFill = !last && fill != null && fill < LOW_FILL_THRESHOLD;
    const overFill = fill != null && fill > FULL_FILL_THRESHOLD;
    const fillWarn = lowFill || overFill || atempoFactor !== 1;
    const gapWarn = gapAfter != null && gapAfter < SHORT_GAP_SEC;
    return { id: line.id, fill, atempoFactor, gapAfter, baseGap, last, fillWarn, gapWarn, warn: fillWarn || gapWarn };
  });
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
  const gapRows = rows.filter((r) => r.gapWarn);
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
      `WARN: line(s) whose slot fill is off (the scene sits in silence, or the line was sped up to fit):\n${lines}\n` +
      `hint: rewrite these lines' wording and re-make them with voice.mjs --lines\n`;
  }
  if (gapRows.length) {
    const lines = gapRows
      .map((r) => {
        const baseStr = r.baseGap == null ? "" : ` (base line's own gap ${r.baseGap.toFixed(2)}s)`;
        return `  ${r.id}: gap after ${r.gapAfter.toFixed(2)}s${baseStr}`;
      })
      .join("\n");
    out +=
      `WARN: line(s) with little silence before the next line (sounds rushed):\n${lines}\n` +
      `hint: shorten the wording, or widen these slots with dub.mjs --min-gap <sec> (about 0.5)\n`;
  }
  return out;
}
