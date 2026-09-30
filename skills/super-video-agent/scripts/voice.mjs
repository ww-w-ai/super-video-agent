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
import { computeLineTimes, wordsProportional, wordsOnCaption, HEAD_SILENCE_SEC, TAIL_SILENCE_SEC } from "./lib/timing.mjs";
import { chooseProvider } from "./lib/choose-provider.mjs";
import { resolvePythonPath, runPythonBatch } from "./lib/pyenv.mjs";
import { compareLine, isGrossMismatch, tailCleared } from "./lib/stt-compare.mjs";
import { spokenText, stripCaptionBreaks } from "./lib/pronounce.mjs";
import { forEngine, unknownMarks, applyDeliveryMark, EMOTIONS } from "./lib/tags.mjs";
import { levelLineWav } from "./lib/line-level.mjs";

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

--takes N            with --lines: synthesize N (2-5, default 3 when given
                     with no number) fresh takes of the same text per listed
                     line, kept as voice/takes/<id>-<k>.wav with their STT
                     CER and duration; prints a comparison table and
                     installs take 1.
--takes <tone>,<tone>[,<tone>]
                     with --lines: one take per delivery mark instead (2-5
                     marks, freely chosen from scripts/lib/tags.mjs
                     EMOTIONS for the film, e.g. "confident") — each line's
                     own mark is replaced by it for that take. Installing a
                     tone take with --pick also writes it to plan.json
                     meta.voice.delivery (see --pick).
--pick id=k,id=k     on a later run, without --takes: installs take k for
                     each listed line id from its already-synthesized
                     voice/takes/<id>-<k>.wav (no re-synthesis) and rebuilds
                     narration.wav/timings.json as --lines does. If that
                     take came from a --takes m1,m2,... tone comparison, also
                     writes the picked mark to plan.json meta.voice.delivery
                     so the remaining lines are made in it.
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

  const unknown = [...new Set(plan.lines.flatMap((l) => unknownMarks(l.say ?? l.text)))];
  if (unknown.length) {
    process.stderr.write(`note: delivery marks no engine knows, dropped: {${unknown.join("}, {")}} (references/voice.md "Delivery marks")\n`);
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
  const voiceCfg = withFishConfidentDelivery(withShortsRate(plan.meta), plan.meta, providerName);
  if (voiceCfg.rate != null && (plan.meta.voice || {}).rate == null) {
    process.stderr.write(`note: vertical film without meta.voice.rate; speaking at the Shorts default ${voiceCfg.rate}\n`);
  }
  if (voiceCfg.delivery != null && (plan.meta.voice || {}).delivery == null) {
    process.stderr.write(`note: fish Short without meta.voice.delivery; speaking {${voiceCfg.delivery}}\n`);
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

  if (flags.pick) {
    try {
      await runPick({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, gapMs, tailSec, sttEnabled });
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  if (flags.takes) {
    if (!onlyLineIds || !onlyLineIds.length) {
      fail("--takes requires --lines id,id");
      return;
    }
    let spec;
    try {
      spec = parseTakesSpec(flags.takes);
    } catch (e) {
      fail(e.message);
      return;
    }
    try {
      await synthesizeTakes({
        dir,
        paths,
        plan,
        lineIds: onlyLineIds,
        spec,
        provider: providerMod,
        providerName,
        voiceCfg,
        pronounce: plan.meta.pronounce,
        lang: plan.meta.lang || "ko-KR",
        gapMs,
        tailSec,
        sttEnabled,
        keepTiming: !flags.retime,
      });
    } catch (e) {
      fail(e.message);
    }
    return;
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
  takeWavs = null,
}) {
  ensureDir(paths.voiceDir);
  // --lines: each regenerated line's old slot length, when it keeps its slot.
  const slots = new Map();
  // Silence after each line: its own pauseAfterMs, else meta.gapMs.
  let offset = HEAD_SILENCE_SEC;
  const lineResults = [];
  // Lines whose engine measured its own word times (ElevenLabs alignment); the rest take
  // their word times from the speech-to-text check.
  const providerTimed = new Set();
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
      .filter((line) => (!onlySet || onlySet.has(line.id)) && !(takeWavs && takeWavs.has(line.id)))
      .map((line) => ({
        id: line.id,
        text: forEngine(applyDeliveryMark(spokenText(line, pronounce, voiceCfg), voiceCfg.delivery), provider, voiceCfg),
        outPath: path.join(paths.voiceDir, `line-${line.id}.wav`),
      }));
    const results = batchLines.length
      ? await provider.synthBatch(batchLines, { lang, voiceCfg, reelDir: dir })
      : [];
    batchResults = new Map(results.map((r) => [r.id, r]));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const spoken = forEngine(applyDeliveryMark(spokenText(line, pronounce, voiceCfg), voiceCfg.delivery), provider, voiceCfg);
    // "|" is a caption-break marker (references/pipeline.md "Forced caption
    // breaks") — never spoken, never counted as a word or STT target.
    const timedText = stripCaptionBreaks(line.text);
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
    } else if (takeWavs && takeWavs.has(line.id)) {
      // --pick / --takes' own "install take 1": the audio is already
      // synthesized (voice/takes/<id>-<k>.wav) — copy it in and run it
      // through the same tempo/level/slot-fit/STT pipeline as any other
      // regenerated line, no new TTS call.
      fs.copyFileSync(takeWavs.get(line.id), outPath);
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
    if (!reused && voiceCfg.levelLines !== false) {
      const leveled = await levelLineWav(wavPath);
      process.stdout.write(`line "${line.id}" leveled: ${fmtLufs(leveled.beforeLufs)} -> ${fmtLufs(leveled.afterLufs)} LUFS\n`);
    }

    const prevLine = previousById.get(line.id);
    if (keepTiming && onlySet && !reused && prevLine) {
      slots.set(line.id, prevLine.end - prevLine.start);
      await fitToSlot(wavPath, slots.get(line.id));
    }

    const durationSec = await probeDuration(wavPath);
    const start = offset;
    const end = start + durationSec;

    const measured = synthResult.words && synthResult.words.length ? wordsOnCaption(timedText, synthResult.words) : [];
    if (measured.length) providerTimed.add(line.id);
    const words = measured.length ? measured : wordsProportional(timedText, start, end);

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
        applySttResult(lineOut, linesById.get(lineOut.id), stt.results.get(lineOut.id) || "", providerTimed.has(lineOut.id) ? null : stt.words.get(lineOut.id));
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
            providerTimed,
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
  if (!entries.length) return { results: new Map(), words: new Map() };

  const jobDir = fs.mkdtempSync(path.join(voiceDir, ".stt-"));
  const jobPath = path.join(jobDir, "lines.json");
  fs.writeFileSync(jobPath, JSON.stringify(entries), "utf8");
  try {
    const { stdout } = await runPythonBatch(pythonPath, [STT_SCRIPT, voiceDir, jobPath], {
      HF_HUB_OFFLINE: "1",
      SVA_STT_LANG: langCode,
    });
    const arr = JSON.parse(stdout.trim() || "[]");
    return {
      results: new Map(arr.map((r) => [r.id, r.heard])),
      words: new Map(arr.map((r) => [r.id, r.words || []])),
    };
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
function applySttResult(lineOut, line, heard, sttWords) {
  const timedText = stripCaptionBreaks(line.text);
  const timedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;
  if (sttWords && sttWords.length) {
    const words = wordsOnCaption(timedText, sttWords, lineOut.start);
    if (words.length) lineOut.words = words;
  }
  const cmp = compareLine({ text: timedText, say: timedSay, heard });
  const targetText = cmp.against === "say" ? timedSay : timedText;
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
async function retryFlaggedLines({ flagged, lineResults, linesById, provider, voiceCfg, pronounce, lang, langCode, dir, paths, slots, providerTimed }) {
  for (const lineOut of flagged) {
    const line = linesById.get(lineOut.id);
    const spoken = forEngine(applyDeliveryMark(spokenText(line, pronounce, voiceCfg), voiceCfg.delivery), provider, voiceCfg);
    const timedText = stripCaptionBreaks(line.text);
    const timedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;
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
    if (voiceCfg.levelLines !== false) {
      const leveled = await levelLineWav(wavPath);
      process.stdout.write(`line "${line.id}" leveled: ${fmtLufs(leveled.beforeLufs)} -> ${fmtLufs(leveled.afterLufs)} LUFS\n`);
    }
    if (slots.has(line.id)) await fitToSlot(wavPath, slots.get(line.id));

    const newDur = await probeDuration(wavPath);
    const sttRes = await sttTranscribe(paths.voiceDir, [{ id: line.id, wav: `line-${line.id}.wav` }], langCode);
    const newHeard = sttRes.results ? sttRes.results.get(line.id) || "" : "";
    const newCer = sttRes.results ? compareLine({ text: timedText, say: timedSay, heard: newHeard }).cer : Infinity;
    const oldCer = lineOut.stt ? lineOut.stt.cer : Infinity;

    if (newCer < oldCer) {
      const delta = newDur - (lineOut.end - lineOut.start);
      lineOut.end = lineOut.start + newDur;
      const idx = lineResults.indexOf(lineOut);
      for (let i = idx + 1; i < lineResults.length; i++) shiftLine(lineResults[i], delta);
      const measured = synthResult.words && synthResult.words.length ? wordsOnCaption(timedText, synthResult.words) : [];
      if (measured.length) providerTimed.add(line.id);
      else providerTimed.delete(line.id);
      lineOut.words = measured.length ? measured : wordsProportional(timedText, lineOut.start, lineOut.end);
      delete lineOut.voiceFlag;
      if (synthResult.flag && synthResult.flag !== "OK") lineOut.voiceFlag = synthResult.flag;
      applySttResult(lineOut, line, newHeard, measured.length ? null : sttRes.words.get(line.id));
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

  // ElevenLabs lines keep the word times the engine measured; the rest take the speech-to-text ones.
  const engineTimed = timings.provider === "elevenlabs";
  for (const lineOut of lines) {
    applySttResult(lineOut, lineOut, stt.results.get(lineOut.id) || "", engineTimed ? null : stt.words.get(lineOut.id));
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

// Fish Audio reads a Short's lines calm and flat unless tagged — the opening line
// especially. {confident} gives the upbeat tone a Short's opening wants.
const FISH_SHORTS_DELIVERY = "confident";

/**
 * `voice` with the fish default delivery filled in: fish + 9:16 + no
 * meta.voice.delivery speaks every untagged line with {confident}. Any delivery
 * the plan sets — including "none" to turn this off — always wins, and so does
 * a line's own emotion mark (applyDeliveryMark, lib/tags.mjs).
 */
export function withFishConfidentDelivery(voice, meta, providerName) {
  if (voice.delivery != null || providerName !== "fish" || meta.ratio !== "9:16") return voice;
  return { ...voice, delivery: FISH_SHORTS_DELIVERY };
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

/** "-16.0" or "n/a" for the leveling log line. */
function fmtLufs(lufs) {
  return lufs == null || !Number.isFinite(lufs) ? "n/a" : lufs.toFixed(1);
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

// --takes N (mode "count"): 2-5 fresh takes of the same text; --takes with no
// value defaults to 3.
const TAKES_MIN = 2;
const TAKES_MAX = 5;
const TAKES_DEFAULT_N = 3;

/**
 * `--takes`'s value: a bare flag or an integer 2-5 means "N fresh takes of
 * the same text" (mode "count"); a comma list of delivery marks means "one
 * take per tone, that line's own mark replaced" (mode "tone") — 2-5 marks,
 * freely chosen from scripts/lib/tags.mjs EMOTIONS for the film
 * (references/voice.md "Comparing takes").
 * @param {string|true} value flags.takes
 * @returns {{mode:"count", n:number} | {mode:"tone", marks:string[]}}
 */
export function parseTakesSpec(value) {
  if (value === true) return { mode: "count", n: TAKES_DEFAULT_N };
  const s = String(value).trim();
  if (/^[0-9]+$/.test(s)) {
    const n = Number(s);
    if (n < TAKES_MIN || n > TAKES_MAX) {
      throw new Error(`--takes must be ${TAKES_MIN}-${TAKES_MAX}, got ${n}`);
    }
    return { mode: "count", n };
  }
  const marks = s.split(",").map((m) => m.trim()).filter(Boolean);
  if (marks.length < TAKES_MIN || marks.length > TAKES_MAX) {
    throw new Error(`--takes as delivery marks must list ${TAKES_MIN}-${TAKES_MAX}, got ${marks.length}`);
  }
  const unknown = marks.filter((m) => !EMOTIONS.includes(m));
  if (unknown.length) {
    throw new Error(`--takes: unknown delivery mark(s) ${unknown.join(", ")} — see scripts/lib/tags.mjs EMOTIONS`);
  }
  return { mode: "tone", marks };
}

const EMOTION_MARK_RE = /\{([a-z-]+)\}\s*/g;

/**
 * `spoken` (spokenText's output, before applyDeliveryMark) with any emotion
 * mark it already carries stripped and `mark` forced in front — a --takes
 * tone comparison replaces a line's own mark for that take rather than
 * layering the tag on top of it.
 * @param {string} spoken
 * @param {string} mark one of EMOTIONS
 */
export function withForcedTone(spoken, mark) {
  const stripped = String(spoken ?? "").replace(EMOTION_MARK_RE, (full, name) => (EMOTIONS.includes(name) ? "" : full));
  return `{${mark}} ${stripped}`.trim();
}

function takesManifestPath(paths) {
  return path.join(paths.voiceDir, "takes", "manifest.json");
}

/** Which `--takes` spec produced each line's candidates, read by --pick to know
 * whether a picked take is a tone (and if so which mark) or a plain re-take. */
function loadTakesManifest(paths) {
  const p = takesManifestPath(paths);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveTakesManifest(paths, manifest) {
  writeJson(takesManifestPath(paths), manifest);
}

/**
 * `--takes`: synthesize spec.n (mode "count") or one take per spec.marks
 * (mode "tone") for each of `lineIds`, sequentially — never in parallel,
 * one TTS request at a time, even across takes — as
 * voice/takes/<id>-<k>.wav with STT CER and duration; prints a comparison
 * table and installs take 1 (references/voice.md
 * "Comparing takes"). Pick a different one later with --pick.
 */
export async function synthesizeTakes({ dir, paths, plan, lineIds, spec, provider, providerName, voiceCfg, pronounce, lang, gapMs, tailSec, sttEnabled, keepTiming }) {
  const takesDir = path.join(paths.voiceDir, "takes");
  ensureDir(takesDir);
  const langCode = sttLangCode(lang);
  const linesById = new Map(plan.lines.map((l) => [l.id, l]));
  const count = spec.mode === "count" ? spec.n : spec.marks.length;
  const rows = [];
  const manifest = loadTakesManifest(paths);

  for (const id of lineIds) {
    const line = linesById.get(id);
    if (!line) throw new Error(`--takes: unknown line id "${id}"`);
    const base = spokenText(line, pronounce, voiceCfg);
    const strippedText = stripCaptionBreaks(line.text);
    const strippedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;

    for (let k = 1; k <= count; k++) {
      const mark = spec.mode === "tone" ? spec.marks[k - 1] : null;
      const withMark = mark ? withForcedTone(base, mark) : applyDeliveryMark(base, voiceCfg.delivery);
      const spoken = forEngine(withMark, provider, voiceCfg);
      const outPath = path.join(takesDir, `${id}-${k}.wav`);

      const synthResult = typeof provider.synthBatch === "function"
        ? (await provider.synthBatch([{ id, text: spoken, outPath }], { lang, voiceCfg, reelDir: dir })).find((r) => r.id === id)
        : await provider.synth({
            id,
            text: spoken,
            voice: voiceCfg.voiceId,
            lang,
            voiceCfg,
            params: { rate: voiceCfg.rate },
            outPath,
            reelDir: dir,
            lineStart: 0,
          });
      if (!synthResult) throw new Error(`voice provider "${providerName}" returned no result for take ${id}-${k}`);
      const durationSec = await probeDuration(synthResult.wavPath);

      let cerVal = null;
      if (sttEnabled) {
        const sttId = `${id}-${k}`;
        const sttRes = await sttTranscribe(paths.voiceDir, [{ id: sttId, wav: `takes/${id}-${k}.wav` }], langCode);
        if (!sttRes.skipped) {
          const heard = sttRes.results.get(sttId) || "";
          cerVal = compareLine({ text: strippedText, say: strippedSay, heard }).cer;
        }
      }
      rows.push({ id, k, mark, durationSec, cer: cerVal });
    }

    manifest[id] = spec.mode === "tone" ? { mode: "tone", marks: spec.marks } : { mode: "count", n: spec.n };
  }

  saveTakesManifest(paths, manifest);
  printTakesTable(rows);

  const takeWavs = new Map(lineIds.map((id) => [id, path.join(takesDir, `${id}-1.wav`)]));
  const result = await synthesizeAll({
    dir,
    paths,
    lines: plan.lines,
    provider,
    providerName,
    voiceCfg,
    pronounce,
    lang,
    gapMs,
    tailSec,
    onlyLineIds: lineIds,
    sttEnabled,
    retryFlagged: 0,
    keepTiming,
    takeWavs,
  });
  writeJson(paths.timingsJson, result.timings);
  process.stdout.write(`installed take 1 for: ${lineIds.join(", ")}\n`);
  return { rows, timings: result.timings };
}

/** Prints a compact `id | take | tone | cer | duration` comparison table. */
function printTakesTable(rows) {
  if (!rows.length) return;
  process.stdout.write("takes:\n");
  process.stdout.write("id\ttake\ttone\tcer\tduration\n");
  for (const r of rows) {
    const cerStr = r.cer == null ? "-" : r.cer.toFixed(2);
    process.stdout.write(`${r.id}\t${r.k}\t${r.mark || "-"}\t${cerStr}\t${r.durationSec.toFixed(3)}s\n`);
  }
}

/**
 * `--pick id=k,id=k`'s value into `[{id,k}]`.
 * @param {string} pickStr
 */
export function parsePick(pickStr) {
  return String(pickStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [id, kStr] = pair.split("=");
      if (!id || !kStr || !/^[0-9]+$/.test(kStr.trim())) {
        throw new Error(`--pick: invalid entry "${pair}" (expected id=k)`);
      }
      return { id: id.trim(), k: Number(kStr.trim()) };
    });
}

/**
 * `--pick id=k,id=k`: installs each already-synthesized
 * voice/takes/<id>-<k>.wav without re-synthesis — copies the wav in and
 * rebuilds that line's timings and narration.wav/timings.json as --lines
 * does (references/voice.md "Comparing takes"). If a picked take came from
 * a --takes tone comparison (voice/takes/manifest.json), also writes that
 * mark to plan.json meta.voice.delivery, so the remaining lines are made
 * in that tone.
 */
async function runPick({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, gapMs, tailSec, sttEnabled }) {
  const picks = parsePick(flags.pick);
  const missing = picks.filter((p) => !fs.existsSync(path.join(paths.voiceDir, "takes", `${p.id}-${p.k}.wav`)));
  if (missing.length) {
    throw new Error(`--pick: no candidate take(s) for ${missing.map((p) => `${p.id}=${p.k}`).join(", ")} — run --takes first`);
  }

  const manifest = loadTakesManifest(paths);
  let deliveryWritten = null;
  for (const p of picks) {
    const entry = manifest[p.id];
    if (entry && entry.mode === "tone" && entry.marks && entry.marks[p.k - 1]) {
      deliveryWritten = entry.marks[p.k - 1];
    }
  }
  if (deliveryWritten) {
    plan.meta.voice = { ...(plan.meta.voice || {}), delivery: deliveryWritten };
    writeJson(paths.planJson, plan);
  }

  const takeWavs = new Map(picks.map((p) => [p.id, path.join(paths.voiceDir, "takes", `${p.id}-${p.k}.wav`)]));
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
    onlyLineIds: picks.map((p) => p.id),
    sttEnabled,
    retryFlagged: 0,
    keepTiming: !flags.retime,
    takeWavs,
  });
  writeJson(paths.timingsJson, result.timings);
  process.stdout.write(`installed take(s): ${picks.map((p) => `${p.id}=${p.k}`).join(", ")}\n`);
  if (deliveryWritten) {
    process.stdout.write(`wrote meta.voice.delivery = "${deliveryWritten}" to plan.json — the remaining lines will be made in this tone\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
