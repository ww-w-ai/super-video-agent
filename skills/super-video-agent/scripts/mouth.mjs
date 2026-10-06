#!/usr/bin/env node
// Mouth schedule per voice line (references/characters.md "Mouth shapes"). Language-independent:
// amplitude mode follows how loud each line's audio is, steady mode opens and closes at a fixed
// rate. Writes a JSON the page reads with ReelRig.mouthTrack. Facts only: whether to use it, and
// whether it fits a language, is the model's call.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, writeJson } from "./lib/reeldir.mjs";
import { buildSchedule, scheduleLines, STEP_SEC_DEFAULT, THRESHOLD_DEFAULT, RATE_HZ_DEFAULT } from "./lib/mouth.mjs";

const HELP = `usage: mouth.mjs <reel-dir> [--dub <code>] [--timings <file>] [--voice <dir>] [--mode amplitude|steady]
                 [--step <sec>] [--threshold <0-1>] [--rate <hz>] [--out <json>]

Writes when each line's mouth is open, as {mode, params, lines:[{id, start, end, spans:[{from, to, open}]}], skipped}.
Times are film seconds; a line's clip starts at its timings "start". Between spans the mouth is closed.
No phoneme or language model: nothing here depends on the language spoken.

Timings: <reel-dir>/voice/timings.json, or with --dub <code> <reel-dir>/dub/<code>/voice/timings.json.
--timings   another timings file; --voice the folder holding line-<id>.wav (default: the timings file's folder)
--mode      amplitude (default): open where the line's audio level reaches --threshold (default ${THRESHOLD_DEFAULT}) of its own
            loud level, measured every --step seconds (default ${STEP_SEC_DEFAULT}); needs line-<id>.wav, a line without one is listed as skipped
            steady: open for half of each 1/--rate period (default ${RATE_HZ_DEFAULT} Hz) from the line's start to its end; ignores the sound
--out       default: mouth.json next to the timings file

The page reads it with ReelRig.mouthTrack(schedule)(t) (scripts/engine/reel-rig.js). With several languages the
mouth of one language may not match another's speech: make one schedule per language or use steady.
`;

function numberFlag(flags, name, fallback, ok) {
  if (flags[name] === undefined) return fallback;
  const v = Number(flags[name]);
  if (!Number.isFinite(v) || !ok(v)) throw new Error(`--${name} takes a number in range, got "${flags[name]}"`);
  return v;
}

/** Resolves the options of one run: where the timings and audio are, and the mode settings. */
export function resolveOptions(positional, flags) {
  const dir = abs(positional[0]);
  const mode = flags.mode === undefined ? "amplitude" : flags.mode;
  if (mode !== "amplitude" && mode !== "steady") throw new Error(`--mode is amplitude or steady, got "${mode}"`);
  const voiceDefault = typeof flags.dub === "string" ? path.join(dir, "dub", flags.dub, "voice") : path.join(dir, "voice");
  const timingsPath = typeof flags.timings === "string" ? abs(flags.timings) : path.join(voiceDefault, "timings.json");
  return {
    mode,
    timingsPath,
    voiceDir: typeof flags.voice === "string" ? abs(flags.voice) : path.dirname(timingsPath),
    stepSec: numberFlag(flags, "step", STEP_SEC_DEFAULT, (v) => v >= 0.01 && v <= 0.5),
    threshold: numberFlag(flags, "threshold", THRESHOLD_DEFAULT, (v) => v > 0 && v < 1),
    rateHz: numberFlag(flags, "rate", RATE_HZ_DEFAULT, (v) => v > 0 && v <= 20),
    out: typeof flags.out === "string" ? abs(flags.out) : path.join(path.dirname(timingsPath), "mouth.json"),
  };
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  try {
    const o = resolveOptions(positional, flags);
    if (!fs.existsSync(o.timingsPath)) return fail(`no timings file at ${o.timingsPath}`);
    const schedule = buildSchedule({ timings: readJson(o.timingsPath), voiceDir: o.voiceDir, mode: o.mode, stepSec: o.stepSec, threshold: o.threshold, rateHz: o.rateHz });
    writeJson(o.out, schedule);
    process.stdout.write(scheduleLines(schedule).join("\n") + `\nwrote ${o.out}\n`);
  } catch (e) {
    fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
