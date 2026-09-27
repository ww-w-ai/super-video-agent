#!/usr/bin/env node
// Capture frames via seek(t), encode per-segment H.264, concat into the
// video track, mux narration (+ optional page SFX + library sound cues,
// design.md §2.5) with loudnorm (design.md §2.3). Segments (shots) are
// cached under out/segments/<quality>/
// and reused when their frame range, encoder settings and probe frame
// hashes still match — see references/pipeline.md "Re-rendering part of a
// film".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame } from "./lib/browser.mjs";
import { run, ffmpeg, spawnImagePipeEncoder, probeDuration, probeFrameCount } from "./lib/ffmpeg.mjs";
import { writeWavPCM16 } from "./lib/wav.mjs";
import { buildCueMixFilter, LOUDNORM } from "./lib/audio-mix.mjs";
import {
  computeSegments,
  probeFrameIndices,
  decideSegmentReuse,
  unknownOnlyIds,
  validateOnly,
} from "./lib/segments.mjs";

const HELP = `usage: render.mjs <reel-dir> [--preview] [--workers N] [--only id,id] [--plan]

Renders <reel-dir>/reel.html by segment (one segment per tiled run of
window.__reel.shots), encoding each to out/segments/<quality>/<id>.mp4 and
joining them (concat demuxer, -c copy) into the video track, then muxing
voice/narration.wav (+ page SFX via __reel.audio.renderSfx, + any library
sound cues via __reel.soundCues(), design.md §2.5) with loudnorm I=-16,
aac 192k.

--preview     half resolution, crf 28, preset veryfast -> out/preview-<YYYYMMDD-HHMMSS>.mp4
              (default: full resolution, crf 18, preset medium -> out/final-<YYYYMMDD-HHMMSS>.mp4)
              out/final.mp4 / out/preview.mp4 are symlinks to the newest render.
--workers N   probe/render up to N segments concurrently (separate browser
              sessions). Default 1.
--only id,id  re-render exactly these segments regardless of their probe
              hashes; reuse every other segment without probing. Refuses
              (no render happens) if a segment outside --only no longer
              matches its stored frame range.
--plan        print REUSE/RENDER per segment and exit without rendering.

A segment is reused only when its stored frame range, fps, size and three
probe-frame hashes (first/middle/last, sha256 of the captured PNG) all
match the current timeline and its .mp4 exists; otherwise it is
re-rendered. Every render prints one REUSE or RENDER line per segment with
the reason.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }
  if (!fs.existsSync(paths.narrationWav)) {
    fail(`no voice/narration.wav in ${dir} — run voice.mjs first`);
    return;
  }

  const preview = !!flags.preview;
  const workers = flags.workers ? Math.max(1, parseInt(flags.workers, 10)) : 1;
  const only = typeof flags.only === "string" ? flags.only : undefined;
  const plan = !!flags.plan;

  const started = Date.now();
  try {
    const result = await render({ dir, paths, preview, workers, only, plan });
    const elapsed = (Date.now() - started) / 1000;
    if (result.planOnly) {
      process.stdout.write(`--plan: ${result.decisions.length} segment(s), nothing rendered\n`);
      return;
    }
    const achievedFps = result.frames / elapsed;
    process.stdout.write(
      `wrote ${result.outPath}\n` +
        `frames: ${result.frames}  seconds: ${result.seconds.toFixed(3)}  ` +
        `render time: ${elapsed.toFixed(2)}s  fps achieved: ${achievedFps.toFixed(2)}\n`
    );
  } catch (e) {
    fail(e.message);
  }
}

export async function render({ dir, paths, preview, workers = 1, only, plan = false }) {
  const server = await serveDir(dir);
  try {
    const meta = await probeMeta(server.url);
    const fps = meta.fps;
    const duration = meta.duration;

    const { segments, warnings } = computeSegments({ shots: meta.shots, fps, duration });
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

    const quality = preview ? "preview" : "final";
    const segDir = path.join(paths.outDir, "segments", quality);
    fs.mkdirSync(segDir, { recursive: true });

    const targetWidth = preview ? Math.round(meta.width / 2) : meta.width;
    const targetHeight = preview ? Math.round(meta.height / 2) : meta.height;
    const crf = preview ? 28 : 18;
    const cPreset = preview ? "veryfast" : "medium";
    const scaleFilter = preview ? `scale=${targetWidth}:${targetHeight}` : undefined;

    const onlyIds = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (onlyIds) validateOnlyOrThrow({ segments, onlyIds, segDir });

    const decisions = await decideAll({ server, segments, segDir, fps, targetWidth, targetHeight, onlyIds, workers });
    for (const d of decisions) {
      process.stdout.write(`${d.action}  ${d.segment.id}  [${d.segment.frameStart},${d.segment.frameEnd})  ${d.reason}\n`);
    }

    if (plan) return { planOnly: true, decisions };

    await renderNeeded({ server, decisions, fps, crf, preset: cPreset, scaleFilter, workers });

    const videoOnlyPath = path.join(paths.outDir, "_video.mp4");
    await concatMp4(
      segments.map((s) => path.join(segDir, `${s.id}.mp4`)),
      videoOnlyPath
    );

    const expectedFrames = segments[segments.length - 1].frameEnd - segments[0].frameStart;
    await gateAvSync({ videoOnlyPath, narrationPath: paths.narrationWav, expectedFrames });

    let sfxPath;
    const sfx = await maybeRenderSfx(server, paths);
    if (sfx) sfxPath = sfx;

    const cueInputs = await resolveSoundCues(server, paths.root);

    const stampedPath = path.join(paths.outDir, `${quality}-${timestamp()}.mp4`);
    await muxAudio({ videoOnlyPath, narrationPath: paths.narrationWav, sfxPath, cueInputs, outPath: stampedPath });
    fs.rmSync(videoOnlyPath, { force: true });
    if (sfxPath) fs.rmSync(sfxPath, { force: true });
    const outPath = pointLatest(paths.outDir, `${quality}.mp4`, stampedPath);

    return { outPath, stampedPath, frames: expectedFrames, seconds: expectedFrames / fps, segments, decisions };
  } finally {
    await server.close();
  }
}

/** Local time as YYYYMMDD-HHMMSS, so every render gets its own file name. */
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Points out/<name> (final.mp4 / preview.mp4) at the newest stamped render.
 * A render never overwrites a file a player may still have open; the link is
 * swapped with a rename, so readers see either the old or the new target.
 */
function pointLatest(outDir, name, stampedPath) {
  const linkPath = path.join(outDir, name);
  // A plain file left by an older render keeps its content under its own stamp.
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    const stem = path.basename(name, ".mp4");
    fs.renameSync(linkPath, path.join(outDir, `${stem}-${timestamp(existing.mtime)}.mp4`));
  }
  const tmpLink = `${linkPath}.tmp-${process.pid}`;
  fs.rmSync(tmpLink, { force: true });
  fs.symlinkSync(path.basename(stampedPath), tmpLink);
  fs.renameSync(tmpLink, linkPath);
  return linkPath;
}

async function probeMeta(url) {
  let session;
  try {
    session = await openReel(url, {});
    if (session.errors.length) {
      throw new Error(`page errors on load: ${session.errors.join("; ")}`);
    }
    return session.meta;
  } finally {
    if (session) await session.close();
  }
}

function segMp4Path(segDir, id) {
  return path.join(segDir, `${id}.mp4`);
}
function segJsonPath(segDir, id) {
  return path.join(segDir, `${id}.json`);
}

function readStoredMeta(segDir, id) {
  const p = segJsonPath(segDir, id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function validateOnlyOrThrow({ segments, onlyIds, segDir }) {
  const unknown = unknownOnlyIds({ segments, onlyIds });
  if (unknown.length) {
    throw new Error(`--only references unknown segment(s): ${unknown.join(", ")}`);
  }
  const storedById = new Map(segments.map((s) => [s.id, readStoredMeta(segDir, s.id)]));
  const check = validateOnly({ segments, onlyIds, storedById });
  if (!check.ok) {
    throw new Error(
      `--only can't safely reuse segment(s) whose frame range moved: ${check.mustInclude.join(", ")} — ` +
        `include them in --only`
    );
  }
}

/** One REUSE/RENDER decision per segment, probing only where needed. */
async function decideAll({ server, segments, segDir, fps, targetWidth, targetHeight, onlyIds, workers }) {
  const results = new Array(segments.length);
  let idx = 0;

  async function worker() {
    let session = null;
    try {
      while (idx < segments.length) {
        const i = idx++;
        const segment = segments[i];
        if (onlyIds && !onlyIds.includes(segment.id)) {
          results[i] = { segment, action: "REUSE", reason: "--only fast path (not probed)" };
          continue;
        }
        if (!session) session = await openReel(server.url, {});
        const forceRender = !!onlyIds; // onlyIds && onlyIds.includes(segment.id)
        results[i] = await decideOne({ session, segment, segDir, fps, targetWidth, targetHeight, forceRender });
      }
    } finally {
      if (session) await session.close();
    }
  }

  const n = Math.max(1, Math.min(workers, segments.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function decideOne({ session, segment, segDir, fps, targetWidth, targetHeight, forceRender }) {
  const probeIdx = probeFrameIndices(segment.frameStart, segment.frameEnd);
  const probes = [];
  for (const f of probeIdx) {
    const png = await captureFrame(session.page, f / fps);
    probes.push(sha256Hex(png));
  }
  const current = { frameStart: segment.frameStart, frameEnd: segment.frameEnd, fps, width: targetWidth, height: targetHeight, probes };
  const mp4Path = segMp4Path(segDir, segment.id);
  const jsonPath = segJsonPath(segDir, segment.id);

  if (forceRender) {
    return { segment, action: "RENDER", reason: "--only requested", current, mp4Path, jsonPath };
  }

  const stored = readStoredMeta(segDir, segment.id);
  const decision = decideSegmentReuse({ stored, current, mp4Exists: fs.existsSync(mp4Path) });
  if (decision.reuse) return { segment, action: "REUSE", reason: decision.reason };
  return { segment, action: "RENDER", reason: decision.reason, current, mp4Path, jsonPath };
}

async function renderNeeded({ server, decisions, fps, crf, preset, scaleFilter, workers }) {
  const toRender = decisions.filter((d) => d.action === "RENDER");
  let idx = 0;

  async function worker() {
    let session = null;
    try {
      while (idx < toRender.length) {
        const i = idx++;
        const d = toRender[i];
        if (!session) session = await openReel(server.url, {});
        await encodeSegment({ session, segment: d.segment, outPath: d.mp4Path, fps, crf, preset, scaleFilter });
        writeJson(d.jsonPath, d.current);
      }
    } finally {
      if (session) await session.close();
    }
  }

  const n = Math.max(1, Math.min(workers, toRender.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
}

async function encodeSegment({ session, segment, outPath, fps, crf, preset, scaleFilter }) {
  const { proc, done } = spawnImagePipeEncoder({ fps, outPath, crf, preset, scaleFilter });
  for (let frame = segment.frameStart; frame < segment.frameEnd; frame++) {
    const t = frame / fps;
    const png = await captureFrame(session.page, t);
    const ok = proc.stdin.write(png);
    if (!ok) await once(proc.stdin, "drain");
  }
  proc.stdin.end();
  await done;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function concatMp4(segmentPaths, outPath) {
  const listPath = outPath + ".concat.txt";
  const content = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  fs.writeFileSync(listPath, content, "utf8");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  fs.rmSync(listPath, { force: true });
}

const AV_DELTA_MS_THRESHOLD = 50;

/** design point 8: A/V duration delta <= 50ms and joined frame count == expected, or fail loudly. */
async function gateAvSync({ videoOnlyPath, narrationPath, expectedFrames }) {
  const videoDur = await probeDuration(videoOnlyPath);
  const audioDur = await probeDuration(narrationPath);
  const deltaMs = Math.abs(videoDur - audioDur) * 1000;
  if (deltaMs > AV_DELTA_MS_THRESHOLD) {
    throw new Error(
      `A/V duration gate failed: video ${videoDur.toFixed(3)}s vs audio ${audioDur.toFixed(3)}s ` +
        `(delta ${deltaMs.toFixed(1)}ms > ${AV_DELTA_MS_THRESHOLD}ms)`
    );
  }
  const frameCount = await probeFrameCount(videoOnlyPath);
  if (frameCount !== expectedFrames) {
    throw new Error(`frame count gate failed: joined video has ${frameCount} frames, expected ${expectedFrames}`);
  }
}

async function maybeRenderSfx(server, paths) {
  let session;
  try {
    session = await openReel(server.url, {});
    const hasSfx = await session.page.evaluate(
      () => !!(window.__reel.audio && typeof window.__reel.audio.renderSfx === "function")
    );
    if (!hasSfx) return null;
    const sampleRate = 48000;
    const channelsData = await session.page.evaluate(
      (sr) => window.__reel.audio.renderSfx(sr),
      sampleRate
    );
    if (!channelsData || !channelsData.length) return null;
    const channels = channelsData.map((c) => Float32Array.from(c));
    const sfxPath = path.join(paths.outDir, "_sfx.wav");
    writeWavPCM16(sfxPath, channels, sampleRate);
    return sfxPath;
  } finally {
    if (session) await session.close();
  }
}

/**
 * Reads window.__reel.soundCues() (design.md §2.5) and resolves each
 * `file` (relative to the reel dir) to an absolute path plus the trim
 * length and measured peak dB muxAudio needs to place it in the mix.
 * Returns [] when the page has no library cues — the no-cue mux path is
 * then untouched (byte-for-byte the same as before this feature).
 */
async function resolveSoundCues(server, dir) {
  let session;
  try {
    session = await openReel(server.url, {});
    const hasFn = await session.page.evaluate(() => typeof window.__reel.soundCues === "function");
    if (!hasFn) return [];
    const cues = await session.page.evaluate(() => window.__reel.soundCues());
    const resolved = [];
    for (const cue of cues || []) {
      const absPath = path.join(dir, cue.file);
      const clipDur = await probeDuration(absPath);
      const leadSec = cue.soundOnly ? await probeLeadSilenceSec(absPath) : 0;
      const playable = Math.max(0.05, clipDur - leadSec);
      const trimSec = cue.maxSec ? Math.min(cue.maxSec, playable) : playable;
      const peakDb = await probePeakDb(absPath, leadSec + trimSec);
      resolved.push({ absPath, atSec: cue.at, gainDb: cue.gainDb, trimSec, peakDb, leadSec });
    }
    return resolved;
  } finally {
    if (session) await session.close();
  }
}

const MAX_LEAD_SKIP_SEC = 0.3;

/**
 * Silence at the head of a sound file (below -50 dB), capped at 0.3 s so a
 * deliberately delayed effect is not eaten. Skipping it puts the audible
 * onset on the cue time instead of 40-130 ms after it.
 */
async function probeLeadSilenceSec(filePath) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    filePath,
    "-af",
    `atrim=0:${MAX_LEAD_SKIP_SEC + 0.05},silencedetect=noise=-50dB:d=0.005`,
    "-f",
    "null",
    "-",
  ]);
  const start = /silence_start:\s*(-?[\d.]+)/.exec(stderr);
  if (!start || parseFloat(start[1]) > 0.001) return 0;
  const end = /silence_end:\s*([\d.]+)/.exec(stderr);
  if (!end) {
    // Silent for the whole window: leave the file as is, but say so — the
    // effect will be heard later than its cue (shift it with offsetMs).
    process.stderr.write(
      `note: ${path.basename(filePath)} starts with over ${MAX_LEAD_SKIP_SEC}s of silence; not skipped, so it sounds after its cue\n`
    );
    return 0;
  }
  return Math.min(MAX_LEAD_SKIP_SEC, parseFloat(end[1]));
}

/** Peak level (dBFS) of the first `trimSec` seconds of `filePath`, via ffmpeg's astats. */
async function probePeakDb(filePath, trimSec) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    filePath,
    "-af",
    // No reset: astats must accumulate over the whole trim, then report once.
    `atrim=0:${trimSec},astats=metadata=0`,
    "-f",
    "null",
    "-",
  ]);
  // Mono prints one block; multi-channel prints per-channel blocks then "Overall".
  const overall = stderr.slice(Math.max(0, stderr.lastIndexOf("Overall")));
  const m = /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(overall) || /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(stderr);
  if (!m || m[1] === "-inf") return -90; // silent clip: harmless deep negative peak
  return parseFloat(m[1]);
}

async function muxAudio({ videoOnlyPath, narrationPath, sfxPath, cueInputs, outPath }) {
  if (cueInputs && cueInputs.length > 0) {
    const { filterComplex } = buildCueMixFilter({ hasSfx: !!sfxPath, cues: cueInputs });
    const audioInputs = [narrationPath, ...(sfxPath ? [sfxPath] : []), ...cueInputs.map((c) => c.absPath)];
    const inputArgs = [videoOnlyPath, ...audioInputs].flatMap((p) => ["-i", p]);
    await ffmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      outPath,
    ]);
    return;
  }
  if (sfxPath) {
    await ffmpeg([
      "-y",
      "-i",
      videoOnlyPath,
      "-i",
      narrationPath,
      "-i",
      sfxPath,
      "-filter_complex",
      `[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0[amixed];[amixed]${LOUDNORM}[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      outPath,
    ]);
  } else {
    await ffmpeg([
      "-y",
      "-i",
      videoOnlyPath,
      "-i",
      narrationPath,
      "-filter_complex",
      `[1:a]${LOUDNORM}[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      outPath,
    ]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
