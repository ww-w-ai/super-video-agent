#!/usr/bin/env node
// Fit a language's voice lines to an existing picture and write one narration
// track of exactly the picture's length (references/pipeline.md "Fit a track
// to an existing video"). The picture's time is the reference; order:
// trim -> speed (up to 1.1x) -> breath (>= 0.5 s) -> gap (<= 1.0 s, else slow to 0.95x).
// Never stretches the picture.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, ensureDir } from "./lib/reeldir.mjs";
import { probeDuration } from "./lib/ffmpeg.mjs";
import { computeSlots, plannedGapMap } from "./lib/dub-timing.mjs";
import { reportLineFill, formatFillWarnings } from "./lib/dub-fill.mjs";
import { MAX_SPEED_DEFAULT, trimVoiceClips, shiftForTrim, fitOrThrow, fitDraft, formatDraftOverflow, placeLineClips, buildNarrationTrack } from "./lib/fit-track.mjs";
import { measureNarrationGaps, formatSilenceReport, pictureGapPlan } from "./lib/silence-gate.mjs";
import { measureNarrationCuts, formatCutReport } from "./lib/audio-analysis.mjs";

const HELP = `usage: fit-track.mjs --timings <picture.timings.json> --voice <voice-dir> --out <track.wav> [--video <picture.mp4>] [--plan <plan.json>] [--max-speed <x>] [--draft]

Fits a language's voice lines to a picture's slots and writes one mono
48 kHz narration track of exactly the picture's length.

--timings   the picture's timing reference: { duration, lines:[{id,start,end}] };
            each line's slot runs from its start to the next line's start
            (the last line's slot runs to the end).
--voice     a voice.mjs folder: timings.json and line-<id>.wav (same line ids).
--out       the track to write.
--video     take the length from this video instead of --timings' duration.
--plan      the language's plan.json; a pause it asks for (pauseAfterMs) is
            listed as planned, not as a silence failure.
--max-speed the fastest a line may be sped up (default ${MAX_SPEED_DEFAULT}, 10%). Widen it only when asked.
--draft     write the track even when some lines need more than --max-speed: those
            lines are placed at --max-speed, run past their slot, and are listed
            as DRAFT with the speed they need. A draft is for listening; fix the
            listed lines before the final.

Order for every line: trim to its voiced span (0.05 s head, 0.3 s tail),
then speed up by at most --max-speed (pitch kept) if it is longer than its
slot, then keep at least 0.5 s of silence after it when the slot has room, then
leave the rest of the slot voice-free up to 1.0 s; a longer gap slows the line
(down to 0.95x). A line that still does not fit is listed for rewording and no
track is written; a line left with under 0.5 s of silence after it, or a gap
over 1.0 s, is listed with its id. Then the silence gate
reports every pause over 1 s with the line ids around it, and the waveform cut
check lists any line whose start or end is still loud (an abrupt cut).
`;

export async function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h || ["timings", "voice", "out"].some((k) => typeof flags[k] !== "string")) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  let maxSpeed = MAX_SPEED_DEFAULT;
  if (flags["max-speed"] !== undefined) {
    maxSpeed = Number(flags["max-speed"]);
    if (!Number.isFinite(maxSpeed) || maxSpeed < 1) fail(`--max-speed needs a number of 1 or more, got "${flags["max-speed"]}"`);
  }
  try {
    const result = await fitTrack({
      timingsPath: abs(flags.timings),
      voiceDir: abs(flags.voice),
      outPath: abs(flags.out),
      videoPath: typeof flags.video === "string" ? abs(flags.video) : null,
      planPath: typeof flags.plan === "string" ? abs(flags.plan) : null,
      maxSpeed,
      draft: flags.draft !== undefined && flags.draft !== "false",
    });
    process.stdout.write(`wrote ${result.outPath}\nlines: ${result.lineCount}  seconds: ${result.seconds.toFixed(3)}  samples: ${result.samples}\n`);
  } catch (e) {
    fail(e.message);
  }
}

/**
 * @returns {Promise<{outPath:string, lineCount:number, seconds:number, samples:number, fit:object, silence:object}>}
 */
export async function fitTrack({ timingsPath, voiceDir, outPath, videoPath = null, planPath = null, maxSpeed = MAX_SPEED_DEFAULT, draft = false }) {
  const base = readJson(timingsPath);
  const voice = readJson(path.join(voiceDir, "timings.json"));
  const seconds = videoPath ? await probeDuration(videoPath) : base.duration;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("the reference needs a positive duration (--video or timings.duration)");
  const plan = planPath ? readJson(planPath) : {};
  const planLines = plan.lines || [];
  const gapMs = plan.meta && plan.meta.gapMs != null ? plan.meta.gapMs : undefined;
  ensureDir(path.dirname(outPath));
  const workDir = fs.mkdtempSync(path.join(path.dirname(outPath), ".fit-track-"));
  try {
    const trims = await trimVoiceClips({ voiceTimings: voice, voiceDir, workDir });
    for (const [id, t] of trims) process.stdout.write(`line "${id}" trimmed: lead ${t.leadTrimSec.toFixed(3)}s, tail ${t.tailTrimSec.toFixed(3)}s\n`);
    const durations = new Map([...trims].map(([id, t]) => [id, t.trimmedDurationSec]));
    const voiceLines = shiftForTrim(voice.lines, trims);
    const planned = plannedGapMap(pictureGapPlan(base.lines, planLines));
    const breath = { plannedGapSec: planned };
    const fit = draft ? fitDraft(base.lines, voiceLines, durations, seconds, maxSpeed, breath) : fitOrThrow(base.lines, voiceLines, durations, seconds, maxSpeed, breath);
    if (draft) process.stdout.write(formatDraftOverflow(fit.overflow, maxSpeed));
    const fill = formatFillWarnings(reportLineFill(fit.lines, computeSlots(base.lines, seconds), base.lines, planned));
    if (fill) process.stdout.write(fill);
    const clips = await placeLineClips({ fit, trims, workDir, maxSpeed });
    const { samples } = await buildNarrationTrack({ clips, durationSec: seconds, outPath });
    const silence = await measureNarrationGaps(outPath, fit.lines, pictureGapPlan(base.lines, planLines), { gapMs });
    process.stdout.write(formatSilenceReport(silence));
    const cuts = await measureNarrationCuts(outPath, fit.lines);
    process.stdout.write(formatCutReport(cuts));
    return { outPath, lineCount: fit.lines.length, seconds, samples, fit, silence, cuts };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
