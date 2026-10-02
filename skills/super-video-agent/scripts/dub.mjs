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
import { ffmpeg, probeDuration, probeVideoInfo, applyAtempo, snapToFrameGrid, nominalFps } from "./lib/ffmpeg.mjs";
import { measureMasterGain, TO_STEREO } from "./lib/audio-mix.mjs";
import { buildDuckVolumeExpr } from "./lib/duck.mjs";
import { decodeMonoPcm, rmsWindow } from "./lib/audio-analysis.mjs";
import { fitAllLines, buildPlacedTimings, computeSlots, trimEdgeSilence } from "./lib/dub-timing.mjs";
import { levelLineWav } from "./lib/line-level.mjs";
import { reportLineFill, formatFillWarnings } from "./lib/dub-fill.mjs";
import {
  computeGapDeltas,
  buildTimeMap,
  remapTimings,
  segmentFactors,
  buildSpaceFilterGraph,
  buildSpaceFfmpegArgs,
  formatSpaceReport,
} from "./lib/dub-space.mjs";
import { gateAvSync, pointLatest, timestamp, sfxDuckDbFromPlan } from "./render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `usage: dub.mjs <reel-dir> --lang <code> [--min-gap <sec>]

Lays a language version over a picture-first render (render.mjs
--no-captions). <reel-dir>/dub/<code>/ holds plan.json (same line ids as
the base plan, that language's text/say, meta.voice, meta.lang) and voice/
(made by voice.mjs <reel-dir>/dub/<code>). The base language is dubbed the
same way — dub/<base-lang>/ may simply copy the base plan.json and voice/.

Each dub line's own take has its edge silence trimmed first (leading/
trailing only — an internal pause is never touched), then is placed at its
base line's slot (base line start -> next base line start, the last line ->
the film's end). A line longer than its slot is sped up (atempo) up to
1.2x; a line still too long at 1.2x fails, naming the line id and by how
much, instead of cutting audio or moving the picture — shorten the line in
that language's script.

--min-gap <sec>: for every slot except the last whose gap after the
placed line is under <sec>, slow that slot's picture (setpts) and bed
(atempo) so the gap reaches <sec>; the voice keeps its speed. Writes
dub/<code>/spaced/picture.mp4, picture.bed.wav and picture.timings.json
(lines and words remapped) and uses them for this language's final. Prints
each slot's delta and factor and the old -> new length. First and last
frames are unchanged.

Picture: out/picture-<code>.mp4 (render.mjs --no-captions --lang <code>) when
it exists, else out/picture.mp4. The output says which one it used.

Writes out/final-<code>-<YYYYMMDD-HHMMSS>.mp4 + out/final-<code>.mp4.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0 || typeof flags.lang !== "string") {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const lang = flags.lang;
  let minGap = null;
  if (flags["min-gap"] !== undefined) {
    minGap = Number(flags["min-gap"]);
    if (!Number.isFinite(minGap) || minGap <= 0) fail(`--min-gap needs a positive number of seconds, got "${flags["min-gap"]}"`);
  }
  try {
    const result = await dub({ dir, lang, minGap });
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

export async function dub({ dir, lang, minGap = null }) {
  const paths = reelPaths(dir);
  const dubDir = path.join(dir, "dub", lang);
  const dubVoiceDir = path.join(dubDir, "voice");
  const picked = pickPictureFiles(paths.outDir, lang);
  let pictureMp4 = picked.pictureMp4;
  let pictureBedWav = picked.bedWav;
  const pictureTimingsJson = picked.timingsJson;
  const dubTimingsPath = path.join(dubVoiceDir, "timings.json");

  requireFile(pictureMp4, `no ${pictureMp4} — run render.mjs ${dir} --no-captions first`);
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
    // Trim each take's own leading/trailing silence before it is ever
    // measured for the slot fit below — otherwise a take's edge silence
    // (not its actual speech) can push it over the 1.2x atempo cap.
    const trims = await trimDubClips({ dubTimings, dubVoiceDir, workDir });
    for (const [id, t] of trims) {
      process.stdout.write(`line "${id}" trimmed: lead ${t.leadTrimSec.toFixed(3)}s, tail ${t.tailTrimSec.toFixed(3)}s\n`);
    }

    const clipDurations = new Map();
    for (const [id, t] of trims) clipDurations.set(id, t.trimmedDurationSec);

    // The dub line's own word times are still on the untrimmed clip's
    // timeline; shifting `start` forward by the removed lead makes
    // shiftAndScaleWords' "words minus this origin" land on the trimmed
    // clip's own timeline instead.
    const dubLines = (dubTimings.lines || []).map((l) => {
      const t = trims.get(l.id);
      return t && t.leadTrimSec > 0 ? { ...l, start: l.start + t.leadTrimSec } : l;
    });

    let fit = fitOrThrow(baseTimings, dubLines, clipDurations);

    // --min-gap: from here on this language's final uses the widened
    // picture, bed and timings; the lines are fitted again to the new slots.
    if (minGap != null) {
      const spaced = await spaceSlots({ dubDir, pictureMp4, pictureBedWav, baseTimings, fit, minGap });
      if (spaced) {
        ({ pictureMp4, pictureBedWav, baseTimings } = spaced);
        fit = fitOrThrow(baseTimings, dubLines, clipDurations);
      }
    }

    // Report only — a poor fill or a line that needed atempo means the
    // script's wording doesn't match the picture's pace in this language; the
    // film is still written either way (references/pipeline.md "Picture first").
    const fillReport = reportLineFill(fit.lines, computeSlots(baseTimings.lines, baseTimings.duration), baseTimings.lines);
    const fillWarning = formatFillWarnings(fillReport);
    if (fillWarning) process.stdout.write(fillWarning);

    // Written before trying the reel's own caption layer, so a page that
    // supports ?layer=captions&dub=<lang> (declares "captions" in
    // __reel.layers) has this file ready to load.
    writeJson(path.join(dubDir, "timings.placed.json"), buildPlacedTimings(fit.lines, baseTimings.duration, dubPlan.meta.lang || null));

    const meta = await probeVideoInfo(pictureMp4);
    const fps = nominalFps(meta.fps);
    // A picture from an older render may sit a few ticks off the frame grid
    // with its last frame held long; the overlay would then add a frame.
    // Re-stamping is lossless (-c copy), so it runs on every picture.
    const gridPictureMp4 = path.join(workDir, "picture-grid.mp4");
    await snapToFrameGrid(pictureMp4, gridPictureMp4, fps);
    const placedClips = await placeLineClips({ fit, trims, workDir });

    const captionsDir = path.join(workDir, "captions");
    ensureDir(captionsDir);
    const ownLayer = await tryOwnCaptionLayer({
      reelDir: dir,
      lang,
      duration: baseTimings.duration,
      fps,
      framesDir: captionsDir,
    });
    let captionNote;
    if (ownLayer.ok) {
      captionNote = null;
    } else {
      captionNote = await renderCaptionLayer({
        reelDir: dir,
        reelHtmlPath: paths.reelHtml,
        lines: fit.lines,
        duration: baseTimings.duration,
        width: meta.width,
        height: meta.height,
        fps,
        framesDir: captionsDir,
      });
      if (ownLayer.note) captionNote = captionNote ? `${ownLayer.note} ${captionNote}` : ownLayer.note;
    }

    const videoNoAudioPath = path.join(workDir, "video-captioned.mp4");
    await overlayCaptions({ pictureMp4: gridPictureMp4, captionsDir, fps, outPath: videoNoAudioPath });

    const audioPath = path.join(workDir, "audio-final.wav");
    const sfxDuckDb = sfxDuckDbFromPlan(dubPlan);
    await mixDubAudio({
      placedClips,
      bedPath: pictureBedWav,
      narrationWindows: fit.lines.map((l) => ({ start: l.start, end: l.end })),
      duckDb: sfxDuckDb,
      durationSec: baseTimings.duration,
      outPath: audioPath,
    });

    const expectedFrames = Math.round(baseTimings.duration * fps);
    await gateAvSync({ videoOnlyPath: videoNoAudioPath, narrationPath: audioPath, expectedFrames });

    const stampedPath = path.join(paths.outDir, `final-${lang}-${timestamp()}.mp4`);
    await muxVideoAudio({ videoPath: videoNoAudioPath, audioPath, durationSec: baseTimings.duration, outPath: stampedPath });
    const outPath = pointLatest(paths.outDir, `final-${lang}.mp4`, stampedPath);

    return { outPath, stampedPath, lineCount: fit.lines.length, seconds: baseTimings.duration, captionNote };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** fitAllLines, throwing one message that names every line that does not fit. */
function fitOrThrow(baseTimings, dubLines, clipDurations) {
  const fit = fitAllLines(baseTimings.lines, dubLines, clipDurations, baseTimings.duration);
  if (fit.ok) return fit;
  const detail = fit.failures
    .map((f) =>
      f.requiredFactor == null
        ? `${f.id}: ${f.reason}`
        : `${f.id}: needs ${f.requiredFactor.toFixed(3)}x, max is ${f.maxAtempo}x — shorten this line's script`
    )
    .join("; ");
  throw new Error(`line(s) do not fit their slot: ${detail}`);
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

function requireFile(p, message) {
  if (!fs.existsSync(p)) throw new Error(message);
}

const EDGE_ENVELOPE_WINDOW_SEC = 0.01;

/**
 * 10ms RMS-in-dBFS windows across `wavPath`, in order — the envelope
 * trimEdgeSilence (scripts/lib/dub-timing.mjs) reads to find a take's
 * leading/trailing silence.
 * @returns {Promise<{startSec:number, endSec:number, rmsDb:number}[]>}
 */
export async function measureEdgeEnvelope(wavPath, opts = {}) {
  const sampleRate = opts.sampleRate ?? 48000;
  const samples = await decodeMonoPcm(wavPath, sampleRate);
  const winLen = Math.max(1, Math.round(sampleRate * EDGE_ENVELOPE_WINDOW_SEC));
  const windows = [];
  for (let i = 0; i < samples.length; i += winLen) {
    const rms = rmsWindow(samples, i, winLen);
    windows.push({
      startSec: i / sampleRate,
      endSec: Math.min(samples.length, i + winLen) / sampleRate,
      rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    });
  }
  return windows;
}

/**
 * Trims each dub line's own wav (dubVoiceDir/line-<id>.wav) down to its
 * measured speech, keeping trimEdgeSilence's pad on each side, into
 * workDir/trimmed-<id>.wav — the clip fitAllLines measures and
 * placeLineClips places, never the raw take. A line with no wav file (not
 * yet synthesized) is left out, same as before this trimming step existed;
 * fitAllLines reports it as "no measured clip duration".
 * @returns {Promise<Map<string, {leadTrimSec:number, tailTrimSec:number, trimmedDurationSec:number, trimmedPath:string}>>}
 */
async function trimDubClips({ dubTimings, dubVoiceDir, workDir }) {
  const trims = new Map();
  for (const l of dubTimings.lines || []) {
    const srcPath = path.join(dubVoiceDir, `line-${l.id}.wav`);
    if (!fs.existsSync(srcPath)) continue;
    const clipDurationSec = await probeDuration(srcPath);
    const envelope = await measureEdgeEnvelope(srcPath);
    const range = trimEdgeSilence(envelope, clipDurationSec);
    const trimmedPath = path.join(workDir, `trimmed-${l.id}.wav`);
    if (range.trimmedStartSec <= 0 && range.trimmedEndSec >= clipDurationSec) {
      fs.copyFileSync(srcPath, trimmedPath);
    } else {
      // Output-side -ss/-to (after -i): slower than input-side seeking, but
      // sample-accurate, which matters for a trim measured in milliseconds.
      await ffmpeg(["-y", "-i", srcPath, "-ss", String(range.trimmedStartSec), "-to", String(range.trimmedEndSec), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", trimmedPath]);
    }
    trims.set(l.id, {
      leadTrimSec: range.leadTrimSec,
      tailTrimSec: range.tailTrimSec,
      trimmedDurationSec: range.trimmedEndSec - range.trimmedStartSec,
      trimmedPath,
    });
  }
  return trims;
}

/** Copies (or atempo-speeds) each dub line's own trimmed wav (trimDubClips) to its fitted duration, levels it to one loudness (references/voice.md), unplaced (adelay happens in mixDubAudio). */
async function placeLineClips({ fit, trims, workDir }) {
  const placedClips = [];
  for (const line of fit.lines) {
    const srcPath = trims.get(line.id).trimmedPath;
    const placedPath = path.join(workDir, `placed-${line.id}.wav`);
    if (line.atempoFactor === 1) {
      fs.copyFileSync(srcPath, placedPath);
    } else {
      await applyAtempo(srcPath, placedPath, line.atempoFactor, { min: 1, max: 1.2 });
    }
    const leveled = await levelLineWav(placedPath);
    process.stdout.write(`line "${line.id}" leveled: ${leveled.beforeLufs == null ? "n/a" : leveled.beforeLufs.toFixed(1)} -> ${leveled.afterLufs == null ? "n/a" : leveled.afterLufs.toFixed(1)} LUFS\n`);
    placedClips.push({ id: line.id, path: placedPath, startSec: line.start });
  }
  return placedClips;
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
async function tryOwnCaptionLayer({ reelDir, lang, duration, fps, framesDir }) {
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
    const frameCount = Math.round(duration * fps);
    for (let frame = 0; frame < frameCount; frame++) {
      const png = await captureFrame(session.page, frame / fps);
      fs.writeFileSync(path.join(framesDir, frameFileName(frame)), png);
    }
    return { ok: true };
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
async function renderCaptionLayer({ reelDir, reelHtmlPath, lines, duration, width, height, fps, framesDir }) {
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
      const frameCount = Math.round(duration * fps);
      for (let frame = 0; frame < frameCount; frame++) {
        const png = await captureFrame(session.page, frame / fps);
        fs.writeFileSync(path.join(framesDir, frameFileName(frame)), png);
      }
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
