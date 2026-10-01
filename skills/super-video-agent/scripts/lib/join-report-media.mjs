// Media measurements over a finished file, shared by join.mjs (report after
// a join) and review.mjs --file (review of an upload file with no page).
// Each function reads the file with ffmpeg/ffprobe and returns facts; the
// pure helpers (partSpans, parseBlackDetect) are unit-tested without ffmpeg.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, ffmpeg, ffprobe } from "./ffmpeg.mjs";
import { measureLoudness } from "./audio-analysis.mjs";

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

/** Parse ffmpeg blackdetect lines into runs. */
export function parseBlackDetect(stderr) {
  const runs = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    runs.push({ startSec: parseFloat(m[1]), endSec: parseFloat(m[2]), durationSec: parseFloat(m[3]) });
  }
  return runs;
}

/**
 * Black-picture runs via ffmpeg blackdetect (98 % of pixels under the
 * default darkness threshold). blackdetect logs at info level, so this
 * calls `run` directly like measureLoudness does.
 * @param {{minSec?:number}} opts shortest run to report (default one frame at 30 fps)
 */
export async function detectBlackRuns(filePath, { minSec = 1 / 30 } = {}) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    filePath,
    "-an",
    "-vf",
    `blackdetect=d=${minSec.toFixed(4)}:pic_th=0.98`,
    "-f",
    "null",
    "-",
  ]);
  return parseBlackDetect(stderr.toString());
}
