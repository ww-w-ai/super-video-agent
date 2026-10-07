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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, readJson, loadPlan, loadTimings } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, stubSeconds, stubSegmentCount, stubTimings, warmShotsOf, sessionPictureReads, mergePictureReads, glIssues, glReportLines, driftReportLines, parallaxReportLines } from "./lib/browser.mjs";
import { createSessionPool } from "./lib/session-pool.mjs";
import { createContrastCollector, measureDrawnFrame, reportRenderContrast } from "./lib/render-contrast.mjs";
import {
  run, ffmpeg, ffprobe, spawnImagePipeEncoder, probeDuration, probeVideoInfo,
  uniqueTempPath, concatMp4, sameStream, cutFrames, frameHashRange, probePacketCount, videoStreamMd5, probeGops, keyframeInterval,
} from "./lib/ffmpeg.mjs";
import { buildCueMixFilter, measureMasterGain, formatMasterCap, createWavPcm16Writer, TO_STEREO, endFadeFilter } from "./lib/audio-mix.mjs";
import { withTransportRetry } from "./lib/retry.mjs";
import { cueFadeFields } from "./lib/cues.mjs";
import { DUCK_DB_DEFAULT } from "./lib/duck.mjs";
import {
  computeSegments,
  probeFrameIndices,
  decideSegmentReuse,
  unknownOnlyIds,
  validateOnly,
  decideLangSegment,
  decideLangUnprobed,
  neighbourIds,
  pendingIds,
  parseEdl,
  entryCheckRanges,
} from "./lib/segments.mjs";
import { clipVersusPage } from "./lib/segment-verify.mjs";
import { draftsDir, draftSpan, draftSidecar, slotCut, reelStamp, slotProbeFrames, compareDraft } from "./lib/drafts.mjs";

const HELP = `usage: render.mjs <reel-dir> [--preview] [--workers N] [--only id,id [--handle <sec>]] [--plan] [--no-captions [--lang <code> [--probe-all]]]
                 [--stub <sec> [--segments N]] [--insert <clip.mp4>@<start-sec> [--insert-stills <dir>]] [--use-draft <id>]
                 [--span <from>-<to>[,<from>-<to>...]] [--assemble <edl.json>] [--fix-picture-duration] [--no-plan-cache]
       render.mjs <reel-dir> --no-captions [--lang <code>] --bed-only
       render.mjs <reel-dir> --check-pair [--lang <code>]

Renders <reel-dir>/reel.html by segment (one segment per tiled run of
window.__reel.shots), encoding each to out/segments/<quality>/<id>.mp4 and
joining them (concat demuxer, -c copy) into the video track, then muxing
voice/narration.wav (+ page SFX via __reel.audio.renderSfx, + any library
sound cues via __reel.soundCues()), mastered to -16 LUFS
with a single static gain (two-pass, not loudnorm), aac 192k.

--preview     half resolution, crf 28, preset veryfast -> out/preview-<YYYYMMDD-HHMMSS>.mp4
              (default: full resolution, crf 18, preset medium -> out/final-<YYYYMMDD-HHMMSS>.mp4)
              out/final.mp4 / out/preview.mp4 are symlinks to the newest render.
--workers N   probe/render up to N segments concurrently (separate browser
              sessions). Default 1.
--only id,id  re-render exactly these segments regardless of their probe
              hashes. The segment right before and right after each named
              one is probed: if its frames changed it is rendered too
              ("--only: also rendering <id> (its frames changed)"); an
              unchanged neighbour is reused. Every other segment is reused
              without probing. Refuses (no render happens) if a segment
              outside --only no longer matches its stored frame range.
              A segment outside --only that was never rendered (no stored
              segment yet) is skipped ("PENDING"), not probed: a first render
              can go part by part (--only a,b, then --only c,d, ...). The film
              is joined, gated and muxed only on the run that leaves no
              segment pending.
--handle <sec>
              with --only: renders each named shot as a separate draft clip,
              from (slot start - sec) to (slot end + sec) clamped to the film,
              to out/drafts/<id>.mp4 + <id>.json (slot start/end, handle, frames
              gained each side, the page stamp and three slot probe hashes it was
              drawn from; draft-check.mjs reports drafts stale against the page).
              The film is not joined and out/segments/ is
              not touched. Default 0: --only splices the full film as before.
--use-draft <id>
              puts out/drafts/<id>.mp4 in as the shot: the slot span is cut out
              of the handled clip (no page render) and spliced at the slot start
              like --insert. Needs the same --preview setting the draft had.
              Warns (does not stop) when the page stamp moved since the draft.
--plan        print REUSE/RENDER per segment and exit without rendering. The answer
              is cached in out/plan-cache.json: asking again with nothing changed
              (every file of the reel dir outside out/, the segment cache, the
              options) prints it without opening the page ("page opens: 0").
              --no-plan-cache probes again. Real renders never read the cache.
--assemble <edl.json> [--keep-assembled-copies]
              builds the film from existing runs of frames, no page frame is
              rendered. {"entries": [...]} in film order, each entry
              {"segment": "<id>"} (a cached segment mp4 of this quality) or
              {"src": "<clip.mp4>"} (relative to the reel dir), optionally
              "from"/"to" (frames of that clip, default all) and "new": true for
              frames that did not exist before (default true for a clip under
              out/drafts/). The entries must add up to the page's timeline. This
              is how a film is rebuilt when the timeline shifted: old segments are
              copied to their new place, new drafts are put in. Cuts: whole GOPs
              are packet-copied, only the frames up to the next keyframe are
              re-encoded; the join is a packet copy. The frame gate hashes (framemd5)
              only the new frames, re-encoded frames and the first/last two frames
              of each copied run, never the whole film. Afterwards the film's
              segments are cut back out into the cache with fresh probe hashes
              (the page is opened once, three frames per segment captured and
              compared with the copied frames; a segment whose copied frames
              differ from the page is reported and left out of the cache, so the
              next render draws it again), then
              the film is finished as a normal render (voiced film, or with
              --no-captions a picture + bed + timings). Not with --only, --insert,
              --use-draft, --handle, --span, --lang, --stub. With --plan: prints
              the entries and exits.
--bed-only    with --no-captions [--lang <code>]: rebuilds only the sound bed of
              the picture in out/. No picture frame is rendered or encoded: the
              picture file is linked under a new stamp, and its video stream md5
              must equal the old one's (the render stops otherwise). Writes
              out/picture-<stamp>.mp4 + .bed.wav, points picture.mp4 and
              picture.bed.wav at them and keeps picture.timings.json. Stops when
              the picture's frame count is not the page's timeline.
--span <from>-<to>[,<from>-<to>...]
              span render: only the frames between the given seconds, widened by
              0.5 s each side (frame grid, merged when they touch), are rendered
              from the page and spliced into the cached segments at exact frame
              cuts. Every other frame is reused from the cache, not probed. Use
              it when a few seconds changed: it never re-renders a whole shot.
              Each touched segment's cache (mp4 + probe hashes) is updated, so a
              later render reuses it. Needs every segment rendered once and
              their frame ranges unchanged, else it stops and names them. Not
              with --only, --insert, --use-draft, --handle or --probe-all. With
              --no-captions --lang <code> it redraws spans of that language's
              picture (out/segments-<code>/, which must hold every segment
              once: render --lang first; unchanged segments are copied from
              the base). The page gets that language's strings; a rebuilt
              segment keeps the strings its cached frames read and adds the
              ones the new frames read. Use it for in-scene text (langSpans
              in:"scene"): only those seconds are drawn again. With --plan:
              prints the span plan and exits.
--fix-picture-duration
              with --no-captions: when the picture length (the page's shots)
              differs from the timings duration by more than 50 ms the render
              stops and says which value is right (the picture length); this
              flag writes the picture length into out/picture.timings.json
              as its duration and continues. Refused without --no-captions
              and with --stub (there is no timings duration to fix).
--check-pair  checks out/picture.mp4, picture.bed.wav and picture.timings.json
              (with --lang <code>: the picture-<code> files) belong to one
              render and share one length; prints the findings and exits
              non-zero on a mismatch. A render interrupted between writing
              them can leave a mismatched pair: do not lay a dub over it.
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
--lang <code> with --no-captions: renders the picture for that dub language.
              The page gets Reel.lang = <code> and Reel.pictureText(key,
              fallback), which returns dub/<code>/plan.json
              meta.overlay.picture[key] when present, else fallback (a base
              render always returns fallback). Segments go to
              out/segments-<code>/<final|preview>-nocap/; a segment whose
              probe hashes equal the base segment's in out/segments/ is
              copied from it, not rendered. A base segment whose frames read
              no picture string this language sets (and never Reel.lang) is
              copied without probing: every render records, per segment, the
              strings its page read up to the end of that segment (load,
              warm-up, probes and earlier segments included, so a string read
              once and cached still counts). --probe-all probes every segment instead
              (e.g. after changing the page without re-rendering the base
              picture). Writes out/picture-<code>-<stamp>.mp4
              + out/picture-<code>.mp4, picture-<code>.bed.wav and
              picture-<code>.timings.json; dub.mjs --lang <code> uses them.
--stub <sec>  for a reel with no voice/timings.json: the page is served one
              silent line of <sec> seconds (id "stub"); nothing is written to
              voice/. With --no-captions, out/picture.timings.json then
              holds that stub clock. With captions on (optional, e.g. when a
              preview with the film's caption layer helps), the stub lines
              are empty, so no caption is drawn; there is no narration, so
              no A/V gate, and the page's own sound is the audio of
              out/<final|preview>-stub-<stamp>.mp4 (+ out/<final|preview>-stub.mp4).
--segments N  with --stub: N equal silent lines (ids stub-1..stub-N) instead
              of one, so the picture has N segments and --only stub-2 renders
              one of them.
--insert <clip.mp4>@<start-sec>
              puts an already rendered clip into the picture: frames from
              <start-sec> (rounded to the frame grid) for the clip's frame
              count are the clip's own frames. Segments the clip covers
              entirely are not rendered; a segment it covers in part keeps its
              remaining frames (whole GOPs packet-copied, only the frames up to the
              next keyframe re-encoded). The clip must have the reel's fps;
              a clip whose size or encoding differs from the segments is
              re-encoded to match first (said in the output). After the join
              the frame count and the framemd5 of the inserted span (equal to
              the clip's) are checked. picture.timings.json is kept as usual.
--insert-stills <dir>
              with --insert: also writes the clip's frames as JPEG stills to
              <dir>/frame-<film frame, 6 digits>.jpg plus <dir>/stills.json
              ({fps, startFrame, count, pattern}), so the page can draw the
              approved clip in previews and stills.

Every joined video track (picture, preview, final) is re-stamped onto the
exact 1/fps grid without re-encoding (frame hashes unchanged): a plain
-c copy join leaves timestamps a few ticks off at segment joins and the
last frame held long, so a later filter makes one frame too many. Frame
counts are read from the packets (nothing is decoded for a count gate).

Leftovers of crashed renders (temp names <name>-<microseconds>-<pid> in out/
and the segment caches whose pid is no longer running) are removed at the
start of a render, and listed.

A segment is reused only when its stored frame range, fps, size and three
probe-frame hashes (first/middle/last, sha256 of the captured PNG) all
match the current timeline and its .mp4 exists; otherwise it is
re-rendered. Every render prints one REUSE or RENDER line per segment with
the reason.

Caption contrast: a render with captions on (voice-first, real narration) measures, for up to
three frames per line it draws, the caption's colour against the picture behind its text box
as a WCAG contrast ratio (the same measure dub.mjs prints), in both directions (light on
light, dark on dark). The frame is drawn once more without captions
(window.Reel.setCaptionsOn(false)) and the pixels that differ are the caption; no screenshots.
Frames under 3:1 are LOW, under 4.5:1 marginal, per line id and time; rows go to
out/contrast.json. A report, never a stop. Segments reused from the cache are not drawn
again, so a fully cached render prints "checked nothing"; re-render the segments to measure.

One render opens the reel page once (once per --workers worker) and uses
that session for the shot list, the probes, the frames, the page sound and
the sound cues; its warm-up seeks only the shots it will capture. The last
line says how many times the page was opened.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (flags["check-pair"]) {
    await runCheckPair({ paths, lang: flags.lang === undefined ? null : flags.lang });
    return;
  }
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }
  const noCaptions = !!flags["no-captions"];
  let lang = null;
  if (flags.lang !== undefined) {
    if (!noCaptions) {
      fail("--lang renders a language's picture; add --no-captions");
      return;
    }
    if (!isLangCode(flags.lang)) {
      fail(`--lang takes a language code such as en or zh-Hans (got "${flags.lang}")`);
      return;
    }
    lang = flags.lang;
  }
  if (!noCaptions && flags.stub === undefined && !fs.existsSync(paths.narrationWav)) {
    fail(`no voice/narration.wav in ${dir} — run voice.mjs first`);
    return;
  }
  let stubSec;
  let stubSegments = 1;
  let insert;
  let handleSec = 0;
  let spans = null;
  let assemble = null;
  const bedOnly = !!flags["bed-only"];
  const keepAssembledCopies = flags["keep-assembled-copies"] === true;
  try {
    if (flags["fix-picture-duration"] !== undefined && (!noCaptions || flags.stub !== undefined)) {
      throw new Error("--fix-picture-duration fixes the length of a picture render's timings; use it with --no-captions and no --stub");
    }
    if (flags["keep-assembled-copies"] !== undefined && (!keepAssembledCopies || flags.assemble === undefined)) throw new Error("--keep-assembled-copies is a boolean option for --assemble only");
    spans = flags.span !== undefined ? parseSpanFlag(flags.span) : null;
    if (spans) assertWholeFilmFlags("span", flags);
    if (flags.assemble !== undefined) {
      if (typeof flags.assemble !== "string") throw new Error("--assemble takes an EDL file, e.g. --assemble edl.json");
      assertWholeFilmFlags("assemble", flags);
      assemble = abs(flags.assemble);
      if (!fs.existsSync(assemble)) throw new Error(`--assemble EDL not found: ${assemble}`);
    }
    if (bedOnly) {
      if (!noCaptions) throw new Error("--bed-only rebuilds a picture's sound bed; add --no-captions (a voiced film's mix is dub.mjs's)");
      assertWholeFilmFlags("bed-only", flags);
    }
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
    stubSegments = stubSegmentCount(flags.segments, stubSec);
    if (flags["probe-all"] !== undefined && !lang) throw new Error("--probe-all is for a language picture; add --no-captions --lang <code>");
    insert = flags.insert !== undefined ? parseInsertFlag(flags.insert) : null;
    if (flags["insert-stills"] !== undefined && !insert) throw new Error("--insert-stills needs --insert <clip.mp4>@<start-sec>");
    if (insert && flags["insert-stills"] !== undefined) {
      if (typeof flags["insert-stills"] !== "string") throw new Error("--insert-stills takes a directory");
      insert.stillsDir = abs(flags["insert-stills"]);
    }
    if (insert && !fs.existsSync(insert.clipPath)) throw new Error(`--insert clip not found: ${insert.clipPath}`);
    handleSec = parseHandleFlag(flags.handle);
    if (handleSec > 0 && typeof flags.only !== "string") throw new Error("--handle renders drafts of the shots named by --only id,id");
    if (flags["use-draft"] !== undefined) {
      if (insert) throw new Error("--use-draft and --insert both place a clip; use one");
      insert = await cutDraftSlot({ dir, paths, id: flags["use-draft"], preview: !!flags.preview });
    }
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
    const probeAll = !!flags["probe-all"];
    const fixPictureDuration = !!flags["fix-picture-duration"];
    const planCache = flags["no-plan-cache"] === undefined;
    const result = await render({ dir, paths, preview, workers, only, plan, noCaptions, stubSec, stubSegments, insert, lang, handleSec, probeAll, spans, fixPictureDuration, assemble, bedOnly, planCache, keepAssembledCopies });
    const elapsed = (Date.now() - started) / 1000;
    process.stdout.write(summaryLine(result, elapsed));
  } catch (e) {
    fail(e.message);
  }
}

/** The closing lines of a render: what was written, or why nothing was joined, and the page-open count. */
export function summaryLine(result, elapsed) {
  const opens = `page opens: ${result.pageOpens}\n`;
  if (result.draftsOnly) {
    const frames = result.drafts.reduce((n, d) => n + d.frameEnd - d.frameStart, 0);
    return `drafts: ${result.drafts.length} clip(s), ${frames} frames  render time: ${elapsed.toFixed(2)}s\n` + opens;
  }
  if (result.bedOnly) {
    return (
      `wrote ${result.bedPath}\n` +
      `picture kept: ${result.outPath} (${result.frames} frames, video stream md5 ${result.videoMd5} equals the previous one); ${result.framesRendered} picture frames rendered  render time: ${elapsed.toFixed(2)}s\n` +
      opens
    );
  }
  if (result.planOnly) {
    const cached = result.cachedAt ? `  (cached: same inputs as the plan of ${result.cachedAt}; --no-plan-cache probes again)` : "";
    return `--plan: ${result.decisions.length} segment(s), nothing rendered${cached}\n` + opens;
  }
  if (result.partial) {
    const done = result.decisions.filter((d) => d.action === "RENDER").length;
    return (
      `rendered ${done} segment(s); not joined: ${result.pending.length} segment(s) not rendered yet: ${result.pending.join(", ")}\n` +
      `render them (--only <ids>, or no --only) to join the film; the A/V gate runs on that last call  render time: ${elapsed.toFixed(2)}s\n` +
      opens
    );
  }
  const achievedFps = result.frames / elapsed;
  return (
    `wrote ${result.outPath}\n` +
    (result.bedPath ? `wrote ${result.bedPath}\n` : "") +
    `frames: ${result.frames}  seconds: ${result.seconds.toFixed(3)}  ` +
    `render time: ${elapsed.toFixed(2)}s  fps achieved: ${achievedFps.toFixed(2)}\n` +
    opens
  );
}

/**
 * The URL render.mjs opens the reel at. `?captions=0` (design.md, engine
 * captionsOn()) makes Reel.caption() draw nothing — a picture-first render
 * (--no-captions) has no narration or language yet, only the picture.
 * @param {string} baseUrl serveDir()'s server.url
 * @param {boolean} noCaptions
 */
export function pictureUrl(baseUrl, noCaptions, lang = null) {
  if (!noCaptions) return baseUrl;
  return lang ? `${baseUrl}?captions=0&lang=${encodeURIComponent(lang)}` : `${baseUrl}?captions=0`;
}

/** A dub language code safe to use in a file name: letters, digits, "-" (BCP 47 like zh-Hans). */
export function isLangCode(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(value);
}

/**
 * out/segments/<name>/ for this render: "final"/"preview" as before, or
 * "final-nocap"/"preview-nocap" for --no-captions, so a picture-first
 * render's segments never get reused for (or reuse) a captioned render's.
 */
export function segmentDirName(quality, noCaptions) {
  return noCaptions ? `${quality}-nocap` : quality;
}

/**
 * The segment cache directory: out/segments/<name>/, or out/segments-<code>/<name>/
 * for a language picture, so the base picture's cache is never written by it.
 */
export function segmentDirFor(outDir, quality, noCaptions, lang = null) {
  return path.join(outDir, lang ? `segments-${lang}` : "segments", segmentDirName(quality, noCaptions));
}

/** File-name stem of the picture outputs: "picture", or "picture-<code>" for a language picture. */
export function pictureStem(lang = null) {
  return lang ? `picture-${lang}` : "picture";
}

/**
 * What the page receives before it runs (Reel.lang, Reel.pictureText): the
 * language and, for a --lang render, dub/<code>/plan.json meta.overlay.picture.
 * A base render gets its own plan's language and no strings.
 * @param {{lang: string|null, basePlan: object|null, dubPlan: object|null}} args
 * @returns {{lang: string|null, strings: Record<string,string>}}
 */
export function picturePayload({ lang, basePlan, dubPlan }) {
  if (!lang) return { lang: (basePlan && basePlan.meta && basePlan.meta.lang) || null, strings: {} };
  const overlay = dubPlan && dubPlan.meta && dubPlan.meta.overlay;
  const strings = overlay && overlay.picture && typeof overlay.picture === "object" ? overlay.picture : {};
  return { lang, strings };
}

function readPicturePayload(dir, lang) {
  let basePlan = null;
  try {
    basePlan = loadPlan(dir);
  } catch {
    basePlan = null;
  }
  let dubPlan = null;
  if (lang) {
    const dubPlanPath = path.join(dir, "dub", lang, "plan.json");
    if (!fs.existsSync(dubPlanPath)) throw new Error(`no ${dubPlanPath} — --lang needs dub/${lang}/plan.json`);
    dubPlan = readJson(dubPlanPath);
  }
  const payload = picturePayload({ lang, basePlan, dubPlan });
  if (lang && Object.keys(payload.strings).length === 0) {
    process.stderr.write(`warning: dub/${lang}/plan.json has no meta.overlay.picture; Reel.pictureText() returns every fallback\n`);
  }
  return payload;
}

export async function render({ dir, paths, preview, workers = 1, only, plan = false, noCaptions = false, stubSec = null, stubSegments = 1, insert = null, lang = null, handleSec = 0, probeAll = false, spans = null, fixPictureDuration = false, assemble = null, bedOnly = false, planCache = true, keepAssembledCopies = false }) {
  const picture = readPicturePayload(dir, lang);
  if (!plan) reportStaleTemps(paths.outDir);
  const wholeFilm = !insert && !handleSec && !spans && !assemble && !bedOnly;
  const cacheKey = plan && planCache && wholeFilm ? planCacheKey({ dir, paths, preview, noCaptions, lang, only, probeAll, stubSec, stubSegments }) : null;
  const cached = cacheKey ? readPlanCache(paths.outDir, cacheKey) : null;
  if (cached) {
    printDecisions(cached.decisions);
    return { planOnly: true, decisions: cached.decisions, pageOpens: 0, cachedAt: cached.at };
  }
  const server = await serveDir(dir);
  const pageUrl = pictureUrl(server.url, noCaptions, lang);
  // Every session is opened cold and warmed only for the shots it will capture (pool.warmFor).
  const pool = createSessionPool({
    open: () => openReel(pageUrl, { stubSec, stubSegments, picture, warm: false }),
    warm: warmShotsOf,
  });
  try {
    const result = await renderWithPool({ dir, paths, pool, picture, preview, workers, only, plan, noCaptions, stubSec, stubSegments, insert, lang, handleSec, probeAll, spans, fixPictureDuration, assemble, bedOnly, cacheKey, keepAssembledCopies });
    return { ...result, pageOpens: pool.opened };
  } finally {
    await pool.closeAll();
    await server.close();
  }
}

async function renderWithPool({ dir, paths, pool, picture, preview, workers, only, plan, noCaptions, stubSec, stubSegments, insert, lang, handleSec, probeAll, spans = null, fixPictureDuration = false, assemble = null, bedOnly = false, cacheKey = null, keepAssembledCopies = false }) {
  const meta = await probeMeta(pool);
  const fps = meta.fps;
  const duration = meta.duration;
  if (bedOnly) return await rebuildPictureBed({ paths, pool, meta, lang });

  const { segments, warnings } = computeSegments({ shots: meta.shots, fps, duration });
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  const quality = preview ? "preview" : "final";
  const segDir = segmentDirFor(paths.outDir, quality, noCaptions, lang);
  const baseSegDir = lang ? segmentDirFor(paths.outDir, quality, noCaptions, null) : null;
  fs.mkdirSync(segDir, { recursive: true });

  const targetWidth = preview ? Math.round(meta.width / 2) : meta.width;
  const targetHeight = preview ? Math.round(meta.height / 2) : meta.height;
  const crf = preview ? 28 : 18;
  const cPreset = preview ? "veryfast" : "medium";
  const scaleFilter = preview ? `scale=${targetWidth}:${targetHeight}` : undefined;

  const onlyIds = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (onlyIds && handleSec > 0) {
    const drafts = await renderDrafts({ pool, segments, onlyIds, handleSec, fps, meta, quality, crf, preset: cPreset, scaleFilter, targetWidth, targetHeight, outDir: paths.outDir, root: paths.root, workers });
    return { draftsOnly: true, drafts };
  }
  if (spans) {
    return await renderSpanFilm({ dir, paths, pool, segments, segDir, spans, plan, lang, fps, crf, preset: cPreset, scaleFilter, targetWidth, targetHeight, workers, noCaptions, stubSec, stubSegments, fixPictureDuration, quality });
  }
  if (assemble) {
    return await renderAssembled({ dir, paths, pool, segments, segDir, edlPath: assemble, plan, fps, crf, preset: cPreset, targetWidth, targetHeight, noCaptions, stubSec, stubSegments, fixPictureDuration, quality, keepAssembledCopies });
  }
  const pending = onlyIds ? validateOnlyOrThrow({ segments, onlyIds, segDir }) : [];

  const insertPlan = insert ? await prepareInsert({ insert, segments, fps }) : null;

  const decisions = await decideAll({
    pool,
    segments,
    segDir,
    baseSegDir,
    fps,
    targetWidth,
    targetHeight,
    onlyIds,
    workers,
    coveredIds: insertPlan ? insertPlan.coveredIds : [],
    pendingIds: pending,
    langStrings: lang && !probeAll ? picture.strings : null,
  });
  printDecisions(decisions);

  if (plan) {
    if (cacheKey) writePlanCache(paths.outDir, cacheKey, decisions);
    return { planOnly: true, decisions };
  }

  copyBaseSegments({ decisions, baseSegDir, segDir });
  const contrast = contrastCollectorFor({ noCaptions, stubSec, paths, meta });
  await renderNeeded({ pool, decisions, fps, crf, preset: cPreset, scaleFilter, workers, contrast });
  if (contrast) reportRenderContrast(contrast, path.join(paths.outDir, "contrast.json"));
  if (pending.length) return { partial: true, pending, decisions };

  return await joinAndFinish({ dir, paths, pool, segments, segDir, decisions, insertPlan, fps, crf, preset: cPreset, noCaptions, stubSec, stubSegments, lang, quality, fixPictureDuration });
}

/**
 * Joins the segment mp4s (or splices the --insert clip) into the video track,
 * then finishes it as a picture, stub or voiced render.
 */
async function joinAndFinish({ dir, paths, pool, segments, segDir, decisions, insertPlan = null, fps, crf, preset, noCaptions, stubSec, stubSegments, lang, quality, fixPictureDuration = false }) {
  const videoOnlyPath = uniqueTempPath(path.join(paths.outDir, "_video.mp4"));
  const expectedFrames = segments[segments.length - 1].frameEnd - segments[0].frameStart;
  if (insertPlan) {
    await buildInsertedTrack({ insertPlan, segDir, fps, crf, preset, outPath: videoOnlyPath, expectedFrames });
  } else {
    await concatMp4(
      segments.map((s) => path.join(segDir, `${s.id}.mp4`)),
      videoOnlyPath,
      fps
    );
  }
  return await finishTrack({ dir, paths, pool, videoOnlyPath, expectedFrames, segments, decisions, fps, noCaptions, stubSec, stubSegments, lang, quality, fixPictureDuration });
}

/** What a joined video track becomes: a picture (--no-captions), a stub preview, or a voiced film. */
async function finishTrack({ dir, paths, pool, videoOnlyPath, expectedFrames, segments, decisions, fps, noCaptions, stubSec, stubSegments, lang, quality, fixPictureDuration }) {
  if (noCaptions) {
    return await finishPictureRender({ dir, paths, pool, videoOnlyPath, expectedFrames, fps, segments, decisions, stubSec, stubSegments, lang, fixPictureDuration });
  }
  if (stubSec) {
    return await finishStubRender({ paths, pool, videoOnlyPath, expectedFrames, fps, segments, decisions, quality });
  }

  await gateAvSync({ videoOnlyPath, narrationPath: paths.narrationWav, expectedFrames });

  let sfxPath;
  const sfx = await maybeRenderSfx(pool, paths);
  if (sfx) sfxPath = sfx;

  const cueInputs = await resolveSoundCues(pool, paths.root);
  const narrationWindows = narrationWindowsFor(dir, stubSec, stubSegments);
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
    fadeOutSec: fadeOutSecFor(dir),
  });
  fs.rmSync(videoOnlyPath, { force: true });
  if (sfxPath) fs.rmSync(sfxPath, { force: true });
  const outPath = pointLatest(paths.outDir, `${quality}.mp4`, stampedPath);

  return { outPath, stampedPath, frames: expectedFrames, seconds: expectedFrames / fps, segments, decisions };
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
async function finishPictureRender({ paths, pool, videoOnlyPath, expectedFrames, fps, segments, decisions, stubSec, stubSegments = 1, lang = null, fixPictureDuration = false }) {
  const frameCount = await probePacketCount(videoOnlyPath);
  if (frameCount !== expectedFrames) {
    throw new Error(`frame count gate failed: joined video has ${frameCount} frames, expected ${expectedFrames}`);
  }
  const timings = pictureTimingsFor({ paths, stubSec, stubSegments, pictureSec: expectedFrames / fps, frames: expectedFrames, fps, fix: fixPictureDuration });

  const stem = pictureStem(lang);
  const stamp = timestamp();
  const stampedPath = path.join(paths.outDir, `${stem}-${stamp}.mp4`);
  fs.renameSync(videoOnlyPath, stampedPath);

  let sfxPath;
  const sfx = await maybeRenderSfx(pool, paths);
  if (sfx) sfxPath = sfx;
  const cueInputs = await resolveSoundCues(pool, paths.root);

  const durationSec = String(await probeDuration(stampedPath));
  const bedStampedPath = path.join(paths.outDir, `${stem}-${stamp}.bed.wav`);
  await muxBedOnly({ sfxPath, cueInputs, durationSec, fadeOutSec: fadeOutSecFor(paths.root), outPath: bedStampedPath });
  if (sfxPath) fs.rmSync(sfxPath, { force: true });

  // Publish only a pair that agrees: the video and bed just written plus the clock they were built on.
  const pairProblem = pairProblems({
    videoSec: Number(durationSec),
    bedSec: await probeDuration(bedStampedPath),
    timingsSec: stubSec ? null : timings.duration,
    videoStamp: stampOfPictureFile(stampedPath, stem),
    bedStamp: stampOfPictureFile(bedStampedPath, stem),
  });
  if (pairProblem.length) throw new Error(`picture/bed/timings mismatch, nothing published: ${pairProblem.join("; ")}`);
  const timingsPath = path.join(paths.outDir, `${stem}.timings.json`);
  const timingsTmp = uniqueTempPath(timingsPath);
  writeJson(timingsTmp, timings);
  fs.renameSync(timingsTmp, timingsPath);
  const outPath = pointLatest(paths.outDir, `${stem}.mp4`, stampedPath);
  const bedPath = pointLatest(paths.outDir, `${stem}.bed.wav`, bedStampedPath);

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

/**
 * Finishes a --stub render with captions on: no narration exists, so there
 * is no A/V gate; the frame count is checked and the page's own sound
 * (renderSfx + library cues, mixed as the picture bed is) becomes the audio.
 * Writes out/<quality>-stub-<stamp>.mp4 + out/<quality>-stub.mp4, so it is
 * never mistaken for a voiced final or preview.
 */
async function finishStubRender({ paths, pool, videoOnlyPath, expectedFrames, fps, segments, decisions, quality }) {
  const frameCount = await probePacketCount(videoOnlyPath);
  if (frameCount !== expectedFrames) {
    throw new Error(`frame count gate failed: joined video has ${frameCount} frames, expected ${expectedFrames}`);
  }
  const sfxPath = await maybeRenderSfx(pool, paths);
  const cueInputs = await resolveSoundCues(pool, paths.root);
  const durationSec = String(await probeDuration(videoOnlyPath));
  const bedPath = uniqueTempPath(path.join(paths.outDir, "_stub-bed.wav"));
  await muxBedOnly({ sfxPath, cueInputs, durationSec, fadeOutSec: fadeOutSecFor(paths.root), outPath: bedPath });
  if (sfxPath) fs.rmSync(sfxPath, { force: true });
  const stampedPath = path.join(paths.outDir, `${quality}-stub-${timestamp()}.mp4`);
  await ffmpeg([
    "-y", "-i", videoOnlyPath, "-i", bedPath,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-t", durationSec, stampedPath,
  ]);
  fs.rmSync(bedPath, { force: true });
  fs.rmSync(videoOnlyPath, { force: true });
  const outPath = pointLatest(paths.outDir, `${quality}-stub.mp4`, stampedPath);
  return { outPath, stampedPath, frames: expectedFrames, seconds: expectedFrames / fps, segments, decisions };
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
  const tmpLink = uniqueTempPath(`${linkPath}.tmp`);
  fs.symlinkSync(path.basename(stampedPath), tmpLink);
  fs.renameSync(tmpLink, linkPath);
  return linkPath;
}

/** The page's meta from the pool's first session, which stays open for the rest of the render. */
async function probeMeta(pool) {
  return pool.use(async (session) => {
    if (session.errors.length) {
      throw new Error(`page errors on load: ${session.errors.join("; ")}`);
    }
    for (const l of driftReportLines(session.meta.drift)) process.stdout.write(`${l}\n`);
    for (const l of parallaxReportLines(session.meta.parallax)) process.stdout.write(`${l}\n`);
    return session.meta;
  });
}

/** Shot ids of every segment that overlaps frames [frameStart, frameEnd). */
function shotIdsOver(segments, frameStart, frameEnd) {
  return segments.filter((s) => s.frameStart < frameEnd && s.frameEnd > frameStart).flatMap((s) => s.shotIds);
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

/**
 * Refuses unknown --only ids and segments outside --only whose stored frame
 * range moved. Returns the segments outside --only never rendered yet
 * (pending): they are skipped, and the film is not joined this run.
 */
function validateOnlyOrThrow({ segments, onlyIds, segDir }) {
  const unknown = unknownOnlyIds({ segments, onlyIds });
  if (unknown.length) {
    throw new Error(`--only references unknown segment(s): ${unknown.join(", ")}`);
  }
  const storedById = new Map(segments.map((s) => [s.id, readStoredMeta(segDir, s.id)]));
  const mp4ExistsById = new Map(segments.map((s) => [s.id, fs.existsSync(segMp4Path(segDir, s.id))]));
  const pending = pendingIds({ segments, onlyIds, storedById, mp4ExistsById });
  const pendingSet = new Set(pending);
  const check = validateOnly({ segments: segments.filter((s) => !pendingSet.has(s.id)), onlyIds, storedById });
  if (!check.ok) {
    throw new Error(
      `--only can't safely reuse segment(s) whose frame range moved: ${check.mustInclude.join(", ")} — ` +
        `include them in --only`
    );
  }
  return pending;
}

/**
 * One decision per segment. Decided without the page: INSERT (covered by
 * the clip), PENDING (--only first render), REUSE on the --only fast path,
 * and a language segment whose base frames read no changed string
 * (decideLangUnprobed). Every other segment is probed; only the shots of
 * probed segments are warmed.
 */
async function decideAll({ pool, segments, segDir, baseSegDir = null, fps, targetWidth, targetHeight, onlyIds, workers, coveredIds = [], pendingIds: pending = [], langStrings = null }) {
  const results = new Array(segments.length);
  // --only: the segments next to a named one are probed, not forced.
  const pendingSet = new Set(pending);
  const neighbours = new Set(onlyIds ? neighbourIds({ segments, onlyIds, skipIds: [...coveredIds, ...pending] }) : []);
  const toProbe = [];
  segments.forEach((segment, i) => {
    const neighbour = neighbours.has(segment.id);
    const known = decideWithoutPage({ segment, segDir, baseSegDir, fps, targetWidth, targetHeight, onlyIds, neighbour, coveredIds, pendingSet, langStrings });
    if (known) results[i] = known;
    else toProbe.push({ i, segment, neighbour });
  });
  await pool.warmFor(toProbe.flatMap((p) => p.segment.shotIds));

  let idx = 0;
  async function worker() {
    if (idx >= toProbe.length) return;
    await pool.use(async (session) => {
      while (idx < toProbe.length) {
        const { i, segment, neighbour } = toProbe[idx++];
        const forceRender = !!onlyIds && !neighbour; // named by --only
        results[i] = await decideOne({ session, segment, segDir, baseSegDir, fps, targetWidth, targetHeight, forceRender });
        if (neighbour) results[i].neighbour = true;
      }
    });
  }

  const n = Math.max(1, Math.min(workers, toProbe.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** The decision for a segment that needs no probe, or null. */
function decideWithoutPage({ segment, segDir, baseSegDir, fps, targetWidth, targetHeight, onlyIds, neighbour, coveredIds, pendingSet, langStrings }) {
  if (coveredIds.includes(segment.id)) return { segment, action: "INSERT", reason: "covered by the --insert clip (not rendered)" };
  if (pendingSet.has(segment.id)) return { segment, action: "PENDING", reason: "--only: never rendered yet (skipped; the film is joined once no segment is pending)" };
  if (onlyIds && !onlyIds.includes(segment.id) && !neighbour) return { segment, action: "REUSE", reason: "--only fast path (not probed)" };
  if (!baseSegDir || !langStrings || (onlyIds && !neighbour)) return null;
  const current = { frameStart: segment.frameStart, frameEnd: segment.frameEnd, fps, width: targetWidth, height: targetHeight };
  const mp4Path = segMp4Path(segDir, segment.id);
  const storedBase = readStoredMeta(baseSegDir, segment.id);
  const d = decideLangUnprobed({
    storedBase,
    storedLang: readStoredMeta(segDir, segment.id),
    current,
    strings: langStrings,
    baseMp4Exists: fs.existsSync(segMp4Path(baseSegDir, segment.id)),
    langMp4Exists: fs.existsSync(mp4Path),
  });
  if (!d) return null;
  if (d.action === "REUSE") return { segment, action: "REUSE", reason: d.reason };
  return { segment, action: "COPY", reason: d.reason, current: storedBase, mp4Path, jsonPath: segJsonPath(segDir, segment.id), baseMp4Path: segMp4Path(baseSegDir, segment.id) };
}

async function decideOne({ session, segment, segDir, baseSegDir = null, fps, targetWidth, targetHeight, forceRender }) {
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
  if (baseSegDir) {
    const d = decideLangSegment({
      storedLang: stored,
      storedBase: readStoredMeta(baseSegDir, segment.id),
      current,
      langMp4Exists: fs.existsSync(mp4Path),
      baseMp4Exists: fs.existsSync(segMp4Path(baseSegDir, segment.id)),
    });
    if (d.action === "REUSE") return { segment, action: "REUSE", reason: d.reason };
    if (d.action === "COPY") {
      return { segment, action: "COPY", reason: d.reason, current, mp4Path, jsonPath, baseMp4Path: segMp4Path(baseSegDir, segment.id) };
    }
    return { segment, action: "RENDER", reason: d.reason, current, mp4Path, jsonPath };
  }
  const decision = decideSegmentReuse({ stored, current, mp4Exists: fs.existsSync(mp4Path) });
  if (decision.reuse) return { segment, action: "REUSE", reason: decision.reason };
  return { segment, action: "RENDER", reason: decision.reason, current, mp4Path, jsonPath };
}

/** A language picture takes the base segment where its probes matched (decideLangSegment's COPY). */
function copyBaseSegments({ decisions, baseSegDir, segDir }) {
  if (!baseSegDir) return;
  for (const d of decisions) {
    if (d.action !== "COPY") continue;
    fs.copyFileSync(d.baseMp4Path, d.mp4Path);
    writeJson(d.jsonPath, d.current);
  }
}

/** A caption-contrast collector for a voice-first render (captions on, real narration), else null. */
function contrastCollectorFor({ noCaptions, stubSec, paths, meta }) {
  if (noCaptions || stubSec || !fs.existsSync(paths.timingsJson)) return null;
  const lines = readJson(paths.timingsJson).lines;
  return Array.isArray(lines) && lines.length ? createContrastCollector({ lines, fps: meta.fps, width: meta.width, height: meta.height }) : null;
}

async function renderNeeded({ pool, decisions, fps, crf, preset, scaleFilter, workers, contrast = null }) {
  const toRender = decisions.filter((d) => d.action === "RENDER");
  let idx = 0;

  async function worker() {
    let session = null;
    try {
      while (idx < toRender.length) {
        const i = idx++;
        const d = toRender[i];
        let reads = null;
        // Both film sessions had render.mjs die once on a Playwright
        // transport error mid-segment (no page error involved) and pass
        // clean on rerun — retry the segment itself, up to 2 more times,
        // dropping the (possibly broken) session so the next attempt opens
        // a fresh one. A real page/application error is never retried
        // (isTransportError rejects it) — see scripts/lib/retry.mjs.
        await withTransportRetry(
          async () => {
            if (!session) session = await pool.acquire();
            await encodeSegment({ session, segment: d.segment, outPath: d.mp4Path, fps, crf, preset, scaleFilter, contrast });
            reads = await sessionPictureReads(session);
          },
          {
            maxRetries: 2,
            onRetry: async (attempt, err) => {
              process.stderr.write(
                `retrying segment ${d.segment.id} after a transport error (attempt ${attempt}): ${err.message}\n`
              );
              if (session) {
                await pool.discard(session);
                session = null;
              }
            },
          }
        );
        writeJson(d.jsonPath, reads ? { ...d.current, picture: reads } : d.current);
      }
    } finally {
      if (session) pool.release(session);
    }
  }

  const n = Math.max(1, Math.min(workers, toRender.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
}

export { mergePictureReads };

// Encodes to a temp name and renames when done, so an interrupted encode never
// leaves a truncated mp4 under the name a cached segment json points at.
async function encodeSegment({ session, segment, outPath, fps, crf, preset, scaleFilter, contrast = null }) {
  const tmpPath = uniqueTempPath(outPath);
  const { proc, done } = spawnImagePipeEncoder({ fps, outPath: tmpPath, crf, preset, scaleFilter });
  done.catch(() => {});
  try {
    for (let frame = segment.frameStart; frame < segment.frameEnd; frame++) {
      const t = frame / fps;
      const png = await captureFrame(session.page, t);
      const ok = proc.stdin.write(png);
      if (!ok) await once(proc.stdin, "drain");
      if (contrast) await measureDrawnFrame(contrast, { page: session.page, frame, withPng: png, capture: (page) => captureFrame(page, t) });
    }
    reportGl(session, `frames [${segment.frameStart},${segment.frameEnd})`);
    proc.stdin.end();
    await done;
    fs.renameSync(tmpPath, outPath);
  } catch (e) {
    proc.stdin.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw e;
  }
}

/**
 * Prints the page's WebGL console messages not yet shown for this session. A
 * GL error code or a lost context means the frames just captured are wrong:
 * that stops the step (throws) before the encode is published; any other GL
 * message is only printed.
 */
export function reportGl(session, what) {
  if (!session.gl) return;
  const issues = glIssues(session);
  const shown = session.glShown || (session.glShown = new Set());
  for (const line of glReportLines(issues)) {
    if (shown.has(line)) continue;
    shown.add(line);
    process.stdout.write(`${line}  (${what})\n`);
  }
  if (issues.definite.length) {
    throw new Error(`the page logged WebGL error(s) while drawing ${what}, so those frames are wrong: ${glReportLines({ definite: issues.definite, warnings: [] }).join("; ")}`);
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

// ---- temp names: original name + µs timestamp + pid (lib/ffmpeg.mjs) ---------

export { uniqueTempPath, concatMp4 };

const TEMP_NAME = /-\d{15,17}-(\d+)(?:\.[A-Za-z0-9]+)?$/;

/**
 * Names (of a directory listing) that are temp leftovers of a render that died:
 * `<stem>-<µs>-<pid><ext>` whose pid is no longer running. A name carrying a
 * live pid (another render in this reel dir) or `selfPid` is never listed.
 */
export function staleTempNames(names, isAlive, selfPid = process.pid) {
  return names.filter((name) => {
    const m = TEMP_NAME.exec(name);
    return m && Number(m[1]) !== selfPid && !isAlive(Number(m[1]));
  });
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Removes the temp leftovers of crashed renders from out/ and its segment cache dirs; returns the removed paths. */
export function removeStaleTemps(outDir, isAlive = pidIsAlive) {
  const dirs = [outDir];
  for (const top of ["segments"].concat(fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((n) => n.startsWith("segments-")) : [])) {
    const base = path.join(outDir, top);
    if (fs.existsSync(base)) dirs.push(...fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name)));
  }
  const removed = [];
  for (const dir of dirs.filter((d) => fs.existsSync(d))) {
    for (const name of staleTempNames(fs.readdirSync(dir), isAlive)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(path.join(dir, name));
    }
  }
  return removed;
}

// ---- picture length vs timings, and the picture/bed/timings pair -------------

const PAIR_TOLERANCE_SEC = 0.05; // the A/V gate's 50 ms

/**
 * Null when the picture length (frames / fps, the page's own clock) and the
 * timings duration agree within 50 ms. Otherwise the finding: the right value
 * is the picture length, and the fix is to set the timings duration to it.
 */
export function pictureDurationFinding({ pictureSec, timingsSec, frames, fps, timingsPath }) {
  const right = Number(pictureSec.toFixed(6));
  if (Number.isFinite(timingsSec) && Math.abs(timingsSec - pictureSec) <= PAIR_TOLERANCE_SEC) return null;
  const have = Number.isFinite(timingsSec) ? `${timingsSec}s` : "no numeric duration";
  return {
    right,
    message:
      `picture length ${right}s (the page's ${frames} frames at ${fps} fps) differs from the timings duration (${have}) in ${timingsPath}. ` +
      `The picture length is the page's own clock, so it is the right value. Fix: set "duration" to ${right} in out/picture.timings.json ` +
      `(and in voice/timings.json when the shots changed); a narration of another length must be re-fitted to ${right}s (fit-track.mjs). ` +
      `Or run again with --fix-picture-duration to write ${right} into out/picture.timings.json and continue.`,
  };
}

/** voice/timings.json for a picture render, or the stub clock; stops on a length mismatch unless `fix`. */
function pictureTimingsFor({ paths, stubSec, stubSegments, pictureSec, frames, fps, fix }) {
  if (stubSec) return stubTimings(stubSec, stubSegments);
  const timings = readJson(paths.timingsJson);
  const finding = pictureDurationFinding({ pictureSec, timingsSec: timings.duration, frames, fps, timingsPath: paths.timingsJson });
  if (!finding) return timings;
  if (!fix) throw new Error(finding.message);
  process.stdout.write(`note: --fix-picture-duration: timings duration ${timings.duration} -> ${finding.right} (the picture length)\n`);
  return { ...timings, duration: finding.right };
}

/**
 * What is wrong with a picture/bed/timings pair, as sentences ([] = fine).
 * A null timings length or stamp is not compared.
 */
export function pairProblems({ videoSec, bedSec, timingsSec = null, videoStamp = null, bedStamp = null }) {
  const out = [];
  if (videoStamp && bedStamp && videoStamp !== bedStamp) out.push(`the picture (${videoStamp}) and the bed (${bedStamp}) are from different renders`);
  if (Math.abs(videoSec - bedSec) > PAIR_TOLERANCE_SEC) out.push(`the picture is ${videoSec.toFixed(3)}s but the bed is ${bedSec.toFixed(3)}s`);
  if (timingsSec != null && !(Math.abs(videoSec - timingsSec) <= PAIR_TOLERANCE_SEC)) {
    out.push(`the picture is ${videoSec.toFixed(3)}s but the timings duration is ${timingsSec}s (the picture length is the right value)`);
  }
  return out;
}

/** The render stamp in a picture file's real name (picture-<stamp>.mp4), or null for a plain file. */
function stampOfPictureFile(file, stem) {
  const base = path.basename(fs.realpathSync(file));
  const m = base.startsWith(`${stem}-`) ? /^(\d{8}-\d{6})\./.exec(base.slice(stem.length + 1)) : null;
  return m ? m[1] : null;
}

/**
 * Checks out/<stem>.mp4, .bed.wav and .timings.json belong together: same
 * render stamp, same length. A render interrupted while writing them can leave
 * a mismatched pair; a consumer must not reuse it.
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function checkPicturePair({ outDir, lang = null }) {
  const stem = pictureStem(lang);
  const video = path.join(outDir, `${stem}.mp4`);
  const bed = path.join(outDir, `${stem}.bed.wav`);
  const timingsPath = path.join(outDir, `${stem}.timings.json`);
  const missing = [video, bed, timingsPath].filter((f) => !fs.existsSync(f));
  if (missing.length) return { ok: false, problems: missing.map((f) => `missing ${f}`) };
  const timings = readJson(timingsPath);
  const problems = pairProblems({
    videoSec: await probeDuration(video),
    bedSec: await probeDuration(bed),
    timingsSec: Number.isFinite(timings.duration) ? timings.duration : NaN,
    videoStamp: stampOfPictureFile(video, stem),
    bedStamp: stampOfPictureFile(bed, stem),
  });
  return { ok: problems.length === 0, problems };
}

async function runCheckPair({ paths, lang }) {
  if (lang !== null && !isLangCode(lang)) {
    fail(`--lang takes a language code such as en or zh-Hans (got "${lang}")`);
    return;
  }
  const { ok, problems } = await checkPicturePair({ outDir: paths.outDir, lang });
  if (ok) {
    process.stdout.write(`pair ok: ${pictureStem(lang)}.mp4, .bed.wav and .timings.json belong to one render\n`);
    return;
  }
  fail(`${pictureStem(lang)} pair is not usable — ${problems.join("; ")}. Render the picture again (--no-captions${lang ? ` --lang ${lang}` : ""}) before dubbing.`);
}

// ---- --span: render only the changed frames, splice them into the cache --------

const SPAN_MARGIN_SEC = 0.5;

/** `--span 3-4.5,40-42` as [{fromSec, toSec}]. */
export function parseSpanFlag(value) {
  const parts = typeof value === "string" ? value.split(",") : [""];
  return parts.map((part) => {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(part.trim());
    if (!m || Number(m[2]) <= Number(m[1])) {
      throw new Error(`--span takes <from>-<to> seconds, e.g. --span 12.5-15 or --span 3-4,40-42.5 (got "${value}")`);
    }
    return { fromSec: Number(m[1]), toSec: Number(m[2]) };
  });
}

const MODE_REFUSES = {
  span: ["only", "insert", "use-draft", "handle", "probe-all", "assemble", "bed-only"],
  assemble: ["only", "insert", "use-draft", "handle", "lang", "probe-all", "span", "bed-only", "stub"],
  "bed-only": ["only", "insert", "use-draft", "handle", "probe-all", "span", "assemble", "stub", "plan"],
};

/** Stops (throws) when a mode that works on the whole film is combined with a flag it cannot honour. */
export function assertWholeFilmFlags(mode, flags) {
  for (const f of MODE_REFUSES[mode]) {
    if (flags[f] !== undefined) throw new Error(`--${mode} works on the film as a whole; it does not combine with --${f}`);
  }
}

/**
 * The frame ranges a --span renders: each span widened by the margin, snapped
 * outward to whole frames, clamped to the film, overlapping or touching ranges
 * merged. Ascending, non-overlapping [startFrame, endFrame).
 */
export function planSpanFrames({ spans, fps, filmStart, filmEnd, marginSec = SPAN_MARGIN_SEC }) {
  const eps = 1e-6;
  const ranges = spans
    .map(({ fromSec, toSec }) => {
      const startFrame = Math.max(filmStart, Math.floor((fromSec - marginSec) * fps + eps));
      const endFrame = Math.min(filmEnd, Math.ceil((toSec + marginSec) * fps - eps));
      if (startFrame >= endFrame) {
        throw new Error(`--span ${fromSec}-${toSec} lies outside the film (frames [${filmStart},${filmEnd}), ${(filmEnd / fps).toFixed(3)}s)`);
      }
      return { startFrame, endFrame };
    })
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Maps frame ranges onto the segments they touch. Per touched segment, the
 * ordered pieces of its new mp4: `old` (frames [from,to) relative to the cached
 * segment) and `new` (frames [from,to) of the film, rendered from the page).
 * Segments no range touches are absent: they are reused as they are.
 */
export function planSpanSplice({ segments, ranges }) {
  const out = [];
  for (const segment of segments) {
    const hits = ranges
      .map((r) => ({ from: Math.max(r.startFrame, segment.frameStart), to: Math.min(r.endFrame, segment.frameEnd) }))
      .filter((h) => h.from < h.to);
    if (!hits.length) continue;
    const pieces = [];
    let cursor = segment.frameStart;
    for (const h of hits) {
      if (h.from > cursor) pieces.push({ kind: "old", from: cursor - segment.frameStart, to: h.from - segment.frameStart });
      pieces.push({ kind: "new", from: h.from, to: h.to });
      cursor = h.to;
    }
    if (cursor < segment.frameEnd) pieces.push({ kind: "old", from: cursor - segment.frameStart, to: segment.frameEnd - segment.frameStart });
    out.push({ id: segment.id, segment, pieces });
  }
  return out;
}

/** Stops (throws) naming every segment the span render cannot build on: never rendered, or its frame range moved. */
export function assertSpanBase({ segments, touched, segDir, fps, width, height }) {
  const wholeNew = new Set(touched.filter((t) => t.pieces.every((p) => p.kind === "new")).map((t) => t.id));
  const bad = [];
  for (const s of segments) {
    if (wholeNew.has(s.id)) continue;
    const stored = readStoredMeta(segDir, s.id);
    if (!fs.existsSync(segMp4Path(segDir, s.id)) || !stored) bad.push(`${s.id} (never rendered)`);
    else if (stored.frameStart !== s.frameStart || stored.frameEnd !== s.frameEnd || stored.fps !== fps || stored.width !== width || stored.height !== height) {
      bad.push(`${s.id} (frame range, fps or size moved)`);
    }
  }
  if (bad.length) {
    throw new Error(
      `--span reuses the cached segments, so they must be rendered once and still match the timeline: ${bad.join(", ")}. ` +
        `Render those first (--only <ids>, or no --span).`
    );
  }
}

/**
 * Builds one segment's new mp4 from its pieces: `old` pieces are cut out of the
 * cached mp4 at exact frames (cutFrames: whole GOPs are packet-copied, only the
 * frames up to the next keyframe are re-encoded), `new` pieces come from
 * renderNew(piece, outPath); a new piece whose encoder headers differ from the
 * old cut is re-encoded to match, then all are joined. This is the one place
 * that cuts and joins at the span's frame boundaries. Returns the path of the
 * joined mp4 in workDir.
 */
export async function spliceSpanPieces({ pieces, oldPath, renderNew, fps, crf, preset, workDir }) {
  const files = [];
  for (const [i, p] of pieces.entries()) {
    const out = path.join(workDir, `${i}-${p.kind}.mp4`);
    if (p.kind === "old") await cutFrames({ src: oldPath, from: p.from, to: p.to, fps, crf, preset, outPath: out });
    else await renderNew(p, out);
    files.push({ kind: p.kind, path: out });
  }
  const reference = files.find((f) => f.kind === "old");
  if (reference) {
    for (const f of files) {
      if (f.kind !== "new" || (await sameStream(reference.path, f.path))) continue;
      const like = path.join(workDir, `${path.basename(f.path, ".mp4")}-like.mp4`);
      await reencodeLikeSegments({ src: f.path, like: await streamTags(reference.path), fps, crf, preset, outPath: like });
      f.path = like;
    }
  }
  if (files.length === 1) return files[0].path;
  const joined = path.join(workDir, "joined.mp4");
  await concatMp4(files.map((f) => f.path), joined, fps);
  return joined;
}

/**
 * The per-string read record a span-rebuilt segment stores. Frames cut from the
 * cache keep the reads recorded for them (union with this session's reads, which
 * only grows the record: a later render then probes more, never less); a
 * segment with no record cannot claim one for its cached frames, so it stays
 * without. A segment the span covers whole is described by the session alone.
 * @param {{stored: object|null, sessionReads: object|null, pieces: {kind: string}[]}} args
 */
export function spanPictureReads({ stored, sessionReads, pieces }) {
  if (pieces.every((p) => p.kind === "new")) return sessionReads;
  return stored && stored.picture ? mergePictureReads(stored.picture, sessionReads) : null;
}

async function rebuildSegmentSpan({ session, touched, segDir, fps, crf, preset, scaleFilter, width, height, headerRef }) {
  const { id, segment } = touched;
  const target = segMp4Path(segDir, id);
  const workDir = uniqueTempPath(path.join(segDir, `_span-${id}`));
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const renderNew = (p, outPath) => encodeSegment({ session, segment: { frameStart: p.from, frameEnd: p.to }, outPath, fps, crf, preset, scaleFilter });
    const built = await spliceSpanPieces({ pieces: touched.pieces, oldPath: target, renderNew, fps, crf, preset, workDir });
    const frames = await probePacketCount(built);
    if (frames !== segment.frameEnd - segment.frameStart) throw new Error(`span splice of ${id} has ${frames} frames, expected ${segment.frameEnd - segment.frameStart}`);
    if (headerRef && !(await sameStream(headerRef, built))) {
      throw new Error(`span splice of ${id} has different encoder headers from the other segments; a -c copy join would not decode`);
    }
    const stored = readStoredMeta(segDir, id);
    fs.renameSync(built, target);
    const probes = [];
    for (const f of probeFrameIndices(segment.frameStart, segment.frameEnd)) probes.push(sha256Hex(await captureFrame(session.page, f / fps)));
    const picture = spanPictureReads({ stored, sessionReads: await sessionPictureReads(session), pieces: touched.pieces });
    const assembledCopy = stored?.assembledCopy && touched.pieces.some(p => p.kind === "old") ? { assembledCopy: stored.assembledCopy } : {};
    writeJson(segJsonPath(segDir, id), { ...assembledCopy, frameStart: segment.frameStart, frameEnd: segment.frameEnd, fps, width, height, probes, ...(picture ? { picture } : {}) });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function renderSpans({ pool, segments, touched, segDir, fps, crf, preset, scaleFilter, width, height, workers }) {
  const touchedIds = new Set(touched.map((t) => t.id));
  const untouched = segments.find((s) => !touchedIds.has(s.id));
  const headerRef = untouched ? segMp4Path(segDir, untouched.id) : null;
  await pool.warmFor(touched.flatMap((t) => t.segment.shotIds));
  let idx = 0;
  async function worker() {
    let session = null;
    try {
      while (idx < touched.length) {
        if (!session) session = await pool.acquire();
        await rebuildSegmentSpan({ session, touched: touched[idx++], segDir, fps, crf, preset, scaleFilter, width, height, headerRef });
      }
    } finally {
      if (session) pool.release(session);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, touched.length)) }, worker));
}

function spanDecisions({ segments, touched }) {
  const byId = new Map(touched.map((t) => [t.id, t]));
  return segments.map((segment) => {
    const t = byId.get(segment.id);
    if (!t) return { segment, action: "REUSE", reason: "span render: cached segment, not probed" };
    const frames = t.pieces.filter((p) => p.kind === "new").reduce((n, p) => n + p.to - p.from, 0);
    return { segment, action: "SPAN", reason: `${frames} frame(s) rendered from the page; the other ${segment.frameEnd - segment.frameStart - frames} cut from the cache`, frames };
  });
}

/** The widest gap, in frames, between keyframes of a clip (its tail counts to the end). */
export function widestKeyframeGap({ keyFrames, total }) {
  let widest = 0;
  keyFrames.forEach((k, i) => {
    widest = Math.max(widest, (i + 1 < keyFrames.length ? keyFrames[i + 1] : total) - k);
  });
  return widest;
}

/**
 * Said once: touched segments whose cached mp4 has keyframes further apart than
 * a render writes now (older renders used x264's 250-frame default). They still
 * splice, but the untouched frames up to the next keyframe are re-encoded.
 */
async function noteLongKeyframeGaps({ touched, segDir, fps }) {
  const limit = 2 * keyframeInterval(fps);
  const long = [];
  for (const t of touched) {
    if (t.pieces.every((p) => p.kind === "new")) continue;
    if (widestKeyframeGap(await probeGops(segMp4Path(segDir, t.id))) > limit) long.push(t.id);
  }
  if (long.length) {
    process.stdout.write(
      `note: cached segment(s) ${long.join(", ")} have keyframes more than ${limit} frames apart (rendered before 1.9.0), so the untouched frames next to the span are re-encoded, not copied. Their new encode writes a keyframe every ${keyframeInterval(fps)} frames; later spans on them copy.\n`
    );
  }
}

async function renderSpanFilm({ dir, paths, pool, segments, segDir, spans, plan, lang = null, fps, crf, preset, scaleFilter, targetWidth, targetHeight, workers, noCaptions, stubSec, stubSegments, fixPictureDuration, quality }) {
  const filmStart = segments[0].frameStart;
  const filmEnd = segments[segments.length - 1].frameEnd;
  const ranges = planSpanFrames({ spans, fps, filmStart, filmEnd });
  const touched = planSpanSplice({ segments, ranges });
  assertSpanBase({ segments, touched, segDir, fps, width: targetWidth, height: targetHeight });
  await noteLongKeyframeGaps({ touched, segDir, fps });
  const decisions = spanDecisions({ segments, touched });
  for (const d of decisions) process.stdout.write(`${d.action}  ${d.segment.id}  [${d.segment.frameStart},${d.segment.frameEnd})  ${d.reason}\n`);
  const rendered = decisions.reduce((n, d) => n + (d.frames || 0), 0);
  process.stdout.write(`span: ${ranges.map((r) => `[${r.startFrame},${r.endFrame})`).join(" ")} — ${rendered} of ${filmEnd - filmStart} frames rendered\n`);
  if (plan) return { planOnly: true, decisions };
  await renderSpans({ pool, segments, touched, segDir, fps, crf, preset, scaleFilter, width: targetWidth, height: targetHeight, workers });
  return await joinAndFinish({ dir, paths, pool, segments, segDir, decisions, fps, crf, preset, noCaptions, stubSec, stubSegments, lang, quality, fixPictureDuration });
}

// ---- the plan printout, its cache, and leftovers of crashed renders -----------

/** One REUSE/RENDER/... line per segment (and the --only neighbour note). */
function printDecisions(decisions) {
  for (const d of decisions) {
    if (d.neighbour && d.action === "RENDER") process.stdout.write(`--only: also rendering ${d.segment.id} (its frames changed)\n`);
    process.stdout.write(`${d.action}  ${d.segment.id}  [${d.segment.frameStart},${d.segment.frameEnd})  ${d.reason}\n`);
  }
}

function reportStaleTemps(outDir) {
  const removed = removeStaleTemps(outDir);
  if (removed.length) process.stdout.write(`removed ${removed.length} temp leftover(s) of crashed render(s):\n${removed.map((p) => `  ${p}`).join("\n")}\n`);
}

const PLAN_CACHE_FILE = "plan-cache.json";
const FINGERPRINT_SKIP = new Set(["node_modules", ".git", ".backup", ".worktree"]);

/** "relative path, size, mtime" of every file under `root` (the reel's own out/ left out), sorted. */
function treeStats(root) {
  const lines = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!FINGERPRINT_SKIP.has(e.name) && !(d === root && e.name === "out")) stack.push(p);
      } else {
        const s = fs.statSync(p, { throwIfNoEntry: false });
        if (s) lines.push(`${path.relative(root, p)}|${s.size}|${s.mtimeMs}`);
      }
    }
  }
  return lines.sort();
}

function segmentCacheStats(segDir) {
  if (!fs.existsSync(segDir)) return [];
  return fs.readdirSync(segDir).filter((n) => /\.(json|mp4)$/.test(n)).sort().map((n) => {
    const s = fs.statSync(path.join(segDir, n));
    return `${n}|${s.size}|${s.mtimeMs}`;
  });
}

/**
 * What a --plan answer depends on: the options, every file of the reel dir
 * outside out/ (the page and what it loads) and the segment cache dirs it
 * compares against. Equal key = the plan would come out the same.
 */
export function planCacheKey({ dir, paths, preview, noCaptions, lang, only, probeAll, stubSec, stubSegments }) {
  const quality = preview ? "preview" : "final";
  const segDir = segmentDirFor(paths.outDir, quality, noCaptions, lang);
  const baseSegDir = lang ? segmentDirFor(paths.outDir, quality, noCaptions, null) : null;
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify([treeStats(dir), segmentCacheStats(segDir), baseSegDir ? segmentCacheStats(baseSegDir) : null]))
    .digest("hex");
  return JSON.stringify({ quality, noCaptions, lang, only: only || null, probeAll, stubSec, stubSegments, fingerprint, skill: skillStamp() });
}

/** Which render code made a cached plan: the skill's package.json version and render.mjs's mtime (an edited or updated skill plans again). */
export function skillStamp() {
  const here = fileURLToPath(import.meta.url);
  let version = null;
  try {
    version = readJson(path.join(path.dirname(here), "..", "package.json")).version || null;
  } catch {
    version = null;
  }
  return { version, renderMtimeMs: fs.statSync(here).mtimeMs };
}

function readPlanCache(outDir, key) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(outDir, PLAN_CACHE_FILE), "utf8"));
    return stored.key === key ? stored : null;
  } catch {
    return null;
  }
}

function writePlanCache(outDir, key, decisions) {
  const slim = decisions.map((d) => ({ segment: d.segment, action: d.action, reason: d.reason, neighbour: !!d.neighbour }));
  const file = path.join(outDir, PLAN_CACHE_FILE);
  const tmp = uniqueTempPath(file);
  writeJson(tmp, { key, at: new Date().toISOString(), decisions: slim });
  fs.renameSync(tmp, file);
}

// ---- --bed-only: new sound, the same picture ----------------------------------

function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
}

/** A render stamp no picture or bed file in `outDir` uses yet. */
function freshStamp(outDir, stem) {
  let when = new Date();
  for (;;) {
    const stamp = timestamp(when);
    if (!fs.existsSync(path.join(outDir, `${stem}-${stamp}.mp4`)) && !fs.existsSync(path.join(outDir, `${stem}-${stamp}.bed.wav`))) return stamp;
    when = new Date(when.getTime() + 1000);
  }
}

/**
 * Rebuilds the sound bed of the current picture (out/<stem>.mp4) from the page
 * and publishes a new picture/bed/timings trio: the picture file is hard-linked
 * (copied where links fail) under the new stamp, so no frame is rendered or
 * re-encoded, and its video stream md5 must equal the old one's. The page is
 * opened once for renderSfx and the sound cues; no frame is captured.
 */
async function rebuildPictureBed({ paths, pool, meta, lang }) {
  const stem = pictureStem(lang);
  const again = `--no-captions${lang ? ` --lang ${lang}` : ""}`;
  const link = path.join(paths.outDir, `${stem}.mp4`);
  const timingsPath = path.join(paths.outDir, `${stem}.timings.json`);
  if (!fs.existsSync(link) || !fs.existsSync(timingsPath)) throw new Error(`no out/${stem}.mp4 and out/${stem}.timings.json to keep — render the picture first (${again})`);
  const oldVideo = fs.realpathSync(link);
  const frames = await probePacketCount(oldVideo);
  const pageFrames = Math.round(meta.duration * meta.fps);
  if (frames !== pageFrames) {
    throw new Error(`--bed-only keeps the picture, but ${path.basename(oldVideo)} has ${frames} frames and the page's timeline is ${pageFrames}: the picture is out of date — render it (${again}; --span for a few seconds)`);
  }
  // Hashed before anything is linked or re-pointed: a hard link shares its inode with the old file, so the later hash can only differ if the stream changed in between.
  const oldMd5 = await videoStreamMd5(oldVideo);
  const sfxPath = await maybeRenderSfx(pool, paths);
  const cueInputs = await resolveSoundCues(pool, paths.root);
  const stamp = freshStamp(paths.outDir, stem);
  const stampedVideo = path.join(paths.outDir, `${stem}-${stamp}.mp4`);
  const stampedBed = path.join(paths.outDir, `${stem}-${stamp}.bed.wav`);
  let videoMd5;
  try {
    linkOrCopy(oldVideo, stampedVideo);
    const durationSec = String(await probeDuration(stampedVideo));
    await muxBedOnly({ sfxPath, cueInputs, durationSec, fadeOutSec: fadeOutSecFor(paths.root), outPath: stampedBed });
    videoMd5 = await assertBedPair({ oldMd5, stampedVideo, stampedBed, stem, timingsPath, durationSec });
  } catch (e) {
    fs.rmSync(stampedVideo, { force: true });
    fs.rmSync(stampedBed, { force: true });
    throw e;
  } finally {
    if (sfxPath) fs.rmSync(sfxPath, { force: true });
  }
  const outPath = pointLatest(paths.outDir, `${stem}.mp4`, stampedVideo);
  const bedPath = pointLatest(paths.outDir, `${stem}.bed.wav`, stampedBed);
  return { bedOnly: true, outPath, bedPath, frames, seconds: frames / meta.fps, videoMd5, framesRendered: 0 };
}

/** Throws unless the new picture's stream md5 is `oldMd5` (taken before the link) and the new picture/bed/timings agree. Returns that md5. */
export async function assertBedPair({ oldMd5, stampedVideo, stampedBed, stem, timingsPath, durationSec }) {
  const after = await videoStreamMd5(stampedVideo);
  if (oldMd5 !== after) throw new Error(`--bed-only changed the picture stream (md5 ${oldMd5} -> ${after}); nothing published`);
  const timings = readJson(timingsPath);
  const problems = pairProblems({
    videoSec: Number(durationSec),
    bedSec: await probeDuration(stampedBed),
    timingsSec: Number.isFinite(timings.duration) ? timings.duration : NaN,
    videoStamp: stampOfPictureFile(stampedVideo, stem),
    bedStamp: stampOfPictureFile(stampedBed, stem),
  });
  if (problems.length) throw new Error(`picture/bed/timings mismatch, nothing published: ${problems.join("; ")}`);
  return after;
}

// ---- --assemble: a film from existing runs of frames (an EDL) ------------------

/** Each EDL entry's clip file, frame range and film position; stops (throws) naming an entry whose clip is missing, off the reel's fps or too short. */
async function resolveEdlEntries({ entries, dir, segDir, fps }) {
  const out = [];
  let outStart = 0;
  for (const [i, e] of entries.entries()) {
    const label = e.segment ? `segment ${e.segment}` : e.src;
    const file = e.segment ? segMp4Path(segDir, e.segment) : path.resolve(dir, e.src);
    if (!fs.existsSync(file)) throw new Error(`EDL entry ${i + 1} (${label}): ${file} does not exist${e.segment ? " — render that segment first" : ""}`);
    const info = await probeVideoInfo(file);
    if (Math.abs(info.fps - fps) > 1e-3) throw new Error(`EDL entry ${i + 1} (${label}) runs at ${info.fps} fps, the reel at ${fps} fps`);
    const total = await probePacketCount(file);
    const to = e.to === null ? total : e.to;
    if (to > total) throw new Error(`EDL entry ${i + 1} (${label}): frames [${e.from},${to}) do not fit its ${total} frames`);
    out.push({ ...e, label, file, to, frames: to - e.from, whole: e.from === 0 && to === total, outStart });
    outStart += to - e.from;
  }
  return out;
}

/**
 * Cuts every entry out of its clip (a whole clip is used as it is) and joins
 * them with a packet copy. An entry whose encoder headers differ from the
 * cache's (a segment entry is the reference) is re-encoded like the segments.
 * @returns {Promise<{checks: {entry: object, file: string, ranges: {from:number,to:number}[]}[], notes: string[]}>}
 */
async function assembleTrack({ resolved, fps, crf, preset, workDir, outPath }) {
  const reference = (resolved.find((r) => r.segment) || resolved[0]).file;
  const files = [];
  const checks = [];
  const notes = [];
  for (const [i, r] of resolved.entries()) {
    let file = r.file;
    let pieces = [{ kind: "copy", from: 0, to: r.frames }];
    if (!r.whole) {
      const cut = await cutFrames({ src: r.file, from: r.from, to: r.to, fps, crf, preset, outPath: path.join(workDir, `e${i}.mp4`) });
      file = cut.outPath;
      pieces = cut.pieces.map((p) => ({ kind: p.kind, from: p.from - r.from, to: p.to - r.from }));
    }
    if (!(await sameStream(reference, file))) {
      const like = path.join(workDir, `e${i}-like.mp4`);
      await reencodeLikeSegments({ src: file, like: await streamTags(reference), fps, crf, preset, outPath: like });
      file = like;
      pieces = [{ kind: "encode", from: 0, to: r.frames }];
      notes.push(`${r.label}: encoder headers differ from the cache's; re-encoded (crf ${crf}) before the join`);
    }
    files.push(file);
    checks.push({ entry: r, file, ranges: entryCheckRanges({ frames: r.frames, pieces, fresh: r.fresh }) });
  }
  await concatMp4(files, outPath, fps);
  return { checks, notes };
}

/**
 * The frame gate of --assemble: the frame count (from packets), then the
 * framemd5 of the new entries, the re-encoded pieces and the first/last frames
 * of every copied piece (the seams), against the same frames in their clips.
 * The rest of the film is packet-copied and is not decoded. Returns how many
 * frames were hashed.
 */
async function gateAssembled({ outPath, checks, expectedFrames, fps }) {
  const frames = await probePacketCount(outPath);
  if (frames !== expectedFrames) throw new Error(`--assemble frame count gate failed: the film has ${frames} frames, expected ${expectedFrames}`);
  let hashed = 0;
  for (const { entry, file, ranges } of checks) {
    for (const r of ranges) {
      const want = await frameHashRange(file, r.from, r.to, fps);
      const got = await frameHashRange(outPath, entry.outStart + r.from, entry.outStart + r.to, fps);
      const bad = got.findIndex((h, i) => h !== want[i]);
      if (got.length !== want.length || bad !== -1) {
        throw new Error(`--assemble framemd5 gate failed: film frame ${entry.outStart + r.from + Math.max(0, bad)} (${entry.label}) differs from its clip`);
      }
      hashed += r.to - r.from;
    }
  }
  return hashed;
}

/** Explicitly retained copies keep provenance without claiming they match the page. */
export function assembledSegmentMeta({ segment, fps, width, height, items, bad, keepAssembledCopies = false }) {
  if (bad.length && !keepAssembledCopies) return null;
  return { frameStart: segment.frameStart, frameEnd: segment.frameEnd, fps, width, height,
    probes: items.map(i => sha256Hex(i.image)),
    ...(bad.length ? { assembledCopy: { pageMismatch: true, probes: bad } } : {}) };
}

/**
 * After an assembly the film's own segments are cut back out of the track
 * (packet copy where the cut is on a keyframe) and their cache entries
 * rewritten with the page's probe hashes, so a later render, --span or --only
 * finds every segment current at its new place.
 */
async function refreshSegmentCache({ pool, segments, segDir, videoPath, fps, crf, preset, width, height, keepAssembledCopies = false }) {
  await pool.warmFor(segments.flatMap((s) => s.shotIds));
  await pool.use(async (session) => {
    for (const segment of segments) {
      const mp4Path = segMp4Path(segDir, segment.id);
      const tmpPath = uniqueTempPath(mp4Path);
      await cutFrames({ src: videoPath, from: segment.frameStart, to: segment.frameEnd, fps, crf, preset, outPath: tmpPath });
      // An mp4 with no meta is "never rendered"; the old meta must not outlive the old mp4.
      fs.rmSync(segJsonPath(segDir, segment.id), { force: true });
      fs.renameSync(tmpPath, mp4Path);
      const items = [];
      for (const f of probeFrameIndices(segment.frameStart, segment.frameEnd)) items.push({ index: f - segment.frameStart, image: await captureFrame(session.page, f / fps) });
      const bad = await clipVersusPage({ mp4: mp4Path, items, width, height });
      if (bad.length) {
        // No meta = "never rendered": the next render draws this segment instead of trusting frames that are not the page's.
        process.stderr.write(`warning: segment ${segment.id}: ${bad.length} of ${items.length} copied probe frames differ from what the page draws now (${bad.map((b) => `clip frame ${b.index}: ${(b.fraction * 100).toFixed(1)}% of pixels`).join("; ")}); copied frames are not page-current; without --keep-assembled-copies the next render draws them again\n`);
        if (!keepAssembledCopies) continue;
        process.stderr.write(`note: segment ${segment.id}: keeping copied frames for explicit --span edits; a normal probed render will redraw this segment\n`);
      }
      const meta = assembledSegmentMeta({ segment, fps, width, height, items, bad, keepAssembledCopies });
      if (meta) writeJson(segJsonPath(segDir, segment.id), meta);
    }
  });
}

async function renderAssembled({ dir, paths, pool, segments, segDir, edlPath, plan, fps, crf, preset, targetWidth, targetHeight, noCaptions, stubSec, stubSegments, fixPictureDuration, quality, keepAssembledCopies = false }) {
  const resolved = await resolveEdlEntries({ entries: parseEdl(readJson(edlPath)), dir, segDir, fps });
  const expectedFrames = segments[segments.length - 1].frameEnd - segments[0].frameStart;
  const edlFrames = resolved.reduce((n, r) => n + r.frames, 0);
  if (edlFrames !== expectedFrames) {
    throw new Error(`the EDL has ${edlFrames} frames, the page's timeline ${expectedFrames}: entries must tile the film exactly (the shots decide the length)`);
  }
  const decisions = resolved.map((r) => ({
    segment: { id: r.label, frameStart: r.outStart, frameEnd: r.outStart + r.frames },
    action: r.fresh ? "NEW" : "COPY",
    reason: `clip frames [${r.from},${r.to})${r.whole ? " (whole clip, used as it is)" : ""}`,
  }));
  printDecisions(decisions);
  if (plan) return { planOnly: true, decisions };
  const workDir = uniqueTempPath(path.join(segDir, "_assemble"));
  fs.mkdirSync(workDir, { recursive: true });
  const videoOnlyPath = uniqueTempPath(path.join(paths.outDir, "_video.mp4"));
  // finishTrack consumes the joined track; the cache is cut from this second name after the film is out.
  const cacheSourcePath = uniqueTempPath(path.join(paths.outDir, "_assembled.mp4"));
  try {
    const { checks, notes } = await assembleTrack({ resolved, fps, crf, preset, workDir, outPath: videoOnlyPath });
    for (const n of notes) process.stdout.write(`note: ${n}\n`);
    const hashed = await gateAssembled({ outPath: videoOnlyPath, checks, expectedFrames, fps });
    process.stdout.write(`assemble: ${expectedFrames} frames joined by packet copy; framemd5 checked on ${hashed} (new frames, re-encoded frames, seams)\n`);
    linkOrCopy(videoOnlyPath, cacheSourcePath);
  } catch (e) {
    fs.rmSync(videoOnlyPath, { force: true });
    fs.rmSync(cacheSourcePath, { force: true });
    throw e;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  try {
    const result = await finishTrack({ dir, paths, pool, videoOnlyPath, expectedFrames, segments, decisions, fps, noCaptions, stubSec, stubSegments, lang: null, quality, fixPictureDuration });
    await refreshAfterAssemble({ pool, segments, segDir, videoPath: cacheSourcePath, fps, crf, preset, width: targetWidth, height: targetHeight, keepAssembledCopies });
    return result;
  } finally {
    fs.rmSync(cacheSourcePath, { force: true });
  }
}

/** The cache rewrite of --assemble runs after the film is published; a failure here leaves the film and says what the next render will do. */
async function refreshAfterAssemble(args) {
  try {
    await refreshSegmentCache(args);
  } catch (e) {
    process.stderr.write(`warning: the film is written, but the segment cache was not brought up to date (${e.message}); the next render probes the changed segments again\n`);
  }
}

// ---- --handle / --use-draft: drafts a little longer than their slot --------

/** `--handle <sec>`: 0 when absent, else seconds >= 0. */
export function parseHandleFlag(value) {
  if (value === undefined) return 0;
  const n = typeof value === "string" ? Number(value) : NaN;
  if (value === "" || !Number.isFinite(n) || n < 0) throw new Error(`--handle takes seconds >= 0, e.g. --handle 0.5 (got "${value}")`);
  return n;
}

/**
 * Renders each shot of `onlyIds` as out/drafts/<id>.mp4 (+ <id>.json) over its
 * slot widened by the handle. Nothing else is written: no segment cache, no join.
 */
async function renderDrafts({ pool, segments, onlyIds, handleSec, fps, quality, crf, preset, scaleFilter, targetWidth, targetHeight, outDir, root, workers }) {
  const unknown = unknownOnlyIds({ segments, onlyIds });
  if (unknown.length) throw new Error(`--only references unknown segment(s): ${unknown.join(", ")}`);
  const filmStart = segments[0].frameStart;
  const filmEnd = segments[segments.length - 1].frameEnd;
  const dir = draftsDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = reelStamp(root);
  const jobs = onlyIds.map((id) => {
    const segment = segments.find((s) => s.id === id);
    const span = draftSpan({ segment, fps, filmStart, filmEnd, handleSec });
    return { segment, span, mp4Path: path.join(dir, `${id}.mp4`), jsonPath: path.join(dir, `${id}.json`) };
  });
  await pool.warmFor(jobs.flatMap((j) => shotIdsOver(segments, j.span.frameStart, j.span.frameEnd)));
  let idx = 0;
  async function worker() {
    let session = null;
    try {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        if (!session) session = await pool.acquire();
        await encodeSegment({ session, segment: job.span, outPath: job.mp4Path, fps, crf, preset, scaleFilter });
        const probes = [];
        for (const f of slotProbeFrames(job.segment)) probes.push(sha256Hex(await captureFrame(session.page, f / fps)));
        writeJson(job.jsonPath, draftSidecar({ segment: job.segment, span: job.span, fps, handleSec, quality, width: targetWidth, height: targetHeight, stamp, probes }));
        process.stdout.write(
          `DRAFT  ${job.segment.id}  frames [${job.span.frameStart},${job.span.frameEnd})  slot [${job.segment.frameStart},${job.segment.frameEnd})  handle -${job.span.handleBefore}/+${job.span.handleAfter} frames\n`
        );
      }
    } finally {
      if (session) pool.release(session);
    }
  }
  const n = Math.max(1, Math.min(workers, jobs.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return jobs.map((j) => j.span);
}

/**
 * `--use-draft <id>`: cuts the slot span out of out/drafts/<id>.mp4 (frame
 * exact, no page render) into out/drafts/<id>.slot.mp4 and returns it as the
 * --insert clip, placed at the slot's start.
 */
export async function cutDraftSlot({ dir: reelDir, paths, id, preview }) {
  if (typeof id !== "string" || !id) throw new Error("--use-draft takes a shot id");
  const dir = draftsDir(paths.outDir);
  const mp4 = path.join(dir, `${id}.mp4`);
  const jsonPath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(mp4) || !fs.existsSync(jsonPath)) throw new Error(`no draft for ${id} in ${dir} — render it with --only ${id} --handle <sec>`);
  const sidecar = readJson(jsonPath);
  const quality = preview ? "preview" : "final";
  if (sidecar.quality !== quality) throw new Error(`draft ${id} was rendered as ${sidecar.quality}; render with${sidecar.quality === "preview" ? "" : "out"} --preview to use it`);
  const cut = slotCut(sidecar);
  const root = reelDir || paths.root;
  const state = root ? compareDraft({ sidecar, stamp: reelStamp(root), probes: null }) : { state: "current" };
  if (state.state !== "current") process.stderr.write(`warning: draft ${id}: ${state.detail} (draft-check.mjs compares its slot frames with the page)\n`);
  const clipPath = path.join(dir, `${id}.slot.mp4`);
  await cutFrames({ src: mp4, from: cut.from, to: cut.to, fps: sidecar.fps, crf: preview ? 28 : 18, preset: preview ? "veryfast" : "medium", outPath: clipPath });
  process.stdout.write(`use-draft: ${id} slot cut from draft frames [${cut.from},${cut.to}) (${cut.frames} frames) at t=${cut.startSec.toFixed(4)}s\n`);
  return { clipPath, startSec: cut.startSec };
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

/** Probes the clip, plans the splice, prints the plan, writes stills when asked. */
async function prepareInsert({ insert, segments, fps }) {
  const info = await probeVideoInfo(insert.clipPath);
  if (Math.abs(info.fps - fps) > 1e-3) {
    throw new Error(`--insert clip runs at ${info.fps} fps, the reel at ${fps} fps — render the clip at the reel's fps`);
  }
  const clipFrames = await probePacketCount(insert.clipPath);
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
  const workDir = uniqueTempPath(path.join(segDir, "_insert"));
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
  await verifyInsertedSpan({ outPath, clipPath: result.clipUsed, startFrame: insertPlan.startFrame, expectedFrames, fps });
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
    else if (p.kind === "part") files.push((await cutFrames({ src: segmentPath(p.id), from: p.from, to: p.to, fps, crf, preset, outPath: path.join(workDir, `${p.id}-${p.from}-${p.to}.mp4`) })).outPath);
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
  await concatMp4(joined, outPath, fps);
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
 * Throws unless `outPath` has `expectedFrames` frames (counted from the packets,
 * nothing decoded) and its frames from `startFrame` hash (framemd5) the same as
 * every frame of `clipPath`. Only the inserted span is decoded.
 */
export async function verifyInsertedSpan({ outPath, clipPath, startFrame, expectedFrames, fps }) {
  const frames = await probePacketCount(outPath);
  if (frames !== expectedFrames) {
    throw new Error(`--insert frame count gate failed: joined video has ${frames} frames, expected ${expectedFrames}`);
  }
  const clip = await frameHashes(clipPath);
  const span = await frameHashRange(outPath, startFrame, startFrame + clip.length, fps || (await probeVideoInfo(outPath)).fps);
  const bad = span.findIndex((h, i) => h !== clip[i]);
  if (span.length !== clip.length || bad !== -1) {
    throw new Error(`--insert framemd5 gate failed: film frame ${startFrame + Math.max(0, bad)} differs from clip frame ${Math.max(0, bad)}`);
  }
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
        `(delta ${deltaMs.toFixed(1)}ms > ${AV_DELTA_MS_THRESHOLD}ms). ` +
        `The picture length ${videoDur.toFixed(3)}s is the page's own clock (its shots), so it is the right value: ` +
        `make voice/narration.wav ${videoDur.toFixed(3)}s long (voice.mjs / fit-track.mjs), and set "duration" in voice/timings.json to ${videoDur.toFixed(3)} if it differs`
    );
  }
  const frameCount = await probePacketCount(videoOnlyPath);
  if (frameCount !== expectedFrames) {
    throw new Error(`frame count gate failed: joined video has ${frameCount} frames, expected ${expectedFrames}`);
  }
}

async function maybeRenderSfx(pool, paths) {
  return pool.use(async (session) => {
    const sfxPath = uniqueTempPath(path.join(paths.outDir, "_sfx.wav"));
    return (await pullPageSfx(session.page, { sampleRate: 48000, outPath: sfxPath })) ? sfxPath : null;
  });
}

const SFX_CHUNK_FRAMES = 1 << 20; // ~22 s at 48 kHz: 4 MB per channel per call

/**
 * Runs the page's renderSfx(sampleRate) and writes its channels to
 * `outPath` as a 16-bit WAV, one chunk of `chunkFrames` frames per
 * page.evaluate. The samples cross as base64 of Float32 bytes, so Node never
 * holds the whole bed as JS numbers: a plain-array bed of a 5-minute film
 * returned in one evaluate ran Node out of its 4 GB heap. renderSfx may
 * return typed arrays (preferred; sliced without a copy) or plain arrays.
 * Each chunk is written before the next is fetched.
 * @param {{evaluate: Function}} page Playwright page (or a stand-in with the same evaluate)
 * @returns {Promise<{channels:number, frames:number}|null>} null when the page has no renderSfx or it returns nothing
 */
export async function pullPageSfx(page, { sampleRate, outPath, chunkFrames = SFX_CHUNK_FRAMES }) {
  const info = await page.evaluate(async (sr) => {
    const audio = window.__reel.audio;
    if (!audio || typeof audio.renderSfx !== "function") return null;
    const out = await audio.renderSfx(sr);
    if (!out || !out.length) return null;
    window.__svaSfx = Array.from(out);
    return { channels: out.length, frames: out[0] ? out[0].length : 0 };
  }, sampleRate);
  if (!info) return null;
  const writer = createWavPcm16Writer(outPath, { channels: info.channels, sampleRate, frames: info.frames });
  try {
    for (let start = 0; start < info.frames; start += chunkFrames) {
      const encoded = await page.evaluate(sfxChunkBase64, [start, Math.min(info.frames, start + chunkFrames)]);
      writer.write(encoded.map(decodeFloat32Base64));
    }
  } finally {
    writer.close();
  }
  await page.evaluate(() => {
    delete window.__svaSfx;
  });
  return info;
}

// Runs in the page: frames [start, end) of every channel as base64 of
// little-endian Float32 bytes.
function sfxChunkBase64([start, end]) {
  return window.__svaSfx.map((ch) => {
    const part = ch ? (ArrayBuffer.isView(ch) ? ch.subarray(start, end) : ch.slice(start, end)) : [];
    const f32 = part instanceof Float32Array ? part : Float32Array.from(part);
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

function decodeFloat32Base64(b64) {
  const bytes = Buffer.from(b64, "base64");
  const aligned = new Uint8Array(bytes.length); // own buffer: Float32Array needs a 4-byte-aligned offset
  aligned.set(bytes);
  return new Float32Array(aligned.buffer, 0, aligned.length >> 2);
}

/**
 * Reads window.__reel.soundCues() (design.md §2.5) and resolves each
 * `file` (relative to the reel dir) to an absolute path plus the trim
 * length and measured peak dB muxAudio needs to place it in the mix.
 * Returns [] when the page has no library cues — the no-cue mux path is
 * then untouched (byte-for-byte the same as before this feature).
 */
async function resolveSoundCues(pool, dir) {
  const cues = await pool.use(async (session) => {
    const hasFn = await session.page.evaluate(() => typeof window.__reel.soundCues === "function");
    return hasFn ? session.page.evaluate(() => window.__reel.soundCues()) : null;
  });
  const resolved = [];
  for (const cue of cues || []) {
    const absPath = path.join(dir, cue.file);
    const clipDur = await probeDuration(absPath);
    const leadSec = cue.soundOnly ? await probeLeadSilenceSec(absPath) : 0;
    const playable = Math.max(0.05, clipDur - leadSec);
    const trimSec = cue.maxSec ? Math.min(cue.maxSec, playable) : playable;
    const peakDb = await probePeakDb(absPath, leadSec + trimSec);
    resolved.push({ absPath, atSec: cue.at, gainDb: cue.gainDb, trimSec, peakDb, leadSec, ...cueFadeFields(cue) });
  }
  return resolved;
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
/** A picture-only stub may have no plan; a malformed existing plan still fails. */
export function fadeOutSecFor(dir) {
  if (!fs.existsSync(reelPaths(dir).planJson)) return undefined;
  return loadPlan(dir).meta?.sound?.fadeOutSec;
}

async function muxAudio({ videoOnlyPath, narrationPath, sfxPath, cueInputs, outPath, narrationWindows = [], sfxDuckDb, fadeOutSec }) {
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
      durationSec: videoSec,
      fadeOutSec,
    });
    const audioInputs = [narrationPath, ...(sfxPath ? [sfxPath] : []), ...cueInputs.map((c) => c.absPath)];
    const inputArgs = [videoOnlyPath, ...audioInputs].flatMap((p) => ["-i", p]);
    const { filter, measured, report } = await measurePremaster(inputArgs, filterComplex, outPath);
    noteMasterCap(report, measured);
    await finalMux(inputArgs, `${filterComplex};[premaster]${filter},apad[aout]`);
    return;
  }
  if (sfxPath) {
    const inputArgs = [videoOnlyPath, narrationPath, sfxPath].flatMap((p) => ["-i", p]);
    const premix = `[1:a]${TO_STEREO}[voice];[2:a]${TO_STEREO},${endFadeFilter(videoSec, fadeOutSec)}[sfx];[voice][sfx]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixed];[amixed]anull[premaster]`;
    const { filter, measured, report } = await measurePremaster(inputArgs, premix, outPath);
    noteMasterCap(report, measured);
    await finalMux(inputArgs, `${premix};[premaster]${filter},apad[aout]`);
    return;
  }
  // No sfx, no cues: the premix is just the narration file itself, no
  // separate pass-1 render needed.
  const inputArgs = [videoOnlyPath, narrationPath].flatMap((p) => ["-i", p]);
  const { filter, measured, report } = await measureMasterGain(narrationPath);
  noteMasterCap(report, measured);
  await finalMux(inputArgs, `[1:a]${filter},apad[aout]`);
}

/** Prints the master-gain fact when the boost cap held the gain (the film then sits under the target level). */
function noteMasterCap(report, measured) {
  const line = formatMasterCap(report, measured);
  if (line) process.stdout.write(line);
}

/** Runs pass 1 (renders `filterComplex`'s `[premaster]` label to a temp wav
 * next to `outPath`, then deletes it) and returns the measured loudness +
 * pass-2 gain filter (audio-mix.mjs measureMasterGain). */
async function measurePremaster(inputArgs, filterComplex, outPath) {
  const premasterPath = uniqueTempPath(`${outPath}.premaster.wav`);
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
async function muxBedOnly({ sfxPath, cueInputs, durationSec, fadeOutSec, outPath }) {
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
    const { filterComplex } = buildCueMixFilter({ narrationIndex: 0, hasSfx: !!sfxPath, cues: cueInputs, includeNarration: false, durationSec, fadeOutSec });
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
    `apad,${endFadeFilter(durationSec, fadeOutSec)}`,
    "-c:a",
    "pcm_s16le",
    "-t",
    durationSec,
    outPath,
  ]);
}

/** voice/timings.json's lines (or the --stub line) as {start,end} narration windows, for ducking (scripts/lib/duck.mjs). */
function narrationWindowsFor(dir, stubSec, stubSegments = 1) {
  const timings = stubSec ? stubTimings(stubSec, stubSegments) : loadTimings(dir);
  return (timings.lines || []).map((l) => ({ start: l.start, end: l.end }));
}

/** plan.meta.sound.sfxDuckDb, else the gentle duck default (lib/duck.mjs: -2.5 dB, 0.8 s ramps, gaps under 1.5 s held). Shared with dub.mjs. */
export function sfxDuckDbFromPlan(plan) {
  const sound = plan.meta && plan.meta.sound;
  return sound && sound.sfxDuckDb != null ? sound.sfxDuckDb : DUCK_DB_DEFAULT;
}

function sfxDuckDbFor(dir) {
  return sfxDuckDbFromPlan(loadPlan(dir));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
