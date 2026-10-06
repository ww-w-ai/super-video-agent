#!/usr/bin/env node
// On-demand upload version: joins an opening + body + ending (or any N
// parts, any order) into one file — see references/bookends.md for when
// to use this. Parts that share codec, size, frame rate and encoder headers
// are joined with the video stream copied; otherwise every part is scaled to
// the first and re-encoded. Reports facts about each join afterward and never
// blocks on them.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { ffmpeg, probeDuration, probeVideoInfo, streamSignature, concatMp4, uniqueTempPath, fpsRational, nominalFps } from "./lib/ffmpeg.mjs";
import { decodeMonoPcm } from "./lib/audio-analysis.mjs";
import { probeStreamDurations, measureSpansLoudness } from "./lib/join-report-media.mjs";
import { buildJoinFilter, buildJoinAudioFilter, joinOffsets, joinTimes } from "./lib/join-ffmpeg.mjs";
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

Joins two or more video parts into one file. Parts with the same codec,
size, pixel format, frame rate and encoder headers keep their video stream
as it is (packet copy, no re-encode; said on stderr); otherwise every part
is scaled to the first part's size and fps, yuv420p, H.264 CRF 18. Audio is
AAC 48kHz stereo 192k with a 10ms edge fade per part at every join, and the
file is +faststart. Never overwrites an input.
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
    cut is simply reported as one); only the two frames at each join are
    decoded for this, not the whole film

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

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await joinVideo({ outPath, partPaths, durationsSec, width, height, fps });

  const offsets = joinOffsets(durationsSec);
  const cuts = joinTimes(durationsSec);
  const totalDurationSec = offsets[offsets.length - 1] + durationsSec[durationsSec.length - 1];

  const parts = await measurePartsLoudness(outPath, offsets, durationsSec, partPaths);
  const spread = loudnessSpread(parts.map((p) => p.integratedLufs));
  const joins = cuts.length > 0 ? await analyzeJoins(outPath, cuts, offsets, durationsSec, fps) : [];

  const report = { outPath, totalDurationSec, parts, loudnessSpread: spread, joins };
  process.stdout.write(formatReport(report, { json: !!flags.json }) + "\n");
}

/**
 * Joins the video by packet copy when the parts allow it, else re-encodes.
 * Either way the reason is said on stderr: a part that is variable-frame-rate
 * or runs at a rate the frame grid cannot hold (concatMp4 refuses it) falls
 * back to the re-encode instead of failing the join.
 */
async function joinVideo({ outPath, partPaths, durationsSec, width, height, fps }) {
  const blocker = await copyBlocker(partPaths);
  if (!blocker) {
    try {
      await joinCopyingVideo({ outPath, partPaths, durationsSec, fps });
      process.stderr.write("video: stream copy, no re-encode (the parts share codec, size, frame rate and encoder headers)\n");
      return;
    } catch (e) {
      fs.rmSync(outPath, { force: true });
      process.stderr.write(`video: stream copy not possible (${firstLine(e.message)}); re-encoding every part to the first part's size and frame rate\n`);
    }
  } else {
    process.stderr.write(`video: re-encoded to the first part's size and frame rate (${blocker})\n`);
  }
  await joinReencoding({ outPath, partPaths, durationsSec, width, height, fps });
}

const firstLine = (text) => String(text).split("\n")[0];

/** Why the video cannot be joined by packet copy, or null when every part has the first part's codec, size, pixel format, encoder headers and a frame rate the frame grid holds. */
export async function copyBlocker(partPaths) {
  const [first, ...rest] = partPaths;
  const firstInfo = await probeVideoInfo(first);
  try {
    fpsRational(nominalFps(firstInfo.fps));
  } catch {
    return `${path.basename(first)} runs at ${firstInfo.fps} fps, not an integer or NTSC rate`;
  }
  const firstSig = await streamSignature(first);
  for (const p of rest) {
    const info = await probeVideoInfo(p);
    if (Math.abs(info.fps - firstInfo.fps) > 1e-3) return `${path.basename(p)} runs at ${info.fps} fps, the first part at ${firstInfo.fps}`;
    if ((await streamSignature(p)) !== firstSig) return `${path.basename(p)} differs from the first part in codec, size, pixel format or encoder headers`;
  }
  return null;
}

/** Video by packet copy (no decode), audio cut/padded/faded per part and encoded as AAC, muxed with +faststart. */
async function joinCopyingVideo({ outPath, partPaths, durationsSec, fps }) {
  const videoPath = uniqueTempPath(`${outPath}.video.mp4`);
  const videoOnly = [];
  try {
    // A part's audio may run past its last frame (encoder padding); the concat demuxer would then place the next part late. Each part's video stream alone is copied out first.
    for (const p of partPaths) {
      const tmp = uniqueTempPath(`${outPath}.part.mp4`);
      videoOnly.push(tmp);
      await ffmpeg(["-y", "-i", p, "-map", "0:v:0", "-c", "copy", "-an", tmp]);
    }
    await concatMp4(videoOnly, videoPath, fps);
    await ffmpeg([
      "-y", "-i", videoPath, ...partPaths.flatMap((p) => ["-i", p]),
      "-filter_complex", buildJoinAudioFilter({ count: partPaths.length, durationsSec, inputOffset: 1 }),
      "-map", "0:v", "-map", "[a]", "-c:v", "copy",
      ...AUDIO_ARGS, "-movflags", "+faststart", outPath,
    ]);
  } finally {
    for (const f of [videoPath, ...videoOnly]) fs.rmSync(f, { force: true });
  }
}

/** Parts that differ in codec, size, frame rate or headers: everything is scaled to the first part and re-encoded (H.264 CRF 18). */
async function joinReencoding({ outPath, partPaths, durationsSec, width, height, fps }) {
  const filterComplex = buildJoinFilter({ count: partPaths.length, width, height, fps, durationsSec });
  await ffmpeg([
    "-y", ...partPaths.flatMap((p) => ["-i", p]),
    "-filter_complex", filterComplex,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    ...AUDIO_ARGS, "-movflags", "+faststart", outPath,
  ]);
}

const AUDIO_ARGS = ["-c:a", "aac", "-ar", String(SAMPLE_RATE), "-ac", "2", "-b:a", "192k"];

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

    const seam = await seamFrames(outPath, Math.round(joinTimeSec * fps), fps);
    const meanPixelDiff = seam ? meanAbsDiff(seam.before, seam.after) : null;

    joins.push({ index: i, atSec: joinTimeSec, betweenParts: [i, i + 1], click, meanPixelDiff });
  }
  return joins;
}

const SEAM_WIDTH = 64;

/** The greyscale frames just before and after a join (frame `joinFrame - 1` and `joinFrame`), 64 px wide: only the seam is decoded, not the film. Null when either is missing. */
async function seamFrames(outPath, joinFrame, fps) {
  if (joinFrame < 1) return null;
  const { width, height } = await probeVideoInfo(outPath);
  const w = Math.min(SEAM_WIDTH, width);
  const h = Math.max(2, Math.round((w * height) / width / 2) * 2);
  const { stdout } = await ffmpeg([
    "-ss", String(Math.max(0, (joinFrame - 1) / fps - 0.25 / fps)), "-i", outPath, "-an", "-frames:v", "2",
    "-vf", `scale=${w}:${h}:flags=neighbor,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ]);
  const size = w * h;
  return stdout.length >= 2 * size ? { before: stdout.subarray(0, size), after: stdout.subarray(size, 2 * size) } : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
