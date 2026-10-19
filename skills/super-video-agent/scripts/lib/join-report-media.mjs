// Media measurements over a finished file, shared by join.mjs (report after
// a join) and review.mjs --file (review of an upload file with no page).
// Each function reads the file with ffmpeg/ffprobe and returns facts; the
// pure helpers (partSpans, isBlackFrame, createBlackRuns) are unit-tested without ffmpeg.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe } from "./ffmpeg.mjs";
import { measureLoudness } from "./audio-analysis.mjs";
import { streamGrayFrames } from "./frame-diff.mjs";
import { createFreezeStream } from "./freeze-scan.mjs";
import { filmFrameCount } from "./frame-count.mjs";

const SAMPLE_RATE = 48000;

/**
 * Length in seconds of the first video and first audio stream (not the
 * container), so an audio track that runs past the last frame shows up.
 * @returns {Promise<{videoSec:number|null, audioSec:number|null}>}
 */
export async function probeStreamDurations(filePath) {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,duration",
    "-of",
    "json",
    filePath,
  ]);
  const streams = JSON.parse(stdout.toString()).streams || [];
  const first = (type) => {
    const s = streams.find((x) => x.codec_type === type);
    const v = s ? parseFloat(s.duration) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  return { videoSec: first("video"), audioSec: first("audio") };
}

/**
 * Spans [start, end) of each part from its cut times.
 * @param {number[]} cutsSec part boundaries inside the file, ascending
 * @param {number} totalSec file length
 * @returns {{index:number, startSec:number, durationSec:number}[]}
 */
export function partSpans(cutsSec, totalSec) {
  const edges = [0, ...cutsSec.filter((c) => c > 0 && c < totalSec), totalSec];
  const spans = [];
  for (let i = 0; i < edges.length - 1; i++) {
    spans.push({ index: i, startSec: edges[i], durationSec: edges[i + 1] - edges[i] });
  }
  return spans;
}

/**
 * Integrated loudness and true peak of each span of `filePath`, measured
 * on a PCM extract of that span (what actually shipped, not the source).
 * @param {{startSec:number, durationSec:number}[]} spans
 * @returns {Promise<{integratedLufs:number|null, truePeakDb:number|null}[]>}
 */
export async function measureSpansLoudness(filePath, spans) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-span-"));
  try {
    const results = [];
    for (let i = 0; i < spans.length; i++) {
      const tmpWav = path.join(tmpDir, `span-${i}.wav`);
      await ffmpeg([
        "-ss",
        String(spans[i].startSec),
        "-t",
        String(spans[i].durationSec),
        "-i",
        filePath,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "2",
        tmpWav,
      ]);
      results.push(await measureLoudness(tmpWav));
    }
    return results;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Grey value at or under which a pixel is black: ffmpeg blackdetect's default pix_th (0.10) of the full 0-255 range the grey decode delivers. */
export const BLACK_PIXEL_MAX = 25;
/** Share of black pixels that makes a black picture (blackdetect pic_th=0.98). */
export const BLACK_PICTURE_SHARE = 0.98;

/** True when at least BLACK_PICTURE_SHARE of the grey frame's pixels are at or under BLACK_PIXEL_MAX. */
export function isBlackFrame(frame) {
  let black = 0;
  for (let i = 0; i < frame.length; i++) if (frame[i] <= BLACK_PIXEL_MAX) black++;
  return frame.length > 0 && black / frame.length >= BLACK_PICTURE_SHARE;
}

/**
 * Black runs from per-frame flags pushed in order, reported as blackdetect
 * did: start, end (the first frame after the run), duration, when the run
 * lasts at least `minSec`.
 * @returns {{push:(black:boolean)=>void, finish:()=>{startSec:number,endSec:number,durationSec:number}[]}}
 */
export function createBlackRuns(fps, minSec = 1 / fps) {
  const runs = [];
  let start = -1;
  let index = -1;
  const close = (end) => {
    if (start >= 0 && (end - start) / fps >= minSec - 1e-9) runs.push({ startSec: start / fps, endSec: end / fps, durationSec: (end - start) / fps });
    start = -1;
  };
  return {
    push(black) {
      index++;
      if (!black) close(index);
      else if (start < 0) start = index;
    },
    finish() {
      close(index + 1);
      return runs;
    },
  };
}

/**
 * Picture facts of a finished file from ONE decode at 320-px grey, every
 * frame streamed through three checks: freezes (the shared method in
 * freeze-scan.mjs), black runs, and frame count vs expected with identical
 * neighbouring frames. Holds the freeze look-back ring, not the film.
 * @param {string} file
 * @param {{width:number, height:number, fps:number, expectedSec?:number|null, spawnFn?:Function}} opts
 *   width/height/fps = the video stream's own; expectedSec = video stream length; spawnFn injectable to count decodes
 */
export async function scanFilePicture(file, { width, height, fps, expectedSec = null, spawnFn }) {
  const freeze = createFreezeStream({ fps });
  const black = createBlackRuns(fps);
  let prev = null;
  let identicalNeighbours = 0;
  const onFrame = (frame) => {
    freeze.push(frame);
    black.push(isBlackFrame(frame));
    if (prev && prev.equals(frame)) identicalNeighbours++;
    prev = frame;
  };
  const { frames } = await streamGrayFrames(file, { width, height, onFrame, spawnFn });
  const scan = freeze.finish();
  const expected = expectedSec == null ? null : filmFrameCount(expectedSec, fps);
  return {
    freezeRuns: scan.runs,
    recheckSpans: scan.recheckSpans,
    sampleCount: scan.sampleCount,
    blackRuns: black.finish(),
    frames: { decoded: frames, expected, decodedMinusExpected: expected == null ? null : frames - expected, identicalNeighbours },
  };
}

