// How well each dub line's clip fills its base slot (dub.mjs): a low fill
// leaves the scene sitting in silence, and a line that needed atempo was
// already sped up to fit — both mean the script's wording doesn't match
// the picture's pace in that language. Report only: dub.mjs still writes
// the film either way (references/pipeline.md "Picture first"). No I/O.

export const LOW_FILL_THRESHOLD = 0.75;
export const FULL_FILL_THRESHOLD = 1.0;

/**
 * @param {{id:string, start:number, end:number, atempoFactor?:number}[]} fittedLines fitAllLines' `.lines`
 * @param {{id:string, start:number, end:number}[]} slots computeSlots' output, same ids as fittedLines
 * @returns {{id:string, fill:number|null, atempoFactor:number, warn:boolean}[]}
 */
export function reportLineFill(fittedLines, slots) {
  const slotById = new Map((slots || []).map((s) => [s.id, s]));
  return (fittedLines || []).map((line) => {
    const slot = slotById.get(line.id);
    const slotDur = slot ? slot.end - slot.start : null;
    const clipDur = line.end - line.start;
    const fill = slotDur != null && slotDur > 0 ? clipDur / slotDur : null;
    const atempoFactor = line.atempoFactor ?? 1;
    const warn = (fill != null && (fill < LOW_FILL_THRESHOLD || fill > FULL_FILL_THRESHOLD)) || atempoFactor !== 1;
    return { id: line.id, fill, atempoFactor, warn };
  });
}

/**
 * The WARN block dub.mjs prints for lines a fill report flags — "" when
 * nothing needs a look.
 * @param {{id:string, fill:number|null, atempoFactor:number, warn:boolean}[]} report reportLineFill's output
 */
export function formatFillWarnings(report) {
  const warned = (report || []).filter((r) => r.warn);
  if (!warned.length) return "";
  const rows = warned
    .map((r) => {
      const fillStr = r.fill == null ? "n/a" : `${(r.fill * 100).toFixed(0)}%`;
      const atempoStr = r.atempoFactor !== 1 ? `, atempo ${r.atempoFactor.toFixed(2)}x` : "";
      return `  ${r.id}: fill ${fillStr}${atempoStr}`;
    })
    .join("\n");
  return (
    `WARN: line(s) whose slot fill is off (the scene sits in silence, or the line was sped up to fit):\n${rows}\n` +
    `hint: rewrite these lines' wording and re-make them with voice.mjs --lines\n`
  );
}
