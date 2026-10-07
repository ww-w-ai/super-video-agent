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
import { openReel, captureFrame, scanDeadAirBySeek, scanIssuesBySeek, splitEngineFacts, engineFactLines, readSafeAreaNote } from "./lib/browser.mjs";
import { render } from "./render.mjs";
import { ffmpeg, probeDuration, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { excludeEndHold, splitIntendedHolds } from "./lib/dead-air.mjs";
import { groupIssueRuns } from "./lib/layout-scan.mjs";
import { captionLayerAliases, placedDuration, serveDirWithAliases } from "./lib/layout-scan-serve.mjs";
import { markOnsetOffset } from "./lib/sync-marks.mjs";
import { sameLanguageTag } from "./lib/lang-tag.mjs";
import { extractGrayFrames, analyzeMotion, FREEZE_SCAN_WIDTH } from "./lib/frame-diff.mjs";
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
import { gapsFromPcm, silenceNote } from "./lib/silence-gate.mjs";
import { loudnessUnderTarget } from "./lib/audio-mix.mjs";
import { findClipDefects, describeDefects, waveformFlag } from "./voice/take-check.mjs";
import { checkedNothingNext } from "./lib/checked-nothing.mjs";

const HELP = `usage: review.mjs <reel-dir> [--mp4 <path>]
       review.mjs <reel-dir> --scan [stepSec] [--layer captions [--dub <code>]]
       review.mjs --file <video.mp4> [--parts t1,t2,...] [--holds a-b,c-d] [--json] [--out <report.json>]
       review.mjs <reel-dir> --copy [--lang <code,code>] [--out <dir>]

Reviews a rendered reel: builds a contact sheet (one frame per shot's
readAt, with timestamps), scans for dead air, compares audio/video
duration, and collects layout issues(). Writes
<reel-dir>/out/review.json and prints a human summary. The summary also lists
fresh voice clip facts measured from current line audio (HEAD, TAIL, DIP, PAUSE
per line). Stored clipFacts are ignored; unavailable clips are reported unchecked.

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
        is not given. --dub ko names the base language ko-KR (region
        is ignored; zh-Hans and zh-Hant stay different). For the base language (plan.json meta.lang) a
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
--holds with --file: spans (seconds, "12.5-15,40-44") where the picture is meant to move slowly or hold;
        a freeze inside them is listed as an intended hold, not flagged. In a reel review the page declares
        them: window.__reel.holds = [{from, to}]. The freeze test reads 320-px frames (64 px read slow
        movement as frozen).
--copy  review copy, for showing a film to a reviewer: for each language layer (the base language, and every
        dub/<code>/ that has an out/final-<code>.mp4) the existing encode, which carries picture, voice and
        bed, is stream-copied into <out>/review-copy-<code>.mp4 with one subtitle track whose cues read
        "<line id> <text>" (line text from that language's plan). Nothing is rendered or re-encoded. With no
        encode yet (voice stage) the base layer is built from voice/narration.wav under a black 640x360
        picture as long as the narration. A layer with no encode and no narration, or no timings, is skipped
        with the reason; exit 1 only when no copy could be built.
--lang  with --copy: only these language codes.
--json  with --file, print the report as JSON.

A check that looked at nothing (no audio stream, no shots, no samples) prints "checked nothing" and the
reason; it is never counted as a pass.
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
    if (flags.copy) {
      await runCopy(dir, paths, flags);
      return;
    }
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

/**
 * scanIssuesBySeek with the engine facts (label strings a language lacks,
 * corner-note gaps) moved out of the layout hits into report lines.
 */
async function scanLayoutHits(page, args) {
  const { times, issuesByTime } = await scanIssuesBySeek(page, args);
  const split = issuesByTime.map(splitEngineFacts);
  const facts = engineFactLines({ note: await readSafeAreaNote(page), facts: split.flatMap((s) => s.facts) });
  return { times, issuesByTime: split.map((s) => s.layout), facts };
}

/** --scan: seeks the whole film at `stepSec` and groups issues() hits into runs (scripts/lib/layout-scan.mjs). */
export async function scanLayoutDense({ dir, paths, stepSec }) {
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
    const { duration } = session.meta;
    const { times, issuesByTime, facts } = await scanLayoutHits(session.page, { duration, stepSec });
    const runs = groupIssueRuns(times, issuesByTime);
    const totalIssues = issuesByTime.reduce((n, arr) => n + arr.length, 0);
    return {
      reelDir: dir,
      stepSec,
      duration,
      sampleCount: times.length,
      totalIssues,
      runs,
      facts,
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
    const { times, issuesByTime, facts } = await scanLayoutHits(session.page, { duration, stepSec: step });
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
      facts,
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
  lines.push(...(report.facts || []));
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
    const holds = typeof flags.holds === "string" ? parseHolds(flags.holds) : [];
    const report = await reviewFile({ file, cuts, holds });
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

/** SRT time "HH:MM:SS,mmm". */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
}

/** The cue a reviewer reads for one line: "<line id> <text>", break marks removed, one row. */
export function reviewCueText(id, text) {
  return `${id} ${String(text || "").replace(/\|/g, "").replace(/\s+/g, " ").trim()}`.trim();
}

/**
 * SRT body for the review copy: one cue per line from `start` to `end`.
 * @param {{id:string, start:number, end:number, text?:string}[]} lines
 * @param {Map<string,string>} [planText] line id -> that language's plan text (wins over the timings text)
 */
export function buildReviewSrt(lines, planText = new Map()) {
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${reviewCueText(l.id, planText.has(l.id) ? planText.get(l.id) : l.text)}\n`).join("\n");
}

/**
 * The language layers a review copy covers and the existing files each is built from. A layer
 * whose picture or timings are missing is returned with `skip` (the reason), never guessed.
 */
export function reviewLayers(dir, paths, only) {
  const exists = (p) => fs.existsSync(p);
  const first = (...c) => c.find(exists) || null;
  const basePlan = exists(paths.planJson) ? readJson(paths.planJson) : { meta: {}, lines: [] };
  const baseCode = (basePlan.meta && basePlan.meta.lang) || "base";
  const layers = new Map();
  layers.set(baseCode, { code: baseCode, mp4: first(path.join(paths.outDir, "final.mp4"), path.join(paths.outDir, "preview.mp4")),
    timings: first(paths.timingsJson), plan: paths.planJson, voiceWav: first(paths.narrationWav) });
  const dubRoot = path.join(dir, "dub");
  for (const code of exists(dubRoot) ? fs.readdirSync(dubRoot).sort() : []) {
    const mp4 = first(path.join(paths.outDir, `final-${code}.mp4`), path.join(paths.outDir, `preview-${code}.mp4`));
    if (!mp4 && layers.has(code)) continue;
    layers.set(code, { code, mp4, timings: first(path.join(dubRoot, code, "timings.placed.json")), plan: path.join(dubRoot, code, "plan.json") });
  }
  const wanted = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : [...layers.keys()];
  return wanted.map((code) => {
    const l = layers.get(code) || (sameLanguageTag(code, baseCode) === true ? layers.get(baseCode) : undefined);
    if (!l) return { code, skip: `no such language layer (have: ${[...layers.keys()].join(", ")})` };
    if (!l.mp4 && !l.voiceWav) return { code, skip: "no existing encode (out/final[-<code>].mp4 or preview) and no voice/narration.wav: render or voice it first, a review copy never renders" };
    if (!l.timings) return { code, skip: "no timings (voice/timings.json or dub/<code>/timings.placed.json)" };
    return l;
  });
}

/** Unique temp name beside the target: microsecond clock + pid. */
function uniqueTemp(target) {
  const us = process.hrtime.bigint() / 1000n;
  return path.join(path.dirname(target), `.${path.basename(target)}.${us}-${process.pid}.tmp${path.extname(target)}`);
}

/**
 * ffmpeg arguments for the voice-stage review copy: `voice/narration.wav` under a small black picture whose
 * length is fixed to the narration length (`-shortest` would end at the last cue and drop a silent tail),
 * plus the "<line id> <text>" subtitle track.
 */
export function voiceOnlyCopyArgs({ wav, durationSec, srt, out }) {
  const d = durationSec.toFixed(3);
  return ["-y", "-f", "lavfi", "-i", `color=c=black:s=640x360:r=2:d=${d}`, "-i", wav, "-i", srt,
    "-map", "0:v", "-map", "1:a", "-map", "2:0", "-t", d, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-c:s", "mov_text", "-disposition:s:0", "default", "-movflags", "+faststart", out];
}

/**
 * --copy: per language layer, the existing encode (picture + voice + bed) stream-copied with a subtitle
 * track whose cues read "<line id> <text>". Nothing is rendered or re-encoded; only the muxer runs.
 * With no encode, the base layer is built from voice/narration.wav under a black picture (voiceOnlyCopyArgs).
 * @returns {Promise<{code:string, out?:string, cues?:number, skip?:string}[]>}
 */
export async function reviewCopy({ dir, paths, only, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const layer of reviewLayers(dir, paths, only)) {
    if (layer.skip) { results.push({ code: layer.code, skip: layer.skip }); continue; }
    const lines = (readJson(layer.timings).lines || []).filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end));
    if (!lines.length) { results.push({ code: layer.code, skip: "timings has no lines with start/end" }); continue; }
    const planLines = fs.existsSync(layer.plan) ? readJson(layer.plan).lines || [] : [];
    const text = new Map(planLines.filter((l) => typeof l.text === "string").map((l) => [l.id, l.text]));
    const out = path.join(outDir, `review-copy-${layer.code}.mp4`);
    const tmp = uniqueTemp(out);
    const srt = tmp.replace(/\.mp4$/, ".srt");
    try {
      fs.writeFileSync(srt, buildReviewSrt(lines, text), "utf8");
      if (layer.mp4) {
        await ffmpeg(["-y", "-i", layer.mp4, "-i", srt, "-map", "0:v", "-map", "0:a?", "-map", "1:0", "-c:v", "copy", "-c:a", "copy",
          "-c:s", "mov_text", "-disposition:s:0", "default", "-movflags", "+faststart", tmp]);
      } else {
        await ffmpeg(voiceOnlyCopyArgs({ wav: layer.voiceWav, durationSec: await probeDuration(layer.voiceWav), srt, out: tmp }));
      }
      fs.renameSync(tmp, out);
    } finally {
      fs.rmSync(srt, { force: true });
      fs.rmSync(tmp, { force: true });
    }
    results.push({ code: layer.code, out, cues: lines.length, from: layer.mp4 || layer.voiceWav, voiceOnly: !layer.mp4 });
  }
  return results;
}

async function runCopy(dir, paths, flags) {
  const outDir = typeof flags.out === "string" ? abs(flags.out) : paths.outDir;
  const results = await reviewCopy({ dir, paths, only: typeof flags.lang === "string" ? flags.lang : undefined, outDir });
  for (const r of results) {
    const source = r.voiceOnly ? `black picture, voice from ${path.basename(r.from)}` : `picture+audio copied from ${path.basename(r.from)}`;
    process.stdout.write(r.out ? `${r.code}: ${r.out} (${r.cues} cues "<line id> <text>", ${source})\n` : `${r.code}: skipped — ${r.skip}\n`);
  }
  if (!results.some((r) => r.out)) throw new Error("no review copy was built");
}

/** "12.5-15,40-44" -> [{from:12.5,to:15},{from:40,to:44}]: intended slow-motion / hold spans in seconds. */
export function parseHolds(text) {
  return text.split(",").map((s) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(s);
    if (!m || Number(m[2]) <= Number(m[1])) throw new Error(`--holds expects from-to seconds like 12.5-15,40-44, got "${text}"`);
    return { from: Number(m[1]), to: Number(m[2]) };
  });
}

/**
 * --file: facts about one finished video, no page. Every number is
 * reported; nothing here decides whether the video is good.
 * @param {{file:string, cuts:number[], holds?:{from:number,to:number}[]}} args holds = intended slow-motion / hold spans
 */
export async function reviewFile({ file, cuts, holds = [] }) {
  const streams = await probeStreamDurations(file);
  const totalSec = streams.videoSec != null ? streams.videoSec : await probeDuration(file);
  const avDeltaMs =
    streams.videoSec != null && streams.audioSec != null ? (streams.audioSec - streams.videoSec) * 1000 : null;

  const whole = await measureLoudness(file);
  const spans = partSpans(cuts, totalSec);
  const partLoudness = cuts.length ? await measureSpansLoudness(file, spans) : [];
  const parts = partLoudness.map((l, i) => ({ ...spans[i], ...l }));

  const { fps } = await probeVideoInfo(file);
  const { frames } = await extractGrayFrames(file, fps, { width: FREEZE_SCAN_WIDTH });
  const { deadAirRuns, intendedHoldRuns } = analyzeMotion(frames, fps, { holds });

  const hasAudio = streams.audioSec != null;
  const pcm = hasAudio ? await decodeMonoPcm(file, AUDIO_SAMPLE_RATE) : new Float32Array(0);
  const silence = longestSilenceAfterFirstSound(pcm, AUDIO_SAMPLE_RATE, { thresholdDb: -50 });
  const blackRuns = await detectBlackRuns(file, { minSec: 1 / fps });
  const checkedNothing = [];
  if (!hasAudio) checkedNothing.push({ check: "silence", reason: "the file has no audio stream" });
  else if (!Number.isFinite(silence.firstSoundSec)) checkedNothing.push({ check: "silence", reason: "no sound above the threshold, so there is no first sound to measure from" });
  if (frames.length < 2) checkedNothing.push({ check: "deadAir", reason: `${frames.length} decoded frame(s); a freeze needs two` });

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
      intendedHolds: intendedHoldRuns,
      note: `runs of >=0.8 s where under 0.2 % of ${FREEZE_SCAN_WIDTH}-px greyscale pixels change between frames; spans given with --holds are listed as intended holds, not flagged`,
    },
    silence: { ...silence, thresholdDb: -50 },
    black: { runs: blackRuns },
    checkedNothing,
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
  const nothing = (name) => (r.checkedNothing || []).find((c) => c.check === name);
  lines.push(nothing("deadAir")
    ? `picture dead air: checked nothing (${nothing("deadAir").reason}). ${checkedNothingNext()}`
    : `picture dead air: ${r.deadAir.runs.length} run(s)${r.deadAir.runs.map((x) => ` ${f(x.startSec, 2)}s+${f(x.durationSec, 2)}s`).join(",")}`);
  for (const h of r.deadAir.intendedHolds || []) lines.push(`  intended hold (not flagged): ${f(h.startSec, 2)}s+${f(h.durationSec, 2)}s`);
  lines.push(nothing("silence")
    ? `audio: silence checked nothing (${nothing("silence").reason}). ${checkedNothingNext("an audio stream")}`
    : `audio: longest silence after first sound ${f(r.silence.longestSilenceSec)}s (first sound at ${f(r.silence.firstSoundSec)}s)`);
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
  const engineFacts = [];
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
      const split = splitEngineFacts(await session.page.evaluate(() => window.__reel.issues()));
      engineFacts.push(...split.facts);
      issuesByShot.push({ shotId: shot.id, readAt: shot.readAt, issues: split.layout });
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
    const factLines = engineFactLines({ note: await readSafeAreaNote(session.page), facts: engineFacts });
    // Spans the page declared as intended slow motion / hold (window.__reel.holds) are marked, not flagged,
    // the same way the end hold is.
    const declaredHolds = await session.page.evaluate(() => (window.__reel && window.__reel.holds) || []);
    const { runs: deadAirRuns, intendedHolds } = splitIntendedHolds(
      excludeEndHold(deadAirScan.runs, lastLineEnd, DEAD_AIR_RUN_SEC_MIN), declaredHolds, DEAD_AIR_RUN_SEC_MIN);
    const checkedNothing = [];
    if (shots.length === 0) checkedNothing.push({ check: "layout", reason: "the page declares no shots, so no frame was read for issues()" });
    if (deadAirScan.times.length < 2) checkedNothing.push({ check: "deadAir", reason: "fewer than 2 samples" });
    const hasAudio = (await probeStreamDurations(mp4Path)).audioSec != null;
    if (!hasAudio) checkedNothing.push({ check: "silence", reason: "the video has no audio stream" });
    else if (!(timings.lines && timings.lines.length)) checkedNothing.push({ check: "silence", reason: "timings.json has no lines, so there is no narration span to measure" });
    const nothingOf = (name) => checkedNothing.some((c) => c.check === name);

    const loudness = hasAudio ? await measureLoudness(mp4Path) : { integratedLufs: null, truePeakDb: null };
    const pcm = hasAudio ? await decodeMonoPcm(mp4Path, AUDIO_SAMPLE_RATE) : new Float32Array(0);
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
    const markResults = marks.map((m) => {
      const { offsetMs, source } = markOnsetOffset(m, { stems, mixPcm: pcm, sampleRate: AUDIO_SAMPLE_RATE, windowSec: 0.15 });
      const sync = !!m.sync;
      const duckedByNarration = narrationWindows.some((w) => m.at >= w.start && m.at <= w.end);
      const pass =
        !sync ||
        (offsetMs != null && offsetMs >= SYNC_OFFSET_MIN_MS && offsetMs <= SYNC_OFFSET_MAX_MS);
      return { at: m.at, kind: m.kind, sync, offsetMs, source, duckedByNarration, pass };
    });
    const silencePass = nothingOf("silence") ? null : silenceGaps.unplanned.length === 0;
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
          pass: nothingOf("deadAir") ? null : deadAirRuns.length === 0,
          checkedNothing: nothingOf("deadAir"),
          runs: deadAirRuns,
          intendedHolds,
          endHoldSec: Math.max(0, videoDuration - lastLineEnd),
          note: "measured from seek() output at native resolution: canvas pixel hash every 0.1s, a run of identical hashes >=0.8s is flagged; the end hold after the last line (meta.tailSec) is not counted",
        },
        layout: {
          pass: nothingOf("layout") ? null : allIssues.length === 0,
          checkedNothing: nothingOf("layout"),
          issueCount: allIssues.length,
          byShot: issuesByShot,
        },
        audio: {
          // silence that checked nothing is neither a pass nor a fail; with no marks either, the audio check has no result.
          pass: silencePass === null && markResults.length === 0 ? null : silencePass !== false && marksPass,
          silenceCheckedNothing: nothingOf("silence"),
          integratedLufs: loudness.integratedLufs,
          truePeakDb: loudness.truePeakDb,
          longestSilenceSec: silence.longestSilenceSec,
          silenceGateSec: SILENCE_GATE_SEC,
          silencePass,
          silenceGaps: { unplanned: silenceGaps.unplanned, planned: silenceGaps.planned },
          silenceNote: nothingOf("silence") ? null : silenceNote(silence, silenceGaps, SILENCE_GATE_SEC),
          underTarget: loudnessUnderTarget(loudness.integratedLufs),
          marks: markResults,
          voiceClipFacts: await voiceClipFacts(timings, paths.voiceDir),
          onsetSourceNote:
            "each mark's offsetMs is measured on its own effects-only stem (window.__reel.sfxStems(), source:'stems') when one exists, so a mark on a spoken word measures the effect's onset, not the voice's; a mark with no matching stem falls back to the full mix (source:'mix'), same as before this page provided sfxStems.",
          duckingNote:
            "render.mjs ducks library asset cue sounds (plan.json line `cues`) by meta.sound.sfxDuckDb (default -2.5dB, 0.8 s ramps, gaps under 1.5 s stay ducked) while a narration line speaks; each mark above carries duckedByNarration for whether it fell inside a narration window. The sync tolerance (-20..+40ms) is unchanged, but a mark on a ducked sound near that edge is expected, not a regression.",
        },
      },
      checkedNothing,
      facts: factLines,
      note: "Technical checks do not certify art — this reports what was mechanically checked (motion, sync, layout); a human must read the contact sheet and judge composition, legibility, and taste.",
    };
    return report;
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/** Current clip measurements only. Stored synthesis-time facts may describe a replaced take. */
export async function voiceClipFacts(timings, voiceDir, { decode = decodeMonoPcm } = {}) {
  const lines = [];
  const unavailable = [];
  const all = timings?.lines || [];
  for (const line of all) {
    const result = await measureVoiceClip(line, voiceDir, decode);
    if (result.reason) unavailable.push({ id: line.id, reason: result.reason });
    else if (result.facts.length) lines.push(result);
  }
  return { lines, measured: all.length - unavailable.length, unmeasured: unavailable.length,
    unavailable, source: "current-clips", sampleRate: AUDIO_SAMPLE_RATE };
}

async function measureVoiceClip(line, voiceDir, decode) {
  try {
    const name = `line-${line.id}.wav`;
    if (!voiceDir || path.basename(name) !== name) throw new Error("no valid current clip path");
    const file = path.join(voiceDir, name);
    const pcm = await decode(file, AUDIO_SAMPLE_RATE);
    if (!pcm.length) throw new Error("current clip has no samples");
    const defects = findClipDefects(pcm, AUDIO_SAMPLE_RATE);
    return { id: line.id, file, facts: describeDefects(defects), flag: waveformFlag(defects) };
  } catch (error) {
    return { id: line.id, reason: error.message };
  }
}

/** Missing measurements remain explicit and never fall back to saved clipFacts. */
export function voiceClipFactLines({ lines, measured, unmeasured, unavailable = [] }) {
  const out = lines.map((l) => (l.flag
    ? `WARN voice clip ${l.flag}, line "${l.id}": ${l.facts.join("; ")} (current clip, perceived-level evidence; re-make the line: voice.mjs <reel> --lines ${l.id})`
    : `voice clip facts, line "${l.id}": ${l.facts.join("; ")} (current clip measurement)`));
  if (measured === 0) out.push("voice clip facts: CHECKED NOTHING; no current clips measured.");
  for (const clip of unavailable) out.push(`voice clip facts: CHECKED NOTHING, line "${clip.id}": ${clip.reason}`);
  if (unmeasured && !unavailable.length) out.push(`voice clip facts: CHECKED NOTHING; ${unmeasured} current clip(s) unavailable.`);
  return out;
}

/** pass is true / false, or null when the check looked at nothing: null is never a pass and never a fail. */
export const verdict = (check) => (check.checkedNothing || check.pass === null ? "CHECKED NOTHING" : check.pass ? "PASS" : "FAIL");

function printSummary(report) {
  const c = report.checks;
  const lines = [
    `reel: ${report.reelDir}`,
    `video: ${report.mp4}${report.renderedNow ? " (rendered now, preview)" : ""}`,
    `contact sheet: ${report.contactSheet}`,
    `A/V duration: video=${report.duration.video.toFixed(3)}s audio=${report.duration.audio.toFixed(3)}s delta=${report.duration.deltaMs.toFixed(1)}ms [${c.avSync.pass ? "PASS" : "FAIL"}]`,
    `dead air: ${c.deadAir.runs.length} run(s) >=0.8s [${verdict(c.deadAir)}]${c.deadAir.intendedHolds.map((h) => ` intended hold ${h.startSec.toFixed(2)}s+${h.durationSec.toFixed(2)}s (not flagged)`).join(";")}`,
    `layout issues: ${c.layout.issueCount} [${verdict(c.layout)}]`,
    `audio: I=${c.audio.integratedLufs == null ? "n/a" : c.audio.integratedLufs.toFixed(1) + " LUFS"} truePeak=${c.audio.truePeakDb == null ? "n/a" : c.audio.truePeakDb.toFixed(1) + " dBFS"} longest silence in narration=${c.audio.longestSilenceSec.toFixed(3)}s (gate ${c.audio.silenceGateSec}s, ${c.audio.silenceGaps.planned.length} planned) [${verdict({ pass: c.audio.silencePass })}]${c.audio.silenceGaps.unplanned.map((g) => ` gap ${g.startSec.toFixed(2)}-${g.endSec.toFixed(2)}s after line ${g.afterId}`).join(";")}`,
    ...(c.audio.silenceNote ? [`  note: ${c.audio.silenceNote}`] : []),
    ...(c.audio.underTarget ? [`  note: ${c.audio.underTarget.text}`] : []),
    `sync marks: ${c.audio.marks.length} (${c.audio.marks.filter((m) => m.sync).length} sync, ${c.audio.marks.filter((m) => m.source === "mix").length} measured on the mix fallback) offsets=${c.audio.marks.map((m) => (m.offsetMs == null ? "n/a" : m.offsetMs + "ms")).join(", ")} [${c.audio.marks.every((m) => m.pass) ? "PASS" : "FAIL"}]`,
    ...report.checkedNothing.map((n) => `checked nothing: ${n.check}: ${n.reason}. ${checkedNothingNext()}`),
    ...(report.facts || []),
    ...voiceClipFactLines(c.audio.voiceClipFacts),
    report.note,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
