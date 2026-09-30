// ffmpeg/ffprobe spawn helpers shared by voice.mjs, render.mjs, review.mjs.
import { spawn } from "node:child_process";

/**
 * Run ffmpeg (or ffprobe) with `args`, resolving with {stdout, stderr}
 * on exit code 0, rejecting with an Error carrying the captured stderr
 * otherwise.
 */
export function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
    // Collect chunks and join once on close: re-concatenating per chunk is
    // O(n^2) and takes minutes on raw frame dumps of several hundred MB.
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (d) => {
      chunks.push(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) =>
      reject(new Error(`${bin} failed to start: ${e.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr, child });
      else
        reject(
          new Error(`${bin} exited ${code}\nargs: ${args.join(" ")}\n${stderr}`)
        );
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    if (opts.pipeStdin) {
      opts.pipeStdin(child.stdin);
    }
  });
}

export function ffmpeg(args, opts) {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], opts);
}

export function ffprobe(args, opts) {
  return run("ffprobe", args, opts);
}

/** Duration in seconds of a media file, via ffprobe. */
export async function probeDuration(filePath) {
  const { stdout } = await ffprobe(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    {}
  );
  const val = parseFloat(stdout.toString().trim());
  if (!Number.isFinite(val)) {
    throw new Error(`ffprobe returned no duration for ${filePath}`);
  }
  return val;
}

/** Decoded video frame count of `filePath`'s first video stream, via ffprobe -count_frames. */
export async function probeFrameCount(filePath) {
  const { stdout } = await ffprobe(
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    {}
  );
  const val = parseInt(stdout.toString().trim(), 10);
  if (!Number.isFinite(val)) {
    throw new Error(`ffprobe returned no frame count for ${filePath}`);
  }
  return val;
}

/** Pixel dimensions and frame rate of `filePath`'s first video stream, via ffprobe. Used by dub.mjs to size the caption layer to the picture without re-opening reel.html. */
export async function probeVideoInfo(filePath) {
  const { stdout } = await ffprobe(
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-of",
      "csv=s=x:p=0",
      filePath,
    ],
    {}
  );
  const [w, h, rate] = stdout.toString().trim().split("x");
  const [num, den] = String(rate).split("/").map(Number);
  const fps = den ? num / den : Number(rate);
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(fps)) {
    throw new Error(`ffprobe returned no usable video stream info for ${filePath}`);
  }
  return { width, height, fps };
}

const ATEMPO_MIN = 0.8;
const ATEMPO_MAX = 1.3;

/** Clamp a requested speech rate to ffmpeg atempo's sane, artifact-free range. */
export function clampAtempoRate(rate, min = ATEMPO_MIN, max = ATEMPO_MAX) {
  return Math.min(max, Math.max(min, rate));
}

/**
 * Re-encode `inPath` at `rate`x speed via ffmpeg's atempo filter, writing
 * `outPath`. Clamped to [0.8, 1.3] (plan.json meta.voice.rate) unless the
 * caller passes a wider range (a line's own `rate`).
 */
export async function applyAtempo(inPath, outPath, rate, range = {}) {
  const clamped = clampAtempoRate(rate, range.min, range.max);
  await ffmpeg([
    "-y",
    "-i",
    inPath,
    "-filter:a",
    `atempo=${clamped}`,
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

/**
 * Spawn a long-lived ffmpeg process that reads PNG frames from stdin
 * (image2pipe) and encodes H.264. Caller writes frames then ends stdin.
 * Returns {proc, done} where done resolves when the process exits 0.
 */
export function spawnImagePipeEncoder({ fps, outPath, crf = 18, preset = "medium", scaleFilter }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(fps),
    "-i",
    "-",
  ];
  if (scaleFilter) args.push("-vf", scaleFilter);
  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    String(crf),
    "-preset",
    preset,
    outPath
  );
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const done = new Promise((resolve, reject) => {
    proc.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg image2pipe exited ${code}\n${stderr}`));
    });
  });
  return { proc, done };
}
