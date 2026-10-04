#!/usr/bin/env node
// Warns about sound-effect cues keyed to a word (`at: "word:<text>"`) whose word is missing,
// not heard, interpolated, or moved. Warnings only: exit 0 whatever it finds.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, loadPlan, loadTimings, writeJson } from "./lib/reeldir.mjs";
import { readWav } from "./lib/wav-read.mjs";
import { measureWordOnsets, OFFSET_REPORT_SEC } from "./lib/word-onsets.mjs";
import { checkWordCues, formatCueWarnings } from "./lib/cue-check.mjs";

const HELP = `usage: cue-check.mjs <reel-dir> [--threshold <ms>] [--out <json>]

Reads plan.json cues keyed to a word and voice/timings.json. Warns when
  cue-line-missing      the cue's line is not in timings.json
  cue-word-missing      no caption word of the line contains the cue word (the cue falls back to the line start)
  cue-word-not-heard    the speech-to-text check's transcript of the line lacks the word
  cue-word-uncertain    the line has interpolated word times (wordsMeasured below its word count), or the
                        waveform shows no clear onset near the word
  cue-word-moved        the sound starts more than --threshold from the recorded word time
The waveform checks need voice/narration.wav (same measurement as word-times.mjs); without it the
rest still run. Writes <reel-dir>/out/cue-check.json. Exit 0 whatever it finds.

--threshold <ms>  moved beyond this offset (default ${Math.round(OFFSET_REPORT_SEC * 1000)})
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const paths = reelPaths(abs(positional[0]));
  let reportSec;
  if (flags.threshold !== undefined) {
    const n = Number(flags.threshold);
    if (!Number.isFinite(n) || n <= 0) return fail(`--threshold takes milliseconds > 0 (got "${flags.threshold}")`);
    reportSec = n / 1000;
  }
  let plan, timings, onsets = null;
  try {
    plan = loadPlan(paths.root);
    timings = loadTimings(paths.root);
    if (fs.existsSync(paths.narrationWav)) {
      const wav = readWav(paths.narrationWav);
      onsets = measureWordOnsets(timings, wav.samples, wav.sampleRate, { reportSec });
    }
  } catch (e) {
    return fail(e.message);
  }
  const cueCount = (plan.lines || []).reduce((n, l) => n + (l.cues || []).filter((c) => typeof c.at === "string" && c.at.startsWith("word:")).length, 0);
  const warnings = checkWordCues(plan, timings, onsets);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "cue-check.json");
  writeJson(outPath, { cueCount, waveformChecked: onsets !== null, warnings });
  process.stdout.write(formatCueWarnings(warnings, cueCount));
  if (!onsets) process.stdout.write("no voice/narration.wav: moved-word checks skipped\n");
  process.stdout.write(`wrote ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
