#!/usr/bin/env node
// Capture frames via seek(t), encode per-segment H.264, concat into the
// video track, mux narration (+ optional page SFX + library sound cues,
// design.md §2.5), then two-pass masters the mix to -16 LUFS with a single
// static gain (design.md §2.3, scripts/lib/audio-mix.mjs). Segments (shots) are
// cached under out/segments/<quality>/
// and reused when their frame range, encoder settings and probe frame
// hashes still match — see references/pipeline.md "Re-rendering part of a
// film".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, loadPlan, loadTimings } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, stubSeconds, stubTimings } from "./lib/browser.mjs";
import { run, ffmpeg, ffprobe, spawnImagePipeEncoder, probeDuration, probeFrameCount, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { writeWavPCM16 } from "./lib/wav.mjs";
import { buildCueMixFilter, measureMasterGain } from "./lib/audio-mix.mjs";
import { withTransportRetry } from "./lib/retry.mjs";
import {
  computeSegments,
  probeFrameIndices,
  decideSegmentReuse,
  unknownOnlyIds,
  validateOnly,
} from "./lib/segments.mjs";

const HELP = `usage: render.mjs <reel-dir> [--preview] [--workers N] [--only id,id] [--plan] [--no-captions]
                 [--stub <sec>] [--insert <clip.mp4>@<start-sec> [--insert-stills <dir>]]

Renders <reel-dir>/reel.html by segment (one segment per tiled run of
window.__reel.shots), encoding each to out/segments/<quality>/<id>.mp4 and
joining them (concat demuxer, -c copy) into the video track, then muxing
voice/narration.wav (+ page SFX via __reel.audio.renderSfx, + any library
sound cues via __reel.soundCues(), design.md §2.5), mastered to -16 LUFS
with a single static gain (two-pass, not loudnorm), aac 192k.

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
--no-captions loads the page with ?captions=0 (references/pipeline.md
              "Picture first"), so window.__reel.captionsOn() is false and
              Reel.caption() draws nothing. Segments go to
              out/segments/<final|preview>-nocap/, separate from captioned
              segments. Does not require voice/narration.wav. Writes
              out/picture-<YYYYMMDD-HHMMSS>.mp4 (video only, no audio) +
              out/picture.mp4, the page's own sound bed (renderSfx + library
              cues, no narration) to out/picture-<stamp>.bed.wav +
              out/picture.bed.wav, and copies the clock it was built on to
              out/picture.timings.json. Use dub.mjs to lay a language's
              caption + voice over the picture afterwards.
--stub <sec>  for a reel with no voice/timings.json: the page is served one
              silent line of <sec> seconds (id "stub"); nothing is written to
              voice/. Use with --no-captions; out/picture.timings.json then
              holds that stub clock.
--insert <clip.mp4>@<start-sec>
              puts an already rendered clip into the picture: frames from
              <start-sec> (rounded to the frame grid) for the clip's frame
              count are the clip's own frames. Segments the clip covers
              entirely are not rendered; a segment it covers in part has its
              remaining frames re-encoded from its own mp4. The joined track
              is re-stamped onto the 1/fps grid (-bsf:v setts) — a plain
              -c copy join can shift later timestamps by a few ticks, which
              changes a later frame count. The clip must have the reel's fps;
              a clip whose size or encoding differs from the segments is
              re-encoded to match first (said in the output). After the join
              the frame count and the framemd5 of the inserted span (equal to
              the clip's) are checked. picture.timings.json is kept as usual.
--insert-stills <dir>
              with --insert: also writes the clip's frames as JPEG stills to
              <dir>/frame-<film frame, 6 digits>.jpg plus <dir>/stills.json
              ({fps, startFrame, count, pattern}), so the page can draw the
              approved clip in previews and stills.

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
  const noCaptions = !!flags["no-captions"];
  if (!noCaptions && !fs.existsSync(paths.narrationWav)) {
    fail(`no voice/narration.wav in ${dir} — run voice.mjs first${flags.stub !== undefined ? " (a --stub render needs --no-captions)" : ""}`);
    return;
  }
  let stubSec;
  let insert;
  try {
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
    insert = flags.insert !== undefined ? parseInsertFlag(flags.insert) : null;
    if (flags["insert-stills"] !== undefined && !insert) throw new Error("--insert-stills needs --insert <clip.mp4>@<start-sec>");
    if (insert && flags["insert-stills"] !== undefined) {
      if (typeof flags["insert-stills"] !== "string") throw new Error("--insert-stills takes a directory");
      insert.stillsDir = abs(flags["insert-stills"]);
    }
    if (insert && !fs.existsSync(insert.clipPath)) throw new Error(`--insert clip not found: ${insert.clipPath}`);
  } catch (e) {
    fail(e.message);
    return;
  }
  if (!stubSec && !fs.existsSync(paths.timingsJson)) {
    fail(`no voice/timings.json in ${dir} — run voice.mjs first (or pass --stub <sec> for a picture-only probe)`);
    return;
  }

  const preview = !!flags.preview;
  const workers = flags.workers ? Math.max(1, parseInt(flags.workers, 10)) : 1;
  const only = typeof flags.only === "string" ? flags.only : undefined;
  const plan = !!flags.plan;

  const started = Date.now();
  try {
    const result = await render({ dir, paths, preview, workers, only, plan, noCaptions, stubSec, insert });
    const elapsed = (Date.now() - started) / 1000;
    if (result.planOnly) {
      process.stdout.write(`--plan: ${result.decisions.length} segment(s), nothing rendered\n`);
      return;
    }
    const achievedFps = result.frames / elapsed;
    process.stdout.write(
      `wrote ${result.outPath}\n` +
        (result.bedPath ? `wrote ${result.bedPath}\n` : "") +
        `frames: ${result.frames}  seconds: ${result.seconds.toFixed(3)}  ` +
        `render time: ${elapsed.toFixed(2)}s  fps achieved: ${achievedFps.toFixed(2)}\n`
    );
  } catch (e) {
    fail(e.message);
  }
}

/**
 * The URL render.mjs opens the reel at. `?captions=0` (design.md, engine
 * captionsOn()) makes Reel.caption() draw nothing — a picture-first render
 * (--no-captions) has no narration or language yet, only the picture.
 * @param {string} baseUrl serveDir()'s server.url
 * @param {boolean} noCaptions
 */
export function pictureUrl(baseUrl, noCaptions) {
  return noCaptions ? `${baseUrl}?captions=0` : baseUrl;
}

/**
 * out/segments/<name>/ for this render: "final"/"preview" as before, or
 * "final-nocap"/"preview-nocap" for --no-captions, so a picture-first
 * render's segments never get reused for (or reuse) a captioned render's.
 */
export function segmentDirName(quality, noCaptions) {
  return noCaptions ? `${quality}-nocap` : quality;
}

export async function render({ dir, paths, preview, workers = 1, only, plan = false, noCaptions = false, stubSec = null, insert = null }) {
  const server = await serveDir(dir);
  const pageUrl = pictureUrl(server.url, noCaptions);
  const openAt = { url: pageUrl, opts: { stubSec } }; // what every helper below opens: page URL + openReel options
  try {
    const meta = await probeMeta(openAt);
    const fps = meta.fps;
    const duration = meta.duration;

    const { segments, warnings } = computeSegments({ shots: meta.shots, fps, duration });
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

    const quality = preview ? "preview" : "final";
    const segDir = path.join(paths.outDir, "segments", segmentDirName(quality, noCaptions));
    fs.mkdirSync(segDir, { recursive: true });

    const targetWidth = preview ? Math.round(meta.width / 2) : meta.width;
    const targetHeight = preview ? Math.round(meta.height / 2) : meta.height;
    const crf = preview ? 28 : 18;
    const cPreset = preview ? "veryfast" : "medium";
    const scaleFilter = preview ? `scale=${targetWidth}:${targetHeight}` : undefined;

    const onlyIds = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (onlyIds) validateOnlyOrThrow({ segments, onlyIds, segDir });

    const insertPlan = insert ? await prepareInsert({ insert, segments, fps }) : null;

    const decisions = await decideAll({
      server: openAt,
      segments,
      segDir,
      fps,
      targetWidth,
      targetHeight,
      onlyIds,
      workers,
      coveredIds: insertPlan ? insertPlan.coveredIds : [],
    });
    for (const d of decisions) {
      process.stdout.write(`${d.action}  ${d.segment.id}  [${d.segment.frameStart},${d.segment.frameEnd})  ${d.reason}\n`);
    }

    if (plan) return { planOnly: true, decisions };

    await renderNeeded({ server: openAt, decisions, fps, crf, preset: cPreset, scaleFilter, workers });

    const videoOnlyPath = path.join(paths.outDir, "_video.mp4");
    const expectedFrames = segments[segments.length - 1].frameEnd - segments[0].frameStart;
    if (insertPlan) {
      await buildInsertedTrack({ insertPlan, segDir, fps, crf, preset: cPreset, outPath: videoOnlyPath, expectedFrames });
    } else {
      await concatMp4(
        segments.map((s) => path.join(segDir, `${s.id}.mp4`)),
        videoOnlyPath
      );
    }

    if (noCaptions) {
      return await finishPictureRender({ dir, paths, openAt, videoOnlyPath, expectedFrames, fps, segments, decisions, stubSec });
    }

    await gateAvSync({ videoOnlyPath, narrationPath: paths.narrationWav, expectedFrames });

    let sfxPath;
    const sfx = await maybeRenderSfx(openAt, paths);
    if (sfx) sfxPath = sfx;

    const cueInputs = await resolveSoundCues(openAt, paths.root);
    const narrationWindows = narrationWindowsFor(dir, stubSec);
    const sfxDuckDb = sfxDuckDbFor(dir);

    const stampedPath = path.join(paths.outDir, `${quality}-${timestamp()}.mp4`);
    await muxAudio({
      videoOnlyPath,
      narrationPath: paths.narrationWav,
      sfxPath,
      cueInputs,
      outPath: stampedPath,
      narrationWindows,
      sfxDuckDb,
    });
    fs.rmSync(videoOnlyPath, { force: true });
    if (sfxPath) fs.rmSync(sfxPath, { force: true });
    const outPath = pointLatest(paths.outDir, `${quality}.mp4`, stampedPath);

    return { outPath, stampedPath, frames: expectedFrames, seconds: expectedFrames / fps, segments, decisions };
  } finally {
    await server.close();
  }
}

/**
 * Finishes a --no-captions ("picture first", references/pipeline.md) render:
 * the joined video track becomes out/picture-<stamp>.mp4 (video only, no
 * audio — no narration exists yet, only the page's own sound bed), a
 * separate out/picture-<stamp>.bed.wav carries renderSfx + library cues
 * mixed exactly as muxAudio mixes them (no narration channel), and
 * voice/timings.json (the clock the picture was built on) is copied to
 * out/picture.timings.json so dub.mjs can lay a language's caption + voice
 * over the picture later without re-deriving the shot clock.
 */
async function finishPictureRender({ paths, openAt, videoOnlyPath, expectedFrames, fps, segments, decisions, stubSec }) {
  const frameCount = await probeFrameCount(videoOnlyPath);
  if (frameCount !== expectedFrames) {
    throw new Error(`frame count gate failed: joined video has ${frameCount} frames, expected ${expectedFrames}`);
  }

  const stamp = timestamp();
  const stampedPath = path.join(paths.outDir, `picture-${stamp}.mp4`);
  fs.renameSync(videoOnlyPath, stampedPath);
  const outPath = pointLatest(paths.outDir, "picture.mp4", stampedPath);

  let sfxPath;
  const sfx = await maybeRenderSfx(openAt, paths);
  if (sfx) sfxPath = sfx;
  const cueInputs = await resolveSoundCues(openAt, paths.root);

  const durationSec = String(await probeDuration(stampedPath));
  const bedStampedPath = path.join(paths.outDir, `picture-${stamp}.bed.wav`);
  await muxBedOnly({ sfxPath, cueInputs, durationSec, outPath: bedStampedPath });
  if (sfxPath) fs.rmSync(sfxPath, { force: true });
  const bedPath = pointLatest(paths.outDir, "picture.bed.wav", bedStampedPath);

  const timingsPath = path.join(paths.outDir, "picture.timings.json");
  if (stubSec) writeJson(timingsPath, stubTimings(stubSec));
  else fs.copyFileSync(paths.timingsJson, timingsPath);

  return {
    outPath,
    stampedPath,
    bedPath,
    timingsPath,
    frames: expectedFrames,
    seconds: expectedFrames / fps,
    segments,
    decisions,
  };
}

/** Local time as YYYYMMDD-HHMMSS, so every render gets its own file name. */
export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Points out/<name> (final.mp4 / preview.mp4) at the newest stamped render.
 * A render never overwrites a file a player may still have open; the link is
 * swapped with a rename, so readers see either the old or the new target.
 */
export function pointLatest(outDir, name, stampedPath) {
  const linkPath = path.join(outDir, name);
  // A plain file left by an older render keeps its content under its own stamp.
  const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    const ext = path.extname(name); // ".mp4", ".wav", ... (picture.bed.wav -> ".wav")
    const stem = path.basename(name, ext);
    fs.renameSync(linkPath, path.join(outDir, `${stem}-${timestamp(existing.mtime)}${ext}`));
  }
  const tmpLink = `${linkPath}.tmp-${process.pid}`;
  fs.rmSync(tmpLink, { force: true });
  fs.symlinkSync(path.basename(stampedPath), tmpLink);
  fs.renameSync(tmpLink, linkPath);
  return linkPath;
}

async function probeMeta(target) {
  let session;
  try {
    session = await openReel(target.url, target.opts);
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
async function decideAll({ server, segments, segDir, fps, targetWidth, targetHeight, onlyIds, workers, coveredIds = [] }) {
  const results = new Array(segments.length);
  let idx = 0;

  async function worker() {
    let session = null;
    try {
      while (idx < segments.length) {
        const i = idx++;
        const segment = segments[i];
        if (coveredIds.includes(segment.id)) {
          results[i] = { segment, action: "INSERT", reason: "covered by the --insert clip (not rendered)" };
          continue;
        }
        if (onlyIds && !onlyIds.includes(segment.id)) {
          results[i] = { segment, action: "REUSE", reason: "--only fast path (not probed)" };
          continue;
        }
        if (!session) session = await openReel(server.url, server.opts);
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
        // Both film sessions had render.mjs die once on a Playwright
        // transport error mid-segment (no page error involved) and pass
        // clean on rerun — retry the segment itself, up to 2 more times,
        // dropping the (possibly broken) session so the next attempt opens
        // a fresh one. A real page/application error is never retried
        // (isTransportError rejects it) — see scripts/lib/retry.mjs.
        await withTransportRetry(
          async () => {
            if (!session) session = await openReel(server.url, server.opts);
            await encodeSegment({ session, segment: d.segment, outPath: d.mp4Path, fps, crf, preset, scaleFilter });
          },
          {
            maxRetries: 2,
            onRetry: async (attempt, err) => {
              process.stderr.write(
                `retrying segment ${d.segment.id} after a transport error (attempt ${attempt}): ${err.message}\n`
              );
              if (session) {
                await session.close().catch(() => {});
                session = null;
              }
            },
          }
        );
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

// ---- --insert: an approved clip in place of rendered frames --------------

/**
 * Reads `--insert <clip.mp4>@<start-sec>`. The last "@" splits, so a clip
 * path may itself contain "@".
 * @returns {{clipPath: string, startSec: number}}
 */
export function parseInsertFlag(value) {
  const s = typeof value === "string" ? value : "";
  const at = s.lastIndexOf("@");
  const startSec = at > 0 ? Number(s.slice(at + 1)) : NaN;
  if (at <= 0 || s.slice(at + 1) === "" || !Number.isFinite(startSec) || startSec < 0) {
    throw new Error(`--insert takes <clip.mp4>@<start-sec>, e.g. --insert out/opening.mp4@0 (got "${value}")`);
  }
  return { clipPath: abs(s.slice(0, at)), startSec };
}

/**
 * Lays a clip of `clipFrames` frames over the segment tiling from
 * `startSec` (rounded to the frame grid). Returns the pieces of the joined
 * track in order — whole segments, the clip, and parts of segments the clip
 * covers only in part (frame ranges relative to that segment) — plus the
 * ids of segments the clip covers entirely (never rendered) and partly.
 * @param {{segments: {id:string, frameStart:number, frameEnd:number}[], startSec: number, fps: number, clipFrames: number}} args
 */
export function planInsert({ segments, startSec, fps, clipFrames }) {
  if (!Number.isInteger(clipFrames) || clipFrames < 1) throw new Error(`--insert clip has no frames (${clipFrames})`);
  const startFrame = Math.round(startSec * fps);
  const endFrame = startFrame + clipFrames;
  const filmStart = segments[0].frameStart;
  const filmEnd = segments[segments.length - 1].frameEnd;
  if (startFrame < filmStart || endFrame > filmEnd) {
    throw new Error(
      `--insert span frames [${startFrame},${endFrame}) (${clipFrames} frames from t=${startSec}s) does not fit the film's frames [${filmStart},${filmEnd})`
    );
  }
  const pieces = [];
  const coveredIds = [];
  const partialIds = [];
  let clipPlaced = false;
  const placeClip = () => {
    if (!clipPlaced) pieces.push({ kind: "clip", frames: clipFrames });
    clipPlaced = true;
  };
  for (const seg of segments) {
    const { id, frameStart: a, frameEnd: b } = seg;
    if (b <= startFrame) {
      pieces.push({ kind: "segment", id, frames: b - a });
      continue;
    }
    if (a >= endFrame) {
      placeClip();
      pieces.push({ kind: "segment", id, frames: b - a });
      continue;
    }
    if (a < startFrame) pieces.push({ kind: "part", id, from: 0, to: startFrame - a, frames: startFrame - a });
    placeClip();
    if (b > endFrame) pieces.push({ kind: "part", id, from: endFrame - a, to: b - a, frames: b - endFrame });
    if (a >= startFrame && b <= endFrame) coveredIds.push(id);
    else partialIds.push(id);
  }
  placeClip();
  return { startFrame, endFrame, clipFrames, pieces, coveredIds, partialIds, snapped: Math.abs(startSec * fps - startFrame) > 1e-6 };
}

/**
 * The setts bitstream filter that rounds every packet's PTS and DTS to the
 * 1/fps grid. A -c copy join of files whose timestamps were cut on a
 * different tick can leave later packets a few ticks off the grid.
 */
export function gridTimestampFilter(fps) {
  const snap = (v) => `round(${v}*TB*${fps})/(TB*${fps})`;
  return `setts=pts=${snap("PTS")}:dts=${snap("DTS")}`;
}

/** Probes the clip, plans the splice, prints the plan, writes stills when asked. */
async function prepareInsert({ insert, segments, fps }) {
  const info = await probeVideoInfo(insert.clipPath);
  if (Math.abs(info.fps - fps) > 1e-3) {
    throw new Error(`--insert clip runs at ${info.fps} fps, the reel at ${fps} fps — render the clip at the reel's fps`);
  }
  const clipFrames = await probeFrameCount(insert.clipPath);
  const plan = { ...planInsert({ segments, startSec: insert.startSec, fps, clipFrames }), clipPath: insert.clipPath };
  if (plan.snapped) {
    process.stdout.write(`note: --insert start ${insert.startSec}s is not on the frame grid; using frame ${plan.startFrame} (t=${(plan.startFrame / fps).toFixed(4)}s)\n`);
  }
  process.stdout.write(
    `insert: ${path.basename(insert.clipPath)} → frames [${plan.startFrame},${plan.endFrame}); ` +
      `covers ${plan.coveredIds.join(", ") || "no whole segment"}` +
      (plan.partialIds.length ? `; re-encodes the rest of ${plan.partialIds.join(", ")}` : "") +
      "\n"
  );
  if (insert.stillsDir) await writeInsertStills({ clipPath: insert.clipPath, dir: insert.stillsDir, startFrame: plan.startFrame, count: clipFrames, fps });
  return plan;
}

/**
 * Writes the clip's frames as <dir>/frame-<film frame>.jpg plus
 * <dir>/stills.json, so the page can draw the approved clip in previews
 * and stills before the final picture swaps the clip itself in.
 */
export async function writeInsertStills({ clipPath, dir, startFrame, count, fps }) {
  fs.mkdirSync(dir, { recursive: true });
  const pattern = "frame-%06d.jpg";
  await ffmpeg(["-y", "-i", clipPath, "-fps_mode", "passthrough", "-q:v", "2", "-start_number", String(startFrame), path.join(dir, pattern)]);
  writeJson(path.join(dir, "stills.json"), { fps, startFrame, count, pattern });
  process.stdout.write(`wrote ${count} stills to ${dir} (frame-${String(startFrame).padStart(6, "0")}.jpg …)\n`);
}

/**
 * Builds the joined video track from the insert plan, then checks it: the
 * frame count equals `expectedFrames` and the inserted span's framemd5
 * equals the clip's.
 */
async function buildInsertedTrack({ insertPlan, segDir, fps, crf, preset, outPath, expectedFrames }) {
  const workDir = path.join(segDir, "_insert");
  const result = await spliceTrack({
    pieces: insertPlan.pieces,
    segmentPath: (id) => segMp4Path(segDir, id),
    clipPath: insertPlan.clipPath,
    fps,
    crf,
    preset,
    workDir,
    outPath,
  });
  if (result.clipReencoded) {
    process.stdout.write(`note: the clip's size or encoder headers differ from the segments; re-encoded it (crf ${crf}) before the join\n`);
  }
  await verifyInsertedSpan({ outPath, clipPath: result.clipUsed, startFrame: insertPlan.startFrame, expectedFrames });
  process.stdout.write(`insert: ${expectedFrames} frames, framemd5 of frames [${insertPlan.startFrame},${insertPlan.endFrame}) equals the clip\n`);
  fs.rmSync(workDir, { recursive: true, force: true });
}

/**
 * Joins `pieces` (planInsert order) into `outPath` with -c copy and the
 * grid re-stamp. Parts of segments are re-encoded from that segment's mp4
 * (crf/preset as the render). The clip is used as is when its stream
 * matches the segments' (size, pixel format, encoder headers); otherwise a
 * re-encoded copy is used. Returns which clip file went in.
 * @param {{pieces: object[], segmentPath: (id: string) => string, clipPath: string, fps: number, crf: number, preset: string, workDir: string, outPath: string}} args
 */
export async function spliceTrack({ pieces, segmentPath, clipPath, fps, crf, preset, workDir, outPath }) {
  fs.mkdirSync(workDir, { recursive: true });
  const files = [];
  for (const p of pieces) {
    if (p.kind === "segment") files.push(segmentPath(p.id));
    else if (p.kind === "part") files.push(await encodePart({ src: segmentPath(p.id), from: p.from, to: p.to, fps, crf, preset, outPath: path.join(workDir, `${p.id}-${p.from}-${p.to}.mp4`) }));
    else files.push(null);
  }
  const reference = files.find(Boolean);
  let clipUsed = clipPath;
  let clipReencoded = false;
  if (reference && !(await sameStream(reference, clipPath))) {
    clipUsed = path.join(workDir, "clip.mp4");
    await reencodeLikeSegments({ src: clipPath, like: await streamTags(reference), fps, crf, preset, outPath: clipUsed });
    clipReencoded = true;
  }
  const joined = files.map((f) => f || clipUsed);
  for (const f of joined) {
    if (f !== reference && reference && !(await sameStream(reference, f))) {
      throw new Error(`--insert: ${path.basename(f)} has different encoder headers from ${path.basename(reference)}; a -c copy join would not decode`);
    }
  }
  const listPath = path.join(workDir, "concat.txt");
  fs.writeFileSync(listPath, joined.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v", "-c", "copy", "-bsf:v", gridTimestampFilter(fps), outPath]);
  return { clipUsed, clipReencoded };
}

/**
 * Size, sample aspect ratio and colour tags of `file`'s video stream, as
 * values the scale/setsar/setparams filters take. These end up in the
 * H.264 headers, so a re-encoded clip must carry the segments' values.
 */
async function streamTags(file) {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,sample_aspect_ratio,color_range,color_space,color_primaries,color_transfer",
    "-of", "json", file,
  ]);
  const s = JSON.parse(stdout.toString()).streams[0];
  const known = (v) => (v && v !== "N/A" ? v : "unknown");
  return {
    width: s.width,
    height: s.height,
    sar: s.sample_aspect_ratio && /^\d+:\d+$/.test(s.sample_aspect_ratio) ? s.sample_aspect_ratio.replace(":", "/") : "0",
    range: known(s.color_range),
    colorspace: known(s.color_space),
    primaries: known(s.color_primaries),
    trc: known(s.color_transfer),
  };
}

// Decodes `src` to PNG frames piped into the same encoder render.mjs uses
// for segments, with the segments' size, SAR and colour tags (`like`), so
// the result carries the segments' encoder headers. A direct re-encode
// keeps the source's tags, which change the headers.
async function reencodeLikeSegments({ src, like, fps, crf, preset, outPath }) {
  const { proc, done } = spawnImagePipeEncoder({ fps, outPath, crf, preset });
  const filter =
    `scale=${like.width}:${like.height},setsar=${like.sar},format=rgba,` +
    `setparams=range=${like.range}:color_primaries=${like.primaries}:color_trc=${like.trc}:colorspace=${like.colorspace}`;
  const decoder = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", src, "-an", "-fps_mode", "passthrough", "-vf", filter, "-f", "image2pipe", "-c:v", "png", "-"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  decoder.stderr.on("data", (d) => (stderr += d.toString()));
  decoder.stdout.pipe(proc.stdin);
  const code = await new Promise((resolve, reject) => {
    decoder.on("error", reject);
    decoder.on("close", resolve);
  });
  if (code !== 0) {
    proc.stdin.destroy();
    throw new Error(`ffmpeg could not decode ${src} (exit ${code})\n${stderr}`);
  }
  await done;
}

async function encodePart({ src, from, to, fps, crf, preset, outPath }) {
  await ffmpeg([
    "-y", "-i", src, "-an",
    "-vf", `trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-r", String(fps),
    outPath,
  ]);
  return outPath;
}

// Same codec, size, pixel format and encoder headers (avcC extradata), so
// a -c copy join decodes every piece correctly.
async function sameStream(a, b) {
  const [x, y] = await Promise.all([streamSignature(a), streamSignature(b)]);
  return x === y;
}

async function streamSignature(file) {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0", "-show_data_hash", "MD5",
    "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,extradata_hash",
    "-of", "compact=p=0", file,
  ]);
  return stdout.toString().trim();
}

/** framemd5 hashes (one per decoded frame) of `file`'s first video stream. */
export async function frameHashes(file) {
  const { stdout } = await ffmpeg(["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return stdout
    .toString()
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").pop().trim());
}

/**
 * Throws unless `outPath` has `expectedFrames` frames and its frames from
 * `startFrame` hash (framemd5) the same as every frame of `clipPath`.
 */
export async function verifyInsertedSpan({ outPath, clipPath, startFrame, expectedFrames }) {
  const [out, clip] = await Promise.all([frameHashes(outPath), frameHashes(clipPath)]);
  if (out.length !== expectedFrames) {
    throw new Error(`--insert frame count gate failed: joined video has ${out.length} frames, expected ${expectedFrames}`);
  }
  const span = out.slice(startFrame, startFrame + clip.length);
  const bad = span.findIndex((h, i) => h !== clip[i]);
  if (span.length !== clip.length || bad !== -1) {
    throw new Error(`--insert framemd5 gate failed: film frame ${startFrame + Math.max(0, bad)} differs from clip frame ${Math.max(0, bad)}`);
  }
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
export async function gateAvSync({ videoOnlyPath, narrationPath, expectedFrames }) {
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
    session = await openReel(server.url, server.opts);
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
    session = await openReel(server.url, server.opts);
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

// The video decides the length: audio is padded with silence (apad) and cut at
// the video's end, so a narration shorter than the picture never trims the
// still tail the way -shortest did.
async function muxAudio({ videoOnlyPath, narrationPath, sfxPath, cueInputs, outPath, narrationWindows = [], sfxDuckDb = 0 }) {
  const videoSec = String(await probeDuration(videoOnlyPath));
  const finalMux = (inputArgs, filterComplex) =>
    ffmpeg([
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
      "-t",
      videoSec,
      outPath,
    ]);
  if (cueInputs && cueInputs.length > 0) {
    const { filterComplex } = buildCueMixFilter({
      hasSfx: !!sfxPath,
      cues: cueInputs,
      narrationWindows,
      duckDb: sfxDuckDb,
    });
    const audioInputs = [narrationPath, ...(sfxPath ? [sfxPath] : []), ...cueInputs.map((c) => c.absPath)];
    const inputArgs = [videoOnlyPath, ...audioInputs].flatMap((p) => ["-i", p]);
    const { filter } = await measurePremaster(inputArgs, filterComplex, outPath);
    await finalMux(inputArgs, `${filterComplex};[premaster]${filter},apad[aout]`);
    return;
  }
  if (sfxPath) {
    const inputArgs = [videoOnlyPath, narrationPath, sfxPath].flatMap((p) => ["-i", p]);
    const premix = "[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed];[amixed]anull[premaster]";
    const { filter } = await measurePremaster(inputArgs, premix, outPath);
    await finalMux(inputArgs, `${premix};[premaster]${filter},apad[aout]`);
    return;
  }
  // No sfx, no cues: the premix is just the narration file itself, no
  // separate pass-1 render needed.
  const inputArgs = [videoOnlyPath, narrationPath].flatMap((p) => ["-i", p]);
  const { filter } = await measureMasterGain(narrationPath);
  await finalMux(inputArgs, `[1:a]${filter},apad[aout]`);
}

/** Runs pass 1 (renders `filterComplex`'s `[premaster]` label to a temp wav
 * next to `outPath`, then deletes it) and returns the measured loudness +
 * pass-2 gain filter (audio-mix.mjs measureMasterGain). */
async function measurePremaster(inputArgs, filterComplex, outPath) {
  const premasterPath = `${outPath}.premaster.wav`;
  await ffmpeg(["-y", ...inputArgs, "-filter_complex", filterComplex, "-map", "[premaster]", "-c:a", "pcm_s16le", premasterPath]);
  try {
    return await measureMasterGain(premasterPath);
  } finally {
    fs.rmSync(premasterPath, { force: true });
  }
}

/**
 * Builds out/picture-<stamp>.bed.wav: the page's own sound (renderSfx +
 * library cues), mixed exactly the way muxAudio mixes them into a normal
 * render, minus the narration channel — there is no narration yet, only
 * the picture. Reuses buildCueMixFilter's graph (audio-mix.mjs) with
 * includeNarration:false so the two mixes never drift apart. The bed is not
 * mastered: it keeps the page's own level, so its balance against a -16 LUFS
 * voice is the same as in a normal render. dub.mjs masters the final mix.
 */
async function muxBedOnly({ sfxPath, cueInputs, durationSec, outPath }) {
  if (!sfxPath && (!cueInputs || cueInputs.length === 0)) {
    // The page has no sound of its own: a silent bed at the picture's length.
    await ffmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      durationSec,
      "-c:a",
      "pcm_s16le",
      outPath,
    ]);
    return;
  }
  if (cueInputs && cueInputs.length > 0) {
    const { filterComplex } = buildCueMixFilter({ narrationIndex: 0, hasSfx: !!sfxPath, cues: cueInputs, includeNarration: false });
    const audioInputs = [...(sfxPath ? [sfxPath] : []), ...cueInputs.map((c) => c.absPath)];
    const inputArgs = audioInputs.flatMap((p) => ["-i", p]);
    await ffmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex",
      `${filterComplex};[premaster]apad[aout]`,
      "-map",
      "[aout]",
      "-c:a",
      "pcm_s16le",
      "-t",
      durationSec,
      outPath,
    ]);
    return;
  }
  // sfx only, no cues: the bed is sfxPath itself, padded to the picture.
  await ffmpeg([
    "-y",
    "-i",
    sfxPath,
    "-filter:a",
    "apad",
    "-c:a",
    "pcm_s16le",
    "-t",
    durationSec,
    outPath,
  ]);
}

/** voice/timings.json's lines (or the --stub line) as {start,end} narration windows, for ducking (scripts/lib/duck.mjs). */
function narrationWindowsFor(dir, stubSec) {
  const timings = stubSec ? stubTimings(stubSec) : loadTimings(dir);
  return (timings.lines || []).map((l) => ({ start: l.start, end: l.end }));
}

/** plan.meta.sound.sfxDuckDb, default -6dB (references/sound.md "Mix"). Shared with dub.mjs. */
export function sfxDuckDbFromPlan(plan) {
  const sound = plan.meta && plan.meta.sound;
  return sound && sound.sfxDuckDb != null ? sound.sfxDuckDb : -6;
}

function sfxDuckDbFor(dir) {
  return sfxDuckDbFromPlan(loadPlan(dir));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
