#!/usr/bin/env node
// Synthesize each plan.json line, measure it (ffprobe, never guessed),
// concatenate with gap silences + head/tail into voice/narration.wav, and
// write voice/timings.json — the single timeline authority (design.md §2).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, loadPlan, writeJson, readJson, ensureDir } from "./lib/reeldir.mjs";
import { ffmpeg, probeDuration, applyAtempo } from "./lib/ffmpeg.mjs";
import { computeLineTimes, wordsProportional, HEAD_SILENCE_SEC, TAIL_SILENCE_SEC } from "./lib/timing.mjs";
import { chooseProvider } from "./lib/choose-provider.mjs";
import { resolvePythonPath, runPythonBatch } from "./lib/pyenv.mjs";
import { compareLine, isGrossMismatch, tailCleared } from "./lib/stt-compare.mjs";
import { spokenText } from "./lib/pronounce.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STT_SCRIPT = path.join(here, "voice", "py", "stt_check.py");
// Providers whose output is deterministic (same input -> same audio every
// time), so re-synthesizing a flagged line for --retry-flagged is pointless.
const DETERMINISTIC_PROVIDERS = new Set(["say", "file", "none"]);

const HELP = `usage: voice.mjs <reel-dir> [--provider say|fish|elevenlabs|file|none|qwen3|melotts|fishspeech] [--lines id,id]

Synthesizes voice/line-<id>.wav for each plan.json line, measures each
with ffprobe, concatenates them with meta.gapMs of silence between lines
(plus a fixed 0.4s head silence and a meta.tailSec tail silence, default
0.4s — set meta.tailSec higher to keep a wordless end card) into
voice/narration.wav (48kHz mono), and writes voice/timings.json.

--provider overrides plan.json meta.voice.provider. If neither is given,
voice.mjs auto-chooses (design.md §2.3): file (if voice/in/ has audio) ->
qwen3 (if its python venv is found and meta.voice.refAudio is set) -> fish
-> elevenlabs -> melotts (if its python venv is found); with none of these it
stops and lists what to set up. say (macOS) runs only when asked for. It prints
which provider it picked and why.

--lines id,id  regenerate only these lines' audio; reuse the existing
               voice/line-<id>.wav for every other line (they must already
               exist). narration.wav and timings.json are always rebuilt in
               full. A regenerated line keeps its old time slot (a shorter
               take is padded, a longer one sped up by up to 10%), so the
               picture does not change and render.mjs reuses every shot.
               A take longer than that keeps its length; the lines after
               it move, and their shots re-render.
--retime       with --lines: let regenerated lines keep their own length
               (use after a wording change, not a pronunciation fix).

After synthesis, every synthesized line is checked by transcribing its own
audio back (faster-whisper) and comparing it against the intended text —
see references/voice.md "Did the voice say the line?". Flags a line
voiceFlag: MISHEARD only on a gross mismatch (most of it wrong, or words dropped or added), and clears a
provider's TAIL flag when the STT transcript shows the last syllable was
not actually cut off.

--no-stt            skip the speech-to-text check entirely.
--retry-flagged N   re-synthesize lines flagged MISHEARD/SHORT/TAIL up to N
                     more times, keeping the candidate with the lowest
                     character error rate (default 1; skipped for
                     deterministic providers: say, file, none).
--stt-only           run the STT check on the existing voice/line-*.wav
                     files without synthesizing anything; updates
                     timings.json in place and does not touch narration.wav.
`;

const PROVIDERS = ["say", "fish", "elevenlabs", "file", "none", "qwen3", "melotts", "fishspeech"];

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);

  if (flags["stt-only"]) {
    try {
      await runSttOnly(dir, paths);
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  let plan;
  try {
    plan = loadPlan(dir);
  } catch (e) {
    fail(e.message);
    return;
  }

  let providerName = flags.provider || (plan.meta.voice && plan.meta.voice.provider);
  if (!providerName) {
    const choice = chooseProvider({
      hasVoiceInDir: fs.existsSync(path.join(paths.voiceDir, "in")),
      qwen3PythonFound: !!resolvePythonPath("SVA_QWEN3_PYTHON", null),
      refAudioSet: !!(plan.meta.voice && plan.meta.voice.refAudio),
      fishKeySet: !!(process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY),
      elevenKeySet: !!process.env.ELEVENLABS_API_KEY,
      melottsPythonFound: !!resolvePythonPath("SVA_MELO_PYTHON", null),
    });
    if (!choice.provider) {
      fail(choice.reason);
      return;
    }
    providerName = choice.provider;
    process.stdout.write(`provider: auto-chose "${providerName}" (${choice.reason})\n`);
  }
  if (!PROVIDERS.includes(providerName)) {
    fail(`unknown provider "${providerName}", expected one of: ${PROVIDERS.join(", ")}`);
    return;
  }

  let providerMod;
  try {
    providerMod = await import(`./voice/${providerName}.mjs`);
  } catch (e) {
    fail(`failed to load voice provider "${providerName}": ${e.message}`);
    return;
  }

  const gapMs = plan.meta.gapMs == null ? 250 : plan.meta.gapMs;
  const tailSec = plan.meta.tailSec == null ? TAIL_SILENCE_SEC : plan.meta.tailSec;
  const voiceCfg = withShortsRate(plan.meta);
  if (voiceCfg.rate != null && (plan.meta.voice || {}).rate == null) {
    process.stderr.write(`note: vertical film without meta.voice.rate; speaking at the Shorts default ${voiceCfg.rate}\n`);
  }

  let onlyLineIds = null;
  if (typeof flags.lines === "string") {
    onlyLineIds = flags.lines.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(plan.lines.map((l) => l.id));
    const unknown = onlyLineIds.filter((id) => !known.has(id));
    if (unknown.length) {
      fail(`--lines references unknown line id(s): ${unknown.join(", ")}`);
      return;
    }
  }

  const sttEnabled = !flags["no-stt"];
  const retryFlagged = flags["retry-flagged"] != null ? Number(flags["retry-flagged"]) : 1;

  if (CLONE_PROVIDERS.has(providerName) && voiceCfg.refAudio) {
    const refError = await checkRefAudioLength(voiceCfg.refAudio, dir);
    if (refError) {
      fail(refError);
      return;
    }
  }

  try {
    const result = await synthesizeAll({
      dir,
      paths,
      lines: plan.lines,
      provider: providerMod,
      providerName,
      voiceCfg,
      pronounce: plan.meta.pronounce,
      lang: plan.meta.lang || "ko-KR",
      gapMs,
      tailSec,
      onlyLineIds,
      sttEnabled,
      retryFlagged,
      keepTiming: !flags.retime,
    });
    writeJson(paths.timingsJson, result.timings);
    process.stdout.write(
      `wrote ${paths.narrationWav}\n` +
        `wrote ${paths.timingsJson}\n` +
        `provider: ${providerName}  lines: ${plan.lines.length}  duration: ${result.timings.duration.toFixed(3)}s\n`
    );
    if (onlyLineIds && result.moved.length) {
      process.stdout.write(`lines with shifted start (their shots will re-render): ${result.moved.join(", ")}\n`);
    }
  } catch (e) {
    fail(e.message);
  }
}

/**
 * Core orchestration, separated from CLI wiring so it can be exercised in
 * tests with a mocked provider (no network, no ffmpeg required for the
 * timing math itself — only the final concat step touches ffmpeg).
 */
export async function synthesizeAll({
  dir,
  paths,
  lines,
  provider,
  providerName,
  voiceCfg,
  pronounce,
  lang,
  gapMs,
  tailSec = TAIL_SILENCE_SEC,
  onlyLineIds,
  sttEnabled = true,
  retryFlagged = 1,
  keepTiming = true,
}) {
  ensureDir(paths.voiceDir);
  // --lines: each regenerated line's old slot length, when it keeps its slot.
  const slots = new Map();
  // Silence after each line: its own pauseAfterMs, else meta.gapMs.
  let offset = HEAD_SILENCE_SEC;
  const lineResults = [];
  const segmentFiles = []; // {kind, path, durationSec}
  const warnings = [];

  const onlySet = onlyLineIds ? new Set(onlyLineIds) : null;
  // `--lines`: reuse existing per-line wavs and their previous timings.json
  // fields (estimated/voiceFlag) for lines outside the set; only lines in
  // the set are re-synthesized.
  let previousById = new Map();
  if (onlySet && fs.existsSync(paths.timingsJson)) {
    try {
      const prev = JSON.parse(fs.readFileSync(paths.timingsJson, "utf8"));
      previousById = new Map((prev.lines || []).map((l) => [l.id, l]));
    } catch {
      previousById = new Map();
    }
  }

  const headPath = path.join(paths.voiceDir, "_silence-head.wav");
  await makeSilence(headPath, HEAD_SILENCE_SEC);
  segmentFiles.push({ kind: "silence", path: headPath, durationSec: HEAD_SILENCE_SEC });

  // Batch-capable providers (qwen3, melotts) load their model once for all
  // lines instead of once per line; voice.mjs prefers synthBatch when a
  // provider implements it (design.md §2.3 voice providers). With --lines,
  // only the lines being regenerated are sent to the batch.
  let batchResults = null;
  if (typeof provider.synthBatch === "function") {
    const batchLines = lines
      .filter((line) => !onlySet || onlySet.has(line.id))
      .map((line) => ({
        id: line.id,
        text: spokenText(line, pronounce, voiceCfg),
        outPath: path.join(paths.voiceDir, `line-${line.id}.wav`),
      }));
    const results = batchLines.length
      ? await provider.synthBatch(batchLines, { lang, voiceCfg, reelDir: dir })
      : [];
    batchResults = new Map(results.map((r) => [r.id, r]));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const spoken = spokenText(line, pronounce, voiceCfg);
    const outPath = path.join(paths.voiceDir, `line-${line.id}.wav`);
    const reused = onlySet && !onlySet.has(line.id);

    let synthResult;
    if (reused) {
      if (!fs.existsSync(outPath)) {
        throw new Error(
          `--lines: no existing audio for line "${line.id}" at ${outPath} — run a full voice.mjs pass first`
        );
      }
      synthResult = { wavPath: outPath };
    } else if (batchResults) {
      synthResult = batchResults.get(line.id);
      if (!synthResult) {
        throw new Error(`voice provider "${providerName}" synthBatch returned no result for line "${line.id}"`);
      }
    } else {
      const synthArgs = {
        id: line.id,
        text: spoken,
        voice: voiceCfg.voiceId,
        lang,
        voiceCfg,
        params: { rate: voiceCfg.rate },
        outPath,
        reelDir: dir,
        lineStart: offset,
      };
      synthResult = await provider.synth(synthArgs);
    }

    const wavPath = synthResult.wavPath;
    if (!reused) await applyLineTempo(wavPath, line, voiceCfg, provider);

    const prevLine = previousById.get(line.id);
    if (keepTiming && onlySet && !reused && prevLine) {
      slots.set(line.id, prevLine.end - prevLine.start);
      await fitToSlot(wavPath, slots.get(line.id));
    }

    const durationSec = await probeDuration(wavPath);
    const start = offset;
    const end = start + durationSec;

    const words = synthResult.words && synthResult.words.length
      ? synthResult.words
      : wordsProportional(line.text, start, end);

    const lineOut = { id: line.id, text: line.text, start, end, words };
    if (line.say != null) lineOut.say = line.say;
    if (reused && prevLine && prevLine.estimated) lineOut.estimated = true;
    if (reused && prevLine && prevLine.voiceFlag) lineOut.voiceFlag = prevLine.voiceFlag;
    if (reused && prevLine && prevLine.stt) lineOut.stt = prevLine.stt;
    if (!reused && synthResult.estimated) lineOut.estimated = true;
    if (!reused && synthResult.flag && synthResult.flag !== "OK") {
      lineOut.voiceFlag = synthResult.flag;
      warnings.push(`line "${line.id}": voice provider flagged ${synthResult.flag}`);
    }
    lineResults.push(lineOut);

    segmentFiles.push({ kind: "line", path: wavPath, durationSec });

    offset = end;
    if (i < lines.length - 1) {
      const gapSec = (line.pauseAfterMs ?? gapMs) / 1000;
      const gapPath = path.join(paths.voiceDir, `_silence-gap-${i}.wav`);
      await makeSilence(gapPath, gapSec);
      segmentFiles.push({ kind: "silence", path: gapPath, durationSec: gapSec });
      offset += gapSec;
    }
  }

  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }

  // STT round-trip check (references/voice.md "Did the voice say the
  // line?"): only on lines synthesized THIS run — a `--lines` pass leaves
  // reused lines' previous `stt` untouched (copied above).
  const checkedIds = lines.filter((l) => !onlySet || onlySet.has(l.id)).map((l) => l.id);
  if (sttEnabled && checkedIds.length) {
    const langCode = sttLangCode(lang);
    const entries = checkedIds.map((id) => ({ id, wav: `line-${id}.wav` }));
    const stt = await sttTranscribe(paths.voiceDir, entries, langCode);
    if (stt.skipped) {
      process.stdout.write(`STT check skipped: ${stt.skipped}\n`);
    } else {
      const linesById = new Map(lines.map((l) => [l.id, l]));
      for (const lineOut of lineResults) {
        if (!checkedIds.includes(lineOut.id)) continue;
        applySttResult(lineOut, linesById.get(lineOut.id), stt.results.get(lineOut.id) || "");
      }

      if (retryFlagged > 0 && !DETERMINISTIC_PROVIDERS.has(providerName)) {
        for (let round = 0; round < retryFlagged; round++) {
          const flagged = lineResults.filter(
            (l) => checkedIds.includes(l.id) && needsRetry(l.voiceFlag)
          );
          if (!flagged.length) break;
          await retryFlaggedLines({
            flagged,
            lineResults,
            linesById,
            provider,
            pronounce,
            voiceCfg,
            lang,
            langCode,
            dir,
            paths,
            slots,
          });
        }
      }

      printSttTable(lineResults.filter((l) => checkedIds.includes(l.id)));

      // Retries can change a line's measured duration; re-derive the
      // running offset from the (possibly shifted) last line before laying
      // down the tail silence.
      offset = lineResults.length ? lineResults[lineResults.length - 1].end : offset;
    }
  }

  const tailPath = path.join(paths.voiceDir, "_silence-tail.wav");
  await makeSilence(tailPath, tailSec);
  segmentFiles.push({ kind: "silence", path: tailPath, durationSec: tailSec });
  const totalDuration = offset + tailSec;

  await concatWavs(segmentFiles.map((s) => s.path), paths.narrationWav);

  // Clean up intermediate silence files; keep per-line wavs for inspection.
  for (const s of segmentFiles) {
    if (s.kind === "silence") fs.rmSync(s.path, { force: true });
  }

  const timings = {
    duration: totalDuration,
    lines: lineResults,
    provider: providerName,
  };

  // --lines: report which OTHER lines' start times shifted (a regenerated
  // line's new duration pushes every following line) — those lines' shots
  // will re-render on the next render.mjs run.
  const moved = onlySet
    ? lineResults
        .filter((l) => !onlySet.has(l.id) && previousById.has(l.id) && previousById.get(l.id).start !== l.start)
        .map((l) => l.id)
    : [];

  return { timings, moved };
}

// Cloning providers copy the reference clip; a clip outside this range is
// refused before synthesis so a weak clone is never produced silently.
const CLONE_PROVIDERS = new Set(["qwen3", "fishspeech"]);
const REF_AUDIO_MIN_SEC = 5;
const REF_AUDIO_MAX_SEC = 15;

/** @returns {Promise<string|null>} an error message, or null when the clip length is allowed */
async function checkRefAudioLength(refAudio, reelDir) {
  const refPath = path.isAbsolute(refAudio) ? refAudio : path.join(reelDir, refAudio);
  if (!fs.existsSync(refPath)) return null; // the provider reports a missing file
  const sec = await probeDuration(refPath);
  if (sec >= REF_AUDIO_MIN_SEC && sec <= REF_AUDIO_MAX_SEC) return null;
  return (
    `meta.voice.refAudio is ${sec.toFixed(1)}s (${refPath}); a clone reference must be ` +
    `${REF_AUDIO_MIN_SEC}-${REF_AUDIO_MAX_SEC}s of clean speech. Supply a clip in that range.`
  );
}

/** meta.lang ("ko-KR", "en-US", ...) -> a faster-whisper language code. */
function sttLangCode(lang) {
  const s = String(lang || "ko").toLowerCase();
  return s.slice(0, 2) || "ko";
}

function needsRetry(voiceFlag) {
  return voiceFlag === "MISHEARD" || voiceFlag === "SHORT" || voiceFlag === "TAIL";
}

/**
 * Transcribe `entries` ({id, wav} — wav relative to voiceDir or absolute)
 * with faster-whisper (scripts/voice/py/stt_check.py), model loaded once
 * for the whole batch. Never throws: missing python / faster-whisper comes
 * back as `{skipped: reason}` so the voice step never fails because of this
 * check.
 * @returns {Promise<{results: Map<string,string>} | {skipped: string}>}
 */
async function sttTranscribe(voiceDir, entries, langCode) {
  const pythonPath = resolvePythonPath("SVA_STT_PYTHON", null);
  if (!pythonPath) {
    return { skipped: "no python found (set SVA_STT_PYTHON to a venv with faster-whisper installed)" };
  }
  if (!entries.length) return { results: new Map() };

  const jobDir = fs.mkdtempSync(path.join(voiceDir, ".stt-"));
  const jobPath = path.join(jobDir, "lines.json");
  fs.writeFileSync(jobPath, JSON.stringify(entries), "utf8");
  try {
    const { stdout } = await runPythonBatch(pythonPath, [STT_SCRIPT, voiceDir, jobPath], {
      HF_HUB_OFFLINE: "1",
      SVA_STT_LANG: langCode,
    });
    const arr = JSON.parse(stdout.trim() || "[]");
    return { results: new Map(arr.map((r) => [r.id, r.heard])) };
  } catch (e) {
    return { skipped: `stt check failed to run (${e.message.split("\n")[0]})` };
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

/**
 * Compare `heard` against `line.text`/`line.say`, write `lineOut.stt`, and
 * update `lineOut.voiceFlag`: clears a provider TAIL flag when the STT
 * transcript shows the tail wasn't actually cut off, and sets MISHEARD only
 * on a gross mismatch (references/voice.md).
 */
function applySttResult(lineOut, line, heard) {
  const cmp = compareLine({ text: line.text, say: line.say, heard });
  const targetText = cmp.against === "say" ? line.say : line.text;
  lineOut.stt = { heard, cer: cmp.cer, diffs: cmp.diffs };

  if (lineOut.voiceFlag === "TAIL" && tailCleared(targetText, heard)) {
    delete lineOut.voiceFlag;
    lineOut.stt.tailCleared = true;
  }
  if (isGrossMismatch(targetText, heard, cmp.cer)) {
    lineOut.voiceFlag = "MISHEARD";
  }
}

/** Shift an already-laid-out line (and its word timings) by `deltaSec`. */
function shiftLine(lineOut, deltaSec) {
  if (!deltaSec) return;
  lineOut.start += deltaSec;
  lineOut.end += deltaSec;
  for (const w of lineOut.words || []) {
    if (typeof w.start === "number") w.start += deltaSec;
    if (typeof w.end === "number") w.end += deltaSec;
  }
}

/**
 * Re-synthesize each of `flagged`'s lines once more, re-check with STT, and
 * keep whichever candidate (previous vs. new) has the lower character error
 * rate. A duration change on an accepted candidate shifts every later
 * line's start/end (mirrors the `--lines` "moved" mechanism).
 */
async function retryFlaggedLines({ flagged, lineResults, linesById, provider, voiceCfg, pronounce, lang, langCode, dir, paths, slots }) {
  for (const lineOut of flagged) {
    const line = linesById.get(lineOut.id);
    const spoken = spokenText(line, pronounce, voiceCfg);
    const outPath = path.join(paths.voiceDir, `line-${lineOut.id}.wav`);
    const backupPath = outPath + ".prevbest.wav";
    fs.copyFileSync(outPath, backupPath);

    let synthResult;
    if (typeof provider.synthBatch === "function") {
      const res = await provider.synthBatch([{ id: line.id, text: spoken, outPath }], {
        lang,
        voiceCfg,
        reelDir: dir,
      });
      synthResult = res.find((r) => r.id === line.id);
    } else {
      synthResult = await provider.synth({
        id: line.id,
        text: spoken,
        voice: voiceCfg.voiceId,
        lang,
        voiceCfg,
        params: { rate: voiceCfg.rate },
        outPath,
        reelDir: dir,
        lineStart: lineOut.start,
      });
    }

    const wavPath = synthResult.wavPath;
    await applyLineTempo(wavPath, line, voiceCfg, provider);
    if (slots.has(line.id)) await fitToSlot(wavPath, slots.get(line.id));

    const newDur = await probeDuration(wavPath);
    const sttRes = await sttTranscribe(paths.voiceDir, [{ id: line.id, wav: `line-${line.id}.wav` }], langCode);
    const newHeard = sttRes.results ? sttRes.results.get(line.id) || "" : "";
    const newCer = sttRes.results ? compareLine({ text: line.text, say: line.say, heard: newHeard }).cer : Infinity;
    const oldCer = lineOut.stt ? lineOut.stt.cer : Infinity;

    if (newCer < oldCer) {
      const delta = newDur - (lineOut.end - lineOut.start);
      lineOut.end = lineOut.start + newDur;
      const idx = lineResults.indexOf(lineOut);
      for (let i = idx + 1; i < lineResults.length; i++) shiftLine(lineResults[i], delta);
      lineOut.words =
        synthResult.words && synthResult.words.length
          ? synthResult.words
          : wordsProportional(line.text, lineOut.start, lineOut.end);
      delete lineOut.voiceFlag;
      if (synthResult.flag && synthResult.flag !== "OK") lineOut.voiceFlag = synthResult.flag;
      applySttResult(lineOut, line, newHeard);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.copyFileSync(backupPath, outPath);
      fs.rmSync(backupPath, { force: true });
    }
  }
}

/** Prints a compact `id | cer | flag | diffs` table for the checked lines. */
function printSttTable(checkedLines) {
  if (!checkedLines.length) return;
  process.stdout.write("stt check:\n");
  process.stdout.write("id\tcer\tflag\tdiffs\n");
  for (const l of checkedLines) {
    const cerStr = l.stt ? l.stt.cer.toFixed(2) : "-";
    const flag = l.voiceFlag || "OK";
    const diffs = l.stt && l.stt.diffs && l.stt.diffs.length ? l.stt.diffs.map((d) => `${d.want}→${d.heard}`).join("; ") : "-";
    process.stdout.write(`${l.id}\t${cerStr}\t${flag}\t${diffs}\n`);
  }
}

/**
 * `--stt-only`: run the STT check against existing voice/line-*.wav files
 * without synthesizing anything — updates timings.json in place. Useful
 * standalone (no provider/python-for-TTS needed) and for the skill to
 * re-verify a previously synthesized reel.
 */
async function runSttOnly(dir, paths) {
  if (!fs.existsSync(paths.timingsJson)) {
    throw new Error(`--stt-only: no ${paths.timingsJson} — run a full voice.mjs pass first`);
  }
  const timings = readJson(paths.timingsJson);
  const lines = timings.lines || [];
  const missing = lines.filter((l) => !fs.existsSync(path.join(paths.voiceDir, `line-${l.id}.wav`)));
  if (missing.length) {
    throw new Error(`--stt-only: missing voice/line-<id>.wav for: ${missing.map((l) => l.id).join(", ")}`);
  }

  const langCode = sttLangCode(timings.lang);
  const entries = lines.map((l) => ({ id: l.id, wav: `line-${l.id}.wav` }));
  const stt = await sttTranscribe(paths.voiceDir, entries, langCode);
  if (stt.skipped) {
    process.stdout.write(`STT check skipped: ${stt.skipped}\n`);
    return;
  }

  for (const lineOut of lines) {
    applySttResult(lineOut, lineOut, stt.results.get(lineOut.id) || "");
  }
  printSttTable(lines);
  writeJson(paths.timingsJson, timings);
  process.stdout.write(`wrote ${paths.timingsJson}\n`);
}

// A local voice at its own speed sounds slow in a Short. The same rate for every
// language: the voice already reads each language at that language's own pace.
const SHORTS_RATE = 1.1;

/**
 * meta.voice with the Shorts speaking rate filled in: a 9:16 film whose plan
 * sets no meta.voice.rate speaks at SHORTS_RATE. A rate the plan sets always wins.
 */
export function withShortsRate(meta) {
  const voice = meta.voice || {};
  if (voice.rate != null || meta.ratio !== "9:16") return voice;
  return { ...voice, rate: SHORTS_RATE };
}

// A line's own `rate` (0.5–2) replaces meta.voice.rate for that line, for a
// deliberately rushed or slowed run of lines; it is always applied with
// atempo. meta.voice.rate goes through atempo only for providers without
// native speed control (`export const nativeRate = true`).
const LINE_RATE_RANGE = { min: 0.5, max: 2 };

/** The atempo to apply to a line's take, or null for none. */
export function lineTempo(line, voiceCfg, provider) {
  if (line.rate != null) {
    const handled = provider.nativeRate && voiceCfg.rate != null ? voiceCfg.rate : 1;
    return { factor: line.rate / handled, range: LINE_RATE_RANGE };
  }
  if (voiceCfg.rate != null && !provider.nativeRate) return { factor: voiceCfg.rate, range: {} };
  return null;
}

async function applyLineTempo(wavPath, line, voiceCfg, provider) {
  const tempo = lineTempo(line, voiceCfg, provider);
  if (!tempo || tempo.factor === 1) return;
  const preTempoPath = wavPath + ".pretempo.wav";
  fs.renameSync(wavPath, preTempoPath);
  await applyAtempo(preTempoPath, wavPath, tempo.factor, tempo.range);
  fs.rmSync(preTempoPath, { force: true });
}

// A regenerated line keeps its old slot when the new take is close in length,
// so the picture does not move: a shorter take is padded with silence, a
// longer one is sped up by at most this factor. A take longer than that keeps
// its own length and the lines after it shift.
const MAX_FIT_SPEEDUP = 1.1;

/**
 * Fit the take at `wavPath` into `slotSec` in place when it can.
 * @returns {Promise<boolean>} whether the take now fills the slot
 */
async function fitToSlot(wavPath, slotSec) {
  const dur = await probeDuration(wavPath);
  if (Math.abs(dur - slotSec) < 0.005) return true;
  if (dur / slotSec > MAX_FIT_SPEEDUP) return false;
  const prefitPath = wavPath + ".prefit.wav";
  fs.renameSync(wavPath, prefitPath);
  const filter = dur > slotSec ? `atempo=${(dur / slotSec).toFixed(4)},apad` : "apad";
  await ffmpeg([
    "-y",
    "-i",
    prefitPath,
    "-filter:a",
    filter,
    "-t",
    slotSec.toFixed(4),
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);
  fs.rmSync(prefitPath, { force: true });
  return true;
}

async function makeSilence(outPath, durationSec) {
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    Math.max(0, durationSec).toFixed(3),
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

async function concatWavs(files, outPath) {
  const listPath = outPath + ".concat.txt";
  const listContent = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  fs.writeFileSync(listPath, listContent, "utf8");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
  fs.rmSync(listPath, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
