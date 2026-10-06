#!/usr/bin/env node
// SRT subtitles: from a reel's placed timings (build), from an existing video's audio plus its known
// script (align), and a cue count / time check across languages (compare).
// Facts only: findings are printed for the reviewer; only an unreadable input or a step that cannot
// run (no STT) stops with a non-zero exit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import {
  buildCues, checkCues, formatChecks, formatSrt, parseSrt, compareTracks, formatComparison,
  parseScript, alignScript, defaultLineChars, DEFAULT_MAX_LINES, sttExtractArgs,
} from "./lib/srt.mjs";
import { ffmpeg } from "./lib/ffmpeg.mjs";

const HELP = `usage:
  srt.mjs build <reel-dir> [--base | --dub <code>] [--line-chars <n>] [--max-lines <n>] [--out-dir <dir>]
  srt.mjs align <media> --script <file> --lang <code> [--out <file.srt>] [--timings-out <json>] [--line-chars <n>] [--max-lines <n>]
  srt.mjs compare <a.srt> <b.srt> [...] [--tolerance <ms>]

build    One SRT per language from <reel-dir>/voice/timings.json (base) and every
         dub/<code>/timings.placed.json, written to <out-dir> (default <reel-dir>/out/srt/<code>.srt).
         Cues break where the on-screen caption breaks: a writer's "|" and a newline win, a number
         stays with its unit, no row ends on an article, nothing breaks inside a parenthesis or quote.
         At most --max-lines rows per cue (default ${DEFAULT_MAX_LINES}); --line-chars rows (default by language:
         ja/zh ${defaultLineChars("ja")}, ko ${defaultLineChars("ko")}, others ${defaultLineChars("en")}). With two or more languages it then reports cue
         count and time equality per line. Writes <out-dir>/srt-report.json.
align    SRT for a video that already exists: speech-to-text on its audio times the words, the text
         is your script. --script is plan.json / timings.json (lines[].text) or plain text, one script
         line per row ("|" marks a break). Uses the same STT engine as voice.mjs (SVA_STT_ENGINE, SVA_STT_MODEL).
         A media file that is not a .wav (an .mp4, say) is first turned into mono 16 kHz PCM wav with
         ffmpeg in a temp dir; if ffmpeg fails the step exits non-zero with its message.
         A script line with under half its words found in the audio gets no cue and is listed
         ("low match"): check it against the audio (a different wording, a cut, or music).
compare  Cue count and time equality across SRT files (the first file is the reference).

Reports findings and exits 0; exits non-zero only when an input cannot be read or STT cannot run.
`;

async function loadReel() {
  await import("./engine/reel-engine.js");
  return globalThis.Reel;
}

function numFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} takes a number > 0 (got "${flags[name]}")`);
  return n;
}

function readPlanLang(paths) {
  try {
    return readJson(paths.planJson).meta?.lang;
  } catch {
    return undefined;
  }
}

/** Language tracks of a reel: the base voice and every dub with placed timings. */
function reelTracks(paths, flags) {
  const tracks = [];
  const only = typeof flags.dub === "string" ? flags.dub : null;
  if (!only && fs.existsSync(paths.timingsJson)) {
    const t = readJson(paths.timingsJson);
    tracks.push({ code: t.lang || readPlanLang(paths) || "base", lang: t.lang || readPlanLang(paths), lines: t.lines || [] });
  }
  const dubRoot = path.join(paths.root, "dub");
  const codes = only ? [only] : flags.base || !fs.existsSync(dubRoot) ? [] : fs.readdirSync(dubRoot).sort();
  for (const code of codes) {
    const file = path.join(dubRoot, code, "timings.placed.json");
    if (!fs.existsSync(file)) {
      if (only) fail(`no ${file}`);
      continue;
    }
    const t = readJson(file);
    tracks.push({ code, lang: t.lang || code, lines: t.lines || [] });
  }
  if (!tracks.length) fail(`no timings in ${paths.root} (voice/timings.json, dub/<code>/timings.placed.json)`);
  return tracks;
}

async function runBuild(positional, flags) {
  if (!positional[0]) return printHelpAndExit(HELP, 1);
  const paths = reelPaths(abs(positional[0]));
  const outDir = typeof flags["out-dir"] === "string" ? abs(flags["out-dir"]) : path.join(paths.outDir, "srt");
  const Reel = await loadReel();
  const opts = { lineChars: numFlag(flags, "line-chars"), maxLines: numFlag(flags, "max-lines") };
  fs.mkdirSync(outDir, { recursive: true });
  const report = { tracks: {}, findings: {} };
  const cueTracks = {};
  for (const t of reelTracks(paths, flags)) {
    const built = buildCues(Reel, t.lines, { ...opts, lang: t.lang });
    const file = path.join(outDir, `${t.code}.srt`);
    fs.writeFileSync(file, formatSrt(built.cues), "utf8");
    const findings = checkCues(built);
    process.stdout.write(`${t.code}: ${built.cues.length} cues -> ${file}\n${formatChecks(findings, { label: `${t.code} checks` })}`);
    cueTracks[t.code] = built.cues;
    report.tracks[t.code] = { file, cues: built.cues.length, lineChars: built.opts.lineChars, maxLines: built.opts.maxLines };
    report.findings[t.code] = findings;
  }
  finishCompare(cueTracks, report, outDir);
}

function finishCompare(cueTracks, report, outDir) {
  if (Object.keys(cueTracks).length > 1) {
    const cmp = compareTracks(cueTracks);
    process.stdout.write(formatComparison(cmp));
    report.comparison = cmp;
  }
  writeJson(path.join(outDir, "srt-report.json"), report);
  process.stdout.write(`wrote ${path.join(outDir, "srt-report.json")}\n`);
}

function runCompare(positional, flags) {
  if (positional.length < 2) return fail("compare takes two or more .srt files");
  const ms = numFlag(flags, "tolerance");
  const tracks = {};
  for (const f of positional) {
    let cues;
    try {
      cues = parseSrt(fs.readFileSync(abs(f), "utf8"));
    } catch (e) {
      return fail(`${f}: ${e.message}`);
    }
    tracks[path.basename(f)] = cues;
  }
  const tolSec = ms ? ms / 1000 : undefined;
  process.stdout.write(formatComparison(compareTracks(tracks, { tolSec }), { tolSec }));
}

async function heardWords(media, code) {
  const { sttTranscribe } = await import("./voice.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sva-srt-${process.pid}-${Date.now()}${process.hrtime.bigint() % 1000000n}-`));
  try {
    const wav = path.join(work, "audio-16k.wav");
    const extract = sttExtractArgs(media, wav);
    if (extract) {
      try {
        await ffmpeg(extract);
      } catch (e) {
        fail(`could not extract audio from ${media}: ${e.message}`);
      }
    }
    const stt = await sttTranscribe(work, [{ id: "all", wav: extract ? wav : media }], code);
    if (stt.skipped) fail(`speech-to-text could not run: ${stt.skipped}`);
    return stt.words.get("all") || [];
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function runAlign(positional, flags) {
  const media = positional[0] && abs(positional[0]);
  if (!media || typeof flags.script !== "string" || typeof flags.lang !== "string") return printHelpAndExit(HELP, 1);
  if (!fs.existsSync(media)) return fail(`missing media: ${media}`);
  let script;
  try {
    script = parseScript(fs.readFileSync(abs(flags.script), "utf8"));
  } catch (e) {
    return fail(`${flags.script}: ${e.message}`);
  }
  if (!script.length) return fail(`${flags.script}: no script lines`);
  const { sttLangCode } = await import("./voice/line-edit.mjs");
  const { alignCaptionWords, matchLetters } = await import("./voice/word-align.mjs");
  const heard = await heardWords(media, sttLangCode(flags.lang));
  if (!heard.length) return fail("speech-to-text heard no words in the audio");
  const aligned = alignScript(script, heard, { align: alignCaptionWords, letters: matchLetters, lang: sttLangCode(flags.lang) });
  const Reel = await loadReel();
  const built = buildCues(Reel, aligned.lines, { lang: flags.lang, lineChars: numFlag(flags, "line-chars"), maxLines: numFlag(flags, "max-lines") });
  const out = typeof flags.out === "string" ? abs(flags.out) : media.replace(/\.[^./\\]+$/, "") + `.${flags.lang}.srt`;
  fs.writeFileSync(out, formatSrt(built.cues), "utf8");
  if (typeof flags["timings-out"] === "string") {
    writeJson(abs(flags["timings-out"]), { duration: aligned.lines.at(-1)?.end ?? 0, lang: flags.lang, provider: "stt-align", lines: aligned.lines });
  }
  process.stdout.write(`${built.cues.length} cues from ${aligned.lines.length}/${script.length} script lines -> ${out}\n`);
  for (const l of aligned.lowMatch) process.stdout.write(`  low match ${l.id}: ${l.measured}/${l.total} words found in the audio\n`);
  process.stdout.write(formatChecks(checkCues(built)));
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || !positional.length) return printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
  const [mode, ...rest] = positional;
  if (mode === "build") return runBuild(rest, flags);
  if (mode === "align") return runAlign(rest, flags);
  if (mode === "compare") return runCompare(rest, flags);
  return fail(`unknown mode "${mode}" (build, align, compare)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
