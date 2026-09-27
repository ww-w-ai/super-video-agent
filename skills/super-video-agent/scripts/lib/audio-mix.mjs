// Builds the ffmpeg filter_complex that mixes library sound cues
// (design.md §2.5 "Sound") into a film's audio: each cue is trimmed to
// maxSec (or its own length), given a 30ms fade-out, peak-normalized to
// -6 dBFS then `gainDb`, delayed to its cue time, and summed with
// narration (+ optional page SFX) before the shared loudnorm pass. A pure
// function of its inputs so the graph shape can be unit-tested without
// ffmpeg: render.mjs supplies each cue's measured peak dB and trim length.
const FADE_OUT_SEC = 0.03;
const TARGET_PEAK_DB = -6;
// asetpts: loudnorm leaves one gap in the packet timestamps when video is muxed in the same command (ffmpeg 8.1, ~42 ms); renumbering from the sample count removes it.
export const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB";

/**
 * @param {{narrationIndex?:number, hasSfx:boolean, cues:{trimSec:number, peakDb:number, gainDb?:number, atSec:number, leadSec?:number}[]}} args
 *   `narrationIndex` is narration's `-i` position in the ffmpeg command
 *   (default 1: video is always input 0). Sfx (if `hasSfx`) is assumed to
 *   be the next input, then one input per cue, in `cues` order.
 * @returns {{filterComplex:string, inputCount:number}} `inputCount` is how
 *   many audio `-i` inputs (narration [+ sfx] + cues) the caller must pass,
 *   starting at `narrationIndex`.
 */
export function buildCueMixFilter({ narrationIndex = 1, hasSfx, cues }) {
  const parts = [];
  const sumLabels = [`[${narrationIndex}:a]`];
  let nextInput = narrationIndex + 1;
  if (hasSfx) {
    sumLabels.push(`[${nextInput}:a]`);
    nextInput++;
  }

  cues.forEach((cue, i) => {
    const inIdx = nextInput + i;
    const label = `cue${i}`;
    const trimSec = cue.trimSec;
    const fadeStart = Math.max(0, trimSec - FADE_OUT_SEC);
    const gainDb = (TARGET_PEAK_DB - cue.peakDb) + (cue.gainDb || 0);
    const delayMs = Math.max(0, Math.round(cue.atSec * 1000));
    const leadSec = cue.leadSec || 0;
    const trim = leadSec > 0 ? `atrim=${leadSec}:${leadSec + trimSec},asetpts=PTS-STARTPTS` : `atrim=0:${trimSec}`;
    parts.push(
      `[${inIdx}:a]${trim},afade=t=out:st=${fadeStart}:d=${FADE_OUT_SEC},` +
        `volume=${gainDb}dB,adelay=${delayMs}:all=1[${label}]`
    );
    sumLabels.push(`[${label}]`);
  });

  const mixedLabel = sumLabels.length > 1 ? "[amixed]" : sumLabels[0];
  if (sumLabels.length > 1) {
    parts.push(`${sumLabels.join("")}amix=inputs=${sumLabels.length}:duration=first:dropout_transition=0[amixed]`);
  }
  parts.push(`${mixedLabel}${LOUDNORM}[aout]`);

  const inputCount = nextInput - narrationIndex + cues.length; // narration [+ sfx] + cues
  return { filterComplex: parts.join(";"), inputCount };
}
