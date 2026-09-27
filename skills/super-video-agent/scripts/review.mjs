#!/usr/bin/env node
// Contact sheet, dead-air, boil cadence, A/V duration delta, layout issues
// -> out/review.json + human summary (design.md §2.3, §2.4).
// "Technical checks do not certify art" — this script reports what it
// checked, not whether the video looks good.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, loadTimings } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, scanDeadAirBySeek } from "./lib/browser.mjs";
import { render } from "./render.mjs";
import { probeDuration } from "./lib/ffmpeg.mjs";
import { extractGrayFrames, analyzeMotion, estimateBoilCadence, evaluateBoilCadence } from "./lib/frame-diff.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { excludeEndHold } from "./lib/dead-air.mjs";
import {
  measureLoudness,
  decodeMonoPcm,
  longestSilenceAfterFirstSound,
  findOnsetOffsetMs,
} from "./lib/audio-analysis.mjs";

const HELP = `usage: review.mjs <reel-dir> [--mp4 <path>]

Reviews a rendered reel: builds a contact sheet (one frame per shot's
readAt, with timestamps), scans for dead air, estimates boil cadence,
compares audio/video duration, and collects layout issues(). Writes
<reel-dir>/out/review.json and prints a human summary.

--mp4  path to an already-rendered video (default: out/final.mp4, or
       out/preview.mp4, or render a preview now if neither exists).
`;

const AV_DELTA_MS_THRESHOLD = 50;
const AUDIO_SAMPLE_RATE = 48000;
const SILENCE_GATE_SEC = 1.0; // a pause inside the narration longer than ~1 s fails
const SYNC_OFFSET_MIN_MS = -20;
const SYNC_OFFSET_MAX_MS = 40;
const DEAD_AIR_STEP_SEC = 0.1;
const DEAD_AIR_RUN_SEC_MIN = 0.8;

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

  try {
    const report = await reviewReel({ dir, paths, mp4Flag: flags.mp4 ? abs(flags.mp4) : undefined });
    writeJson(path.join(paths.outDir, "review.json"), report);
    printSummary(report);
  } catch (e) {
    fail(e.message);
  }
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

    // Boil cadence still uses the ffmpeg pixel-diff scan (design.md §2.4):
    // at native resolution (or, for a --preview render, whatever "native"
    // already halved down to) so sub-pixel boil motion survives analysis.
    const isPreviewMp4 = /^preview(-[0-9-]+)?\.mp4$/.test(path.basename(fs.realpathSync(mp4Path)));
    const cadenceGray = await extractGrayFrames(mp4Path, fps, { width: null });
    const cadenceMotion = analyzeMotion(cadenceGray.frames, fps);
    const cadenceEstimate = estimateBoilCadence(cadenceMotion.fractions, fps);
    const plannedBoilHz = 8; // matches engine default (design.md §2.2 boil hz=8)
    const plannedCadenceSec = 1 / plannedBoilHz;
    const cadenceToleranceSec = 1 / fps; // "±1 frame" (design.md §2.4)
    const boilCadence = evaluateBoilCadence({
      cadenceSec: cadenceEstimate.cadenceSec,
      spikeCount: cadenceEstimate.spikeCount,
      plannedHz: plannedBoilHz,
      toleranceSec: cadenceToleranceSec,
      isPreview: isPreviewMp4,
      analyzedWidthPx: cadenceGray.w,
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
    const markResults = marks.map((m) => {
      const offsetMs = findOnsetOffsetMs(pcm, AUDIO_SAMPLE_RATE, m.at, 0.15);
      const sync = !!m.sync;
      const pass =
        !sync ||
        (offsetMs != null && offsetMs >= SYNC_OFFSET_MIN_MS && offsetMs <= SYNC_OFFSET_MAX_MS);
      return { at: m.at, kind: m.kind, sync, offsetMs, pass };
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
        boilCadenceToleranceSec: cadenceToleranceSec,
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
        boilCadence,
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
    `boil cadence: planned=${c.boilCadence.plannedIntervalSec.toFixed(3)}s estimated=${c.boilCadence.estimatedIntervalSec == null ? "n/a" : c.boilCadence.estimatedIntervalSec.toFixed(3) + "s"} (analyzed at ${c.boilCadence.analyzedWidthPx}px) [${c.boilCadence.status.toUpperCase()}]`,
    `layout issues: ${c.layout.issueCount} [${c.layout.pass ? "PASS" : "FAIL"}]`,
    `audio: I=${c.audio.integratedLufs == null ? "n/a" : c.audio.integratedLufs.toFixed(1) + " LUFS"} truePeak=${c.audio.truePeakDb == null ? "n/a" : c.audio.truePeakDb.toFixed(1) + " dBFS"} longest silence in narration=${c.audio.longestSilenceSec.toFixed(3)}s (gate ${c.audio.silenceGateSec}s) [${c.audio.silencePass ? "PASS" : "FAIL"}]`,
    `sync marks: ${c.audio.marks.length} (${c.audio.marks.filter((m) => m.sync).length} sync) offsets=${c.audio.marks.map((m) => (m.offsetMs == null ? "n/a" : m.offsetMs + "ms")).join(", ")} [${c.audio.marks.every((m) => m.pass) ? "PASS" : "FAIL"}]`,
    report.note,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
