// ffmpeg/ffprobe spawn helpers shared by voice.mjs, render.mjs, review.mjs.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isTransientDecodeError, withRetry } from "./retry.mjs";

const DECODE_RETRIES = 2;

/**
 * Run ffmpeg (or ffprobe) with `args`, resolving with {stdout, stderr}
 * on exit code 0, rejecting with an Error carrying the captured stderr
 * otherwise. A decode-only run (isDecodeOnly) that fails with the transient
 * EBADF signature (isTransientDecodeError) is run again, up to 2 more times;
 * the last attempt's error is the one thrown. A run that writes a file or
 * streams its own stdin is never re-run.
 */
export function run(bin, args, opts = {}) {
  if (!isDecodeOnly(args, opts)) return runOnce(bin, args, opts);
  return withRetry(() => runOnce(bin, args, opts), {
    isRetryable: isTransientDecodeError,
    maxRetries: DECODE_RETRIES,
    onRetry: (k) => process.stderr.write(`${bin}: transient decode error (Bad file descriptor), retrying (${k}/${DECODE_RETRIES})\n`),
  });
}

/** Output to stdout (last arg `-` or `pipe:…`) and no caller-fed stdin stream: nothing on disk changes, so a rerun is safe. */
function isDecodeOnly(args, opts) {
  if (opts.pipeStdin) return false;
  const last = String(args[args.length - 1] ?? "");
  return last === "-" || last.startsWith("pipe:");
}

function runOnce(bin, args, opts) {
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
 * of ticks (or `timescale` ticks per second, a whole number of ticks per
 * frame, to keep a stream's time base). A -c copy concat of separately encoded
 * segments can leave packets a few ticks off the grid and the last frame held
 * long; a later filter (overlay, setpts) then makes one frame more than the
 * picture has.
 * @returns {Promise<{frames:number}>}
 */
export async function snapToFrameGrid(src, outPath, fps, timescale = null) {
  const plan = planFrameGrid(await probeVideoPackets(src), fps);
  const { num } = fpsRational(fps);
  await ffmpeg([
    "-y", "-i", src, "-map", "0:v:0", "-c", "copy",
    "-bsf:v", frameGridFilter({ fps, ...plan }),
    "-video_track_timescale", String(timescale || num),
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


// ---- video encoder choice (SVA_VENC) -----------------------------------------
//
// Every video encode goes through videoEncodeArgs. SVA_VENC picks the encoder:
// auto (default) = HEVC hardware, else H.264 hardware, else libx264;
// hw = the same hardware order or a loud failure; hevc / h264 = only that
// hardware codec or a loud failure; sw = libx264 with the call site's crf/preset.
// Hardware settings keep files near libx264's size (measured on a 1080p scene:
// libx264 crf 18 3.72 MB; hevc_videotoolbox 4 Mb/s 3.68 MB; h264_videotoolbox
// -q:v 77 4.03 MB, while -q:v 78 already passes 1.3x libx264).

export const VENC_MODES = ["auto", "hw", "hevc", "h264", "sw"];
export const SW_ENCODER = "libx264";
const HW_CANDIDATES = {
  hevc: { darwin: ["hevc_videotoolbox"], other: ["hevc_nvenc", "hevc_qsv"] },
  h264: { darwin: ["h264_videotoolbox"], other: ["h264_nvenc", "h264_qsv"] },
};
const KNOWN_ENCODERS = new Set([SW_ENCODER, ...Object.values(HW_CANDIDATES).flatMap((c) => [...c.darwin, ...c.other])]);
// Bitrate-mode targets at 1920x1080, scaled by pixel count. H.264 outside
// VideoToolbox (unmeasured) gets 1.3x libx264's measured 2.5 Mb/s.
const HW_BITRATE_1080P = { hevc: 4_000_000, h264: 3_200_000 };
const HW_BITRATE_MIN = 250_000;
const VT_H264_QUALITY = 77;
const PROBE_TIMEOUT_MS = 20_000;

const codecOf = (name) => (name.startsWith("hevc_") ? "hevc" : "h264");

/** The hardware candidates SVA_VENC=`mode` tries on `platform`, in order: HEVC then H.264 for auto and hw. */
export function hardwareCandidates(mode = "auto", platform = process.platform) {
  const codecs = mode === "hevc" || mode === "h264" ? [mode] : ["hevc", "h264"];
  return codecs.flatMap((c) => (platform === "darwin" ? HW_CANDIDATES[c].darwin : HW_CANDIDATES[c].other));
}

/** Bitrate-mode target for `encoder` at width x height: HEVC 4 Mb/s at 1080p (2160p 16, 720p ~1.8), H.264 3.2 Mb/s. */
export function hwBitrate(width, height, encoder = "hevc_videotoolbox") {
  if (!(width > 0 && height > 0)) throw new Error(`a hardware encode needs the output size, got ${width}x${height}`);
  const bps = (HW_BITRATE_1080P[codecOf(encoder)] * width * height) / (1920 * 1080);
  return Math.max(HW_BITRATE_MIN, Math.round(bps / 1000) * 1000);
}

function hardwareArgs(name, width, height) {
  const pixFmt = name.endsWith("_qsv") ? "nv12" : "yuv420p";
  // h264_videotoolbox in bitrate mode needs far more bits than x264 for the same picture; constant quality keeps the size near x264.
  if (name === "h264_videotoolbox") return ["-c:v", name, "-q:v", String(VT_H264_QUALITY), "-allow_sw", "0", "-profile:v", "high", "-pix_fmt", pixFmt];
  const rate = ["-b:v", String(hwBitrate(width, height, name))];
  if (codecOf(name) === "hevc") return ["-c:v", name, ...rate, ...(name.endsWith("_videotoolbox") ? ["-allow_sw", "0"] : []), "-tag:v", "hvc1", "-pix_fmt", pixFmt];
  return ["-c:v", name, ...rate, "-profile:v", "high", "-pix_fmt", pixFmt];
}

/**
 * Output args for one video encode. libx264: `-crf`/`-preset` exactly as the
 * call site asks (each left out when the site passes none). Hardware: HEVC at
 * the bitrate for width x height tagged hvc1; h264_videotoolbox at constant
 * quality 77; other H.264 hardware at its bitrate; VideoToolbox never falls back
 * to its software path (-allow_sw 0).
 * @param {{crf?: number, preset?: string, width?: number, height?: number, encoder?: string}} opts encoder defaults to chooseVideoEncoder().name
 */
export function videoEncodeArgs({ crf, preset, width, height, encoder = chooseVideoEncoder().name }) {
  if (encoder === SW_ENCODER || belowHardwareMinimum(encoder, width, height)) {
    return ["-c:v", SW_ENCODER, ...(crf === undefined ? [] : ["-crf", String(crf)]), ...(preset ? ["-preset", preset] : []), "-pix_fmt", "yuv420p"];
  }
  if (!KNOWN_ENCODERS.has(encoder)) throw new Error(`unknown video encoder ${encoder}`);
  return hardwareArgs(encoder, width, height);
}

// Smallest frame NVENC opens (measured on an RTX 3050, driver 617): below it the encoder refuses
// with "Frame dimensions are less than the minimum supported value".
const NVENC_MIN = { hevc: [129, 33], h264: [145, 49] };

/** Whether width x height is too small for this hardware encoder, so the encode goes to libx264. */
export function belowHardwareMinimum(encoder, width, height) {
  if (!encoder.endsWith("_nvenc") || !width || !height) return false;
  const [w, h] = NVENC_MIN[codecOf(encoder)] || [0, 0];
  return width < w || height < h;
}

/**
 * The encoder SVA_VENC selects, from injected probes (testable without ffmpeg).
 * A hardware encoder counts only when ffmpeg lists it AND a 1-frame test encode
 * succeeds (some builds list VideoToolbox but cannot open it, e.g. in a VM).
 * @param {{mode?: string, platform?: string, listEncoders: () => Set<string>, tryEncode: (name: string) => string|null}} args tryEncode returns null on success, else the error
 * @returns {{name: string, hardware: boolean, reason: string}}
 */
export function resolveVideoEncoder({ mode = "auto", platform = process.platform, listEncoders, tryEncode }) {
  if (!VENC_MODES.includes(mode)) throw new Error(`SVA_VENC=${mode} is not one of ${VENC_MODES.join(", ")}`);
  if (mode === "sw") return { name: SW_ENCODER, hardware: false, reason: "SVA_VENC=sw" };
  const listed = listEncoders();
  const skipped = [];
  for (const name of hardwareCandidates(mode, platform)) {
    if (!listed.has(name)) {
      skipped.push(`${name} not listed by ffmpeg -encoders`);
      continue;
    }
    const err = tryEncode(name);
    if (!err) {
      const before = skipped.length ? ` (${skipped.join("; ")})` : "";
      return { name, hardware: true, reason: `SVA_VENC=${mode}: ${name} is listed and a 1-frame test encode succeeded${before}` };
    }
    skipped.push(`${name} test encode failed: ${err}`);
  }
  const why = skipped.join("; ") || "no candidates";
  const kind = { hw: "", hevc: "HEVC ", h264: "H.264 " }[mode];
  if (mode !== "auto") throw new Error(`SVA_VENC=${mode} but no ${kind}hardware video encoder works here (${why}). Use SVA_VENC=auto or sw.`);
  return { name: SW_ENCODER, hardware: false, reason: `SVA_VENC=auto: no hardware encoder works here (${why}); using libx264` };
}

function ffmpegEncoders() {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  const names = new Set();
  for (const line of String(r.stdout || "").split("\n")) {
    const m = /^\s*V\S*\s+(\S+)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

function ffmpegTestEncode(name) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30", "-frames:v", "1", ...hardwareArgs(name, 320, 240), "-f", "null", "-"],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }
  );
  if (r.status === 0) return null;
  return encodeFailureReason(String(r.stderr || r.error?.message || `exit ${r.status}`));
}

/**
 * The line of a failed encode that says why. ffmpeg's last line is usually the generic
 * "Nothing was written into output file"; the encoder's own first complaint (an old driver,
 * a missing device) comes earlier, so prefer the first line the encoder itself printed.
 */
export function encodeFailureReason(stderr) {
  const lines = stderr.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => /^\[(h264|hevc)_\w+ @/.test(l));
  return (own || lines[lines.length - 1] || "").replace(/^\[[^\]]*\]\s*/, "");
}

let chosenEncoder = null;

/** SVA_VENC's encoder on this machine, detected once per process and per mode. */
export function chooseVideoEncoder() {
  const mode = process.env.SVA_VENC || "auto";
  if (!chosenEncoder || chosenEncoder.mode !== mode) {
    chosenEncoder = { mode, ...resolveVideoEncoder({ mode, listEncoders: ffmpegEncoders, tryEncode: ffmpegTestEncode }) };
  }
  return chosenEncoder;
}

/** The encoder that wrote `file`'s first video stream (its `encoder` tag, kept through stream copies), or null when it is not one SVA uses. */
export async function probeVideoEncoder(file) {
  return (await probeEncodeSource(file)).encoder;
}

/** Size and SVA encoder of `file`'s first video stream: what a re-encode must match for a stream-copy join. */
export async function probeEncodeSource(file) {
  const { stdout } = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=encoder", "-of", "json", file]);
  const s = JSON.parse(stdout.toString()).streams?.[0] || {};
  const name = String(s.tags?.encoder || "").trim().split(/\s+/).pop();
  return { width: s.width, height: s.height, encoder: KNOWN_ENCODERS.has(name) ? name : null };
}

/**
 * Spawn a long-lived ffmpeg process that reads frames from stdin and encodes
 * them with videoEncodeArgs. Caller writes frames then ends stdin. Frames are
 * PNG files (image2pipe), or with `rgbaSize` {width, height} raw unpremultiplied
 * RGBA frames of that size (rawvideo). `width`/`height` are the output size
 * (the hardware bitrate); `encoder` defaults to SVA_VENC's choice.
 * Returns {proc, done} where done resolves when the process exits 0.
 */
export function spawnImagePipeEncoder({ fps, outPath, crf = 18, preset = "medium", scaleFilter, width, height, encoder, rgbaSize = null }) {
  const gop = keyframeInterval(fps);
  const input = rgbaSize
    ? ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${rgbaSize.width}x${rgbaSize.height}`]
    : ["-f", "image2pipe"];
  const args = ["-hide_banner", "-loglevel", "error", "-y", ...input, "-framerate", String(fps), "-i", "-"];
  if (scaleFilter) args.push("-vf", scaleFilter);
  args.push(
    ...videoEncodeArgs({ crf, preset, width, height, encoder }),
    "-g",
    String(gop),
    outPath
  );
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const done = new Promise((resolve, reject) => {
    proc.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${rgbaSize ? "rawvideo" : "image2pipe"} exited ${code}\n${stderr}`));
    });
  });
  return { proc, done };
}

/**
 * Frames per keyframe for render encodes: about one second (scene-cut keyframes
 * stay on). x264's default (250 frames) leaves a segment under ~8 s with one
 * keyframe, so a span cut inside it could copy no GOP at all (planFrameCut).
 */
export function keyframeInterval(fps) {
  return Math.max(1, Math.round(fps));
}

// ---- temp names, joins and frame-exact cuts without re-encoding -------------

let lastTempMicros = 0n;

/**
 * A unique sibling name for a temp file or directory: `<stem>-<µs>-<pid><ext>`.
 * The µs value never repeats within a process, and the pid separates processes,
 * so concurrent jobs in one reel dir never share a temp name.
 */
export function uniqueTempPath(p) {
  const ext = path.extname(p);
  let micros = BigInt(Date.now()) * 1000n + ((process.hrtime.bigint() / 1000n) % 1000n);
  if (micros <= lastTempMicros) micros = lastTempMicros + 1n;
  lastTempMicros = micros;
  return `${p.slice(0, p.length - ext.length)}-${micros}-${process.pid}${ext}`;
}

/**
 * Joins video files with the concat demuxer (-c copy), then re-stamps the
 * joined track onto the exact 1/fps grid (snapToFrameGrid). The concat alone
 * leaves packets a few ticks off the grid at joins and the last frame held
 * long, and a later filter (dub.mjs's caption overlay) then makes one frame
 * more than the picture has. The parts must share codec, size and encoder
 * headers (assertJoinable throws otherwise); no frame is decoded, and the copied packets stay
 * byte for byte the parts' own (the demuxer's auto_convert is off). The concat demuxer does not
 * rescale between track time bases, so a part on another time base is first
 * re-labelled (a packet copy) to the first part's.
 */
export async function concatMp4(segmentPaths, outPath, fps) {
  await assertJoinable(segmentPaths);
  const listPath = uniqueTempPath(`${outPath}.concat.txt`);
  const joinedPath = uniqueTempPath(`${outPath}.concat.mp4`);
  const relabelled = [];
  try {
    const files = await unifyTimescale(segmentPaths, relabelled);
    fs.writeFileSync(listPath, files.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
    // auto_convert 0: the demuxer does not rewrite the copied packets (it adds parameter sets to every keyframe otherwise).
    await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-auto_convert", "0", "-i", listPath, "-map", "0:v", "-c", "copy", joinedPath]);
    await snapToFrameGrid(joinedPath, outPath, fps);
  } finally {
    for (const f of [listPath, joinedPath, ...relabelled]) fs.rmSync(f, { force: true });
  }
}

/**
 * Throws unless every part has the first part's stream signature: a stream-copy
 * join of parts from different encoders (libx264 next to hevc_videotoolbox, or
 * H.264 next to HEVC) writes a file that does not decode. When the encoders
 * differ the message says so, since that comes from SVA_VENC changing between
 * renders of one reel.
 */
export async function assertJoinable(paths) {
  if (paths.length < 2) return;
  const sigs = await Promise.all(paths.map(streamSignature));
  const bad = sigs.findIndex((s) => s !== sigs[0]);
  if (bad < 0) return;
  const [a, b] = await Promise.all([probeVideoEncoder(paths[0]), probeVideoEncoder(paths[bad])]);
  const first = path.basename(paths[0]);
  const other = path.basename(paths[bad]);
  if (a !== b) {
    throw new Error(
      `cannot join ${other} (${b || "unknown encoder"}) to ${first} (${a || "unknown encoder"}) by stream copy: ` +
        `a reel must use one video encoder. SVA_VENC changed since one of them was made; render the film again so every segment is re-encoded with ${chooseVideoEncoder().name}.`
    );
  }
  throw new Error(`cannot join ${other} to ${first} by stream copy: they differ in codec, size, pixel format or encoder headers`);
}

/** Track time base denominator of the first video stream (ticks per second). */
async function probeTimescale(file) {
  const { stdout } = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const [n, d] = stdout.toString().trim().split("/").map(Number);
  return Math.round(d / n);
}

/** `paths` with every file on the first file's time base; re-labelled copies are pushed to `made` for the caller to delete. */
async function unifyTimescale(paths, made) {
  const scales = await Promise.all(paths.map(probeTimescale));
  const out = [];
  for (const [i, p] of paths.entries()) {
    if (scales[i] === scales[0]) {
      out.push(p);
      continue;
    }
    const tmp = uniqueTempPath(`${p}.timescale.mp4`);
    made.push(tmp);
    await ffmpeg(["-y", "-i", p, "-map", "0:v:0", "-c", "copy", "-video_track_timescale", String(scales[0]), tmp]);
    out.push(tmp);
  }
  return out;
}

/** Codec, profile, size, pixel format and encoder headers (extradata hash) of the first video stream. Equal signatures can be joined with -c copy (concatMp4 aligns the time bases); the frame rate is checked by the caller (a short clip's probed rate is a guess). */
export async function streamSignature(file) {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0", "-show_data_hash", "MD5",
    "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,extradata_hash",
    "-of", "compact=p=0", file,
  ]);
  return stdout.toString().trim();
}

/** True when `a` and `b` share one stream signature, so a -c copy join decodes every piece. */
export async function sameStream(a, b) {
  const [x, y] = await Promise.all([streamSignature(a), streamSignature(b)]);
  return x === y;
}

/** md5 of the first video stream's packets as stored (nothing decoded): equal md5 = the same encoded picture. */
export async function videoStreamMd5(file) {
  const { stdout } = await ffmpeg(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"]);
  return stdout.toString().trim().replace(/^MD5=/, "");
}

/** Number of video packets (= frames of an H.264 mp4), read from the container without decoding. */
export async function probePacketCount(filePath) {
  const { stdout } = await ffprobe([
    "-v", "error", "-count_packets", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_packets", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const n = parseInt(stdout.toString().trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`ffprobe returned no packet count for ${filePath}`);
  return n;
}

/**
 * Packet map of an H.264 mp4 without decoding: frames in display order, the
 * packet size of each decode position, and the *clean* keyframes — a keyframe
 * at display index k whose decode position is k too, with nothing decoded
 * before it that displays after it (a closed GOP). Only a clean keyframe is a
 * point where the stream can be cut and joined by packet copy.
 * @returns {Promise<{total:number, timeBase:number, ptsSec:number[], sizes:number[], keyFrames:number[]}>}
 */
export async function probeGops(filePath) {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:packet=pts,size,flags", "-of", "json", filePath,
  ]);
  const j = JSON.parse(stdout.toString());
  const [tn, td] = String(j.streams[0].time_base).split("/").map(Number);
  const packets = (j.packets || []).map((p) => ({ pts: Number(p.pts), size: Number(p.size), key: String(p.flags).includes("K") }));
  if (!packets.length || packets.some((p) => !Number.isFinite(p.pts))) throw new Error(`${filePath} has no usable video packet timestamps`);
  const order = packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts);
  const display = new Array(packets.length);
  order.forEach((decodeIdx, rank) => (display[decodeIdx] = rank));
  const keyFrames = [];
  let seenMax = -1;
  packets.forEach((p, i) => {
    if (p.key && display[i] === i && seenMax < i) keyFrames.push(i);
    seenMax = Math.max(seenMax, display[i]);
  });
  const minPts = packets[order[0]].pts;
  const timeBase = tn / td;
  return { total: packets.length, timeBase, ptsSec: order.map((i) => (packets[i].pts - minPts) * timeBase), sizes: packets.map((p) => p.size), keyFrames };
}

/**
 * The pieces a frame-exact cut of frames [from, to) is built from. A piece
 * between two clean keyframes is a packet copy ("copy"); the frames before the
 * first keyframe at or after `from`, and after the last keyframe at or before
 * `to`, are re-encoded ("encode") — the smallest span a cut off a keyframe
 * needs. With no whole GOP inside the range the whole range is re-encoded.
 * @returns {{kind:"copy"|"encode", from:number, to:number}[]}
 */
export function planFrameCut({ from, to, keyFrames, total }) {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= total)) {
    throw new Error(`cut frames [${from},${to}) do not fit a clip of ${total} frames`);
  }
  const a = keyFrames.find((k) => k >= from);
  const ends = [...keyFrames, total].filter((k) => k <= to);
  const b = ends[ends.length - 1];
  if (a === undefined || b <= a) return [{ kind: "encode", from, to }];
  const pieces = [];
  if (from < a) pieces.push({ kind: "encode", from, to: a });
  pieces.push({ kind: "copy", from: a, to: b });
  if (b < to) pieces.push({ kind: "encode", from: b, to });
  return pieces;
}

// Input seeks land on the keyframe at or before the time: the copy seek goes
// just after the keyframe's own time, the re-encode seek just before the first
// wanted frame (the decoder then drops frames before it).
const SEEK_MARGIN_FRAMES = 0.25;

async function copyFrames({ src, probe, from, to, fps, outPath }) {
  const seek = from > 0 ? ["-ss", String(probe.ptsSec[from] + SEEK_MARGIN_FRAMES / fps)] : [];
  // The seek leaves the first packets a fraction off zero; the re-stamp puts the piece on the frame grid so its length is exactly (to-from)/fps.
  const rawPath = uniqueTempPath(`${outPath}.raw.mp4`);
  try {
    await ffmpeg(["-y", ...seek, "-i", src, "-map", "0:v:0", "-c", "copy", "-frames:v", String(to - from), "-an", rawPath]);
    await snapToFrameGrid(rawPath, outPath, fps, Math.round(1 / probe.timeBase));
  } finally {
    fs.rmSync(rawPath, { force: true });
  }
  const got = (await probeGops(outPath)).sizes;
  const want = probe.sizes.slice(from, to);
  if (got.length !== want.length || got.some((s, i) => s !== want[i])) {
    throw new Error(`stream-copy cut of frames [${from},${to}) of ${path.basename(src)} did not copy the source packets`);
  }
}

async function encodeFrames({ src, probe, from, to, fps, crf, preset, outPath }) {
  const seek = from > 0 ? ["-ss", String(Math.max(0, probe.ptsSec[from] - SEEK_MARGIN_FRAMES / fps))] : [];
  await ffmpeg([
    ...["-y", ...seek, "-i", src, "-an", "-vf", "setpts=PTS-STARTPTS", "-frames:v", String(to - from)],
    ...videoEncodeArgs({ crf, preset, width: probe.source.width, height: probe.source.height, encoder: probe.source.encoder || chooseVideoEncoder().name }),
    ...["-g", String(keyframeInterval(fps)), "-r", String(fps), outPath],
  ]);
}

/**
 * Cuts frames [from, to) of `src` into `outPath` at exact frames. Rule: every
 * whole GOP between clean keyframes is packet-copied (bit-identical, nothing
 * decoded); only the frames between `from` and the next keyframe, and between
 * the last keyframe and `to`, are re-encoded (crf/preset as the render) with the
 * encoder that wrote `src` (SVA_VENC's choice when the tag names no SVA encoder),
 * from a seek to the nearest keyframe before them. If a re-encoded piece's
 * encoder headers differ from the copied ones (a clip encoded elsewhere), the
 * whole range is re-encoded instead, so the join always decodes.
 * @returns {Promise<{outPath:string, pieces:{kind:string,from:number,to:number}[], fellBack:boolean}>}
 */
export async function cutFrames({ src, from, to, fps, crf, preset, outPath }) {
  const probe = { ...(await probeGops(src)), source: await probeEncodeSource(src) };
  const workDir = uniqueTempPath(`${outPath}.parts`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    let pieces = planFrameCut({ from, to, keyFrames: probe.keyFrames, total: probe.total });
    let files = await buildCutPieces({ src, probe, pieces, fps, crf, preset, workDir });
    let fellBack = false;
    if (pieces.length > 1 && !(await allSameStream(files))) {
      pieces = [{ kind: "encode", from, to }];
      files = await buildCutPieces({ src, probe, pieces, fps, crf, preset, workDir });
      fellBack = true;
    }
    await concatMp4(files, outPath, fps);
    return { outPath, pieces, fellBack };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function buildCutPieces({ src, probe, pieces, fps, crf, preset, workDir }) {
  const files = [];
  for (const [i, p] of pieces.entries()) {
    const outPath = path.join(workDir, `${i}-${p.kind}-${p.from}-${p.to}.mp4`);
    if (p.kind === "copy") await copyFrames({ src, probe, from: p.from, to: p.to, fps, outPath });
    else await encodeFrames({ src, probe, from: p.from, to: p.to, fps, crf, preset, outPath });
    files.push(outPath);
  }
  return files;
}

async function allSameStream(files) {
  for (const f of files.slice(1)) if (!(await sameStream(files[0], f))) return false;
  return true;
}

/**
 * framemd5 hash of each decoded frame [from, to) of `file` (a track joined by
 * concatMp4, whose frame i sits at i/fps): decodes from the keyframe before
 * `from`, not from the start.
 */
export async function frameHashRange(file, from, to, fps) {
  const seek = from > 0 ? ["-ss", String(Math.max(0, from / fps - SEEK_MARGIN_FRAMES / fps))] : [];
  const { stdout } = await ffmpeg([...seek, "-i", file, "-map", "0:v:0", "-frames:v", String(to - from), "-fps_mode", "passthrough", "-f", "framemd5", "-"]);
  return stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
}
