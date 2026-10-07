#!/usr/bin/env node
// The film clock of a film with no narration (references/assembly.md "A film with no narration").
import path from "node:path";
import fs from "node:fs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, readJson } from "./lib/reeldir.mjs";
import { buildClock, realVoiceIn, writeSilentWav } from "./lib/silent-clock.mjs";

const HELP = `usage: silent-clock.mjs <reel-dir> --timeline <timeline.json> [--fps <n>] [--force]

Writes the clock of a film that has no narration, from a timeline you generated:
  voice/timings.json   one silent line per timeline item (text "", words []) with the item's exact start and end
  voice/narration.wav  silence of exactly the film's length (48 kHz, mono, 16-bit)
render.mjs then makes out/final.mp4, and --span and --assemble work (they refuse the --stub clock).

The timeline is {duration?, steps|stages|scenes|lines|shots: [{id, start, end}]} in seconds, in film order.
Each item owns its frames from its start to the next item's start. duration defaults to the last end.
Stops, writing nothing, when an id repeats, an item is not a span, items overlap or run out of order, an item ends
after the duration, or voice/timings.json holds real text or words (add --force to replace a real voice).
Gaps between items, a first item that does not start at 0, a tail past the last item and edges off the frame grid
(with --fps) are printed as facts.
--fps <n>   report edges that are not on the frame grid
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1 || typeof flags.timeline !== "string") return printHelpAndExit(HELP, 1);
  try {
    const paths = reelPaths(abs(positional[0]));
    if (!fs.existsSync(paths.root)) throw new Error(`reel folder not found: ${paths.root}`);
    const fps = flags.fps === undefined ? undefined : Number(flags.fps);
    if (fps !== undefined && !(fps > 0)) throw new Error(`--fps takes a positive number (got "${flags.fps}")`);
    const { timings, facts } = buildClock(readJson(abs(flags.timeline)), { fps });
    if (realVoiceIn(paths.timingsJson) && !flags.force) {
      throw new Error(`${paths.timingsJson} holds real narration text or words; the silent clock would replace it (add --force to do that)`);
    }
    writeJson(paths.timingsJson, timings);
    const frames = writeSilentWav(paths.narrationWav, timings.duration);
    process.stdout.write(`${timings.lines.length} silent lines, ${timings.duration.toFixed(3)} s -> ${paths.timingsJson}\n`);
    process.stdout.write(`silent ${path.relative(paths.root, paths.narrationWav)}: ${frames} samples (${(frames / 48000).toFixed(3)} s)\n`);
    for (const f of facts) process.stdout.write(`fact: ${f}\n`);
  } catch (e) {
    return fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
