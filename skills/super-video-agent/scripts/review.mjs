#!/usr/bin/env node
// Contact sheet, dead-air, A/V duration delta, layout issues
// -> out/review.json + human summary (design.md §2.3, §2.4).
// "Technical checks do not certify art" — this script reports what it
// checked, not whether the video looks good.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson, loadTimings } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, scanDeadAirBySeek, scanIssuesBySeek } from "./lib/browser.mjs";
import { render } from "./render.mjs";
import { probeDuration } from "./lib/ffmpeg.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { excludeEndHold } from "./lib/dead-air.mjs";
import { groupIssueRuns } from "./lib/layout-scan.mjs";
import { markOnsetOffset } from "./lib/sync-marks.mjs";
import {
  measureLoudness,
  decodeMonoPcm,
  longestSilenceAfterFirstSound,
} from "./lib/audio-analysis.mjs";

const HELP = `usage: review.mjs <reel-dir> [--mp4 <path>]
       review.mjs <reel-dir> --scan [stepSec]

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
    if (flags.scan) {
      const stepSec = typeof flags.scan === "string" ? parseFloat(flags.scan) : DENSE_SCAN_STEP_SEC_DEFAULT;
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

function printScanSummary(report) {
  const lines = [
    `dense layout scan: ${report.reelDir}`,
    `step: ${report.stepSec}s over ${report.duration.toFixed(2)}s (${report.sampleCount} samples)`,
    `issues: ${report.totalIssues} sample-hit(s) in ${report.runs.length} run(s)`,
  ];
  for (const r of report.runs) {
    lines.push(`  ${r.startSec.toFixed(2)}s-${r.endSec.toFixed(2)}s (${r.sampleCount} sample(s), types: ${r.types.join(", ")})`);
  }
  if (report.runs.length === 0) lines.push("no layout issues found across the scan");
  process.stdout.write(lines.join("\n") + "\n");
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
