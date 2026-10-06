#!/usr/bin/env node
// Lays a language version over a picture-first render (render.mjs
// --no-captions; references/pipeline.md "Picture first and language
// versions"): <reel-dir>/dub/<code>/ holds plan.json (same line ids, that
// language's text/say, meta.voice, meta.lang) and voice/ (made by
// voice.mjs <reel-dir>/dub/<code>). Each dub line's own take is first
// trimmed of its own edge silence (scripts/lib/dub-timing.mjs
// trimEdgeSilence — a take's leading/trailing silence, not its speech,
// should never be what decides whether it fits its slot), then placed at
// its base line's slot, the bed is ducked
// against that placed narration (scripts/lib/duck.mjs), and a caption
// layer drawn with the engine's Reel.caption() is composited over the
// picture — never re-rendering the picture itself.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, loadPlan, readJson, writeJson, ensureDir } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame } from "./lib/browser.mjs";
import { ffmpeg, probeDuration, probeFrameCount, probeVideoInfo, snapToFrameGrid, nominalFps } from "./lib/ffmpeg.mjs";
import { measureMasterGain, TO_STEREO } from "./lib/audio-mix.mjs";
import { buildDuckVolumeExpr } from "./lib/duck.mjs";
import {
  fitFrozenLines,
  buildPlacedTimings,
  computeSlots,
  planCaptionSpans,
  langFrameRanges,
  promoteSharedSpan,
  shiftPlacedTimings,
  shiftSrt,
  formatTimeInsertReport,
} from "./lib/dub-timing.mjs";
import { reportLineFill, formatFillWarnings, formatFillTable, GAP_MIN_SEC, GAP_MAX_SHARE, GAP_MAX_FLOOR_SEC } from "./lib/dub-fill.mjs";
import { measureEdgeEnvelope } from "./lib/clip-trim.mjs";
import {
  MAX_SPEED_DEFAULT,
  trimVoiceClips,
  shiftForTrim,
  fitOrThrow,
  placeLineClips,
  buildNarrationTrack,
} from "./lib/fit-track.mjs";
import { measureNarrationGaps, formatSilenceReport, pictureGapPlan } from "./lib/silence-gate.mjs";
import { formatLeadReport } from "./lib/lead.mjs";

export { measureEdgeEnvelope };
import {
  computeGapDeltas,
  buildTimeMap,
  remapTimings,
  segmentFactors,
  buildSpaceFilterGraph,
  buildSpaceFfmpegArgs,
  formatSpaceReport,
  buildPlainSpanArgs,
  buildCaptionSpanArgs,
} from "./lib/dub-space.mjs";
import { gateAvSync, pointLatest, timestamp, sfxDuckDbFromPlan, concatMp4 } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `usage: dub.mjs <reel-dir> --lang <code> [--min-gap <sec>] [--max-speed <x>] [--table]
       dub.mjs <reel-dir> --lang <code> --audio-only [--audio-format m4a|wav] [--max-speed <x>]
       dub.mjs <reel-dir> --insert-time <sec> --seconds <n>

Lays a language version over a picture-first render (render.mjs
--no-captions). <reel-dir>/dub/<code>/ holds plan.json (same line ids as
the base plan, that language's text/say, meta.voice, meta.lang) and voice/
(made by voice.mjs <reel-dir>/dub/<code>). The base language is dubbed the
same way — dub/<base-lang>/ may simply copy the base plan.json and voice/.

The picture's time is the reference. Each dub line's own take is trimmed to
its voiced span plus 0.05 s head / 0.3 s tail (edges only — an internal
pause is never touched), then placed at its base line's slot (base line
start -> next base line start, the last line -> the film's end). A line
longer than its slot is sped up (atempo, pitch kept) by at most --max-speed
(default ${MAX_SPEED_DEFAULT}, 10%); at least 0.5 s of silence is kept after a line when the
slot has room, and the rest stays voice-free up to 1.0 s (a longer gap slows the line, down
to 0.95x). A line still too
long fails, naming the line id and by how much, instead of cutting audio or
moving the picture — shorten the line in that language's script and re-make
it. Then each line's silence after it is judged against its own scene's
allowed range, the same in every language: at least ${GAP_MIN_SEC} s, at most
${GAP_MAX_SHARE * 100}% of the slot (never under ${GAP_MAX_FLOOR_SEC} s). Under it the line is listed as
crammed, over it as sparse; a line sped up or past its slot is listed too. Afterwards the silence gate lists every pause over 1 s in the placed
narration with the line ids around it (a pause the picture itself has is
listed as planned).

--table: also print every line's fill, gap after, allowed range and state.

--max-speed <x>: the fastest a line may be sped up (default ${MAX_SPEED_DEFAULT}). Widen it only
when the user asks.

--min-gap <sec>: for every slot except the last whose gap after the
placed line is under <sec>, slow that slot's picture (setpts) and bed
(atempo) so the gap reaches <sec>; the voice keeps its speed. Writes
dub/<code>/spaced/picture.mp4, picture.bed.wav and picture.timings.json
(lines and words remapped) and uses them for this language's final. Prints
each slot's delta and factor and the old -> new length. First and last
frames are unchanged.

Picture: out/picture-<code>.mp4 (render.mjs --no-captions --lang <code>) when
it exists, else out/picture.mp4. The output says which one it used.

Writes out/final-<code>-<YYYYMMDD-HHMMSS>.mp4 + out/final-<code>.mp4. An output is
written under a unique temporary name first and only counts as the result after it
exists, is new, and has the picture's length; otherwise the run fails and nothing is
reported as written.

Shared spans: the picture is cut into language spans (a caption chunk, the last
caption's hold to the end, and any {start,end} the page lists in __reel.langSpans)
and language-neutral spans. A neutral span is encoded ONCE into out/shared-spans/
and reused by every language (stream-copied into the final); only the language
spans are captured and encoded per language. Samples inside neutral spans are
checked for language-drawn pixels; a span that has some is made a language span.
The run prints the split. A film with no neutral span of at least 1 s encodes whole.

--audio-only: write only the language's audio track, no caption capture and no video:
out/audio-<code>-<stamp>.m4a (AAC 192k; --audio-format wav for 48 kHz PCM) plus
out/audio-<code>.<ext> pointing at the newest. Its length is checked against the
picture's. Use it to add a language to a video that was already uploaded
(--replace-audio cannot: it requires the frozen caption text to be unchanged). Cannot
combine with --min-gap.

--insert-time <sec> --seconds <n>: a time insert (e.g. a title-card hold) at film
second <sec>. Moves every dub/<code>/timings.placed.json (lines, words, length) and
every .srt under out/ and dub/<code>/ later by <n> at once, then prints each
language's old -> new length and whether all languages are the same length. A line
or cue that straddles <sec> stops the run before anything is written. It does not
touch pictures, beds or audio: re-render the picture with the hold, then run dub
again per language. Use it before upload only — tracks already attached to a
published video would no longer match.

--replace-audio <final.mp4> --timings <frozen.json> --bed <clean-bed.wav>:
copy an existing captioned video's stream and replace only its audio.
Uses dub/<code>/plan.json and voice/. Caption text and line IDs must match
the frozen timings. Fits inside each frozen start/end window, never moves
the picture, and never renders captions. Supply a narration-free bed on
the same clock. Cannot combine with --min-gap. Writes a new revoice MP4
and timing sidecar; preserves the source video and frozen timings.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (typeof flags.table === "string") positional.unshift(flags.table);
  const inserting = flags["insert-time"] !== undefined;
  if (flags.help || flags.h || positional.length === 0 || (!inserting && typeof flags.lang !== "string")) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  if (inserting) return runTimeInsert(dir, flags);
  const lang = flags.lang;
  let minGap = null;
  if (flags["min-gap"] !== undefined) {
    minGap = Number(flags["min-gap"]);
    if (!Number.isFinite(minGap) || minGap <= 0) fail(`--min-gap needs a positive number of seconds, got "${flags["min-gap"]}"`);
  }
  let maxSpeed = MAX_SPEED_DEFAULT;
  if (flags["max-speed"] !== undefined) {
    maxSpeed = Number(flags["max-speed"]);
    if (!Number.isFinite(maxSpeed) || maxSpeed < 1) fail(`--max-speed needs a number of 1 or more, got "${flags["max-speed"]}"`);
  }
  try {
    const replacing = flags["replace-audio"] !== undefined;
    if (replacing && (minGap != null || !["replace-audio", "timings", "bed"].every(k => typeof flags[k] === "string"))) {
      throw new Error("--replace-audio requires --timings and --bed; --min-gap cannot change a frozen picture");
    }
    const audioOnly = flags["audio-only"] !== undefined;
    if (audioOnly && (replacing || minGap != null)) throw new Error("--audio-only cannot combine with --replace-audio or --min-gap");
    const audioFormat = flags["audio-format"] === undefined ? "m4a" : flags["audio-format"];
    if (!["m4a", "wav"].includes(audioFormat)) throw new Error(`--audio-format must be m4a or wav, got "${audioFormat}"`);
    const result = replacing
      ? await replaceDubAudio({ dir, lang, videoPath: abs(flags["replace-audio"]), timingsPath: abs(flags.timings), bedPath: abs(flags.bed), maxSpeed })
      : await dub({ dir, lang, minGap, maxSpeed, table: flags.table !== undefined, audioOnly, audioFormat });
    process.stdout.write(
      `wrote ${result.outPath}\n` +
        (result.captionNote ? `note: ${result.captionNote}\n` : "") +
        `lines: ${result.lineCount}  seconds: ${result.seconds.toFixed(3)}\n`
    );
  } catch (e) {
    fail(e.message);
  }
}

/**
 * The picture files a language's final is built on: out/picture-<lang>.mp4
 * (render.mjs --no-captions --lang <lang>) when it exists, else the base
 * out/picture.mp4. Its bed and timings are that language's own when they
 * exist, else the base ones (same clock).
 * @param {string} outDir
 * @param {string} lang
 * @param {(p: string) => boolean} [exists]
 * @returns {{source: "lang"|"base", pictureMp4: string, bedWav: string, timingsJson: string}}
 */
export function pickPictureFiles(outDir, lang, exists = fs.existsSync) {
  const own = (name) => path.join(outDir, `picture-${lang}${name}`);
  const base = (name) => path.join(outDir, `picture${name}`);
  const useLang = exists(own(".mp4"));
  const pick = (name) => (useLang && exists(own(name)) ? own(name) : base(name));
  return {
    source: useLang ? "lang" : "base",
    pictureMp4: useLang ? own(".mp4") : base(".mp4"),
    bedWav: pick(".bed.wav"),
    timingsJson: pick(".timings.json"),
  };
}

/** Replace narration in an already-captioned final video. All source files remain immutable. */
export async function replaceDubAudio({ dir, lang, videoPath, timingsPath, bedPath, maxSpeed = MAX_SPEED_DEFAULT }) {
  if (typeof lang !== "string" || !/^[\w-]+$/.test(lang)) throw new Error("invalid language code");
  const startedMs = Date.now();
  const paths = reelPaths(dir);
  const dubDir = path.join(dir, "dub", lang);
  const dubVoiceDir = path.join(dubDir, "voice");
  for (const file of [videoPath, timingsPath, bedPath]) requireFile(file, `missing ${file}; preserve the clean bed and frozen timings for audio replacement`);
  const frozen = readJson(timingsPath);
  const plan = loadPlan(dubDir);
  const voice = readJson(path.join(dubVoiceDir, "timings.json"));
  // Validate before using line IDs in paths or launching media processing.
  const placeholderDurations = new Map((frozen.lines || []).map(l => [l.id, l.end - l.start]));
  fitFrozenLines(frozen, plan.lines.map(l => ({ ...l, start: 0 })), placeholderDurations, maxSpeed);
  fitFrozenLines(frozen, voice.lines, placeholderDurations, maxSpeed);
  const meta = await probeVideoInfo(videoPath);
  const videoDuration = await probeDuration(videoPath);
  const bedDuration = await probeDuration(bedPath);
  const tolerance = 1 / meta.fps + 0.002;
  if (Math.abs(videoDuration - frozen.duration) > tolerance || Math.abs(bedDuration - frozen.duration) > tolerance) {
    throw new Error("video, clean bed and frozen timings must share the same clock");
  }
  ensureDir(paths.outDir);
  const workDir = fs.mkdtempSync(path.join(dubDir, ".revoice-work-"));
  try {
    const trims = await trimVoiceClips({ voiceTimings: voice, voiceDir: dubVoiceDir, workDir });
    const durations = new Map([...trims].map(([id, t]) => [id, t.trimmedDurationSec]));
    const shifted = shiftForTrim(voice.lines, trims);
    const fit = { lines: fitFrozenLines(frozen, shifted, durations, maxSpeed) };
    const clips = await placeLineClips({ fit, trims, workDir, maxSpeed });
    await verifyReplacementDurations(fit.lines, clips);
    const audioPath = path.join(workDir, "audio.wav");
    await mixDubAudio({ placedClips: clips, bedPath, narrationWindows: fit.lines,
      duckDb: sfxDuckDbFromPlan(plan), durationSec: frozen.duration, outPath: audioPath });
    const outPath = path.join(paths.outDir, `revoice-${lang}-${timestamp()}-${crypto.randomBytes(4).toString("hex")}.mp4`);
    await muxVideoAudio({ videoPath, audioPath, durationSec: videoDuration, outPath });
    await verifyFreshOutput({ filePath: outPath, startedMs, expectedSec: videoDuration, toleranceSec: tolerance + 0.05 });
    writeJson(`${outPath}.json`, { sourceVideo: videoPath, frozenTimings: timingsPath, cleanBed: bedPath,
      videoMode: "stream-copy", ...buildPlacedTimings(fit.lines, frozen.duration, lang) });
    return { outPath, lineCount: fit.lines.length, seconds: videoDuration, captionNote: "Original captioned video stream copied; no browser render." };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** ffmpeg tempo may round clip lengths; reject overflow instead of clipping speech. */
async function verifyReplacementDurations(lines, clips) {
  for (let i = 0; i < lines.length; i++) {
    const duration = await probeDuration(clips[i].path);
    if (lines[i].start + duration > lines[i].slotEnd + 1 / 48000) {
      throw new Error(`line ${lines[i].id}: measured fitted audio exceeds frozen window; shorten a pause locally before replacing`);
    }
    lines[i].end = lines[i].start + duration;
  }
}

export async function dub({ dir, lang, minGap = null, maxSpeed = MAX_SPEED_DEFAULT, table = false, audioOnly = false, audioFormat = "m4a" }) {
  const startedMs = Date.now();
  const paths = reelPaths(dir);
  const dubDir = path.join(dir, "dub", lang);
  const dubVoiceDir = path.join(dubDir, "voice");
  const picked = pickPictureFiles(paths.outDir, lang);
  let pictureMp4 = picked.pictureMp4;
  let pictureBedWav = picked.bedWav;
  const pictureTimingsJson = picked.timingsJson;
  const dubTimingsPath = path.join(dubVoiceDir, "timings.json");

  if (!audioOnly) requireFile(pictureMp4, `no ${pictureMp4} — run render.mjs ${dir} --no-captions first`);
  requireFile(pictureBedWav, `no ${pictureBedWav} — run render.mjs ${dir} --no-captions first`);
  requireFile(pictureTimingsJson, `no ${pictureTimingsJson} — run render.mjs ${dir} --no-captions first`);
  process.stdout.write(
    picked.source === "lang"
      ? `picture: ${path.basename(pictureMp4)} (this language's own picture)\n`
      : `picture: ${path.basename(pictureMp4)} (base picture; no out/picture-${lang}.mp4)\n`
  );
  requireFile(path.join(dubDir, "plan.json"), `no ${path.join(dubDir, "plan.json")} — create dub/${lang}/plan.json with this reel's line ids, in ${lang}`);
  requireFile(dubTimingsPath, `no ${dubTimingsPath} — run voice.mjs ${dubDir} first`);

  let baseTimings = readJson(pictureTimingsJson);
  const dubPlan = loadPlan(dubDir);
  const dubTimings = readJson(dubTimingsPath);

  const workDir = path.join(dubDir, `.dub-work-${lang}`);
  ensureDir(workDir);
  try {
    // 1. trim: each take's own edge silence goes before it is measured for
    // the slot fit — otherwise a take's dead air (not its speech) eats the
    // speed allowance.
    const trims = await trimVoiceClips({ voiceTimings: dubTimings, voiceDir: dubVoiceDir, workDir });
    for (const [id, t] of trims) {
      process.stdout.write(`line "${id}" trimmed: lead ${t.leadTrimSec.toFixed(3)}s, tail ${t.tailTrimSec.toFixed(3)}s\n`);
    }

    const clipDurations = new Map();
    for (const [id, t] of trims) clipDurations.set(id, t.trimmedDurationSec);

    // The dub line's own word times are still on the untrimmed clip's
    // timeline; shiftForTrim moves `start` forward by the removed lead so
    // shiftAndScaleWords' "words minus this origin" lands on the trimmed
    // clip's own timeline.
    const dubLines = shiftForTrim(dubTimings.lines, trims);

    // 2. speed (at most maxSpeed) and 3. the voice-free gap: fitAllLines.
    const fitSlots = (timings) => fitOrThrow(timings.lines, dubLines, clipDurations, timings.duration, maxSpeed);
    let fit = fitSlots(baseTimings);

    // --min-gap: from here on this language's final uses the widened
    // picture, bed and timings; the lines are fitted again to the new slots.
    if (minGap != null) {
      const spaced = await spaceSlots({ dubDir, pictureMp4, pictureBedWav, baseTimings, fit, minGap });
      if (spaced) {
        ({ pictureMp4, pictureBedWav, baseTimings } = spaced);
        fit = fitSlots(baseTimings);
      }
    }

    // Report only — a poor fill or a line that needed atempo means the
    // script's wording doesn't match the picture's pace in this language; the
    // film is still written either way (references/pipeline.md "Picture first").
    const fillReport = reportLineFill(fit.lines, computeSlots(baseTimings.lines, baseTimings.duration), baseTimings.lines);
    const fillWarning = formatFillWarnings(fillReport);
    if (table) process.stdout.write(formatFillTable(fillReport));
    if (fillWarning) process.stdout.write(fillWarning);

    // Written before trying the reel's own caption layer, so a page that
    // supports ?layer=captions&dub=<lang> (declares "captions" in
    // __reel.layers) has this file ready to load.
    writeJson(path.join(dubDir, "timings.placed.json"), buildPlacedTimings(fit.lines, baseTimings.duration, dubPlan.meta.lang || null, baseTimings.lead));

    const placedClips = await placeLineClips({ fit, trims, workDir, maxSpeed });

    // Silence gate on the placed narration alone (the bed would hide a voice gap).
    const narrationOnly = path.join(workDir, "narration-only.wav");
    await buildNarrationTrack({ clips: placedClips, durationSec: baseTimings.duration, outPath: narrationOnly });
    const silence = await measureNarrationGaps(narrationOnly, fit.lines, pictureGapPlan(baseTimings.lines, dubPlan.lines));
    process.stdout.write(formatSilenceReport(silence));
    if (baseTimings.lead > 0) {
      process.stdout.write(formatLeadReport({ meta: { ...dubPlan.meta, lead: baseTimings.lead }, lines: dubPlan.lines }));
    }

    const audioPath = path.join(workDir, "audio-final.wav");
    await mixDubAudio({
      placedClips,
      bedPath: pictureBedWav,
      narrationWindows: fit.lines.map((l) => ({ start: l.start, end: l.end })),
      duckDb: sfxDuckDbFromPlan(dubPlan),
      durationSec: baseTimings.duration,
      outPath: audioPath,
    });
    if (audioOnly) {
      return await writeAudioTrack({ audioPath, outDir: paths.outDir, lang, format: audioFormat, startedMs, durationSec: baseTimings.duration, lineCount: fit.lines.length });
    }

    const meta = await probeVideoInfo(pictureMp4);
    const fps = nominalFps(meta.fps);
    // A picture from an older render may sit a few ticks off the frame grid
    // with its last frame held long; the overlay would then add a frame.
    // Re-stamping is lossless (-c copy), so it runs on every picture.
    const gridPictureMp4 = path.join(workDir, "picture-grid.mp4");
    await snapToFrameGrid(pictureMp4, gridPictureMp4, fps);
    const { videoPath: videoNoAudioPath, captionNote } = await buildCaptionedVideo({
      dir, paths, lang, fit, baseTimings, meta, fps, pictureMp4, gridPictureMp4, workDir,
    });

    const expectedFrames = Math.round(baseTimings.duration * fps);
    await gateAvSync({ videoOnlyPath: videoNoAudioPath, narrationPath: audioPath, expectedFrames });

    const tempPath = uniqueTempPath(paths.outDir, `final-${lang}`, ".mp4");
    await muxVideoAudio({ videoPath: videoNoAudioPath, audioPath, durationSec: baseTimings.duration, outPath: tempPath });
    const stampedPath = await publishFresh({ tempPath, outDir: paths.outDir, stem: `final-${lang}-${timestamp()}`, ext: ".mp4", startedMs, expectedSec: baseTimings.duration, toleranceSec: 1 / fps + 0.05 });
    const outPath = pointLatest(paths.outDir, `final-${lang}.mp4`, stampedPath);

    return { outPath, stampedPath, lineCount: fit.lines.length, seconds: baseTimings.duration, captionNote };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * --min-gap: widens every slot (but the last) whose placed line leaves
 * less than `minGap` of silence, by slowing that slot's picture and bed
 * (scripts/lib/dub-space.mjs). Writes dub/<code>/spaced/picture.mp4,
 * picture.bed.wav and picture.timings.json (remapped lines and words) in
 * one ffmpeg call. Returns null when no slot needs widening — the base
 * picture is used as is.
 */
async function spaceSlots({ dubDir, pictureMp4, pictureBedWav, baseTimings, fit, minGap }) {
  const deltas = computeGapDeltas(baseTimings.lines, fit.lines, minGap);
  if (!deltas.some((d) => d.delta > 0)) {
    process.stdout.write(`min-gap: every gap is already ${minGap}s or more — picture unchanged\n`);
    return null;
  }
  const map = buildTimeMap(baseTimings.lines, baseTimings.duration, deltas.map((d) => d.delta));
  const { fps } = await probeVideoInfo(pictureMp4);
  const spacedDir = path.join(dubDir, "spaced");
  ensureDir(spacedDir);
  const out = {
    pictureMp4: path.join(spacedDir, "picture.mp4"),
    pictureBedWav: path.join(spacedDir, "picture.bed.wav"),
    baseTimings: remapTimings(baseTimings, map),
  };
  const graph = buildSpaceFilterGraph(segmentFactors(map), fps, map.newDuration);
  const frameCount = Math.round(map.newDuration * fps);
  await ffmpeg(buildSpaceFfmpegArgs({ pictureMp4, bedWav: pictureBedWav, outMp4: out.pictureMp4, outWav: out.pictureBedWav, graph, frameCount }));
  writeJson(path.join(spacedDir, "picture.timings.json"), out.baseTimings);
  process.stdout.write(formatSpaceReport(deltas, map, baseTimings.lines));
  return out;
}

/** A temp name no earlier run can own: hidden, with a microsecond clock and the pid. */
export function uniqueTempPath(dir, stem, ext) {
  const micros = process.hrtime.bigint() / 1000n;
  return path.join(dir, `.${stem}.${Date.now()}-${micros}-${process.pid}${ext}`);
}

/**
 * An output counts only when it exists, is non-empty, was written during
 * this run and has the expected length. Anything else is deleted and fails
 * the step, so an older file at the same place is never reported as success.
 */
export async function verifyFreshOutput({ filePath, startedMs, expectedSec, toleranceSec }) {
  try {
    const st = fs.statSync(filePath);
    if (st.size === 0) throw new Error(`${filePath} is empty`);
    if (st.mtimeMs < startedMs - 1000) throw new Error(`${filePath} is older than this run; an old file is not a result`);
    const seconds = await probeDuration(filePath);
    if (Math.abs(seconds - expectedSec) > toleranceSec) {
      throw new Error(`${filePath} is ${seconds.toFixed(3)}s, expected ${expectedSec.toFixed(3)}s`);
    }
    return seconds;
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    throw e.code === "ENOENT" ? new Error(`the encoder reported success but ${filePath} was not written`) : e;
  }
}

/** Verifies a temp output, then moves it to its final name (a -2, -3 … suffix when that name is taken). */
export async function publishFresh({ tempPath, outDir, stem, ext, startedMs, expectedSec, toleranceSec }) {
  await verifyFreshOutput({ filePath: tempPath, startedMs, expectedSec, toleranceSec });
  let finalPath = path.join(outDir, `${stem}${ext}`);
  for (let n = 2; fs.existsSync(finalPath); n++) finalPath = path.join(outDir, `${stem}-${n}${ext}`);
  fs.renameSync(tempPath, finalPath);
  return finalPath;
}

/** --audio-only: the language's mixed narration + bed as its own track (AAC .m4a or 48 kHz PCM .wav). */
async function writeAudioTrack({ audioPath, outDir, lang, format, startedMs, durationSec, lineCount }) {
  ensureDir(outDir);
  const ext = `.${format}`;
  const tempPath = uniqueTempPath(outDir, `audio-${lang}`, ext);
  const codec = format === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  await ffmpeg(["-y", "-i", audioPath, "-vn", ...codec, "-t", String(durationSec), tempPath]);
  const stampedPath = await publishFresh({ tempPath, outDir, stem: `audio-${lang}-${timestamp()}`, ext, startedMs, expectedSec: durationSec, toleranceSec: 0.1 });
  const outPath = pointLatest(outDir, `audio-${lang}${ext}`, stampedPath);
  const measured = await probeDuration(stampedPath);
  const note = `audio track only; length ${measured.toFixed(3)}s against the picture's ${durationSec.toFixed(3)}s`;
  return { outPath, stampedPath, lineCount, seconds: durationSec, captionNote: note };
}

/** Frame numbers to sample inside a span: about every 2 s, plus its last frame. */
function probeFramesOf(span, fps) {
  const step = Math.max(1, Math.round(2 * fps));
  const frames = [];
  for (let f = span.startFrame; f < span.endFrame; f += step) frames.push(f);
  frames.push(span.endFrame - 1);
  return frames;
}

/** True when the caption PNG has any non-transparent pixel. */
export async function pngDrawsPixels(png) {
  const { stdout } = await ffmpeg(["-i", "pipe:0", "-vf", "format=rgba,alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { input: png });
  return stdout.some((b) => b !== 0);
}

async function captureRanges(page, framesDir, ranges, fps) {
  for (const [from, to] of ranges) {
    for (let frame = from; frame < to; frame++) {
      fs.writeFileSync(path.join(framesDir, frameFileName(frame)), await captureFrame(page, frame / fps));
    }
  }
}

async function spanDrawsPixels(page, span, fps) {
  for (const frame of probeFramesOf(span, fps)) {
    if (await pngDrawsPixels(await captureFrame(page, frame / fps))) return true;
  }
  return false;
}

/**
 * Samples every language-neutral span; one with a language-drawn pixel (a
 * label the page did not list in __reel.langSpans) becomes a language span
 * and its frames are captured. Reported, never silently dropped.
 */
async function settleSharedSpans({ page, framesDir, plan, fps }) {
  const checked = new Set();
  for (let i = 0; i < plan.spans.length; ) {
    const span = plan.spans[i];
    const key = `${span.startFrame}-${span.endFrame}`;
    if (span.kind === "lang" || checked.has(key)) {
      i++;
      continue;
    }
    if (!(await spanDrawsPixels(page, span, fps))) {
      checked.add(key);
      i++;
      continue;
    }
    process.stdout.write(`span ${span.startFrame}-${span.endFrame}: the caption layer draws here although no line or langSpans entry covers it; encoded per language\n`);
    await captureRanges(page, framesDir, [[span.startFrame, span.endFrame]], fps);
    plan = promoteSharedSpan(plan, i);
    i = 0;
  }
  return plan;
}

/** The {start,end} spans a page lists in __reel.langSpans (language-drawn labels that are not captions). */
async function declaredLangSpans(page) {
  const raw = await page.evaluate(() => (Array.isArray(window.__reel && window.__reel.langSpans) ? window.__reel.langSpans : []));
  return raw.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
}

/** One line: how the film splits into language and shared spans. */
function formatSpanReport(plan, fps) {
  const sec = (frames) => (frames / fps).toFixed(1);
  const n = (kind) => plan.spans.filter((s) => s.kind === kind).length;
  return (
    `spans: ${n("lang")} language (${sec(plan.langFrames)}s captured and encoded for this language), ` +
    `${n("shared")} shared (${sec(plan.sharedFrames)}s built once, stream-copied into every language)\n`
  );
}

/** Caption layer + picture -> a video-only file; language-neutral spans come from the shared cache. */
async function buildCaptionedVideo({ dir, paths, lang, fit, baseTimings, meta, fps, pictureMp4, gridPictureMp4, workDir }) {
  const captionsDir = path.join(workDir, "captions");
  ensureDir(captionsDir);
  const duration = baseTimings.duration;
  const planFor = (labelSpans) => planCaptionSpans({ lines: fit.lines, duration, fps, labelSpans });
  const ownLayer = await tryOwnCaptionLayer({ reelDir: dir, lang, fps, framesDir: captionsDir, planFor });
  let plan = ownLayer.plan;
  let captionNote = null;
  if (!ownLayer.ok) {
    plan = planFor([]);
    captionNote = await renderCaptionLayer({
      reelDir: dir, reelHtmlPath: paths.reelHtml, lines: fit.lines, duration, width: meta.width, height: meta.height,
      fps, framesDir: captionsDir, ranges: langFrameRanges(plan),
    });
    if (ownLayer.note) captionNote = captionNote ? `${ownLayer.note} ${captionNote}` : ownLayer.note;
  }
  process.stdout.write(formatSpanReport(plan, fps));
  const videoPath = path.join(workDir, "video-captioned.mp4");
  if (plan.sharedFrames === 0) await overlayCaptions({ pictureMp4: gridPictureMp4, captionsDir, fps, outPath: videoPath });
  else await assembleSpans({ plan, pictureMp4, gridPictureMp4, captionsDir, fps, workDir, outDir: paths.outDir, outPath: videoPath });
  return { videoPath, captionNote };
}

/** Identity of the picture plus the encoder settings: a shared span built from other input or settings is never reused. */
function sharedSpanKey(pictureMp4, fps) {
  const st = fs.statSync(pictureMp4);
  const settings = buildPlainSpanArgs({ pictureMp4: "", startFrame: 0, endFrame: 0, fps, outPath: "" });
  return crypto.createHash("sha1").update(JSON.stringify([path.resolve(pictureMp4), st.size, st.mtimeMs, fps, settings])).digest("hex").slice(0, 16);
}

/** One language-neutral span, from out/shared-spans/ when an earlier language already built it. */
async function sharedSpanFile({ span, key, pictureMp4, gridPictureMp4, fps, sharedDir }) {
  const frames = span.endFrame - span.startFrame;
  const cached = path.join(sharedDir, `${key}-${span.startFrame}-${span.endFrame}.mp4`);
  if (fs.existsSync(cached) && (await probeFrameCount(cached)) === frames) return { file: cached, reused: true };
  const tempPath = uniqueTempPath(sharedDir, `span-${key}`, ".mp4");
  try {
    await ffmpeg(buildPlainSpanArgs({ pictureMp4: gridPictureMp4, startFrame: span.startFrame, endFrame: span.endFrame, fps, outPath: tempPath }));
    if ((await probeFrameCount(tempPath)) !== frames) throw new Error(`shared span ${span.startFrame}-${span.endFrame} came out with the wrong frame count`);
    fs.renameSync(tempPath, cached);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return { file: cached, reused: false };
}

/** Encodes language spans, takes shared spans from the cache, joins all without re-encoding. */
export async function assembleSpans({ plan, pictureMp4, gridPictureMp4, captionsDir, fps, workDir, outDir, outPath }) {
  const sharedDir = path.join(outDir, "shared-spans");
  ensureDir(sharedDir);
  const key = sharedSpanKey(pictureMp4, fps);
  const files = [];
  for (const [i, span] of plan.spans.entries()) {
    if (span.kind === "lang") {
      const file = path.join(workDir, `span-${i}.mp4`);
      await ffmpeg(buildCaptionSpanArgs({ pictureMp4: gridPictureMp4, captionsDir, startFrame: span.startFrame, endFrame: span.endFrame, fps, outPath: file }));
      files.push(file);
      continue;
    }
    const shared = await sharedSpanFile({ span, key, pictureMp4, gridPictureMp4, fps, sharedDir });
    process.stdout.write(`shared span ${span.startFrame}-${span.endFrame}: ${shared.reused ? "reused" : "built"}\n`);
    files.push(shared.file);
  }
  await concatMp4(files, outPath, fps);
  const frames = await probeFrameCount(outPath);
  if (frames !== plan.totalFrames) throw new Error(`joined spans have ${frames} frames, expected ${plan.totalFrames}`);
}

const SRT_NAME = /\.srt$/i;

function srtFilesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => SRT_NAME.test(f)).map((f) => path.join(dir, f));
}

/** Which language an .srt belongs to: its dub/<code>/ folder, else a "-<code>.srt" / ".<code>.srt" file name. */
function srtLang(file, dubDir, codes) {
  const parent = path.basename(path.dirname(file));
  if (path.dirname(path.dirname(file)) === dubDir && codes.includes(parent)) return parent;
  const base = path.basename(file).replace(SRT_NAME, "");
  return codes.find((c) => base === c || base.endsWith(`-${c}`) || base.endsWith(`.${c}`) || base.endsWith(`_${c}`)) || null;
}

/**
 * A time insert (a title-card hold, say) at film second `at` of `seconds`:
 * every dub/<code>/timings.placed.json and every .srt under out/ and
 * dub/<code>/ moves later together. All inputs are shifted in memory first;
 * a straddling line or cue stops the run before anything is written.
 * @returns {{text: string, equal: boolean, rows: object[], unassignedSrt: string[]}}
 */
export function insertTime({ dir, at, seconds }) {
  const paths = reelPaths(dir);
  const dubDir = path.join(dir, "dub");
  const codes = fs.existsSync(dubDir)
    ? fs.readdirSync(dubDir).filter((c) => fs.existsSync(path.join(dubDir, c, "timings.placed.json")))
    : [];
  if (!codes.length) throw new Error(`no dub/<code>/timings.placed.json under ${dir}; run dub.mjs for each language first`);
  const writes = [];
  const rows = codes.map((lang) => {
    const file = path.join(dubDir, lang, "timings.placed.json");
    const before = readJson(file);
    let shifted;
    try { shifted = shiftPlacedTimings(before, at, seconds); } catch (e) { throw new Error(`${lang}: ${e.message}`); }
    writes.push([file, `${JSON.stringify(shifted, null, 2)}\n`]);
    return { lang, before: before.duration, after: shifted.duration, lines: shifted.lines.filter((l, i) => l !== before.lines[i]).length, srt: 0 };
  });
  const unassignedSrt = [];
  const srtFiles = [...srtFilesIn(paths.outDir), ...codes.flatMap((c) => srtFilesIn(path.join(dubDir, c)))];
  for (const file of srtFiles) {
    let result;
    try { result = shiftSrt(fs.readFileSync(file, "utf8"), at, seconds); } catch (e) { throw new Error(`${file}: ${e.message}`); }
    writes.push([file, result.text]);
    const lang = srtLang(file, dubDir, codes);
    if (lang) rows.find((r) => r.lang === lang).srt += result.shifted;
    else unassignedSrt.push(`${file} (${result.shifted} cues moved)`);
  }
  for (const [file, text] of writes) {
    const tmp = uniqueTempPath(path.dirname(file), path.basename(file), ".tmp");
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  const report = formatTimeInsertReport(rows);
  const extra = unassignedSrt.length ? `SRT files not tied to a language:\n${unassignedSrt.map((s) => `  ${s}`).join("\n")}\n` : "";
  return { text: report.text + extra, equal: report.equal, rows, unassignedSrt };
}

function runTimeInsert(dir, flags) {
  const at = typeof flags["insert-time"] === "string" ? Number(flags["insert-time"]) : NaN;
  const seconds = typeof flags.seconds === "string" ? Number(flags.seconds) : NaN;
  if (!Number.isFinite(at) || at < 0) fail("--insert-time needs the film second to insert at (0 or more)");
  if (!Number.isFinite(seconds) || seconds <= 0) fail("--insert-time needs --seconds <n>, a positive number");
  try {
    process.stdout.write(`time insert: ${seconds}s at ${at}s\n${insertTime({ dir, at, seconds }).text}`);
  } catch (e) {
    fail(e.message);
  }
}

function requireFile(p, message) {
  if (!fs.existsSync(p)) throw new Error(message);
}

/** True when reel.html's own scene code calls Reel.caption() directly (the SCENE block, not the inlined engine). */
function sceneUsesEngineCaption(reelHtmlPath) {
  if (!fs.existsSync(reelHtmlPath)) return false;
  const html = fs.readFileSync(reelHtmlPath, "utf8");
  const start = html.indexOf("/* SCENE:BEGIN */");
  const end = html.indexOf("/* SCENE:END */");
  const scene = start !== -1 && end !== -1 && end > start ? html.slice(start, end) : html;
  return /Reel\.caption\s*\(/.test(scene);
}

function frameFileName(index) {
  return `frame-${String(index).padStart(5, "0")}.png`;
}

/**
 * Tries to capture the caption layer from reel.html itself
 * (?layer=captions&dub=<lang>): a page that supports it draws its own
 * caption look (e.g. word-by-word highlight, emphasis colours) instead of
 * the engine's default Reel.caption() box. Requires dub/<lang>/timings.placed.json
 * (written by the caller before this runs) and declares support via
 * `"captions"` in `__reel.layers`. A film's own caption code decides what
 * per-language fields it needs from dub/<lang>/plan.json (e.g. an
 * `emphasis` word list keyed to that language's words) — that is the film
 * author's job, not dub.mjs's.
 * @returns {Promise<{ok:boolean, note?:string}>}
 */
async function tryOwnCaptionLayer({ reelDir, lang, fps, framesDir, planFor }) {
  const server = await serveDir(reelDir);
  let session;
  try {
    const url = `${server.url}?layer=captions&dub=${encodeURIComponent(lang)}`;
    session = await openReel(url, {});
    if (!(session.meta.layers || []).includes("captions")) {
      return {
        ok: false,
        note:
          'reel.html does not declare "captions" in __reel.layers — it cannot draw its own caption layer yet (references/pipeline.md "Picture first").',
      };
    }
    // Only the language spans are drawn; a probe then checks the rest is blank.
    let plan = planFor(await declaredLangSpans(session.page));
    await captureRanges(session.page, framesDir, langFrameRanges(plan), fps);
    plan = await settleSharedSpans({ page: session.page, framesDir, plan, fps });
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, note: `reel.html's own caption layer failed to load (${e.message.split("\n")[0]}) — fell back to the default look.` };
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/**
 * A small standalone page (engine inlined, same fonts as the reel) whose
 * only draw is Reel.caption() for the dub's placed lines — captured as one
 * PNG-with-alpha per frame. Never touches reel.html's own scene code, so
 * the picture is never re-rendered. Used only when the reel does not
 * support drawing its own caption layer (tryOwnCaptionLayer above).
 * @returns {Promise<string|null>} a note when the reel's own scene draws
 *   captions another way (the engine's default look is used instead), or
 *   null when reel.html calls Reel.caption() itself (same look).
 */
async function renderCaptionLayer({ reelDir, reelHtmlPath, lines, duration, width, height, fps, framesDir, ranges }) {
  const captionNote = sceneUsesEngineCaption(reelHtmlPath)
    ? null
    : "reel.html's scene code does not call Reel.caption() directly — the caption layer uses the engine's default caption look, which may not match this film's own captions.";

  const engineSrc = fs.readFileSync(path.join(here, "engine", "reel-engine.js"), "utf8");
  const pageName = `.dub-caption-${crypto.randomUUID()}.html`;
  const pagePath = path.join(reelDir, pageName);
  fs.writeFileSync(pagePath, buildCaptionPageHtml({ engineSrc, width, height, fps, duration, lines }), "utf8");

  const server = await serveDir(reelDir);
  try {
    const session = await openReel(`${server.url}${pageName}`, { width, height });
    try {
      await captureRanges(session.page, framesDir, ranges, fps);
    } finally {
      await session.close();
    }
  } finally {
    await server.close();
    fs.rmSync(pagePath, { force: true });
  }
  return captionNote;
}

function buildCaptionPageHtml({ engineSrc, width, height, fps, duration, lines }) {
  const linesJson = JSON.stringify(lines.map((l) => ({ id: l.id, text: l.text, start: l.start, end: l.end })));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>dub caption layer</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  @font-face { font-family: 'Pretendard'; src: url('assets/fonts/Pretendard-Regular.otf'); font-weight: 400; font-style: normal; }
  @font-face { font-family: 'Pretendard'; src: url('assets/fonts/Pretendard-Bold.otf'); font-weight: 700; font-style: normal; }
</style></head>
<body>
<canvas id="stage" width="${width}" height="${height}"></canvas>
<script>${engineSrc}</script>
<script>
(function () {
  "use strict";
  var WIDTH = ${width}, HEIGHT = ${height}, FPS = ${fps}, DURATION = ${duration};
  var LINES = ${linesJson};
  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");

  function currentLine(t) {
    for (var i = 0; i < LINES.length; i++) {
      var l = LINES[i];
      if (t >= l.start && t < l.end) return l;
    }
    if (LINES.length && t >= LINES[LINES.length - 1].end) return LINES[LINES.length - 1];
    return null;
  }

  function seek(t) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT); // stays transparent — this layer is composited over the picture
    Reel.caption(ctx, currentLine(t), t, { width: WIDTH, height: HEIGHT });
  }

  function loadDeclaredFonts() {
    var faces = Array.from(document.fonts);
    return Promise.all(faces.map(function (face) {
      return face.load().catch(function () { return null; });
    })).then(function () { return document.fonts.ready; });
  }

  var ready = loadDeclaredFonts();

  window.__reel = {
    get width() { return WIDTH; },
    get height() { return HEIGHT; },
    get fps() { return FPS; },
    get duration() { return DURATION; },
    ready: ready,
    seek: seek,
    get shots() { return []; },
    issues: function () { return Reel.issues(); },
    audio: { narration: null },
    get marks() { return []; },
  };
})();
</script>
</body></html>
`;
}

/** Composites the alpha caption PNG sequence over the picture — video only, no audio. */
async function overlayCaptions({ pictureMp4, captionsDir, fps, outPath }) {
  await ffmpeg([
    "-y",
    "-i",
    pictureMp4,
    "-framerate",
    String(fps),
    "-i",
    path.join(captionsDir, "frame-%05d.png"),
    "-filter_complex",
    "[1:v]format=rgba[cap];[0:v][cap]overlay=format=auto[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outPath,
  ]);
}

/**
 * Places every dub line's (already fitted) clip at its slot start (adelay),
 * sums them into one narration track, ducks the bed against that same
 * narration (scripts/lib/duck.mjs — the language decides where speech is,
 * so the bed is ducked here, not in render.mjs's picture-first bed), mixes
 * narration + ducked bed, and two-pass masters to -16 LUFS (audio-mix.mjs
 * measureMasterGain) — the same loudness target render.mjs uses, as a
 * single static gain rather than dynamic loudnorm (a dynamic normalizer
 * ramps its gain up over the file, which is what made narration sound
 * quiet at the start and jump louder later even though every line wav had
 * already been leveled to -16 LUFS individually).
 */
export async function mixDubAudio({ placedClips, bedPath, narrationWindows, duckDb, durationSec, outPath }) {
  const duckFilter = buildDuckVolumeExpr(narrationWindows, { duckDb });
  const inputs = [...placedClips.map((c) => c.path), bedPath];
  const inputArgs = inputs.flatMap((p) => ["-i", p]);

  const lineStages = placedClips.map((c, i) => `[${i}:a]adelay=${Math.max(0, Math.round(c.startSec * 1000))}:all=1[ln${i}]`);
  const bedIdx = placedClips.length;
  // The bed keeps its own stereo (each cue's pan); the voice sits centred.
  // Both are padded to the picture's length so the bed after the last line
  // (the ending's sounds and music fade) is never cut.
  const pad = `apad=whole_dur=${durationSec}`;
  const bedStage = `[${bedIdx}:a]${TO_STEREO}${duckFilter ? `,${duckFilter}` : ""},${pad}[bed]`;
  const narrStage =
    placedClips.length > 1
      ? // normalize=0: each placed clip is already leveled to -16 LUFS
        // (levelLineWav); ffmpeg's default normalize=1 instead divides the
        // mix by however many of the N clips haven't yet reached EOF, and
        // since each clip is a few seconds long at its own adelay position,
        // that count falls line by line — measured directly, this is what
        // made narration sound quiet at the first line and louder at the
        // last (over 20dB, independent of any final mastering stage) even
        // though every line's own wav was already at -16 LUFS.
        `${placedClips.map((_, i) => `[ln${i}]`).join("")}amix=inputs=${placedClips.length}:duration=longest:dropout_transition=0:normalize=0,${TO_STEREO},${pad}[narr]`
      : `[ln0]${TO_STEREO},${pad}[narr]`;

  const premixComplex = [
    ...lineStages,
    bedStage,
    narrStage,
    `[narr][bed]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=end=${durationSec}[amixed];[amixed]anull[premaster]`,
  ].join(";");

  const premasterPath = `${outPath}.premaster.wav`;
  await ffmpeg(["-y", ...inputArgs, "-filter_complex", premixComplex, "-map", "[premaster]", "-c:a", "pcm_s16le", premasterPath]);
  let filter;
  try {
    ({ filter } = await measureMasterGain(premasterPath));
  } finally {
    fs.rmSync(premasterPath, { force: true });
  }

  const filterComplex = `${premixComplex};[premaster]${filter},apad[aout]`;
  await ffmpeg(["-y", ...inputArgs, "-filter_complex", filterComplex, "-map", "[aout]", "-c:a", "pcm_s16le", "-t", String(durationSec), outPath]);
}

async function muxVideoAudio({ videoPath, audioPath, durationSec, outPath }) {
  await ffmpeg([
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-t",
    String(durationSec),
    outPath,
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
