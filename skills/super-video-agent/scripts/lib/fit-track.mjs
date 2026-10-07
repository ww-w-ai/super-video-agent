// Fit a language's voice lines to a picture's slots and build one narration
// track of exactly the picture's length. The picture's time is the reference:
//   1. trim   each line to its voiced span plus 0.05 s head / 0.3 s tail (clip-trim.mjs)
//   2. speed  up by at most MAX_SPEED_DEFAULT (1.1, atempo, pitch kept) when the line is longer than its slot
//   3. breath keep at least MIN_BREATH_SEC (0.5 s) of silence after the line when the slot has room
//   4. gap    the rest of the slot stays voice-free, up to MAX_BREATH_SEC (1.0 s); a longer gap
//             slows the line (atempo down to MIN_ATEMPO, 0.95); the picture never stretches
// A line that still does not fit is reported for rewording, never sped further.
// How much silence each placed line leaves is judged per scene by dub-fill.mjs (reportLineFill).
// Shared by fit-track.mjs and dub.mjs.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probeDuration, applyAtempo } from "./ffmpeg.mjs";
import { levelLineWav, formatLevelReport } from "./line-level.mjs";
import { trimClipToVoice } from "./clip-trim.mjs";
import { fitAllLines, computeSlots, MAX_ATEMPO_DEFAULT, MIN_ATEMPO } from "./dub-timing.mjs";

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

/**
 * The voice lines with `start` moved forward by the removed lead, so word times land on the trimmed
 * clip's own timeline, and `leadTrimSec` set so fitAllLines starts the trimmed clip that long after
 * its slot start (the sound stays where the voice's own timings put it).
 */
export function shiftForTrim(voiceLines, trims) {
  return (voiceLines || []).map((l) => {
    const t = trims.get(l.id);
    return t && t.leadTrimSec > 0 ? { ...l, start: l.start + t.leadTrimSec, leadTrimSec: t.leadTrimSec } : l;
  });
}

/** fitAllLines, throwing one message that names every line that does not fit. Gaps are judged afterwards per scene (dub-fill.mjs reportLineFill). */
export function fitOrThrow(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed = MAX_SPEED_DEFAULT, breath = {}) {
  const fit = fitAllLines(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed, breath);
  if (!fit.ok) throw new Error(`line(s) do not fit their slot: ${describeFailures(fit.failures)}`);
  return fit;
}

/**
 * A draft fit to listen to: every line that needs more than `maxSpeed` is placed at `maxSpeed`
 * and runs past its slot (`draft: true`); the same lines come back in `overflow`. A line with
 * no clip or no matching id still throws, since there is nothing to place.
 * @returns {{ok:true, lines:object[], breathWarnings:object[], longGaps:object[], overflow:{id:string, requiredFactor:number, overSec:number}[]}}
 */
export function fitDraft(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed = MAX_SPEED_DEFAULT, breath = {}) {
  const first = fitAllLines(baseLines, voiceLines, clipDurations, filmDuration, maxSpeed, breath);
  if (first.ok) return { ...first, overflow: [] };
  const hard = first.failures.filter((f) => f.requiredFactor == null);
  if (hard.length) throw new Error(`line(s) cannot be placed even as a draft: ${describeFailures(hard)}`);
  const slots = new Map(computeSlots(baseLines, filmDuration).map((s) => [s.id, s]));
  const real = new Map();
  const clamped = new Map(clipDurations);
  for (const f of first.failures) {
    const slot = slots.get(f.id);
    real.set(f.id, clipDurations.get(f.id));
    clamped.set(f.id, (slot.end - slot.start) * maxSpeed);
  }
  const fit = fitAllLines(baseLines, voiceLines, clamped, filmDuration, maxSpeed, breath);
  const overflow = [];
  const lines = fit.lines.map((l) => {
    if (!real.has(l.id)) return l;
    const slot = slots.get(l.id);
    const end = l.start + real.get(l.id) / maxSpeed;
    overflow.push({ id: l.id, requiredFactor: first.failures.find((f) => f.id === l.id).requiredFactor, overSec: end - slot.end });
    return { ...l, end, draft: true };
  });
  return { ...fit, lines, overflow };
}

/** "DRAFT: id needs 1.180x (max 1.1x), runs 0.32s past its slot" per overflow line. */
export function formatDraftOverflow(overflow, maxSpeed) {
  return overflow.map((o) => `DRAFT: line "${o.id}" needs ${o.requiredFactor.toFixed(3)}x (max ${maxSpeed}x), runs ${o.overSec.toFixed(2)}s past its slot — shorten it and re-make before the final\n`).join("");
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
    process.stdout.write(formatLevelReport(line.id, await levelLineWav(placedPath)));
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
  await ffmpeg(["-y", ...inputArgs, "-filter_complex", buildNarrationFilter(clips, total), "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  return { samples: total };
}

/** The filter graph for buildNarrationTrack. One clip has no amix, so its label goes straight into apad. */
export function buildNarrationFilter(clips, totalSamples) {
  const stages = clips.map((c, i) => `[${i}:a]adelay=${Math.max(0, Math.round(c.startSec * 1000))}:all=1[ln${i}]`);
  const labels = clips.map((_, i) => `[ln${i}]`).join("");
  const sum = clips.length > 1 ? `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,` : labels;
  return `${stages.join(";")};${sum}apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[out]`;
}

/** Length of a pcm wav in samples at 48 kHz, from its probed duration. */
export async function trackSamples(wavPath) {
  return Math.round((await probeDuration(wavPath)) * SAMPLE_RATE);
}
