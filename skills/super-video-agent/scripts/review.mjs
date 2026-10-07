#!/usr/bin/env node
// Contact sheet, dead-air, A/V duration delta, layout issues
// -> out/review.json + human summary (design.md §2.3, §2.4).
// "Technical checks do not certify art" — this script reports what it
// checked, not whether the video looks good.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, loadTimings, loadPlan, readJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, scanDeadAirBySeek, scanIssuesBySeek, grayFramesBySeek } from "./lib/browser.mjs";
import { render } from "./render.mjs";
import { probeDuration, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { excludeEndHold } from "./lib/dead-air.mjs";
import { groupIssueRuns } from "./lib/layout-scan.mjs";
import { captionLayerAliases, placedDuration, serveDirWithAliases } from "./lib/layout-scan-serve.mjs";
import { markOnsetOffset, pictureSampleTimes, pictureBeat, syncVerdict, PICTURE_WINDOW_SEC, PICTURE_FRAME_WIDTH } from "./lib/sync-marks.mjs";
import { extractGrayFrames, analyzeMotion } from "./lib/frame-diff.mjs";
import { loudnessSpread } from "./lib/join-report.mjs";
import {
  probeStreamDurations,
  partSpans,
  measureSpansLoudness,
  detectBlackRuns,
} from "./lib/join-report-media.mjs";
import {
  measureLoudness,
  decodeMonoPcm,
  longestSilenceAfterFirstSound,
  SILENCE_GATE_SEC,
  SILENCE_THRESHOLD_DB,
} from "./lib/audio-analysis.mjs";
import { gapsFromPcm } from "./lib/silence-gate.mjs";

const HELP = `usage: review.mjs <reel-dir> [--mp4 <path>]
       review.mjs <reel-dir> --scan [stepSec] [--layer captions [--dub <code>]]
       review.mjs --file <video.mp4> [--parts t1,t2,...] [--tail <sec>] [--json] [--out <report.json>]

Reviews a rendered reel: builds a contact sheet (one frame per shot's
readAt, with timestamps), scans for dead air, compares audio/video
duration, and collects layout issues(). Writes
<reel-dir>/out/review.json and prints a human summary.

--mp4   path to an already-rendered video (default: out/final.mp4, or
        out/preview.mp4, or render a preview now if neither exists).
--scan  dense layout scan instead of the normal review: seeks the whole
        film every [stepSec] seconds (default 0.1s), clearing and
        re-reading window.__reel.issues() at each step, and reports issue
        runs with their times — catches a problem the normal one-frame-
        per-shot Layout check misses (qa.md "What the tools cannot see").
        Writes <reel-dir>/out/review-scan.json.
--layer captions
        with --scan: loads reel.html?layer=captions&dub=<code>, where the
        page draws only its overlays (captions, labels) and skips the
        scene, so every frame can be scanned quickly. Default step is one
        frame (1/fps). <code> is --dub, or plan.json meta.lang when --dub
        is not given. For the base language (plan.json meta.lang) a
        missing dub/<code>/timings.placed.json is served from
        voice/timings.json and a missing dub/<code>/plan.json from
        plan.json; nothing is written into the reel.
        Writes <reel-dir>/out/review-scan-captions-<code>.json.
--file  reviews one finished video with no page (for example a joined
        upload file): video and audio stream lengths and their delta,
        integrated loudness of the whole file and of each part, picture
        dead air (runs of unchanged frames), audio silence after the
        first sound, and black-picture runs.
--parts part boundaries in seconds inside --file (e.g. the join times
        join.mjs printed); loudness is reported per part and the spread
        across parts.
--tail  with --file, the last <sec> seconds are the film's intended end
        hold (plan.json meta.tailSec, an end card): a still picture there
        is reported as the end hold, not as dead air. Without --tail, a
        file inside a reel's out/ folder takes the hold from that reel
        (the last line's end in voice/timings.json when the file is that
        length, else meta.tailSec); otherwise a still run that reaches the
        end of the file is labelled as a possible end hold.
--json  with --file, print the report as JSON.
--out   with --file, also write the JSON report to this path.
`;

const AV_DELTA_MS_THRESHOLD = 50;
const AUDIO_SAMPLE_RATE = 48000;
const SYNC_OFFSET_MIN_MS = -20;
const SYNC_OFFSET_MAX_MS = 40;
const DEAD_AIR_STEP_SEC = 0.1;
const DEAD_AIR_RUN_SEC_MIN = 0.8;
const DENSE_SCAN_STEP_SEC_DEFAULT = 0.1;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || (positional.length === 0 && typeof flags.file !== "string")) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  if (typeof flags.file === "string") {
    await runFileReview(flags);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }

  try {
    if (flags.scan) {
      const stepFlag = typeof flags.scan === "string" ? parseFloat(flags.scan) : undefined;
      if (flags.layer !== undefined) {
        if (flags.layer !== "captions") throw new Error(`--layer supports only "captions", got ${JSON.stringify(flags.layer)}`);
        const report = await scanCaptionLayer({ dir, paths, stepSec: stepFlag, dub: typeof flags.dub === "string" ? flags.dub : undefined });
        writeJson(path.join(paths.outDir, `review-scan-captions-${report.dub}.json`), report);
        printScanSummary(report);
        return;
      }
      const stepSec = stepFlag !== undefined ? stepFlag : DENSE_SCAN_STEP_SEC_DEFAULT;
      const report = await scanLayoutDense({ dir, paths, stepSec });
      writeJson(path.join(paths.outDir, "review-scan.json"), report);
      printScanSummary(report);
      return;
    }
    const report = await reviewReel({ dir, paths, mp4Flag: flags.mp4 ? abs(flags.mp4) : undefined });
    writeJson(path.join(paths.outDir, "review.json"), report);
    printSummary(report);
  } catch (e) {
    fail(e.message);
  }
}

/** --scan: seeks the whole film at `stepSec` and groups issues() hits into runs (scripts/lib/layout-scan.mjs). */
export async function scanLayoutDense({ dir, paths, stepSec }) {
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
    const { duration } = session.meta;
    const { times, issuesByTime } = await scanIssuesBySeek(session.page, { duration, stepSec });
    const runs = groupIssueRuns(times, issuesByTime);
    const totalIssues = issuesByTime.reduce((n, arr) => n + arr.length, 0);
    return {
      reelDir: dir,
      stepSec,
      duration,
      sampleCount: times.length,
      totalIssues,
      runs,
      note: "one frame per shot's readAt is not scanned here — this scans every stepSec seconds of the whole film instead.",
    };
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/**
 * --scan --layer captions: the same dense scan on the page's overlay-only
 * layer (?layer=captions&dub=<code>), one frame per step by default.
 */
export async function scanCaptionLayer({ dir, paths, stepSec, dub }) {
  const baseCode = readBaseLang(paths);
  const code = dub || baseCode;
  if (!code) throw new Error("--layer captions needs --dub <code> (plan.json has no meta.lang to use as the base language)");
  const aliases = captionLayerAliases(dir, { code, baseCode });
  const placed = path.join(dir, "dub", code, "timings.placed.json");
  if (!aliases[`/dub/${code}/timings.placed.json`] && !fs.existsSync(placed)) {
    throw new Error(`no ${placed} — run dub.mjs --lang ${code} first (only the base language falls back to voice/timings.json)`);
  }
  const server = await serveDirWithAliases(dir, aliases);
  let session;
  try {
    session = await openReel(`${server.url}reel.html?layer=captions&dub=${encodeURIComponent(code)}`, {});
    const { fps, layers } = session.meta;
    // The page reports the base picture's length; a --min-gap dub is longer.
    const duration = Math.max(session.meta.duration, placedDuration(dir, aliases, code) || 0);
    const step = stepSec !== undefined ? stepSec : 1 / fps;
    const { times, issuesByTime } = await scanIssuesBySeek(session.page, { duration, stepSec: step });
    const runs = groupIssueRuns(times, issuesByTime);
    const layerDeclared = (layers || []).includes("captions");
    return {
      reelDir: dir,
      layer: "captions",
      dub: code,
      baseLang: baseCode,
      servedInPlace: Object.fromEntries(Object.entries(aliases).map(([u, f]) => [u, path.relative(dir, f)])),
      layerDeclared,
      stepSec: step,
      duration,
      sampleCount: times.length,
      totalIssues: issuesByTime.reduce((n, arr) => n + arr.length, 0),
      runs,
      pageErrors: session.errors.slice(),
      note: layerDeclared
        ? "scanned the page's caption layer only (the scene is not drawn in this mode)."
        : 'reel.html does not declare "captions" in __reel.layers — it may have drawn its full scene, so this scan covered the whole picture.',
    };
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/** plan.json meta.lang, or null when the plan has none. */
function readBaseLang(paths) {
  if (!fs.existsSync(paths.planJson)) return null;
  const plan = readJson(paths.planJson);
  return (plan.meta && plan.meta.lang) || null;
}

function printScanSummary(report) {
  const title = report.layer ? `caption-layer scan (dub=${report.dub})` : "dense layout scan";
  const lines = [
    `${title}: ${report.reelDir}`,
    `step: ${report.stepSec.toFixed(4)}s over ${report.duration.toFixed(2)}s (${report.sampleCount} samples)`,
    `issues: ${report.totalIssues} sample-hit(s) in ${report.runs.length} run(s)`,
  ];
  for (const [u, f] of Object.entries(report.servedInPlace || {})) lines.push(`served ${u} from ${f}`);
  for (const r of report.runs) {
    const texts = r.texts && r.texts.length ? `, text: ${r.texts.map((t) => JSON.stringify(t)).join(", ")}` : "";
    lines.push(`  ${r.startSec.toFixed(2)}s-${r.endSec.toFixed(2)}s (${r.sampleCount} sample(s), types: ${r.types.join(", ")}${texts})`);
  }
  if (report.runs.length === 0) lines.push("no layout issues found across the scan");
  if (report.layer) lines.push(report.note);
  process.stdout.write(lines.join("\n") + "\n");
}

async function runFileReview(flags) {
  const file = abs(flags.file);
  if (!fs.existsSync(file)) {
    fail(`no such file: ${file}`);
    return;
  }
  try {
    const cuts = typeof flags.parts === "string" ? parseParts(flags.parts) : [];
    let tailSec;
    if (flags.tail !== undefined) {
      tailSec = parseFloat(flags.tail);
      if (!Number.isFinite(tailSec) || tailSec < 0) throw new Error(`--tail expects seconds >= 0, got "${flags.tail}"`);
    }
    const report = await reviewFile({ file, cuts, tailSec });
    if (typeof flags.out === "string") writeJson(abs(flags.out), report);
    process.stdout.write((flags.json ? JSON.stringify(report, null, 2) : formatFileReport(report)) + "\n");
  } catch (e) {
    fail(e.message);
  }
}

/** "8.03,41.5" -> [8.03, 41.5]; rejects anything that is not an ascending list of numbers. */
export function parseParts(text) {
  const cuts = text.split(",").map((s) => parseFloat(s.trim()));
  if (cuts.some((c) => !Number.isFinite(c) || c <= 0)) throw new Error(`--parts expects positive seconds, got "${text}"`);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] <= cuts[i - 1]) throw new Error(`--parts must be ascending, got "${text}"`);
  }
  return cuts;
}

/**
 * --file: facts about one finished video, no page. Every number is
 * reported; nothing here decides whether the video is good.
 * @param {{file:string, cuts:number[], tailSec?:number}} args tailSec: the intended end hold (--tail)
 */
export async function reviewFile({ file, cuts, tailSec }) {
  const streams = await probeStreamDurations(file);
  const totalSec = streams.videoSec != null ? streams.videoSec : await probeDuration(file);
  const avDeltaMs =
    streams.videoSec != null && streams.audioSec != null ? (streams.audioSec - streams.videoSec) * 1000 : null;

  const whole = await measureLoudness(file);
  const spans = partSpans(cuts, totalSec);
  const partLoudness = cuts.length ? await measureSpansLoudness(file, spans) : [];
  const parts = partLoudness.map((l, i) => ({ ...spans[i], ...l }));

  const { fps } = await probeVideoInfo(file);
  const { frames } = await extractGrayFrames(file, fps, { width: 64 });
  const { deadAirRuns } = analyzeMotion(frames, fps);
  const hold = fileEndHold({ file, totalSec, tailSec });
  const deadAir = splitEndHold(deadAirRuns, hold, totalSec, fps);

  const pcm = streams.audioSec != null ? await decodeMonoPcm(file, AUDIO_SAMPLE_RATE) : new Float32Array(0);
  const silence = longestSilenceAfterFirstSound(pcm, AUDIO_SAMPLE_RATE, { thresholdDb: -50 });
  const blackRuns = await detectBlackRuns(file, { minSec: 1 / fps });

  return {
    file,
    fps,
    streams: { videoSec: streams.videoSec, audioSec: streams.audioSec, audioMinusVideoMs: avDeltaMs },
    loudness: {
      whole,
      parts,
      spread: parts.length ? loudnessSpread(parts.map((p) => p.integratedLufs)) : null,
    },
    deadAir: {
      ...deadAir,
      note:
        "runs of >=0.8 s where under 0.2 % of 64-px greyscale pixels change between frames. endHold is the film's intended still end (--tail, or the reel this file sits in) and is not counted in runs; with no hold known, a run that reaches the end of the file carries possibleEndHold: true",
    },
    silence: { ...silence, thresholdDb: -50 },
    black: { runs: blackRuns },
  };
}

/**
 * Where the film's intended end hold starts, for --file: --tail when given;
 * else, when the file sits in <reel>/out/, the reel's last line end
 * (voice/timings.json, if the file is that film's length — as the page
 * review uses) or its plan.json meta.tailSec; else null.
 * @returns {{startSec:number, source:string}|null}
 */
export function fileEndHold({ file, totalSec, tailSec }) {
  if (tailSec != null) return { startSec: Math.max(0, totalSec - tailSec), source: `--tail ${tailSec}` };
  const outDir = path.dirname(file);
  if (path.basename(outDir) !== "out") return null;
  const reel = path.dirname(outDir);
  const paths = reelPaths(reel);
  if (!fs.existsSync(paths.planJson) && !fs.existsSync(paths.timingsJson)) return null;
  try {
    const t = fs.existsSync(paths.timingsJson) ? readJson(paths.timingsJson) : null;
    const last = t && t.lines && t.lines.length ? t.lines[t.lines.length - 1].end : null;
    if (last != null && t.duration != null && Math.abs(t.duration - totalSec) <= 0.1) {
      return { startSec: last, source: "voice/timings.json (last line end)" };
    }
  } catch {
    // unreadable timings: try the plan
  }
  try {
    const plan = fs.existsSync(paths.planJson) ? readJson(paths.planJson) : null;
    const tail = plan && plan.meta && plan.meta.tailSec;
    if (typeof tail === "number" && tail > 0) return { startSec: Math.max(0, totalSec - tail), source: `plan.json meta.tailSec ${tail}` };
  } catch {
    // no usable plan
  }
  return null;
}

/**
 * Split --file dead-air runs around the end hold: with a known hold, only
 * the part of a run before it counts (same rule as the page review's
 * excludeEndHold); with none, a run reaching the last frame is kept but
 * marked possibleEndHold.
 * @returns {{runs: object[], endHold: {startSec:number, durationSec:number, source:string}|null}}
 */
export function splitEndHold(runs, hold, totalSec, fps) {
  if (hold) {
    return {
      runs: excludeEndHold(runs, hold.startSec, DEAD_AIR_RUN_SEC_MIN),
      endHold: { startSec: hold.startSec, durationSec: Math.max(0, totalSec - hold.startSec), source: hold.source },
    };
  }
  const endTol = 2 / fps;
  return {
    runs: runs.map((r) => (r.startSec + r.durationSec >= totalSec - endTol ? { ...r, possibleEndHold: true } : r)),
    endHold: null,
  };
}

function formatFileReport(r) {
  const f = (v, d = 3) => (v == null ? "n/a" : v.toFixed(d));
  const lines = [
    `file: ${r.file}`,
    `streams: video=${f(r.streams.videoSec)}s audio=${f(r.streams.audioSec)}s audio-video=${f(r.streams.audioMinusVideoMs, 1)}ms`,
    `loudness (whole): I=${f(r.loudness.whole.integratedLufs, 1)} LUFS truePeak=${f(r.loudness.whole.truePeakDb, 1)} dBFS`,
  ];
  for (const p of r.loudness.parts) {
    lines.push(`  part ${p.index} ${f(p.startSec, 2)}s +${f(p.durationSec, 2)}s: I=${f(p.integratedLufs, 1)} LUFS truePeak=${f(p.truePeakDb, 1)} dBFS`);
  }
  if (r.loudness.spread && r.loudness.spread.spreadLu != null) {
    lines.push(`  spread across parts: ${f(r.loudness.spread.spreadLu, 2)} LU${r.loudness.spread.warn ? " (over 1 LU)" : ""}`);
  }
  lines.push(
    `picture dead air: ${r.deadAir.runs.length} run(s)${r.deadAir.runs
      .map((x) => ` ${f(x.startSec, 2)}s+${f(x.durationSec, 2)}s${x.possibleEndHold ? " (reaches the end: an end hold if the film has meta.tailSec; pass --tail <sec>)" : ""}`)
      .join(",")}`
  );
  if (r.deadAir.endHold) {
    const h = r.deadAir.endHold;
    lines.push(`end hold: ${f(h.startSec, 2)}s to the end (${f(h.durationSec, 2)}s, from ${h.source}) — intended, not counted as dead air`);
  }
  lines.push(`audio: longest silence after first sound ${f(r.silence.longestSilenceSec)}s (first sound at ${f(r.silence.firstSoundSec)}s)`);
  lines.push(`black picture: ${r.black.runs.length} run(s)${r.black.runs.map((x) => ` ${f(x.startSec, 2)}-${f(x.endSec, 2)}s`).join(",")}`);
  return lines.join("\n");
}

/**
 * The narration silence check: the longest silence after the first sound, and
 * every pause over the gate split into planned (the plan's pauseAfterMs, or a
 * long meta.gapMs — not a failure) and unplanned (a failure). Same
 * measurement as voice.mjs's silence gate (scripts/lib/silence-gate.mjs).
 */
export function narrationSilenceCheck({ pcm, sampleRate, timingsLines, plan }) {
  const silence = longestSilenceAfterFirstSound(pcm, sampleRate, { thresholdDb: SILENCE_THRESHOLD_DB });
  const planLines = (plan && plan.lines) || [];
  const gapMs = plan && plan.meta && plan.meta.gapMs != null ? plan.meta.gapMs : undefined;
  const silenceGaps = gapsFromPcm(pcm, sampleRate, timingsLines || [], planLines, { gapMs });
  return { silence, silenceGaps };
}

export async function reviewReel({ dir, paths, mp4Flag }) {
  let mp4Path = mp4Flag;
  let renderedNow = false;
  if (!mp4Path) {
    const finalPath = path.join(paths.outDir, "final.mp4");
    const previewPath = path.join(paths.outDir, "preview.mp4");
    if (fs.existsSync(finalPath)) mp4Path = finalPath;
    else if (fs.existsSync(previewPath)) mp4Path = previewPath;
    else {
      const result = await render({ dir, paths, preview: true, workers: 1 });
      mp4Path = result.outPath;
      renderedNow = true;
    }
  }

  const server = await serveDir(dir);
  let session;
  let contactSheetPath;
  let issuesByShot = [];
  try {
    session = await openReel(server.url, {});
    const { shots, fps, duration } = session.meta;
    const marks = await session.page.evaluate(() => (window.__reel && window.__reel.marks) || []);

    // Layout issues at each shot's readAt: clear -> seek -> issues(), so
    // each entry reflects only that frame's draw, not everything drawn so far.
    const shotFrames = [];
    for (const shot of shots) {
      await session.page.evaluate(() => window.Reel.clearIssues());
      const png = await captureFrame(session.page, shot.readAt);
      const issues = await session.page.evaluate(() => window.__reel.issues());
      issuesByShot.push({ shotId: shot.id, readAt: shot.readAt, issues });
      shotFrames.push({ png, label: `${shot.id} t=${shot.readAt.toFixed(2)}s` });
    }

    const sheet = await buildContactSheet(shotFrames, {});
    contactSheetPath = path.join(paths.outDir, "contact-sheet.png");
    fs.writeFileSync(contactSheetPath, sheet);

    // Dead air is judged from what the page actually draws (seek() through
    // the timeline, hash the native-resolution canvas), not a downscaled
    // ffmpeg pixel diff — see scanDeadAirBySeek.
    const deadAirScan = await scanDeadAirBySeek(session.page, {
      duration,
      stepSec: DEAD_AIR_STEP_SEC,
      runSecMin: DEAD_AIR_RUN_SEC_MIN,
    });

    const videoDuration = await probeDuration(mp4Path);
    const audioDuration = duration; // timings.json duration, the timeline authority
    const avDeltaMs = Math.abs(videoDuration - audioDuration) * 1000;
    // shots (design point 4) now always span to the *next* shot's start (or
    // the film's end) so they tile — that's not "the last line's end". The
    // narration span authority for both checks below is timings.json lines.
    const timings = loadTimings(dir);
    const lastLineEnd = timings.lines && timings.lines.length ? timings.lines[timings.lines.length - 1].end : 0;
    const lastLineEndsBeforeFinalFrame = lastLineEnd <= videoDuration;

    const allIssues = issuesByShot.flatMap((s) => s.issues);
    const deadAirRuns = excludeEndHold(deadAirScan.runs, lastLineEnd, DEAD_AIR_RUN_SEC_MIN);

    const loudness = await measureLoudness(mp4Path);
    const pcm = await decodeMonoPcm(mp4Path, AUDIO_SAMPLE_RATE);
    // Silence is measured only inside the narration span (first sound ->
    // last line's end) so an intended silent tail/end card (see
    // plan.json meta.tailSec) is not counted as a gap to flag.
    const narrationPcm = pcm.subarray(0, Math.min(pcm.length, Math.round(lastLineEnd * AUDIO_SAMPLE_RATE)));
    let plan = null;
    try {
      plan = loadPlan(dir);
    } catch {
      plan = null;
    }
    const { silence, silenceGaps } = narrationSilenceCheck({ pcm: narrationPcm, sampleRate: AUDIO_SAMPLE_RATE, timingsLines: timings.lines, plan });
    // A mark inside a narration window may sit on a sound render.mjs ducked
    // (scripts/lib/duck.mjs, references/sound.md "Mix") — flag that here so
    // a borderline offset reads as expected, not a silent regression.
    const narrationWindows = (timings.lines || []).map((l) => ({ start: l.start, end: l.end }));
    // Marks are measured on their own effects-only stem (window.__reel.
    // sfxStems(), the same cue rendered alone — sound.md "Sound cards")
    // when one exists, so a mark that lands on a spoken word measures the
    // effect's own onset instead of the voice's. Falls back to the full mix
    // only when sfxStems() is absent or has no stem for that mark.
    const hasSfxStems = await session.page.evaluate(() => typeof window.__reel.sfxStems === "function");
    const stems = hasSfxStems
      ? await session.page.evaluate((sr) => window.__reel.sfxStems(sr), AUDIO_SAMPLE_RATE)
      : [];
    // The sound side: each mark's onset in its own stem (or the mix). The
    // picture side: the frame where the canvas changes most within
    // ±PICTURE_WINDOW_SEC of the mark (sync marks only). The gated offset is
    // sound onset minus picture beat — the stem alone reads ~0 ms for any cue
    // placed on its own `at`, so it could never fail a cue drawn off its beat.
    const markResults = [];
    for (const m of marks) {
      const { offsetMs: soundOnsetMs, source } = markOnsetOffset(m, { stems, mixPcm: pcm, sampleRate: AUDIO_SAMPLE_RATE, windowSec: 0.15 });
      const sync = !!m.sync;
      const duckedByNarration = narrationWindows.some((w) => m.at >= w.start && m.at <= w.end);
      let beat = null;
      let reason = "not a sync mark";
      if (sync) {
        const times = pictureSampleTimes(m.at, fps, { duration });
        const frames = await grayFramesBySeek(session.page, times, { width: PICTURE_FRAME_WIDTH });
        ({ beat, reason } = pictureBeat(times, frames));
      }
      const v = syncVerdict(m, { soundOnsetMs, beat, reason, minMs: SYNC_OFFSET_MIN_MS, maxMs: SYNC_OFFSET_MAX_MS });
      markResults.push({
        at: m.at,
        kind: m.kind,
        sync,
        offsetMs: v.offsetMs,
        pictureAt: v.pictureAt,
        soundOnsetMs,
        source,
        measured: v.measured,
        notMeasured: v.notMeasured,
        duckedByNarration,
        pass: v.pass,
      });
    }
    const silencePass = silenceGaps.unplanned.length === 0;
    // A sync mark that could not be measured (pass: null) is reported, not passed or failed.
    const marksPass = markResults.every((m) => m.pass !== false);

    const report = {
      reelDir: dir,
      mp4: mp4Path,
      renderedNow,
      contactSheet: contactSheetPath,
      fps,
      duration: { video: videoDuration, audio: audioDuration, deltaMs: avDeltaMs },
      thresholds: {
        avDeltaMsMax: AV_DELTA_MS_THRESHOLD,
        deadAirRunSecMax: DEAD_AIR_RUN_SEC_MIN,
        deadAirStepSec: DEAD_AIR_STEP_SEC,
        syncOffsetMsRange: [SYNC_OFFSET_MIN_MS, SYNC_OFFSET_MAX_MS],
      },
      checks: {
        avSync: {
          pass: avDeltaMs <= AV_DELTA_MS_THRESHOLD && lastLineEndsBeforeFinalFrame,
          deltaMs: avDeltaMs,
          lastLineEndsBeforeFinalFrame,
        },
        deadAir: {
          pass: deadAirRuns.length === 0,
          runs: deadAirRuns,
          endHoldSec: Math.max(0, videoDuration - lastLineEnd),
          note: "measured from seek() output at native resolution: canvas pixel hash every 0.1s, a run of identical hashes >=0.8s is flagged; the end hold after the last line (meta.tailSec) is not counted",
        },
        layout: {
          pass: allIssues.length === 0,
          issueCount: allIssues.length,
          byShot: issuesByShot,
        },
        audio: {
          pass: silencePass && marksPass,
          integratedLufs: loudness.integratedLufs,
          truePeakDb: loudness.truePeakDb,
          longestSilenceSec: silence.longestSilenceSec,
          silenceGateSec: SILENCE_GATE_SEC,
          silencePass,
          silenceGaps: { unplanned: silenceGaps.unplanned, planned: silenceGaps.planned },
          marks: markResults,
          onsetSourceNote:
            "offsetMs = the sound's onset minus the picture beat (sync marks only). The sound's onset is mark.at + soundOnsetMs, measured on the cue's own effects-only stem (window.__reel.sfxStems(), source:'stems') when one exists, so a mark on a spoken word measures the effect, not the voice; otherwise on the full mix (source:'mix'). soundOnsetMs alone is ~0 for any cue by construction (the stem is the cue at its own time) and says nothing about the picture. The picture beat (pictureAt) is where the largest burst of frame-to-frame change (" + PICTURE_FRAME_WIDTH + "-px greyscale, read from seek()) within ±" + PICTURE_WINDOW_SEC + " s of the mark starts, ± half a frame. A sync mark with no clear beat (no change, or steady motion everywhere in the window) is measured:false with the reason in notMeasured, and neither passes nor fails.",
          duckingNote:
            "render.mjs ducks library asset cue sounds (plan.json line `cues`) by meta.sound.sfxDuckDb (default -6dB, ~80ms ramps) while a narration line speaks; each mark above carries duckedByNarration for whether it fell inside a narration window. The sync tolerance (-20..+40ms) is unchanged, but a mark on a ducked sound near that edge is expected, not a regression.",
        },
      },
      note: "Technical checks do not certify art — this reports what was mechanically checked (motion, sync, layout); a human must read the contact sheet and judge composition, legibility, and taste.",
    };
    return report;
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

function printSummary(report) {
  const c = report.checks;
  const lines = [
    `reel: ${report.reelDir}`,
    `video: ${report.mp4}${report.renderedNow ? " (rendered now, preview)" : ""}`,
    `contact sheet: ${report.contactSheet}`,
    `A/V duration: video=${report.duration.video.toFixed(3)}s audio=${report.duration.audio.toFixed(3)}s delta=${report.duration.deltaMs.toFixed(1)}ms [${c.avSync.pass ? "PASS" : "FAIL"}]`,
    `dead air: ${c.deadAir.runs.length} run(s) >=0.8s [${c.deadAir.pass ? "PASS" : "FAIL"}]`,
    `layout issues: ${c.layout.issueCount} [${c.layout.pass ? "PASS" : "FAIL"}]`,
    `audio: I=${c.audio.integratedLufs == null ? "n/a" : c.audio.integratedLufs.toFixed(1) + " LUFS"} truePeak=${c.audio.truePeakDb == null ? "n/a" : c.audio.truePeakDb.toFixed(1) + " dBFS"} longest silence in narration=${c.audio.longestSilenceSec.toFixed(3)}s (gate ${c.audio.silenceGateSec}s, ${c.audio.silenceGaps.planned.length} planned) [${c.audio.silencePass ? "PASS" : "FAIL"}]${c.audio.silenceGaps.unplanned.map((g) => ` gap ${g.startSec.toFixed(2)}-${g.endSec.toFixed(2)}s after line ${g.afterId}`).join(";")}`,
    syncMarksLine(c.audio.marks),
    report.note,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/** One summary line for the sync marks: sound onset vs picture beat, and which ones could not be measured. */
export function syncMarksLine(marks) {
  const syncMarks = marks.filter((m) => m.sync);
  const measured = syncMarks.filter((m) => m.measured);
  const notMeasured = syncMarks.filter((m) => !m.measured);
  const verdict = marks.some((m) => m.pass === false)
    ? "FAIL"
    : syncMarks.length && !measured.length
      ? "NOT MEASURED"
      : "PASS";
  const each = syncMarks
    .map((m) =>
      m.measured
        ? `${m.kind}@${m.at.toFixed(2)}s ${m.offsetMs >= 0 ? "+" : ""}${m.offsetMs}ms vs picture ${m.pictureAt.toFixed(3)}s`
        : `${m.kind}@${m.at.toFixed(2)}s not measured (${m.notMeasured})`
    )
    .join("; ");
  return (
    `sync marks: ${marks.length} (${syncMarks.length} sync, ${measured.length} measured against the picture, ` +
    `${notMeasured.length} not measured, ${marks.filter((m) => m.source === "mix").length} sound onset(s) on the mix fallback)` +
    `${each ? " " + each : ""} [${verdict}]`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
