// Fit a language's voice lines to a picture's slots and build one narration
// track of exactly the picture's length. The picture's time is the reference:
//   1. trim   each line to its voiced span plus 0.05 s head / 0.3 s tail (clip-trim.mjs)
//   2. speed  up by at most MAX_SPEED_DEFAULT (1.1, atempo, pitch kept) when the line is longer than its slot
//   3. breath keep at least MIN_BREATH_SEC (0.5 s) of silence after the line when the slot has room
//   4. gap    the rest of the slot stays voice-free, up to MAX_BREATH_SEC (1.0 s); a longer gap
//             slows the line (atempo down to MIN_ATEMPO, 0.95); the picture never stretches
// A line that still does not fit is reported for rewording, never sped further.
// A line left with under 0.5 s of breath, or a gap over 1.0 s, is reported with its id.
// Shared by fit-track.mjs and dub.mjs.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probeDuration, applyAtempo } from "./ffmpeg.mjs";
import { levelLineWav } from "./line-level.mjs";
import { trimClipToVoice } from "./clip-trim.mjs";
import { fitAllLines, MAX_ATEMPO_DEFAULT, MIN_ATEMPO } from "./dub-timing.mjs";

export const MAX_SPEED_DEFAULT = MAX_ATEMPO_DEFAULT;
export const SAMPLE_RATE = 48000;

/**
 * Trim every voice line's own wav (`<voiceDir>/line-<id>.wav`) into
 * `<workDir>/trimmed-<id>.wav`. A line with no wav is left out; fitAllLines
 * reports it as "no measured clip duration".
 * @param {{lines:{id:string}[]}} voiceTimings
 * @returns {Promise<Map<string, {leadTrimSec:number, tailTrimSec:number, trimmedDurationSec:number, trimmedPath:string}>>}
 */
export async function trimVoiceClips({ voiceTimings, voiceDir, workDir }) {
  const trims = new Map();
  for (const l of voiceTimings.lines || []) {
    const srcPath = path.join(voiceDir, `line-${l.id}.wav`);
    if (!fs.existsSync(srcPath)) continue;
    const trimmedPath = path.join(workDir, `trimmed-${l.id}.wav`);
    const t = await trimClipToVoice(srcPath, trimmedPath);
    trims.set(l.id, { leadTrimSec: t.leadTrimSec, tailTrimSec: t.tailTrimSec, trimmedDurationSec: t.trimmedDurationSec, trimmedPath });
  }
  return trims;
}

/** The voice lines with `start` moved forward by the removed lead, so word times land on the trimmed clip's own timeline. */
export function shiftForTrim(voiceLines, trims) {
  return (voiceLines || []).map((l) => {
    const t = trims.get(l.id);
    return t && t.leadTrimSec > 0 ? { ...l, start: l.start + t.leadTrimSec } : l;
  });
}

/** fitAllLines, throwing one message that names every line that does not fit; prints each line left with a short breath or a long gap. */
export function fitOrThrow(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed = MAX_SPEED_DEFAULT) {
  const fit = fitAllLines(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed);
  if (!fit.ok) throw new Error(`line(s) do not fit their slot: ${describeFailures(fit.failures)}`);
  for (const message of describeBreath(fit)) process.stdout.write(`${message}\n`);
  return fit;
}

/** One message per line that keeps under the minimum breath after it, or leaves a gap over the maximum. */
export function describeBreath(fit) {
  const short = (fit.breathWarnings || []).map(
    (w) => `line "${w.id}": only ${w.breathSec.toFixed(2)}s of silence after it, under the ${w.minBreathSec}s minimum — lines run tight; shorten this line's script or the next slot's need and re-make it`
  );
  const long = (fit.longGaps || []).map(
    (g) => `line "${g.id}": ${g.gapSec.toFixed(2)}s of silence after it, over the ${g.maxBreathSec}s maximum even at the slowest speed — lengthen this line's script and re-make it`
  );
  return [...short, ...long];
}

/** "id: needs 1.080x, max is 1.05x — reword this line" for each failing line. */
export function describeFailures(failures) {
  return failures
    .map((f) =>
      f.requiredFactor == null
        ? `${f.id}: ${f.reason}`
        : `${f.id}: needs ${f.requiredFactor.toFixed(3)}x, max is ${f.maxAtempo}x — shorten this line's script and re-make it (voice.mjs --lines)`
    )
    .join("; ");
}

/**
 * Copy (or atempo-speed) each trimmed clip to its fitted duration and level it
 * to one loudness (references/voice.md). Unplaced: adelay happens in the mix.
 * @returns {Promise<{id:string, path:string, startSec:number}[]>}
 */
export async function placeLineClips({ fit, trims, workDir, maxSpeed = MAX_SPEED_DEFAULT }) {
  const placedClips = [];
  for (const line of fit.lines) {
    const srcPath = trims.get(line.id).trimmedPath;
    const placedPath = path.join(workDir, `placed-${line.id}.wav`);
    if (line.atempoFactor === 1) {
      fs.copyFileSync(srcPath, placedPath);
    } else {
      await applyAtempo(srcPath, placedPath, line.atempoFactor, { min: MIN_ATEMPO, max: maxSpeed });
    }
    const leveled = await levelLineWav(placedPath);
    process.stdout.write(`line "${line.id}" leveled: ${leveled.beforeLufs == null ? "n/a" : leveled.beforeLufs.toFixed(1)} -> ${leveled.afterLufs == null ? "n/a" : leveled.afterLufs.toFixed(1)} LUFS\n`);
    placedClips.push({ id: line.id, path: placedPath, startSec: line.start });
  }
  return placedClips;
}

/**
 * One mono 48 kHz wav of exactly round(durationSec * 48000) samples: each
 * clip delayed to its start, summed (each clip is already leveled, so no
 * normalize), padded or cut to the length.
 */
export async function buildNarrationTrack({ clips, durationSec, outPath }) {
  const total = Math.round(durationSec * SAMPLE_RATE);
  const inputArgs = clips.flatMap((c) => ["-i", c.path]);
  const stages = clips.map((c, i) => `[${i}:a]adelay=${Math.max(0, Math.round(c.startSec * 1000))}:all=1[ln${i}]`);
  const labels = clips.map((_, i) => `[ln${i}]`).join("");
  const sum = clips.length > 1 ? `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0` : labels;
  const filter = `${stages.join(";")};${sum},apad=whole_len=${total},atrim=end_sample=${total}[out]`;
  await ffmpeg(["-y", ...inputArgs, "-filter_complex", filter, "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  return { samples: total };
}

/** Length of a pcm wav in samples at 48 kHz, from its probed duration. */
export async function trackSamples(wavPath) {
  return Math.round((await probeDuration(wavPath)) * SAMPLE_RATE);
}
