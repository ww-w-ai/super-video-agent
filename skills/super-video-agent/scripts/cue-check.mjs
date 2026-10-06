#!/usr/bin/env node
// Warns about sound-effect cues keyed to a word (`at: "word:<text>"`) whose word is missing,
// not heard, interpolated, or moved. Warnings only: exit 0 whatever it finds.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, loadPlan, loadTimings, writeJson } from "./lib/reeldir.mjs";
import { readWav } from "./lib/wav-read.mjs";
import { measureWordOnsets, OFFSET_REPORT_SEC } from "./lib/word-onsets.mjs";
import { checkWordCues, formatCueWarnings, checkPageMarks, formatPageCues } from "./lib/cue-check.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel } from "./lib/browser.mjs";

const HELP = `usage: cue-check.mjs <reel-dir> [--threshold <ms>] [--out <json>] [--page | --marks <json>]

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
--page            also read the sound events the page itself makes (window.__reel.marks, {at, kind}; opens the
                  reel in the browser). Each is reported as a fact: the line it lands in, the nearest recorded
                  word and the offset. A mark that carries a "word" (and optionally a "line") is checked like a
                  word cue: page-cue-moved beyond --threshold, page-cue-word-missing when the line has no such
                  word; page-cue-outside-timeline when the time is outside 0..duration.
--marks <json>    the same check on a marks file (a JSON array, or {"marks": [...]}) instead of opening the page
`;

export async function main(argv) {
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
  let marks = null;
  try {
    marks = await readMarks(flags, paths.root);
  } catch (e) {
    return fail(e.message);
  }
  const cueCount = (plan.lines || []).reduce((n, l) => n + (l.cues || []).filter((c) => typeof c.at === "string" && c.at.startsWith("word:")).length, 0);
  const warnings = checkWordCues(plan, timings, onsets);
  const page = marks ? checkPageMarks(marks, timings, { thresholdSec: reportSec ?? OFFSET_REPORT_SEC }) : null;
  const pageCount = page ? page.cues.length : 0;
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "cue-check.json");
  writeJson(outPath, {
    cueCount, pageCueCount: pageCount, checkedNothing: cueCount === 0 && pageCount === 0,
    waveformChecked: onsets !== null, warnings, pageCues: page ? page.cues : [], pageWarnings: page ? page.warnings : [],
  });
  if (cueCount > 0 || pageCount === 0) process.stdout.write(formatCueWarnings(warnings, cueCount));
  if (page) process.stdout.write(formatPageCues(page));
  if (!onsets && cueCount > 0) process.stdout.write("no voice/narration.wav: moved-word checks skipped\n");
  process.stdout.write(`wrote ${outPath}\n`);
}

/** Page-made sound events: from --marks <json>, or from window.__reel.marks when --page is set; null when neither. */
async function readMarks(flags, root) {
  if (typeof flags.marks === "string") {
    const j = JSON.parse(fs.readFileSync(abs(flags.marks), "utf8"));
    return Array.isArray(j) ? j : j.marks || [];
  }
  if (!flags.page) return null;
  const server = await serveDir(root);
  let session;
  try {
    session = await openReel(server.url, {});
    return await session.page.evaluate(() => (window.__reel && window.__reel.marks) || []);
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
