// Pure math for dub.mjs --min-gap (references/pipeline.md "Picture first
// and language versions"): when a language's placed line leaves less than
// <min-gap> seconds of silence before the next line, that slot's picture
// and bed are slowed (video setpts, bed atempo) until the gap reaches
// <min-gap>. The voice keeps its own speed; the line starts move with the
// stretched timeline. The last slot (it runs under the end card) is never
// stretched, and neither is the lead-in before the first line, so the
// first and last frames stay the same. No I/O, no ffmpeg.

const EPS = 1e-9;
// ffmpeg's atempo accepts 0.5–100 per instance; slower tempos are chained.
const ATEMPO_MIN = 0.5;

/**
 * Extra seconds each slot needs so the gap after its placed line reaches
 * `minGap`. Slot i spans base line i's start to base line i+1's start; the
 * last slot is always 0.
 * @param {{id:string, start:number}[]} baseLines picture.timings.json lines
 * @param {{id:string, end:number}[]} placedLines fitAllLines' `.lines` (same order/ids)
 * @param {number} minGap seconds
 * @returns {{id:string, gap:number|null, delta:number}[]}
 */
export function computeGapDeltas(baseLines, placedLines, minGap) {
  const placedById = new Map((placedLines || []).map((l) => [l.id, l]));
  return baseLines.map((b, i) => {
    if (i === baseLines.length - 1) return { id: b.id, gap: null, delta: 0 };
    const placed = placedById.get(b.id);
    const gap = placed ? baseLines[i + 1].start - placed.end : null;
    const delta = gap == null ? 0 : Math.max(0, minGap - gap);
    return { id: b.id, gap, delta };
  });
}

/**
 * Piecewise-linear old -> new time map. Knots sit at 0, every base line
 * start, and the film's end; slot i grows by deltas[i]. A zero-length
 * lead-in (first line at 0) is dropped so no segment divides by zero.
 * @param {{start:number}[]} baseLines
 * @param {number} filmDuration
 * @param {number[]} deltas one per base line (computeGapDeltas' `.delta`)
 * @returns {{knotsOld:number[], knotsNew:number[], oldDuration:number, newDuration:number}}
 */
export function buildTimeMap(baseLines, filmDuration, deltas) {
  const starts = baseLines.map((l) => l.start);
  const knotsOld = [0];
  const knotsNew = [0];
  const firstStart = starts.length ? starts[0] : filmDuration;
  if (firstStart > EPS) {
    knotsOld.push(firstStart);
    knotsNew.push(firstStart);
  }
  for (let i = 0; i < starts.length; i++) {
    const segEnd = i === starts.length - 1 ? filmDuration : starts[i + 1];
    const segLen = segEnd - starts[i];
    knotsOld.push(segEnd);
    knotsNew.push(knotsNew[knotsNew.length - 1] + segLen + (deltas[i] || 0));
  }
  return { knotsOld, knotsNew, oldDuration: filmDuration, newDuration: knotsNew[knotsNew.length - 1] };
}

/** One old-clock time onto the stretched clock (clamped to the ends). */
export function remapTime(t, map) {
  const { knotsOld, knotsNew } = map;
  if (t <= knotsOld[0]) return knotsNew[0] + (t - knotsOld[0]);
  for (let k = 0; k < knotsOld.length - 1; k++) {
    const a = knotsOld[k];
    const b = knotsOld[k + 1];
    if (t <= b || k === knotsOld.length - 2) {
      const A = knotsNew[k];
      const B = knotsNew[k + 1];
      return b - a > EPS ? A + ((t - a) * (B - A)) / (b - a) : A;
    }
  }
  return t;
}

/**
 * A timings.json-shaped object (duration + lines with words) onto the
 * stretched clock. Returns a copy; the input is not modified.
 */
export function remapTimings(timings, map) {
  const out = JSON.parse(JSON.stringify(timings));
  out.duration = map.newDuration;
  for (const line of out.lines || []) {
    line.start = remapTime(line.start, map);
    line.end = remapTime(line.end, map);
    for (const w of line.words || []) {
      w.start = remapTime(w.start, map);
      w.end = remapTime(w.end, map);
    }
  }
  return out;
}

/** The map's segments: old span and slow factor (new length / old length, 1 = unchanged). */
export function segmentFactors(map) {
  const segs = [];
  for (let k = 0; k < map.knotsOld.length - 1; k++) {
    const a = map.knotsOld[k];
    const b = map.knotsOld[k + 1];
    if (b - a <= EPS) continue;
    segs.push({ start: a, end: b, factor: (map.knotsNew[k + 1] - map.knotsNew[k]) / (b - a) });
  }
  return segs;
}

/** atempo filter chain for `tempo` (< 1 slows); "" when tempo is 1. */
export function atempoChain(tempo) {
  if (Math.abs(tempo - 1) < 1e-6) return "";
  const parts = [];
  let rest = tempo;
  while (rest < ATEMPO_MIN) {
    parts.push(`atempo=${ATEMPO_MIN}`);
    rest /= ATEMPO_MIN;
  }
  parts.push(`atempo=${rest.toFixed(6)}`);
  return parts.join(",");
}

/**
 * One -filter_complex for input 0 = picture (video) and input 1 = bed
 * (audio): each segment trimmed, slowed by its factor, then concatenated.
 * Outputs [v] (resampled onto the fps grid, padded by cloning the last
 * frame so the caller's -frames:v always has enough) and [a] (padded, then
 * cut to the new length).
 * @param {{start:number, end:number, factor:number}[]} segments segmentFactors' output
 * @param {number} fps
 * @param {number} newDuration
 */
export function buildSpaceFilterGraph(segments, fps, newDuration) {
  const video = [];
  const audio = [];
  segments.forEach((s, k) => {
    const span = `start=${s.start.toFixed(6)}:end=${s.end.toFixed(6)}`;
    video.push(`[0:v]trim=${span},setpts=(PTS-STARTPTS)*${s.factor.toFixed(6)}[v${k}]`);
    const tempo = atempoChain(1 / s.factor);
    audio.push(`[1:a]atrim=${span},asetpts=PTS-STARTPTS${tempo ? `,${tempo}` : ""}[a${k}]`);
  });
  const n = segments.length;
  const vIn = segments.map((_, k) => `[v${k}]`).join("");
  const aIn = segments.map((_, k) => `[a${k}]`).join("");
  return [
    ...video,
    ...audio,
    `${vIn}concat=n=${n}:v=1:a=0,fps=${fps},tpad=stop_mode=clone:stop_duration=1[v]`,
    `${aIn}concat=n=${n}:v=0:a=1,apad,atrim=end=${newDuration.toFixed(6)}[a]`,
  ].join(";");
}

/**
 * ffmpeg args writing both outputs in ONE call — two separate calls over
 * the same graph fail with "unconnected output", since a graph that
 * defines [v] and [a] must map both.
 */
export function buildSpaceFfmpegArgs({ pictureMp4, bedWav, outMp4, outWav, graph, frameCount }) {
  return [
    "-y",
    "-i",
    pictureMp4,
    "-i",
    bedWav,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-frames:v",
    String(frameCount),
    "-c:v",
    "libx264",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outMp4,
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    outWav,
  ];
}

// One encoder setting for every picture span: spans are joined without
// re-encoding, so a shared span and a language span must match exactly.
const SPAN_ENCODE = ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-an"];

function trimFilter(startFrame, endFrame) {
  return `trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`;
}

/** ffmpeg args encoding frames [startFrame, endFrame) of the picture alone: a language-neutral span. */
export function buildPlainSpanArgs({ pictureMp4, startFrame, endFrame, fps, outPath }) {
  return ["-y", "-i", pictureMp4, "-vf", trimFilter(startFrame, endFrame), "-r", String(fps),
    "-frames:v", String(endFrame - startFrame), ...SPAN_ENCODE, outPath];
}

/** Same span with the caption PNG sequence (numbered by film frame) composited over it: a language span. */
export function buildCaptionSpanArgs({ pictureMp4, captionsDir, startFrame, endFrame, fps, outPath }) {
  const graph = `[0:v]${trimFilter(startFrame, endFrame)}[p];[1:v]format=rgba[cap];[p][cap]overlay=format=auto[v]`;
  return ["-y", "-i", pictureMp4, "-framerate", String(fps), "-start_number", String(startFrame),
    "-i", `${captionsDir}/frame-%05d.png`, "-filter_complex", graph, "-map", "[v]", "-r", String(fps),
    "-frames:v", String(endFrame - startFrame), ...SPAN_ENCODE, outPath];
}

/**
 * The per-slot table dub.mjs prints: gap before, added seconds, slow
 * factor, and old -> new length.
 * @param {{id:string, gap:number|null, delta:number}[]} deltas computeGapDeltas' output
 * @param {{oldDuration:number, newDuration:number}} map
 * @param {{start:number}[]} baseLines
 */
export function formatSpaceReport(deltas, map, baseLines) {
  const rows = deltas.map((d, i) => {
    const slotLen = (i === baseLines.length - 1 ? map.oldDuration : baseLines[i + 1].start) - baseLines[i].start;
    const factor = slotLen > EPS ? (slotLen + d.delta) / slotLen : 1;
    const gapStr = d.gap == null ? "last" : `gap ${d.gap.toFixed(3)}s`;
    return `  ${d.id}: ${gapStr}, +${d.delta.toFixed(3)}s, factor ${factor.toFixed(3)}`;
  });
  return `min-gap: slots widened (picture and bed slowed, voice unchanged):\n${rows.join("\n")}\nlength ${map.oldDuration.toFixed(3)}s -> ${map.newDuration.toFixed(3)}s\n`;
}
