#!/usr/bin/env node
// On-demand upload version: joins an opening + body + ending (or any N
// parts, any order) into one file — see references/bookends.md for when
// to use this. Re-encodes (parts can differ in codec/settings going in);
// reports facts about each join afterward and never blocks on them.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { ffmpeg, probeDuration, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { decodeMonoPcm } from "./lib/audio-analysis.mjs";
import { probeStreamDurations, measureSpansLoudness } from "./lib/join-report-media.mjs";
import { extractGrayFrames } from "./lib/frame-diff.mjs";
import { buildJoinFilter, joinOffsets, joinTimes } from "./lib/join-ffmpeg.mjs";
import {
  loudnessSpread,
  joinWindowIndices,
  maxStepInRange,
  typicalMaxStep,
  analyzeJoinClick,
  meanAbsDiff,
  formatReport,
} from "./lib/join-report.mjs";

const HELP = `usage: join.mjs <out.mp4> <part1> <part2> [...] [--json]

Joins two or more video parts into one file: scaled to the first part's
size and fps, yuv420p, H.264 CRF 18, AAC 48kHz stereo 192k, a 10ms audio
edge fade per part at every join, +faststart. Never overwrites an input.
Each part's audio is cut (or padded with silence) to that part's video
length before the join, so encoder padding past the last frame never holds
a frame or shifts a later part's sound.

After joining, reports facts about each join — it never blocks on them:
  - each part's own integrated loudness inside the joined file, and the
    spread across parts (flags over 1 LU)
  - the largest sample-to-sample audio jump within +/-20ms of the join,
    against the parts' own typical maximum (a click check)
  - the mean pixel difference between the last frame before and the
    first frame after the join (confirms a match cut; an intended hard
    cut is simply reported as one)

--json prints the report as JSON instead of text.
`;

const CLICK_WINDOW_MS = 20;
const SAMPLE_RATE = 48000;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length < 3) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const outPath = abs(positional[0]);
  const partPaths = positional.slice(1).map(abs);

  for (const p of partPaths) {
    if (!fs.existsSync(p)) return fail(`no such file: ${p}`);
  }
  if (partPaths.includes(outPath)) {
    return fail("out path must not be one of the parts — never overwrite an input");
  }

  try {
    await run(outPath, partPaths, flags);
  } catch (e) {
    fail(e.message);
  }
}

async function run(outPath, partPaths, flags) {
  const durationsSec = [];
  for (const p of partPaths) durationsSec.push(await partVideoSec(p));
  const { width, height, fps } = await probeVideoInfo(partPaths[0]);

  const filterComplex = buildJoinFilter({ count: partPaths.length, width, height, fps, durationsSec });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await ffmpeg([
    "-y",
    ...partPaths.flatMap((p) => ["-i", p]),
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outPath,
  ]);

  const offsets = joinOffsets(durationsSec);
  const cuts = joinTimes(durationsSec);
  const totalDurationSec = offsets[offsets.length - 1] + durationsSec[durationsSec.length - 1];

  const parts = await measurePartsLoudness(outPath, offsets, durationsSec, partPaths);
  const spread = loudnessSpread(parts.map((p) => p.integratedLufs));
  const joins = cuts.length > 0 ? await analyzeJoins(outPath, cuts, offsets, durationsSec, fps) : [];

  const report = { outPath, totalDurationSec, parts, loudnessSpread: spread, joins };
  process.stdout.write(formatReport(report, { json: !!flags.json }) + "\n");
}

/** A part's length is its video stream's length — the audio is cut or padded to it (buildJoinFilter). */
async function partVideoSec(partPath) {
  const { videoSec } = await probeStreamDurations(partPath);
  return videoSec != null ? videoSec : probeDuration(partPath);
}

/** Each part's own integrated loudness measured inside the joined file
 * (not the source file), so the number reflects what actually shipped. */
async function measurePartsLoudness(outPath, offsets, durationsSec, partPaths) {
  const spans = offsets.map((startSec, i) => ({ startSec, durationSec: durationsSec[i] }));
  const measured = await measureSpansLoudness(outPath, spans);
  return measured.map(({ integratedLufs, truePeakDb }, i) => ({
    index: i,
    source: partPaths[i],
    durationSec: durationsSec[i],
    integratedLufs,
    truePeakDb,
  }));
}

/** The click check (sample-jump vs. each part's own typical maximum) and
 * the frame-match check (mean pixel diff across the cut), for every join. */
async function analyzeJoins(outPath, cuts, offsets, durationsSec, fps) {
  const pcm = await decodeMonoPcm(outPath, SAMPLE_RATE);
  const rangeStarts = offsets.map((s) => Math.round(s * SAMPLE_RATE));
  const rangeEnds = offsets.map((s, i) => Math.round((s + durationsSec[i]) * SAMPLE_RATE));
  const marginSamples = Math.round((CLICK_WINDOW_MS / 1000) * SAMPLE_RATE) * 2;
  const { frames } = await extractGrayFrames(outPath, fps, { width: 64 });

  const joins = [];
  for (let i = 0; i < cuts.length; i++) {
    const joinTimeSec = cuts[i];
    const { start, end } = joinWindowIndices(SAMPLE_RATE, joinTimeSec, CLICK_WINDOW_MS);
    const windowMaxStep = maxStepInRange(pcm, start, end);
    const leftTypical = typicalMaxStep(pcm, rangeStarts[i], rangeEnds[i], marginSamples);
    const rightTypical = typicalMaxStep(pcm, rangeStarts[i + 1], rangeEnds[i + 1], marginSamples);
    const click = analyzeJoinClick({
      joinTimeSec,
      windowMaxStep,
      partTypicalMaxStep: Math.max(leftTypical, rightTypical),
    });

    const frameIdx = Math.round(joinTimeSec * fps);
    const before = frames[Math.max(0, frameIdx - 1)];
    const after = frames[Math.min(frames.length - 1, frameIdx)];
    const meanPixelDiff = before && after ? meanAbsDiff(before, after) : null;

    joins.push({ index: i, atSec: joinTimeSec, betweenParts: [i, i + 1], click, meanPixelDiff });
  }
  return joins;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
