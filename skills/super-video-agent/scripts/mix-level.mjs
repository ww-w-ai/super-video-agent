#!/usr/bin/env node
// Measures the page's own sound against a narration line and reports the dB offset to apply.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson } from "./lib/reeldir.mjs";
import { measureLoudness } from "./lib/audio-analysis.mjs";
import { mixOffset, medianLufs, formatMixLevel } from "./lib/mix-level.mjs";

const HELP = `usage: mix-level.mjs <reel-dir> [--under <dB>] [--bed <wav>] [--line <id> | --voice-lufs <n>] [--out <json>]

Measures how loud the page's own sound sits against narration, for a film with little or no narration (the page's
mix then sets the film's loudness). Reads
  the page's sound alone   out/picture.bed.wav (page renderSfx + library cues, no narration), or --bed <wav>
                           (render.mjs --no-captions makes it)
  the voice reference      the integrated loudness of voice/line-<id>.wav (--line <id>), by default the median of
                           all lines; or --voice-lufs <n> when no line exists
Prints the page's integrated loudness, the reference, the gap between them and the page's true peak. With
--under <dB> it also prints the offset to add to the page's level (a master gain in the page's audio code, or the
gain of its cues) to sit that many dB under the voice, and the true peak after it (flagged over -1 dBTP).
Without --under no offset is computed: the gap you want is your decision. Writes <reel-dir>/out/mix-level.json
(or --out). Exit 0 whatever it finds; a missing bed or reference stops with the file it needs.
`;

function lineWavs(voiceDir) {
  if (!fs.existsSync(voiceDir)) return [];
  return fs.readdirSync(voiceDir).filter((n) => /^line-.+\.wav$/.test(n) && !/\.old-|\.pre/.test(n)).sort();
}

async function voiceReference(paths, flags) {
  if (flags["voice-lufs"] !== undefined) {
    const n = Number(flags["voice-lufs"]);
    if (!Number.isFinite(n)) throw new Error(`--voice-lufs takes a number in LUFS (got "${flags["voice-lufs"]}")`);
    return { lufs: n, reference: "the given voice level" };
  }
  if (typeof flags.line === "string") {
    const file = path.join(paths.voiceDir, `line-${flags.line}.wav`);
    if (!fs.existsSync(file)) throw new Error(`no ${file}: make the line first (voice.mjs), or give --voice-lufs <n>`);
    return { lufs: (await measureLoudness(file)).integratedLufs, reference: `line ${flags.line}` };
  }
  const names = lineWavs(paths.voiceDir);
  if (!names.length) throw new Error(`no voice/line-<id>.wav in ${paths.voiceDir}: make a narration line first (voice.mjs), or give --voice-lufs <n>`);
  const all = [];
  for (const n of names) all.push((await measureLoudness(path.join(paths.voiceDir, n))).integratedLufs);
  return { lufs: medianLufs(all), reference: `the median of ${names.length} voice line${names.length === 1 ? "" : "s"}` };
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const paths = reelPaths(abs(positional[0]));
  try {
    const underDb = flags.under === undefined ? null : Number(flags.under);
    if (underDb !== null && !Number.isFinite(underDb)) throw new Error(`--under takes dB (got "${flags.under}")`);
    const bedPath = typeof flags.bed === "string" ? abs(flags.bed) : path.join(paths.outDir, "picture.bed.wav");
    if (!fs.existsSync(bedPath)) throw new Error(`no page sound at ${bedPath}: render the picture first (render.mjs <dir> --no-captions), or pass --bed <wav>`);
    const ref = await voiceReference(paths, flags);
    if (!Number.isFinite(ref.lufs)) throw new Error("the voice reference has no measurable loudness");
    const report = mixOffset(await measureLoudness(bedPath), ref.lufs, { underDb });
    process.stdout.write(formatMixLevel(report, { reference: ref.reference }));
    const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "mix-level.json");
    writeJson(outPath, { bed: bedPath, reference: ref.reference, ...report });
    process.stdout.write(`wrote ${outPath}\n`);
  } catch (e) {
    return fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
