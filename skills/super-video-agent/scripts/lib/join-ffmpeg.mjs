// Filter-graph and timing math for scripts/join.mjs's re-encode join
// (opening + body + ending, or any N parts). Pure string/number building —
// no ffmpeg call — so the graph shape and join times are unit-testable
// without a decode.
const EDGE_FADE_SEC = 0.01; // 10ms audio edge fade per part, at every join

/**
 * @param {{count:number, width:number, height:number, fps:number, durationsSec:number[]}} args
 * @returns {string} filter_complex for -filter_complex: each input scaled
 *   to the target size/fps and its audio edge-faded, then concatenated.
 */
export function buildJoinFilter({ count, width, height, fps, durationsSec }) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(`[${i}:v]scale=${width}:${height},fps=${fps},format=yuv420p,setsar=1[v${i}]`);
    const d = durationsSec[i];
    const fadeOutStart = Math.max(0, d - EDGE_FADE_SEC);
    parts.push(
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,` +
        `afade=t=in:d=${EDGE_FADE_SEC},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${EDGE_FADE_SEC}[a${i}]`
    );
  }
  const labels = [];
  for (let i = 0; i < count; i++) labels.push(`[v${i}][a${i}]`);
  parts.push(`${labels.join("")}concat=n=${count}:v=1:a=1[v][a]`);
  return parts.join(";");
}

/** Start time (seconds) of each part in the joined output. */
export function joinOffsets(durationsSec) {
  const offsets = [0];
  for (let i = 0; i < durationsSec.length - 1; i++) {
    offsets.push(offsets[i] + durationsSec[i]);
  }
  return offsets;
}

/** Cut time (seconds) of each join — between part i and part i+1. */
export function joinTimes(durationsSec) {
  return joinOffsets(durationsSec).slice(1);
}

export const EDGE_FADE_SEC_DEFAULT = EDGE_FADE_SEC;
