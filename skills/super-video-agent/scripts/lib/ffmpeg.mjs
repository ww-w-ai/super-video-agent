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

/**
 * `fps` as an exact rational {num, den}: an integer rate (30 -> 30/1) or an
 * NTSC rate (29.97 -> 30000/1001). Throws for anything else, since the
 * frame grid must be exact in integer ticks.
 */
export function fpsRational(fps) {
  for (const den of [1, 1001]) {
    const num = Math.round(fps * den);
    if (num > 0 && Math.abs(num / den - fps) < 1e-6) return { num, den };
  }
  throw new Error(`frame rate ${fps} is neither an integer nor an NTSC (n*1000/1001) rate`);
}

/**
 * The nominal rate behind a probed `fps`: a file whose timestamps drifted
 * can report a rate slightly off (e.g. 29.98 for 30). An exact integer or
 * NTSC rate is kept; otherwise the nearest integer within 0.5 %; otherwise
 * `fps` unchanged.
 */
export function nominalFps(fps) {
  try {
    const { num, den } = fpsRational(fps);
    return num / den;
  } catch {
    const near = Math.round(fps);
    return near > 0 && Math.abs(near - fps) <= fps * 0.005 ? near : fps;
  }
}

/** pts/dts (in stream ticks) of every packet of `filePath`'s first video stream, in decode order, plus the stream time base. */
export async function probeVideoPackets(filePath) {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:packet=pts,dts",
    "-of", "json", filePath,
  ]);
  const j = JSON.parse(stdout.toString());
  const [tn, td] = String(j.streams[0].time_base).split("/").map(Number);
  const packets = (j.packets || []).map((p) => ({ pts: Number(p.pts), dts: Number(p.dts) }));
  return { timeBase: tn / td, packets };
}

/**
 * Plans the re-stamp that puts every packet exactly on the 1/fps grid.
 * Each packet's frame index is its PTS rounded to the grid (from the first
 * frame); the indexes must be 0..n-1 with no gap or repeat, or the stream
 * drifted by half a frame or more and is refused. DTS becomes the decode
 * index minus the stream's reorder delay (B-frames), so DTS <= PTS holds
 * and DTS rises by one frame per packet.
 * @returns {{frames:number, delay:number, minPts:number}}
 */
export function planFrameGrid({ timeBase, packets }, fps) {
  if (!packets.length) throw new Error("the video stream has no packets");
  const minPts = Math.min(...packets.map((p) => p.pts));
  const index = packets.map((p) => Math.round((p.pts - minPts) * timeBase * fps));
  const seen = new Uint8Array(packets.length);
  for (const i of index) {
    if (i < 0 || i >= packets.length || seen[i]) {
      throw new Error(`video timestamps drift by half a frame or more (frame index ${i} of ${packets.length}); cannot snap to the 1/${fps} s grid losslessly`);
    }
    seen[i] = 1;
  }
  let delay = 0;
  index.forEach((frame, n) => (delay = Math.max(delay, n - frame)));
  return { frames: packets.length, delay, minPts };
}

/** The setts bitstream filter for planFrameGrid's re-stamp: PTS rounded to the grid, DTS from the decode index, every duration one frame. */
export function frameGridFilter({ fps, delay, minPts }) {
  const { num, den } = fpsRational(fps);
  const perTick = `(TB*${num}/${den})`; // frames per stream tick
  return (
    `setts=pts=round((PTS-${minPts})*${perTick})/${perTick}` +
    `:dts=(N-${delay})/${perTick}` +
    `:duration=1/${perTick}`
  );
}

/**
 * Re-stamps `src`'s video onto the exact 1/fps grid without re-encoding
 * (-c copy; decoded frames are unchanged) and writes `outPath` with a track
 * timescale of the frame rate's numerator, so one frame is a whole number
 * of ticks. A -c copy concat of separately encoded segments can leave
 * packets a few ticks off the grid and the last frame held long; a later
 * filter (overlay, setpts) then makes one frame more than the picture has.
 * @returns {Promise<{frames:number}>}
 */
export async function snapToFrameGrid(src, outPath, fps) {
  const plan = planFrameGrid(await probeVideoPackets(src), fps);
  const { num } = fpsRational(fps);
  await ffmpeg([
    "-y", "-i", src, "-map", "0:v:0", "-c", "copy",
    "-bsf:v", frameGridFilter({ fps, ...plan }),
    "-video_track_timescale", String(num),
    outPath,
  ]);
  return { frames: plan.frames };
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
