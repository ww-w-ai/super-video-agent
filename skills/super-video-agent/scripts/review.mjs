#!/usr/bin/env node
// Contact sheet, dead-air, A/V duration delta, layout issues
// -> out/review.json + human summary (design.md §2.3, §2.4).
// "Technical checks do not certify art" — this script reports what it
// checked, not whether the video looks good.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, loadTimings, readJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, scanDeadAirBySeek, scanIssuesBySeek } from "./lib/browser.mjs";
import { render } from "./render.mjs";
import { probeDuration, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { excludeEndHold } from "./lib/dead-air.mjs";
import { groupIssueRuns } from "./lib/layout-scan.mjs";
import { captionLayerAliases, serveDirWithAliases } from "./lib/layout-scan-serve.mjs";
import { markOnsetOffset } from "./lib/sync-marks.mjs";
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
} from "./lib/audio-analysis.mjs";

const HELP = `usage: review.mjs <reel-dir> [--mp4 <path>]
       review.mjs <reel-dir> --scan [stepSec] [--layer captions [--dub <code>]]
       review.mjs --file <video.mp4> [--parts t1,t2,...] [--json] [--out <report.json>]

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
--json  with --file, print the report as JSON.
--out   with --file, also write the JSON report to this path.
`;

const AV_DELTA_MS_THRESHOLD = 50;
const AUDIO_SAMPLE_RATE = 48000;
const SILENCE_GATE_SEC = 1.0; // a pause inside the narration longer than ~1 s fails
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
    const { duration, fps, layers } = session.meta;
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
    const report = await reviewFile({ file, cuts });
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
 * @param {{file:string, cuts:number[]}} args
 */
export async function reviewFile({ file, cuts }) {
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
      runs: deadAirRuns,
      note: "runs of >=0.8 s where under 0.2 % of 64-px greyscale pixels change between frames; an intended hold (end card) is reported too",
    },
    silence: { ...silence, thresholdDb: -50 },
    black: { runs: blackRuns },
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
  lines.push(`picture dead air: ${r.deadAir.runs.length} run(s)${r.deadAir.runs.map((x) => ` ${f(x.startSec, 2)}s+${f(x.durationSec, 2)}s`).join(",")}`);
  lines.push(`audio: longest silence after first sound ${f(r.silence.longestSilenceSec)}s (first sound at ${f(r.silence.firstSoundSec)}s)`);
  lines.push(`black picture: ${r.black.runs.length} run(s)${r.black.runs.map((x) => ` ${f(x.startSec, 2)}-${f(x.endSec, 2)}s`).join(",")}`);
  return lines.join("\n");
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
    const silence = longestSilenceAfterFirstSound(narrationPcm, AUDIO_SAMPLE_RATE, { thresholdDb: -50 });
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
    const markResults = marks.map((m) => {
      const { offsetMs, source } = markOnsetOffset(m, { stems, mixPcm: pcm, sampleRate: AUDIO_SAMPLE_RATE, windowSec: 0.15 });
      const sync = !!m.sync;
      const duckedByNarration = narrationWindows.some((w) => m.at >= w.start && m.at <= w.end);
      const pass =
        !sync ||
        (offsetMs != null && offsetMs >= SYNC_OFFSET_MIN_MS && offsetMs <= SYNC_OFFSET_MAX_MS);
      return { at: m.at, kind: m.kind, sync, offsetMs, source, duckedByNarration, pass };
    });
    const silencePass = silence.longestSilenceSec <= SILENCE_GATE_SEC;
    const marksPass = markResults.every((m) => m.pass);

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
          marks: markResults,
          onsetSourceNote:
            "each mark's offsetMs is measured on its own effects-only stem (window.__reel.sfxStems(), source:'stems') when one exists, so a mark on a spoken word measures the effect's onset, not the voice's; a mark with no matching stem falls back to the full mix (source:'mix'), same as before this page provided sfxStems.",
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
    `audio: I=${c.audio.integratedLufs == null ? "n/a" : c.audio.integratedLufs.toFixed(1) + " LUFS"} truePeak=${c.audio.truePeakDb == null ? "n/a" : c.audio.truePeakDb.toFixed(1) + " dBFS"} longest silence in narration=${c.audio.longestSilenceSec.toFixed(3)}s (gate ${c.audio.silenceGateSec}s) [${c.audio.silencePass ? "PASS" : "FAIL"}]`,
    `sync marks: ${c.audio.marks.length} (${c.audio.marks.filter((m) => m.sync).length} sync, ${c.audio.marks.filter((m) => m.source === "mix").length} measured on the mix fallback) offsets=${c.audio.marks.map((m) => (m.offsetMs == null ? "n/a" : m.offsetMs + "ms")).join(", ")} [${c.audio.marks.every((m) => m.pass) ? "PASS" : "FAIL"}]`,
    report.note,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
