#!/usr/bin/env node
// Re-measures word start times from the narration waveform and reports the words whose recorded
// time is off. Facts only: it never edits timings.json and always exits 0 on a readable reel.
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, loadTimings, writeJson } from "./lib/reeldir.mjs";
import { readWav } from "./lib/wav-read.mjs";
import { measureWordOnsets, formatWordOnsets, OFFSET_REPORT_SEC, ONSET_WINDOW_SEC } from "./lib/word-onsets.mjs";

const HELP = `usage: word-times.mjs <reel-dir> [--threshold <ms>] [--window <ms>] [--lines <id,id,...>] [--out <json>]

For each word in <reel-dir>/voice/timings.json, finds the steepest rise in loudness (10 ms RMS)
within --window of the recorded start in voice/narration.wav (never past halfway to the next
word) and compares it with the recorded start. Prints every word whose sound starts more than
--threshold from its recorded time, and every word with no clear onset (a vowel run-on, silence).
Lines with wordsMeasured below their word count have interpolated words; they are tagged.
Writes <reel-dir>/out/word-times.json (every word, with offset and status). Exit 0 whatever it finds.

--threshold <ms>  report beyond this offset (default ${Math.round(OFFSET_REPORT_SEC * 1000)})
--window <ms>     search this far either side (default ${Math.round(ONSET_WINDOW_SEC * 1000)})
--lines <ids>     only these line ids
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const paths = reelPaths(abs(positional[0]));
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`--${name} takes milliseconds > 0 (got "${v}")`);
    return n / 1000;
  };
  const reportSec = num(flags.threshold, "threshold");
  const windowSec = num(flags.window, "window");
  const lineIds = typeof flags.lines === "string" ? flags.lines.split(",").filter(Boolean) : undefined;
  let report;
  try {
    const timings = loadTimings(paths.root);
    const wav = readWav(paths.narrationWav);
    report = measureWordOnsets(timings, wav.samples, wav.sampleRate, { reportSec, windowSec, lineIds });
  } catch (e) {
    return fail(e.message);
  }
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "word-times.json");
  writeJson(outPath, report);
  process.stdout.write(formatWordOnsets(report));
  process.stdout.write(`wrote ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
