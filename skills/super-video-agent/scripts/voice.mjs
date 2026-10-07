#!/usr/bin/env node
// Synthesize each plan.json line, measure it (ffprobe, never guessed),
// concatenate with gap silences + head/tail into voice/narration.wav, and
// write voice/timings.json — the single timeline authority (design.md §2).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { loadCastVoices } from "./lib/cast-voices.mjs";
import { reelPaths, loadPlan, writeJson, readJson, ensureDir } from "./lib/reeldir.mjs";
import { ffmpeg, probeDuration, applyAtempo } from "./lib/ffmpeg.mjs";
import { computeLineTimes, wordsProportional, HEAD_SILENCE_SEC, TAIL_SILENCE_SEC } from "./lib/timing.mjs";
import { chooseProvider } from "./lib/choose-provider.mjs";
import { resolvePythonPath } from "./lib/pyenv.mjs";
import { compareLine, isGrossMismatch, tailCleared, pronounceFolds } from "./lib/stt-compare.mjs";
import { sttTranscribe, sttTranscribeLeveled } from "./lib/stt-engine.mjs";
import { spokenText, stripCaptionBreaks } from "./lib/pronounce.mjs";
import { forEngine, unknownMarks, applyDeliveryMark, EMOTIONS } from "./lib/tags.mjs";
import { levelLineWav, formatLevelReport } from "./lib/line-level.mjs";
import { trimClipToVoice } from "./lib/clip-trim.mjs";
import { stageRawTake, commitRawTake, discardRawTake, rawTakeProblems, rawTakeWarning } from "./lib/raw-take.mjs";
import { MIN_BREATH_SEC } from "./lib/dub-timing.mjs";
import { measureNarrationGaps, formatSilenceReport } from "./lib/silence-gate.mjs";
import { leadSec, formatLeadReport, withLeadHandover } from "./lib/lead.mjs";
import {
  partialRebuildNote,
  dubCode,
  parsePickBy,
  chooseTake,
  carriedWords,
  sttLangCode,
  sttOnlyLang,
  parseInsertPause,
  pauseWindow,
  quietestSample,
  insertSilence,
  shiftForPause,
  readWavMono16,
  writeWavMono16,
  previousSlots,
  planRetakeFit,
  retakeFitMessage,
  pictureSlotSecs,
  retimeRatioMessage,
  fitColumn,
  borrowedPauseRecord,
  carriedBorrowedGap,
  splitPlanByAudio,
  SAME_LENGTH_SEC,
} from "./voice/line-edit.mjs";
import { alignCaptionWords } from "./voice/word-align.mjs";
import { findClipDefects, describeDefects, defectCodes, waveformFlag, pitchTrack, endContour, wordContours, pitchSummary, PITCH_LIMITS } from "./voice/take-check.mjs";
import { snapStartsToSound } from "./lib/word-onsets.mjs";
import { readWav } from "./lib/wav-read.mjs";
import { measureEdgeEnvelope, voicedSpanWithPads } from "./lib/clip-trim.mjs";
import { lineLang } from "./lib/line-lang.mjs";
import { listVoicesReport } from "./lib/voice-list.mjs";

export { sttTranscribe };
// Providers whose output is deterministic (same input -> same audio every
// time), so re-synthesizing a flagged line for --retry-flagged is pointless.
const DETERMINISTIC_PROVIDERS = new Set(["say", "file", "none"]);

const HELP = `usage: voice.mjs <reel-dir> [--provider say|fish|elevenlabs|typecast|file|none|qwen3|melotts|fishspeech] [--lines id,id]

Synthesizes voice/line-<id>.wav for each plan.json line, measures each
with ffprobe, concatenates them with meta.gapMs of silence between lines
(plus a fixed 0.4s head silence and a meta.tailSec tail silence, default
0.4s — set meta.tailSec higher to keep a wordless end card) into
voice/narration.wav (48kHz mono), and writes voice/timings.json.

Each synthesized line is trimmed to its voiced span plus 0.05 s head and
0.3 s tail, with a 20 ms fade-in and a 30 ms fade-out at the cuts (the untrimmed
take is kept at voice/raw/<id>.wav and replaced when a new take is installed;
timings.json records its hash as rawTake). When the
narration is placed, the silence gate lists every pause over 1 s between
voiced audio with the line ids around it; a pause the plan asks for (a line's
pauseAfterMs) is listed as planned, not as a problem.

--list-voices [<reel-dir>] [--lang <code>] [--provider typecast|elevenlabs]
              prints the voices the provider's own list offers (id, name,
              gender, age, use, languages) and exits; no synthesis. The
              provider is --provider, else the reel's meta.voice.provider.
              --lang keeps the voices whose list names that language; a
              provider whose list has no language field shows every voice
              and says so. The key is read from the environment, never printed.

--provider overrides plan.json meta.voice.provider. If neither is given,
voice.mjs auto-chooses: file (if voice/in/ has audio) ->
qwen3 (if its python venv is found and meta.voice.refAudio is set) -> fish
-> elevenlabs -> typecast -> melotts (if its python venv is found); with none of these it
stops and lists what to set up. say (macOS) runs only when asked for. It prints
which provider it picked and why.

A line's own "voice" (any meta.voice keys) is merged over meta.voice for that
line, so one film can have several speakers; its voice.provider wins over
--provider. Every mode below makes each line in its own voice, timings.json
records each line's provider and voiceId, and the run ends with a one-line
speaker summary.

--lines id,id  regenerate only these lines' audio; reuse the existing
               voice/line-<id>.wav for every other line (they must already
               exist). narration.wav and timings.json are always rebuilt in
               full. A regenerated line keeps its old time slot (the old
               clip plus the pause after it), so the picture does not change
               and render.mjs reuses every shot. The take is fitted in the
               order dub.mjs uses: trimmed, sped up by at most 10% when too
               long, at least 0.5 s of breath kept after it, a voice-free gap
               of at most 1.0 s (a much shorter take is slowed to 0.95x at
               most, then reported). A take that needs more than 1.1x is
               refused: the old clip stays, the take is kept at
               voice/takes/<id>/refused-<stamp>.wav, the other lines install
               and the run ends with an error naming the line — shorten its
               text or say, or re-synthesize it. No take moves later lines.
               Each re-take prints its length against the slot and against
               the take it replaces, and its STT error rate against the old
               one. Every line not regenerated keeps its measured word times
               (moved by how far its start moved). In a dub folder (<reel>/dub/<code>/) the
               picture never moves and a regenerated line always keeps its
               own length (as --retime): dub.mjs fits it to the picture
               slot; run dub.mjs --lang <code> afterwards to re-place the lines.
--retime      with --lines: let regenerated lines keep their own length
               (use after a wording change, not a pronunciation fix); later
               lines move and their shots re-render. Implied in a dub folder.
               Each take installed this way prints its length against the slot
               the line has on the picture as a ratio (1.357x = 35.7% over its
               slot; in a dub folder the slot is the base reel's line slot).

After a line is made, its own waveform and level are read, and the result is
printed. Gate (voiceFlag, with a WARN naming the fix, no STT result clears it):
HEAD (the start is cut, swallowed, or audible at once, or carries the end of the
previous line) and TAIL (the line ends while it is still loud enough to hear),
judged by perceived loudness (BS.1770 K-weighting, relative to the line's own level). Facts: DIP (a stretch 15 dB under the line's level), PAUSE
(0.35 s or more of silence inside the line). Re-make a flagged line with
--lines <id>, or --retry-flagged N. Caption words that follow a pause start where their sound begins, not
where the STT pass put them (--stt-only leaves word times alone).

--raw-status [--lines id,id]
               report only: whether voice/raw/<id>.wav is the take each installed
               clip was made from (timings.json records its hash as rawTake).
               Exit code 1 when a raw take is stale or missing: do not rebuild
               those lines from voice/raw.

--pitch [--lines id,id] [--words]
               report only: where the pitch goes in each installed line —
               voiced share, median, range, and the end contour (rise / fall
               / level in semitones against the voiced stretch before it);
               --words adds each word's shape (rising, falling, level,
               dipping, peaking, unvoiced; one word is one syllable in
               Vietnamese and Chinese). A line whose text ends in a question
               mark is listed with its measured end contour. Writes
               out/pitch.json. It measures pitch; whether a rise, fall or tone
               is the right one for the language is for the reader to judge.

After synthesis, every synthesized line is checked by transcribing its own
audio back (mlx-whisper by default) and comparing it against the intended text —
see references/voice.md "Did the voice say the line?". Numbers (Korean,
Chinese, Japanese too), Simplified/Traditional Chinese, kana and names in the
pronunciation dictionary are folded to one spelling before comparing. Flags a line
voiceFlag: MISHEARD only on a gross mismatch (most of it wrong, or words dropped or added).
The STT check judges only whether the words came out wrong; clicks, cuts and
abrupt edges are judged on the waveform (HEAD / TAIL below) and no transcript
clears them.

--no-stt            skip the speech-to-text check entirely.
--retry-flagged N   re-synthesize lines flagged MISHEARD/SHORT/TAIL/HEAD up to N
                     more times, keeping the candidate with the lowest
                     character error rate (default 0; opt in only after reviewing
                     the advisory evidence; skipped for
                     deterministic providers: say, file, none).
--stt-only           run the STT check on the existing voice/line-*.wav
                     files without synthesizing anything; updates
                     timings.json in place and does not touch narration.wav.
                     Lines are compared with plan.json's current text.
                     Word times are never rewritten for a line that already
                     has measured ones; only the stt fields and voiceFlag change.
                     Transcribes in timings.json's lang, else plan.json
                     meta.lang. A line that now passes loses an old MISHEARD
                     flag. With --lines id,id only those lines are checked.
                     The model loads once; timings.json is saved after every
                     finished line of the first pass, and voice/stt-pending.json
                     lists the lines left: a killed run, rerun with the same
                     command, resumes with those lines only (delete the file
                     to check every line). A line the second model answers
                     keeps the transcript with the lower error rate; the
                     model is recorded in the line's stt.model.

STT engine (env): SVA_STT_PYTHON  python with mlx-whisper installed.
                  SVA_STT_ENGINE  mlx (default) or groq (hosted; audio is
                                  sent only when selected; key in GROQ_API_KEY,
                                  never printed; no key = check skipped).
                  SVA_STT_MODEL / SVA_STT_MODEL_RECHECK  first pass (small)
                                  and the second pass (turbo) run only on
                                  lines whose transcript is doubtful against
                                  the plan text (SVA_STT_DOUBT_CER, 0.15).
                  A model that is not downloaded skips the check with a note;
                  node scripts/setup.mjs --stt-models downloads them.
                  Take comparison (--takes, --pick-by stt) transcribes
                  leveled copies, the loudness an installed line gets.

--takes N            with --lines: synthesize N (2-5, default 3 when given
                     with no number) fresh takes of the same text per listed
                     line, kept as voice/takes/<id>-<k>.wav with their STT
                     CER and duration; prints a comparison table. Never
                     changes an installed clip, timings.json or
                     narration.wav (a line with no installed clip yet gets
                     take 1); install with --pick.
--takes <tone>,<tone>[,<tone>]
                     with --lines: one take per delivery mark instead (2-5
                     marks, freely chosen from scripts/lib/tags.mjs
                     EMOTIONS for the film, e.g. "confident") — each line's
                     own mark is replaced by it for that take. Installing a
                     tone take with --pick also writes it to plan.json
                     for that speaker (see --pick).
--pick id=k,id=k     on a later run, without --takes: installs take k for
                     each listed line id from its already-synthesized
                     voice/takes/<id>-<k>.wav (no re-synthesis) and rebuilds
                     narration.wav/timings.json as --lines does. The clip
                     it replaces is kept as
                     voice/takes/<id>/installed-<timestamp>.wav (restore
                     with --use <id>=<that file>). If that
                     take came from a --takes m1,m2,... tone comparison, also
                     writes the picked mark to plan.json so that speaker's
                     remaining lines are made in it: meta.voice.delivery for
                     the film-wide voice, else the voice.delivery of each of
                     that speaker's lines. A plan line with no audio yet is
                     left out of that rebuild (one note names it); make it
                     next with --lines <ids> or a full pass.
--use id=<wav>,id=<wav>
                     install finished line audio from anywhere (another
                     reel's voice/line-<id>.wav, a comparison folder, a
                     recording) without re-synthesis. Taken as final: the
                     film's speed is NOT applied again (unlike --pick, whose
                     takes are raw). Leveled, STT-checked, and
                     narration.wav/timings.json rebuilt as --lines does;
                     add --retime when its length differs from the old line.
--pick-by length:<sec> | stt
                     choose the take to install instead of naming it:
                     length:<sec> installs the take whose length (at the
                     film's speed) is closest to <sec>; stt installs the take
                     with the lowest character error rate. With --takes it
                     installs the chosen take right away; alone it reads the takes
                     already in voice/takes/ for the --lines ids (default:
                     every line in voice/takes/manifest.json). Prints the take
                     table with the chosen take marked. The take installed now
                     is a row of its own ("installed") and wins ties — if it
                     scores best nothing is installed. A take that runs over
                     the line's slot is never chosen (the table's slot column);
                     when no take fits, that line is refused and the run ends
                     with an error. Columns end (pitch at the line's end) and
                     defects (HEAD, DIP, PAUSE) appear when audio shows any.
--insert-pause <id>@<word>=<ms>[,...]
                     insert <ms> of silence into the finished line <id>
                     between word <word> (0-based index into that line's
                     timings.json words) and the next, at the quietest 10 ms
                     point there. No re-synthesis: the line grows by exactly
                     the pause, its later words and every later line move by
                     the same amount, narration.wav/timings.json are rebuilt.
`;

const PROVIDERS = ["say", "fish", "elevenlabs", "typecast", "file", "none", "qwen3", "melotts", "fishspeech"];

async function loadProviderModule(name) {
  // Only names from the fixed list reach the import path.
  if (!PROVIDERS.includes(name)) {
    throw new Error(`unknown voice provider "${name}" (known: ${PROVIDERS.join(", ")})`);
  }
  try {
    return await import(`./voice/${name}.mjs`);
  } catch (e) {
    throw new Error(`failed to load voice provider "${name}": ${e.message}`);
  }
}

/**
 * Whether a regenerated line keeps its old slot (--lines/--pick/--use). The
 * base reel keeps it unless --retime. In a dub folder (dub/<code>/) the line's
 * limit is the base-language slot on the picture, which dub.mjs fits itself,
 * so the new take keeps its natural length and the old slot is not used.
 * @returns {boolean}
 */
function keepOldSlots(dir, flags) {
  if (flags.retime) return false;
  const code = dubCode(dir);
  if (!code) return true;
  if (flags.lines || flags.pick || flags.use || flags["pick-by"]) {
    process.stdout.write(`dub folder (dub/${code}/): regenerated lines keep their own length (--retime) — dub.mjs fits them to the picture slots\n`);
  }
  return false;
}

/**
 * --list-voices [<reel-dir>] [--lang <code>] [--provider <name>]: the provider's own voice list.
 * The provider is --provider, else the reel's plan.json meta.voice.provider.
 */
async function runListVoices(positional, flags) {
  try {
    if (typeof flags["list-voices"] === "string") positional.unshift(flags["list-voices"]);
    let providerName = flags.provider;
    if (!providerName && positional.length) providerName = (loadPlan(abs(positional[0])).meta.voice || {}).provider;
    if (!providerName) throw new Error("--list-voices needs a provider: --provider typecast|elevenlabs, or a reel whose plan.json sets meta.voice.provider");
    const lang = typeof flags.lang === "string" ? flags.lang : undefined;
    process.stdout.write(await listVoicesReport(providerName, await loadProviderModule(providerName), { lang }));
  } catch (e) {
    fail(e.message);
  }
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags["list-voices"]) {
    await runListVoices(positional, flags);
    return;
  }
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);

  if (flags["stt-only"]) {
    try {
      await runSttOnly(dir, paths, flags);
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  if (flags["raw-status"]) {
    try {
      runRawStatus(paths, flags);
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

  if (flags["insert-pause"]) {
    try {
      await runInsertPause({ dir, paths, plan, spec: flags["insert-pause"] });
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  if (flags.pitch) {
    try {
      runPitchReport(dir, paths, flags);
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  let castVoices;
  try { castVoices = loadCastVoices(plan, dir); } catch (e) { fail(e.message); return; }
  let providerName = flags.provider || (plan.meta.voice && plan.meta.voice.provider) || castVoices.values().next().value?.provider;
  if (!providerName) {
    const choice = chooseProvider({
      hasVoiceInDir: fs.existsSync(path.join(paths.voiceDir, "in")),
      qwen3PythonFound: !!resolvePythonPath("SVA_QWEN3_PYTHON", null),
      refAudioSet: !!(plan.meta.voice && plan.meta.voice.refAudio),
      fishKeySet: !!(process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY),
      elevenKeySet: !!process.env.ELEVENLABS_API_KEY,
      typecastKeySet: !!process.env.TYPECAST_API_KEY,
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

  let lineVoices;
  let providerMod;
  try {
    providerMod = await loadProviderModule(providerName);
    lineVoices = await buildLineVoices(plan, providerName, loadProviderModule, castVoices);
  } catch (e) {
    fail(e.message);
    return;
  }

  const gapMs = plan.meta.gapMs == null ? 700 : plan.meta.gapMs;
  const tailSec = plan.meta.tailSec == null ? TAIL_SILENCE_SEC : plan.meta.tailSec;
  const voiceCfg = resolveLineVoice(plan.meta, null, providerName).voiceCfg;
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
  const retryFlagged = flags["retry-flagged"] != null ? Number(flags["retry-flagged"]) : 0;

  const refAudios = new Set(
    [...lineVoices.values()].filter((v) => CLONE_PROVIDERS.has(v.providerName) && v.voiceCfg.refAudio).map((v) => v.voiceCfg.refAudio)
  );
  for (const refAudio of refAudios) {
    const refError = await checkRefAudioLength(refAudio, dir);
    if (refError) {
      fail(refError);
      return;
    }
  }

  if (flags.use) {
    try {
      await runUse({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, lineVoices, gapMs, tailSec, sttEnabled });
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  if (flags.pick) {
    try {
      await runPick({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, lineVoices, gapMs, tailSec, sttEnabled });
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  let pickBy = null;
  if (flags["pick-by"] != null) {
    try {
      pickBy = parsePickBy(flags["pick-by"]);
    } catch (e) {
      fail(e.message);
      return;
    }
  }

  if (pickBy && !flags.takes) {
    try {
      await runPickBy({ dir, paths, plan, flags, pickBy, lineIds: onlyLineIds, providerMod, providerName, voiceCfg, lineVoices, gapMs, tailSec, sttEnabled });
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
        lineVoices,
        pronounce: plan.meta.pronounce,
        lang: plan.meta.lang || "ko-KR",
        gapMs,
        tailSec,
        sttEnabled,
        keepTiming: keepOldSlots(dir, flags),
        pickBy,
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
      lineVoices,
      pronounce: plan.meta.pronounce,
      lang: plan.meta.lang || "ko-KR",
      gapMs,
      tailSec,
      onlyLineIds,
      sttEnabled,
      retryFlagged,
      keepTiming: keepOldSlots(dir, flags),
    });
    writeJson(paths.timingsJson, result.timings);
    // A full pass rebuilt every line, so ids an earlier --stt-only left unchecked are stale.
    if (!onlyLineIds) fs.rmSync(path.join(paths.voiceDir, STT_PENDING_FILE), { force: true });
    process.stdout.write(
      `wrote ${paths.narrationWav}\n` +
        `wrote ${paths.timingsJson}\n` +
        `provider: ${providerName}  lines: ${plan.lines.length}  duration: ${result.timings.duration.toFixed(3)}s\n`
    );
    if (onlyLineIds) process.stdout.write(partialRebuildNote(dir, result.moved));
    failIfRefused(result);
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
  retryFlagged = 0,
  keepTiming = true,
  takeWavs = null,
  // Line ids whose takeWavs file is finished audio (--use): already at the
  // film's speed, so no tempo is applied again.
  finishedIds = null,
  // Line id -> its resolved voice (buildLineVoices); a line missing here uses
  // provider/providerName/voiceCfg.
  lineVoices = null,
}) {
  ensureDir(paths.voiceDir);
  const filmVoice = { provider, providerName, voiceCfg, key: "" };
  const lineVoice = (line) => voiceOf(lineVoices, line, filmVoice);
  // --lines: each regenerated line's old slot length, when it keeps its slot.
  const slots = new Map();
  // Silence after each line: its own pauseAfterMs, else meta.gapMs.
  // The opening lead (plan.json meta.lead): the story's first line starts HEAD + lead in.
  // Lead lines (lead: true) are laid out first, from the head; the story follows at HEAD + lead.
  const planMeta = readPlanMeta(paths.planJson);
  const lead = leadSec(planMeta);
  const hasLeadLines = lead > 0 && lines.some((l) => l.lead);
  const headSec = HEAD_SILENCE_SEC + (hasLeadLines ? 0 : lead);
  let offset = headSec;
  const lineResults = [];
  // Lines whose engine measured its own word times (ElevenLabs, Typecast); the rest take
  // their word times from the speech-to-text check.
  const providerTimed = new Set();
  const segmentFiles = []; // {kind, path, durationSec}
  const warnings = [];

  const onlySet = onlyLineIds ? new Set(onlyLineIds) : null;
  // `--lines`: reuse existing per-line wavs and their previous timings.json
  // fields (estimated/voiceFlag) for lines outside the set; only lines in
  // the set are re-synthesized.
  let previousById = new Map();
  let oldSlots = new Map();
  if (onlySet && fs.existsSync(paths.timingsJson)) {
    try {
      const prev = JSON.parse(fs.readFileSync(paths.timingsJson, "utf8"));
      previousById = new Map((prev.lines || []).map((l) => [l.id, l]));
      oldSlots = slotsWithoutPauseBefore(prev.lines || [], lines, gapMs);
    } catch {
      previousById = new Map();
    }
  }
  const pictureSlots = onlySet && !keepTiming ? pictureSlotSecs(dir, oldSlots) : new Map();
  // Re-made lines that did not fit their slot (the old clip is back), and lines whose gap after them shrinks.
  const refused = [];
  const slotGaps = new Map();

  const headPath = path.join(paths.voiceDir, "_silence-head.wav");
  await makeSilence(headPath, headSec);
  segmentFiles.push({ kind: "silence", path: headPath, durationSec: headSec });

  // Batch-capable providers: qwen3 and melotts load their model once for all
  // lines; elevenlabs, typecast and fish send all lines in one request and cut
  // one clip per line. voice.mjs prefers synthBatch when a
  // provider implements it (design.md §2.3 voice providers). One batch per
  // resolved voice, since a batch carries one voiceCfg. With --lines, only
  // the lines being regenerated are sent.
  const toSynth = lines.filter((line) => (!onlySet || onlySet.has(line.id)) && !(takeWavs && takeWavs.has(line.id)));
  // Batch providers write straight to voice/line-<id>.wav, so the old clips are put aside first.
  const oldClips = backUpOldClips({ lines, paths, onlySet, keepTiming, previousById, oldSlots });
  let batchResults;
  try {
    batchResults = await synthBatches({ lines: toSynth, lineVoice, pronounce, lang, dir, voiceDir: paths.voiceDir });
  } catch (e) {
    restoreOldClips(paths, oldClips);
    throw e;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The picture plays this long before the line starts (plan line `pauseBeforeMs`).
    const beforeSec = pauseBeforeSec(line);
    if (beforeSec > 0) {
      const beforePath = path.join(paths.voiceDir, `_silence-before-${i}.wav`);
      await makeSilence(beforePath, beforeSec);
      segmentFiles.push({ kind: "silence", path: beforePath, durationSec: beforeSec });
      offset += beforeSec;
    }
    const lv = lineVoice(line);
    const spoken = engineText(line, pronounce, lv);
    // "|" is a caption-break marker (references/pipeline.md "Forced caption
    // breaks") — never spoken, never counted as a word or STT target.
    const timedText = stripCaptionBreaks(line.text);
    const outPath = path.join(paths.voiceDir, `line-${line.id}.wav`);
    let reused = onlySet && !onlySet.has(line.id);
    // The old clip waits under a unique name (backUpOldClips) while a re-made take is tried against its slot.
    const oldClip = oldClips.get(line.id);
    const oldSlot = oldClip ? oldClip.slot : null;
    const oldClipBackup = oldClip ? oldClip.backup : null;

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
    } else if (typeof lv.provider.synthBatch === "function") {
      synthResult = batchResults.get(line.id);
      if (!synthResult) {
        throw new Error(`voice provider "${lv.providerName}" synthBatch returned no result for line "${line.id}"`);
      }
    } else {
      synthResult = await withUsageLog(paths.voiceDir, lv, [{ id: line.id, text: spoken }], () => synthOne(lv, { id: line.id, text: spoken, lang: lineLang(line, lang), outPath, reelDir: dir, lineStart: offset }));
    }

    const wavPath = synthResult.wavPath;
    // Edge trim first (the film's silence gate depends on it), then tempo.
    const trimmedHere = !reused && !(finishedIds && finishedIds.has(line.id));
    const trimmed = trimmedHere ? await trimLineClip(paths, line.id, wavPath, rawSourceOf(takeWavs, line.id)) : { leadTrimSec: 0, staged: null };
    const leadTrimSec = trimmed.leadTrimSec;
    if (!reused && !(finishedIds && finishedIds.has(line.id))) await applyLineTempo(wavPath, line, lv.voiceCfg, lv.provider);
    if (!reused && lv.voiceCfg.levelLines !== false) {
      process.stdout.write(formatLevelReport(line.id, await levelLineWav(wavPath)));
    }

    const prevLine = previousById.get(line.id);
    let leadTrim = leadTrimSec;
    let fitFactor = 1;
    if (oldSlot) {
      const fitted = await fitRetake(line.id, wavPath, oldSlot, { borrow: true });
      if (fitted.ok) {
        slots.set(line.id, oldSlot);
        fitFactor = fitted.fit.atempoFactor;
        fs.rmSync(oldClipBackup, { force: true });
      } else {
        refuseRetake(paths, line.id, wavPath, oldClipBackup);
        refused.push(line.id);
        reused = true;
        leadTrim = 0;
        synthResult = { wavPath };
      }
    }

    const durationSec = await probeDuration(wavPath);
    if (onlySet && !keepTiming && !reused) reportRetimeRatio(line.id, durationSec, pictureSlots, dir);
    const start = offset;
    const end = start + durationSec;

    const speedUp = reused || (finishedIds && finishedIds.has(line.id)) ? fitFactor : tempoFactor(line, lv.voiceCfg, lv.provider) * fitFactor;
    const measured = providerWords(timedText, synthResult, lineLang(line, lang), start, speedUp, leadTrim);
    if (measured) providerTimed.add(line.id);
    // A line reused as-is keeps the word times measured on an earlier run.
    const carried = reused ? carriedWords(prevLine, timedText, start, stripCaptionBreaks) : null;
    // Until the STT check measures them, a line's words are spread evenly (wordsMeasured 0).
    const timed = measured || (carried && { words: carried, measured: prevLine.wordsMeasured }) || { words: wordsProportional(timedText, start, end), measured: 0 };

    // A reused line keeps the speaker recorded when its audio was made.
    const speaker = reused && prevLine && prevLine.voice ? prevLine.voice : speakerOf(lv);
    const lineOut = { id: line.id, text: line.text, start, end, words: timed.words, voice: speaker };
    if (line.lead) lineOut.lead = true;
    if (beforeSec > 0) lineOut.pauseBeforeSec = beforeSec;
    if (line.lang) lineOut.lang = line.lang;
    if (timed.measured != null) lineOut.wordsMeasured = timed.measured;
    if (line.say != null) lineOut.say = line.say;
    if (reused && prevLine && prevLine.estimated) lineOut.estimated = true;
    if (reused && prevLine && prevLine.voiceFlag) lineOut.voiceFlag = prevLine.voiceFlag;
    if (reused && prevLine && prevLine.stt) lineOut.stt = prevLine.stt;
    if (reused && prevLine && prevLine.clipFacts) lineOut.clipFacts = prevLine.clipFacts;
    const rawTake = settleRawTake(trimmed.staged, reused, prevLine);
    if (rawTake) lineOut.rawTake = rawTake;
    if (!reused && synthResult.estimated) lineOut.estimated = true;
    if (!reused && synthResult.flag && synthResult.flag !== "OK") {
      lineOut.voiceFlag = synthResult.flag;
      warnings.push(`line "${line.id}": voice provider flagged ${synthResult.flag}`);
    }
    lineResults.push(lineOut);

    segmentFiles.push({ kind: "line", path: wavPath, durationSec });

    offset = end;
    if (i < lines.length - 1) {
      const plannedGapSec = (line.pauseAfterMs ?? gapMs) / 1000;
      // Never less than the minimum breath after a line; a plan pause below it is raised and reported.
      let gapSec = Math.max(plannedGapSec, MIN_BREATH_SEC);
      if (gapSec > plannedGapSec) warnings.push(`line "${line.id}": pause after it ${plannedGapSec.toFixed(2)}s raised to the ${MIN_BREATH_SEC}s minimum breath`);
      // The last lead line hands over to the story at HEAD + lead (the lead span, not a pause).
      if (hasLeadLines && line.lead && !lines[i + 1].lead) gapSec = Math.max(gapSec, HEAD_SILENCE_SEC + lead - end);
      // A take that borrowed breath from the pause after it (this run, or an earlier one this line is
      // reused from): the next line keeps its start, and timings.json records the pause for later rebuilds.
      const borrowedSec = borrowedGapSec({ slot: slots.get(line.id), durationSec, reused, prevLine, plannedGapSec });
      if (borrowedSec != null) {
        gapSec = borrowedSec;
        lineOut.borrowedPause = borrowedPauseRecord(plannedGapSec, borrowedSec);
      }
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
  const checkedIds = lines.filter((l) => (!onlySet || onlySet.has(l.id)) && !refused.includes(l.id)).map((l) => l.id);
  // The waveform check runs first: its HEAD / TAIL flags are what --retry-flagged re-makes lines for.
  await inspectMadeLines(paths, lineResults.filter((l) => checkedIds.includes(l.id)));
  if (sttEnabled && checkedIds.length) {
    const langCode = sttLangCode(lang);
    const linesById = new Map(lines.map((l) => [l.id, l]));
    // A line with its own `lang` is checked in that language.
    const codeOf = (id) => sttLangCode(lineLang(linesById.get(id), lang));
    const entries = checkedIds.map((id) => sttEntry(linesById.get(id), `line-${id}.wav`, { langCode: codeOf(id), pronounce }));
    const stt = await sttTranscribe(paths.voiceDir, entries, langCode);
    if (stt.skipped) {
      process.stdout.write(`STT check skipped: ${stt.skipped}\n`);
    } else {
      for (const lineOut of lineResults) {
        if (!checkedIds.includes(lineOut.id)) continue;
        applySttResult(lineOut, linesById.get(lineOut.id), stt.results.get(lineOut.id) || "", providerTimed.has(lineOut.id) ? null : stt.words.get(lineOut.id), codeOf(lineOut.id), pronounce, stt.models && stt.models.get(lineOut.id));
      }
      reportAgainstExisting(lineResults.filter((l) => checkedIds.includes(l.id)), previousById);

      if (retryFlagged > 0) {
        for (let round = 0; round < retryFlagged; round++) {
          const flagged = lineResults.filter(
            (l) =>
              checkedIds.includes(l.id) &&
              needsRetry(l.voiceFlag) &&
              !DETERMINISTIC_PROVIDERS.has(lineVoice(linesById.get(l.id)).providerName)
          );
          if (!flagged.length) break;
          await retryFlaggedLines({
            flagged,
            lineResults,
            linesById,
            lineVoice,
            pronounce,
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
  snapMadeLines(paths, lineResults.filter((l) => checkedIds.includes(l.id)));

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
  if (lang) timings.lang = lang;
  if (lead > 0) timings.lead = lead;

  // Silence gate: every pause over 1 s between voiced audio, with the line ids
  // around it; a pause the plan asks for (pauseAfterMs) is listed as planned.
  let silence = null;
  try {
    silence = await measureNarrationGaps(paths.narrationWav, lineResults, withLeadHandover(foldPauseBefore(lines, gapMs), lineResults), { gapMs });
    process.stdout.write(formatSilenceReport(silence) + formatLeadReport({ meta: planMeta, lines }));
  } catch (e) {
    process.stderr.write(`warning: silence gate could not measure ${paths.narrationWav}: ${e.message}\n`);
  }

  // --lines: report which OTHER lines' start times shifted (a regenerated
  // line's new duration pushes every following line) — those lines' shots
  // will re-render on the next render.mjs run.
  const moved = onlySet
    ? lineResults
        .filter((l) => !onlySet.has(l.id) && previousById.has(l.id) && Math.abs(previousById.get(l.id).start - l.start) > MOVED_TOLERANCE_SEC)
        .map((l) => l.id)
    : [];

  process.stdout.write(speakerSummary(lineResults) + "\n");
  return { timings, moved, silence, refused };
}

/**
 * The pause to lay after a line whose clip runs into the breath after it, or null when the plan's pause
 * applies. A re-made take longer than its old clip takes the rest of its slot; a reused line keeps the
 * pause its earlier run borrowed, while the plan's pause is still the one it was borrowed from.
 */
function borrowedGapSec({ slot, durationSec, reused, prevLine, plannedGapSec }) {
  if (reused) return carriedBorrowedGap(prevLine, plannedGapSec);
  if (slot && durationSec > slot.oldClipSec + SAME_LENGTH_SEC) return Math.max(0, slot.slotSec - durationSec);
  return null;
}

/**
 * Edge trim of a freshly synthesized line (scripts/lib/clip-trim.mjs): cut to
 * the voiced span plus 0.05 s head / 0.3 s tail, in place. The untrimmed take is staged
 * for voice/raw/<id>.wav (raw-take.mjs); settleRawTake installs it with the clip.
 * @returns {Promise<{leadTrimSec:number, staged:object}>} the seconds removed from the clip's head, and the staged raw take
 */
async function trimLineClip(paths, id, wavPath, source = "synth") {
  const staged = stageRawTake(paths.voiceDir, id, wavPath, source);
  const trimmedPath = `${wavPath}.trim.wav`;
  const t = await trimClipToVoice(wavPath, trimmedPath);
  fs.renameSync(trimmedPath, wavPath);
  return { leadTrimSec: t.leadTrimSec, staged };
}

/** Where a line's take came from: its --pick / --takes file, else a fresh synthesis. */
function rawSourceOf(takeWavs, id) {
  return takeWavs && takeWavs.has(id) ? `takes/${path.basename(takeWavs.get(id))}` : "synth";
}

/**
 * The line's `rawTake` record once its clip is settled: a staged take of a clip that was installed
 * becomes voice/raw/<id>.wav and is recorded; a staged take of a clip that was not (the old clip
 * came back) is dropped and the old record stays; a reused line keeps its record.
 * @returns {object|undefined}
 */
function settleRawTake(staged, reused, prevLine) {
  if (staged && !reused) {
    commitRawTake(staged);
    return staged.record;
  }
  if (staged) discardRawTake(staged);
  return reused && prevLine ? prevLine.rawTake : undefined;
}

/** The text a provider is sent for `line`: spoken form, delivery mark, engine tags. */
function engineText(line, pronounce, lv) {
  // A line with its own `lang` takes that language's built-in respellings.
  return forEngine(applyDeliveryMark(spokenText(line, pronounce, lv.voiceCfg, line.lang), lv.voiceCfg.delivery), lv.provider, lv.voiceCfg);
}

/** One provider.synth call in the line's voice. */
function synthOne(lv, { id, text, lang, outPath, reelDir, lineStart }) {
  return lv.provider.synth({
    id,
    text,
    voice: lv.voiceCfg.voiceId,
    lang,
    voiceCfg: lv.voiceCfg,
    params: { rate: lv.voiceCfg.rate },
    outPath,
    reelDir,
    lineStart,
  });
}

/**
 * synthBatch for every line whose provider has one, one call per resolved
 * voice (a batch carries one voiceCfg), in first-line order.
 * @returns {Promise<Map<string, object>>} line id -> synth result
 */
export async function synthBatches({ lines, lineVoice, pronounce, lang, dir, voiceDir }) {
  const groups = new Map();
  for (const line of lines) {
    const lv = lineVoice(line);
    if (typeof lv.provider.synthBatch !== "function") continue;
    // One batch per voice and language: a line with its own `lang` is sent apart,
    // with that language's code.
    const gLang = lineLang(line, lang);
    const gKey = `${lv.key}\u0000${gLang || ""}`;
    if (!groups.has(gKey)) groups.set(gKey, { lv, gLang, items: [] });
    groups.get(gKey).items.push({
      id: line.id,
      text: engineText(line, pronounce, lv),
      outPath: path.join(voiceDir, `line-${line.id}.wav`),
    });
  }
  const results = new Map();
  for (const { lv, gLang, items } of groups.values()) {
    const done = await withUsageLog(voiceDir, lv, items, () => lv.provider.synthBatch(items, { lang: gLang, voiceCfg: lv.voiceCfg, reelDir: dir }));
    for (const r of done) results.set(r.id, r);
  }
  return results;
}

const TTS_USAGE_FILE = "tts-usage.jsonl";

/**
 * Runs one synthesis request and appends a line to voice/tts-usage.jsonl for the cost report:
 * {ts, provider, model, voiceId, chars, audioSec, lineIds, cost}. `chars` is the text sent, `audioSec`
 * the audio that came back, `cost` what the provider reported (a result's `cost`) else null. No keys, no
 * request bodies. A failed request records nothing; a log that cannot be written is a note, never a stop.
 */
async function withUsageLog(voiceDir, lv, items, run) {
  const out = await run();
  try {
    const results = (Array.isArray(out) ? out : [out]).filter(Boolean);
    let audioSec = 0;
    for (const r of results) if (r.wavPath && fs.existsSync(r.wavPath)) audioSec += await probeDuration(r.wavPath);
    const costs = results.map((r) => r.cost).filter((c) => Number.isFinite(c));
    const entry = {
      ts: new Date().toISOString(),
      provider: lv.providerName,
      model: lv.voiceCfg.model ?? null,
      voiceId: lv.voiceCfg.voiceId ?? null,
      chars: items.reduce((sum, it) => sum + String(it.text).length, 0),
      audioSec: Math.round(audioSec * 1000) / 1000,
      lineIds: items.map((it) => it.id),
      cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    };
    ensureDir(voiceDir);
    fs.appendFileSync(path.join(voiceDir, TTS_USAGE_FILE), `${JSON.stringify(entry)}\n`);
  } catch (e) {
    process.stderr.write(`note: could not record TTS usage (${e.message})\n`);
  }
  return out;
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
    `voice refAudio is ${sec.toFixed(1)}s (${refPath}); a clone reference must be ` +
    `${REF_AUDIO_MIN_SEC}-${REF_AUDIO_MAX_SEC}s of clean speech. Supply a clip in that range.`
  );
}

function needsRetry(voiceFlag) {
  return voiceFlag === "MISHEARD" || voiceFlag === "SHORT" || voiceFlag === "TAIL" || voiceFlag === "HEAD";
}

/**
 * What sttTranscribe takes for one clip of `line`: the audio, its language, and the
 * target text and name respellings the second pass uses to find doubtful lines.
 * `id` defaults to the line's id (a take uses "<id>-<k>").
 */
function sttEntry(line, wav, { langCode, pronounce, id = line.id }) {
  return {
    id,
    wav,
    langCode,
    text: stripCaptionBreaks(line.text),
    say: line.say != null ? stripCaptionBreaks(line.say) : undefined,
    names: pronounceFolds(langCode, pronounce, line.pronounce),
  };
}

/**
 * Caption words timed from the engine's own word times (ElevenLabs). Batch providers time them from
 * the clip start before the line's tempo (speedUp); null when the engine reports none.
 * @returns {{words:{w:string,start:number,end:number}[], measured:number}|null}
 */
function providerWords(timedText, synthResult, lang, lineStart, speedUp = 1, leadTrimSec = 0) {
  if (!synthResult.words || !synthResult.words.length) return null;
  // synth() results are already on the narration timeline; wordsRelative ones are moved onto it.
  // The clip's edge trim (trimLineClip) removed `leadTrimSec` from its head, before the tempo.
  const speed = synthResult.wordsRelative ? speedUp : 1;
  const offset = synthResult.wordsRelative ? lineStart : 0;
  const words = speed === 1 && !leadTrimSec
    ? synthResult.words
    : synthResult.words.map((w) => ({ ...w, start: Math.max(0, w.start - leadTrimSec) / speed, end: Math.max(0, w.end - leadTrimSec) / speed }));
  const aligned = alignCaptionWords(timedText, words, { lang: sttLangCode(lang), offset });
  return aligned.words.length ? aligned : null;
}

/**
 * Compare `heard` against `line.text`/`line.say`, write `lineOut.stt`, and
 * update `lineOut.voiceFlag`: sets MISHEARD only on a gross mismatch, and
 * clears a MISHEARD left by an earlier check when this one passes. A HEAD or
 * TAIL flag is waveform evidence and is never cleared here: the transcript
 * says whether the words came out wrong, not whether the clip clicks or is
 * cut (references/voice.md). With `sttWords` (clip-relative) the caption
 * words take the heard times (alignCaptionWords), and `lineOut.wordsMeasured`
 * counts the words measured rather than interpolated. `pronounce` is the film's
 * pronunciation dictionary: a name spoken as its respelling is not an error.
 * `model` (optional) is recorded as `lineOut.stt.model`: the STT model the transcript came from.
 */
export function applySttResult(lineOut, line, heard, sttWords, langCode, pronounce = null, model = null) {
  const names = pronounceFolds(langCode, pronounce, line.pronounce);
  const timedText = stripCaptionBreaks(line.text);
  const timedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;
  if (sttWords && sttWords.length) {
    const aligned = alignCaptionWords(timedText, sttWords, { offset: lineOut.start, lang: langCode });
    if (aligned.words.length) {
      lineOut.words = aligned.words;
      lineOut.wordsMeasured = aligned.measured;
    }
  }
  const cmp = compareLine({ text: timedText, say: timedSay, heard, lang: langCode, names });
  const targetText = cmp.against === "say" ? timedSay : timedText;
  const gross = isGrossMismatch(targetText, heard, cmp.cer, langCode, names);
  const tailOk = tailCleared(targetText, heard, langCode, names);
  lineOut.stt = {
    advisory: true,
    target: targetText,
    against: cmp.against,
    heard,
    cer: cmp.cer,
    diffs: cmp.diffs,
    grossMismatch: gross,
    tailMatched: tailOk,
  };
  if (model) lineOut.stt.model = model;

  if (gross) {
    lineOut.voiceFlag = "MISHEARD";
  } else if (lineOut.voiceFlag === "MISHEARD") {
    delete lineOut.voiceFlag;
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
async function retryFlaggedLines({ flagged, lineResults, linesById, lineVoice, pronounce, lang: filmLang, langCode: filmLangCode, dir, paths, slots, providerTimed }) {
  for (const lineOut of flagged) {
    const line = linesById.get(lineOut.id);
    const slot = slots.get(lineOut.id);
    // A take that borrowed breath from the pause after it has no room for a different length.
    if (slot && lineOut.end - lineOut.start > slot.oldClipSec + SAME_LENGTH_SEC) continue;
    // a line with its own `lang` is re-made and re-checked in that language
    const lang = lineLang(line, filmLang);
    const langCode = line.lang ? sttLangCode(line.lang) : filmLangCode;
    const lv = lineVoice(line);
    const { provider, voiceCfg } = lv;
    const spoken = engineText(line, pronounce, lv);
    const timedText = stripCaptionBreaks(line.text);
    const timedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;
    const outPath = path.join(paths.voiceDir, `line-${lineOut.id}.wav`);
    const backupPath = outPath + ".prevbest.wav";
    fs.copyFileSync(outPath, backupPath);

    let synthResult;
    if (typeof provider.synthBatch === "function") {
      const items = [{ id: line.id, text: spoken, outPath }];
      const res = await withUsageLog(paths.voiceDir, lv, items, () => provider.synthBatch(items, { lang, voiceCfg, reelDir: dir }));
      synthResult = res.find((r) => r.id === line.id);
    } else {
      synthResult = await withUsageLog(paths.voiceDir, lv, [{ id: line.id, text: spoken }], () => synthOne(lv, { id: line.id, text: spoken, lang, outPath, reelDir: dir, lineStart: lineOut.start }));
    }

    const wavPath = synthResult.wavPath;
    const { leadTrimSec, staged } = await trimLineClip(paths, line.id, wavPath);
    await applyLineTempo(wavPath, line, voiceCfg, provider);
    if (voiceCfg.levelLines !== false) {
      process.stdout.write(formatLevelReport(line.id, await levelLineWav(wavPath)));
    }
    // A retry that does not fit the slot is not a candidate: the previous best stays and the later lines do not move.
    if (slots.has(line.id) && !(await fitRetake(line.id, wavPath, slots.get(line.id), { borrow: false })).ok) {
      discardRawTake(staged);
      fs.copyFileSync(backupPath, outPath);
      fs.rmSync(backupPath, { force: true });
      continue;
    }

    const newDur = await probeDuration(wavPath);
    const sttRes = await sttTranscribe(paths.voiceDir, [sttEntry(line, `line-${line.id}.wav`, { langCode, pronounce })], langCode);
    const newHeard = sttRes.results ? sttRes.results.get(line.id) || "" : "";
    const newCer = sttRes.results ? compareLine({ text: timedText, say: timedSay, heard: newHeard, lang: langCode, names: pronounceFolds(langCode, pronounce, line.pronounce) }).cer : Infinity;
    const oldCer = lineOut.stt ? lineOut.stt.cer : Infinity;

    const newClip = readLineClip(paths, line.id);
    const newFacts = newClip ? findClipDefects(newClip.samples, newClip.sampleRate) : null;
    if (keepsRetake({ newCer, oldCer, oldFlag: waveformFlag(lineOut.clipFacts), newFlag: waveformFlag(newFacts) })) {
      const delta = newDur - (lineOut.end - lineOut.start);
      lineOut.end = lineOut.start + newDur;
      const idx = lineResults.indexOf(lineOut);
      for (let i = idx + 1; i < lineResults.length; i++) shiftLine(lineResults[i], delta);
      const measured = providerWords(timedText, synthResult, lang, lineOut.start, tempoFactor(line, voiceCfg, provider), leadTrimSec);
      if (measured) providerTimed.add(line.id);
      else providerTimed.delete(line.id);
      lineOut.words = measured ? measured.words : wordsProportional(timedText, lineOut.start, lineOut.end);
      lineOut.wordsMeasured = measured ? measured.measured : 0;
      delete lineOut.voiceFlag;
      if (synthResult.flag && synthResult.flag !== "OK") lineOut.voiceFlag = synthResult.flag;
      delete lineOut.clipFacts;
      if (newFacts) lineOut.clipFacts = newFacts;
      reportClipDefects(lineOut, newFacts);
      applySttResult(lineOut, line, newHeard, measured ? null : sttRes.words.get(line.id), langCode, pronounce, sttRes.models && sttRes.models.get(line.id));
      commitRawTake(staged);
      lineOut.rawTake = staged.record;
      fs.rmSync(backupPath, { force: true });
    } else {
      discardRawTake(staged);
      fs.copyFileSync(backupPath, outPath);
      fs.rmSync(backupPath, { force: true });
    }
  }
}

/**
 * Whether a --retry-flagged take replaces the best one so far: never when it adds a waveform flag
 * (HEAD / TAIL) the old take did not have; else when its error rate is lower, or when it clears a
 * waveform flag at no worse an error rate.
 */
export function keepsRetake({ newCer, oldCer, oldFlag, newFlag }) {
  if (newFlag && !oldFlag) return false;
  return newCer < oldCer || (!!oldFlag && !newFlag && newCer <= oldCer);
}

/** Prints a compact `id | cer | flag | diffs` table for the checked lines. */
function printSttTable(checkedLines) {
  if (!checkedLines.length) return;
  process.stdout.write("stt check (advisory evidence, not a quality verdict; review before retrying):\n");
  process.stdout.write("id\tcer\tflag\tdiffs\n");
  for (const l of checkedLines) {
    const cerStr = l.stt ? l.stt.cer.toFixed(2) : "-";
    const flag = l.voiceFlag || "OK";
    const diffs = l.stt && l.stt.diffs && l.stt.diffs.length ? l.stt.diffs.map((d) => `${d.want}→${d.heard}`).join("; ") : "-";
    process.stdout.write(`${l.id}\t${cerStr}\t${flag}\t${diffs}\n`);
  }
}

/** timings.json written whole through a temp name, so an interrupted write never leaves half a file. */
function writeTimingsAtomic(file, timings) {
  const tmp = `${file}.${process.pid}-${process.hrtime.bigint()}.tmp`;
  writeJson(tmp, timings);
  fs.renameSync(tmp, file);
}

/** The timings lines `--stt-only` checks: the `--lines` ids, else every line. */
function sttOnlyLines(timingsLines, linesFlag) {
  if (linesFlag === undefined) return timingsLines;
  if (typeof linesFlag !== "string") throw new Error("--stt-only: --lines needs id,id");
  const wanted = linesFlag.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(timingsLines.map((l) => l.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`--stt-only: --lines references unknown line id(s): ${unknown.join(", ")}`);
  const set = new Set(wanted);
  return timingsLines.filter((l) => set.has(l.id));
}

/**
 * `--stt-only [--lines id,id]`: run the STT check against existing voice/line-*.wav
 * files without synthesizing anything — updates timings.json in place. Each line is
 * compared with plan.json's CURRENT text (the timings line's text only when the plan
 * no longer has the line). The model loads once per run; timings.json is saved as
 * soon as the first pass has results, so a run that stops midway keeps the lines it
 * finished and prints the ones left for a rerun.
 */
async function runSttOnly(dir, paths, flags = {}) {
  if (!fs.existsSync(paths.timingsJson)) {
    throw new Error(`--stt-only: no ${paths.timingsJson} — run a full voice.mjs pass first`);
  }
  const timings = readJson(paths.timingsJson);
  const pendingFile = path.join(paths.voiceDir, STT_PENDING_FILE);
  const pending = openSttPending(pendingFile, timings.lines || [], flags.lines);
  const lines = pending.resumed ? (timings.lines || []).filter((l) => pending.ids.has(l.id)) : sttOnlyLines(timings.lines || [], flags.lines);
  if (pending.resumed) process.stdout.write(`resuming an interrupted --stt-only: ${lines.length} line(s) left (delete ${pendingFile} to check every line)\n`);
  const missing = lines.filter((l) => !fs.existsSync(path.join(paths.voiceDir, `line-${l.id}.wav`)));
  if (missing.length) {
    throw new Error(`--stt-only: missing voice/line-<id>.wav for: ${missing.map((l) => l.id).join(", ")}`);
  }

  let plan = null;
  try {
    plan = loadPlan(dir);
  } catch {
    plan = null;
  }
  const planLines = new Map(((plan && plan.lines) || []).map((l) => [l.id, l]));
  const pronounce = plan && plan.meta ? plan.meta.pronounce : null;
  const langCode = sttLangCode(sttOnlyLang(timings, plan));
  process.stdout.write(`STT language: ${langCode}\n`);
  const targetOf = (l) => planLines.get(l.id) || l;
  const codeOf = (l) => {
    const own = targetOf(l).lang || l.lang;
    return own ? sttLangCode(own) : langCode;
  };
  const entries = lines.map((l) => sttEntry(targetOf(l), `line-${l.id}.wav`, { id: l.id, langCode: codeOf(l), pronounce }));

  const checked = new Set();
  const applied = new Map();
  const save = ({ results, words, models }) => {
    for (const lineOut of lines) {
      if (!results.has(lineOut.id)) continue;
      const heard = results.get(lineOut.id) || "";
      // Progress saves repeat finished lines; a line is applied again only when its transcript changed (second pass).
      if (applied.get(lineOut.id) === heard) continue;
      const engineTimed = ["elevenlabs", "typecast"].includes((lineOut.voice && lineOut.voice.provider) || timings.provider);
      applySttResult(lineOut, targetOf(lineOut), heard, sttOnlyWords(lineOut, engineTimed, words.get(lineOut.id)), codeOf(lineOut), pronounce, models && models.get(lineOut.id));
      applied.set(lineOut.id, heard);
      checked.add(lineOut.id);
    }
    writeTimingsAtomic(paths.timingsJson, timings);
    pending.done(checked);
  };
  const stt = await sttTranscribe(paths.voiceDir, entries, langCode, { allowPartial: true, onProgress: save });
  if (stt.skipped) {
    process.stdout.write(`STT check skipped: ${stt.skipped}\n`);
    return;
  }
  save(stt);
  printSttTable(lines.filter((l) => checked.has(l.id)));
  process.stdout.write(`wrote ${paths.timingsJson}\n`);
  if (stt.incomplete) reportUnchecked(stt, dir);
}

/**
 * The speech-to-text word times `--stt-only` may write into a line: only for a line whose words
 * were never measured (spread evenly). A line with engine-measured or already measured words
 * keeps them, so highlights and effects keyed to those words do not move on a check run.
 * @returns {object[]|null}
 */
export function sttOnlyWords(lineOut, engineTimed, sttWords) {
  if (engineTimed || lineOut.wordsMeasured > 0) return null;
  return sttWords || null;
}

const STT_PENDING_FILE = "stt-pending.json";

/**
 * The lines a `--stt-only` run has not checked yet, kept in voice/stt-pending.json so a run that
 * was killed resumes where it stopped. A run without `--lines` resumes from an existing file,
 * else starts one covering every line; a run with `--lines` only crosses its lines off an
 * existing file. The file is deleted when nothing is left.
 * @returns {{ids:Set<string>, resumed:boolean, done:(checked:Set<string>)=>void}}
 */
function openSttPending(file, timingsLines, linesFlag) {
  const known = new Set(timingsLines.map((l) => l.id));
  let ids = null;
  try {
    ids = new Set(JSON.parse(fs.readFileSync(file, "utf8")).ids.filter((id) => known.has(id)));
  } catch {
    ids = null;
  }
  const resumed = linesFlag === undefined && ids !== null && ids.size > 0;
  if (linesFlag === undefined && !resumed) ids = new Set(known);
  const write = () => {
    if (!ids || !ids.size) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids: [...ids] }), "utf8");
    fs.renameSync(tmp, file);
  };
  if (ids && !resumed) write();
  return {
    ids: ids || new Set(),
    resumed,
    done(checked) {
      if (!ids) return;
      for (const id of checked) ids.delete(id);
      write();
    },
  };
}

/** What an interrupted `--stt-only` did not reach, and the command that finishes it. */
function reportUnchecked(stt, dir) {
  process.stdout.write(`STT stopped early: ${stt.incomplete}\n`);
  process.stdout.write(`not checked: ${stt.missing.join(", ")} — rerun: voice.mjs ${dir} --stt-only --lines ${stt.missing.join(",")}\n`);
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

/** meta.voice with a line's own `voice` merged over it (line keys win). */
export function mergedVoice(meta, line) {
  const base = meta.voice || {};
  return line && line.voice ? { ...base, ...line.voice } : base;
}

/**
 * The voice one line is spoken in. `baseProvider` is --provider, else
 * meta.voice.provider, else the auto-chosen one; a line's own
 * voice.provider wins over it. The 9:16 default rate and the fish default
 * delivery are filled in from the merged voice, as for the whole film.
 * @returns {{providerName: string, voiceCfg: object, key: string}}
 *   key: one string per distinct resolved voice (provider + settings), for
 *   grouping batch synthesis; a typecast line with its own emotion has a key of its own.
 */
export function resolveLineVoice(meta, line, baseProvider, castVoice) {
  const defaults = castVoice ? Object.fromEntries(Object.entries(meta.voice || {}).filter(([key]) => !["provider", "voiceId", "refAudio", "refText", "refTokens", "model"].includes(key))) : meta.voice;
  const voice = castVoice ? { ...defaults, ...castVoice, ...(line.voice || {}) } : mergedVoice(meta, line);
  const providerName = castVoice?.provider || (line && line.voice && line.voice.provider) || baseProvider;
  const filmCfg = withFishConfidentDelivery(withShortsRate({ ...meta, voice }), meta, providerName);
  // Typecast sets emotion per request, so a line whose own `emotion` differs from the voice's
  // is made in its own request (key carries the line id), outside the one-read batch.
  const own = providerName === "typecast" && line && line.emotion && line.emotion !== (filmCfg.emotion || "normal");
  const voiceCfg = own ? { ...filmCfg, emotion: line.emotion } : filmCfg;
  return { providerName, voiceCfg, key: JSON.stringify(own ? [providerName, voiceCfg, line.id] : [providerName, voiceCfg]) };
}

/** Who spoke a line, as timings.json records it: {provider, voiceId?}. */
export function speakerOf(lineVoice) {
  const voiceId = lineVoice.voiceCfg && lineVoice.voiceCfg.voiceId;
  return voiceId != null ? { provider: lineVoice.providerName, voiceId } : { provider: lineVoice.providerName };
}

function speakerLabel(speaker) {
  return speaker.voiceId != null ? `${speaker.provider}/${speaker.voiceId}` : speaker.provider;
}

/**
 * One line naming each distinct voice in `timingsLines` (their `voice`
 * records) and the ids it spoke, in first-heard order.
 */
export function speakerSummary(timingsLines) {
  const groups = new Map();
  for (const l of timingsLines) {
    const label = l.voice ? speakerLabel(l.voice) : "?";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(l.id);
  }
  return `speakers: ${[...groups].map(([label, ids]) => `${label} (${ids.join(", ")})`).join(" | ")}`;
}

/** A line's speech speed as heard: its own rate, else its voice's rate (9:16 default included), else 1. */
export function lineSpeed(meta, line) {
  return line.rate || withShortsRate({ ...meta, voice: mergedVoice(meta, line) }).rate || 1;
}

/**
 * Every plan line's resolved voice with its provider module loaded, keyed by
 * line id. Each provider module is imported once.
 * @param {(name: string) => Promise<object>} loadProvider
 * @returns {Promise<Map<string, {providerName, provider, voiceCfg, key}>>}
 */
export async function buildLineVoices(plan, baseProvider, loadProvider, castVoices = new Map()) {
  const modules = new Map();
  const out = new Map();
  for (const line of plan.lines) {
    const v = resolveLineVoice(plan.meta, line, baseProvider, castVoices.get(line.id));
    if (!PROVIDERS.includes(v.providerName)) {
      throw new Error(`line "${line.id}": unknown provider "${v.providerName}", expected one of: ${PROVIDERS.join(", ")}`);
    }
    if (!modules.has(v.providerName)) modules.set(v.providerName, await loadProvider(v.providerName));
    out.set(line.id, { ...v, provider: modules.get(v.providerName) });
  }
  return out;
}

/** The voice of `line`: its entry in `lineVoices`, else the film-wide `fallback`. */
function voiceOf(lineVoices, line, fallback) {
  return (lineVoices && lineVoices.get(line.id)) || fallback;
}

/**
 * Where a tone picked for `lineId` is written so the rest of that speaker's
 * lines are made in it: meta.voice.delivery when the line speaks in the
 * film-wide voice, else the `voice.delivery` of every line of its speaker.
 * Lines of other speakers that would inherit a new meta.voice.delivery keep
 * the delivery they had. Mutates `plan`.
 * @returns {string} where it was written, for the run's message
 */
export function writePickedTone(plan, lineId, mark, lineVoices, baseProvider) {
  const speaker = (id) => speakerLabel(speakerOf(lineVoices.get(id)));
  const baseSpeaker = speakerLabel(speakerOf(resolveLineVoice(plan.meta, null, baseProvider)));
  const picked = speaker(lineId);
  if (picked === baseSpeaker) {
    for (const line of plan.lines) {
      if (speaker(line.id) === baseSpeaker || (line.voice && line.voice.delivery != null)) continue;
      line.voice = { ...(line.voice || {}), delivery: lineVoices.get(line.id).voiceCfg.delivery ?? "none" };
    }
    plan.meta.voice = { ...(plan.meta.voice || {}), delivery: mark };
    return "meta.voice.delivery";
  }
  const ids = plan.lines.filter((l) => speaker(l.id) === picked).map((l) => l.id);
  for (const line of plan.lines) {
    if (ids.includes(line.id)) line.voice = { ...(line.voice || {}), delivery: mark };
  }
  return `voice.delivery of line(s) ${ids.join(", ")}`;
}

// A line's own `rate` (0.5–2) replaces meta.voice.rate for that line, for a
// deliberately rushed or slowed run of lines; it is always applied with
// atempo. meta.voice.rate goes through atempo only for providers without
// native speed control (`export const nativeRate = true`).
const LINE_RATE_RANGE = { min: 0.5, max: 2 };

/** How much faster than synthesized a line plays after its atempo (1 = unchanged). */
function tempoFactor(line, voiceCfg, provider) {
  const tempo = lineTempo(line, voiceCfg, provider);
  return tempo ? tempo.factor : 1;
}

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

// A regenerated base-language line keeps its old slot (the picture does not move), fitted in the
// order dub.mjs fits a language: trim, speed up by at most 10%, keep at least 0.5 s of breath, a
// voice-free gap of at most 1.0 s, otherwise the voice is made again (planRetakeFit). A take that
// still needs more speed than that is refused; nothing shifts the lines after it.

/** A name that is unique per call (µs clock + pid), for files a run leaves beside a clip. */
function uniqueSuffix() {
  return `${process.pid}-${process.hrtime.bigint()}`;
}

/**
 * Fit the re-made take at `wavPath` into `slot` in place and print how it compares with the slot and
 * with the take it replaces. The clip ends at the old clip's length (padded, sped up or slowed), so the
 * next line does not move; with `borrow` a take that needs some of the breath after it may stay longer
 * and the caller shortens the gap after it by the same amount.
 * @returns {Promise<{ok:boolean, fit:object}>} ok false = refused, the file is untouched
 */
export async function fitRetake(id, wavPath, slot, { borrow }) {
  const dur = await probeDuration(wavPath);
  const fit = planRetakeFit(dur, slot);
  process.stdout.write(retakeFitMessage(id, dur, slot, fit) + "\n");
  if (!fit.ok) return { ok: false, fit };
  const fillsOld = fit.actualDurationSec <= slot.oldClipSec + SAME_LENGTH_SEC;
  if (!fillsOld && !borrow) {
    process.stdout.write(`${id}: this take needs breath that the line before it keeps — not installed\n`);
    return { ok: false, fit };
  }
  const tempo = Math.abs(fit.atempoFactor - 1) > 1e-4;
  const slotSamples = Math.round(slot.oldClipSec * FIT_SAMPLE_RATE);
  if (!tempo && fillsOld && readWav(wavPath).samples.length === slotSamples) return { ok: true, fit };
  const prefitPath = `${wavPath}.prefit-${uniqueSuffix()}.wav`;
  fs.renameSync(wavPath, prefitPath);
  const filters = [...(tempo ? [`atempo=${fit.atempoFactor.toFixed(4)}`] : []), ...(fillsOld ? slotLengthFilters(slotSamples) : [])].join(",");
  await ffmpeg(["-y", "-i", prefitPath, ...(filters ? ["-filter:a", filters] : []), "-ar", String(FIT_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
  fs.rmSync(prefitPath, { force: true });
  return { ok: true, fit };
}

const FIT_SAMPLE_RATE = 48000;

/** ffmpeg filters that pad or trim a clip to exactly `samples` samples, so the next line does not move. */
export function slotLengthFilters(samples) {
  return [`apad=whole_len=${samples}`, `atrim=end_sample=${samples}`];
}

/** An install that is not fitted (--retime, dub folder) says how long the take is against the slot it has on the picture. */
function reportRetimeRatio(id, takeSec, pictureSlots, dir) {
  const slot = pictureSlots.get(id);
  if (!slot || !(slot > 0)) return;
  const reason = dubCode(dir) ? "dub folder: dub.mjs fits it to the picture" : "--retime";
  process.stdout.write(retimeRatioMessage(id, takeSec, slot, reason) + "\n");
}

/** timings start moves under this (s) are rounding, not a shifted line. */
const MOVED_TOLERANCE_SEC = 0.001;

/** Seconds of silence a plan line asks for before it (`pauseBeforeMs`, ms). */
function pauseBeforeSec(line) {
  return line && line.pauseBeforeMs > 0 ? line.pauseBeforeMs / 1000 : 0;
}

/**
 * Plan lines with the next line's `pauseBeforeMs` added to each line's pause after it, so the silence
 * gate lists that stretch as planned, not as dead air.
 */
export function foldPauseBefore(planLines, gapMs) {
  return planLines.map((l, i) => {
    const next = planLines[i + 1];
    return next && next.pauseBeforeMs > 0 ? { ...l, pauseAfterMs: (l.pauseAfterMs ?? gapMs) + next.pauseBeforeMs } : l;
  });
}

/**
 * previousSlots with the pause recorded before the next line (timings `pauseBeforeSec`) taken out: the
 * pause belongs to the next line, so a re-take is not charged for it and does not borrow it.
 */
export function slotsWithoutPauseBefore(prevLines, planLines, gapMs) {
  const slots = previousSlots(prevLines, planLines, gapMs);
  prevLines.forEach((l, i) => {
    const before = (prevLines[i + 1] && prevLines[i + 1].pauseBeforeSec) || 0;
    if (before > 0) slots.get(l.id).slotSec -= before;
  });
  return slots;
}

/**
 * Puts the current clip of every line being re-made aside as voice/line-<id>.wav.old-<unique>.wav,
 * before any provider writes (a batch provider writes in place). Only lines with a slot to keep.
 * @returns {Map<string, {slot: object, backup: string}>}
 */
function backUpOldClips({ lines, paths, onlySet, keepTiming, previousById, oldSlots }) {
  const clips = new Map();
  if (!keepTiming || !onlySet) return clips;
  for (const line of lines) {
    const clipPath = installedClipPath(paths, line.id);
    const slot = oldSlots.get(line.id);
    if (!onlySet.has(line.id) || !previousById.has(line.id) || !slot || !fs.existsSync(clipPath)) continue;
    const backup = `${clipPath}.old-${uniqueSuffix()}.wav`;
    fs.copyFileSync(clipPath, backup);
    clips.set(line.id, { slot, backup });
  }
  return clips;
}

/** Puts the clips of backUpOldClips back (a run that stopped before it could judge the new takes). */
function restoreOldClips(paths, clips) {
  for (const [id, { backup }] of clips) fs.renameSync(backup, installedClipPath(paths, id));
}

/** A refused re-take: the take is kept at voice/takes/<id>/refused-<stamp>.wav and the old clip is put back. */
function refuseRetake(paths, id, wavPath, oldClipBackup) {
  const keepDir = path.join(paths.voiceDir, "takes", id);
  ensureDir(keepDir);
  const kept = path.join(keepDir, `refused-${uniqueSuffix()}.wav`);
  fs.renameSync(wavPath, kept);
  fs.renameSync(oldClipBackup, wavPath);
  process.stdout.write(`${id}: kept the refused take at ${kept}; the old clip is back\n`);
}

/** Ends a run that refused re-takes: the others are installed, this one step failed. */
function failIfRefused(result) {
  if (result.refused && result.refused.length) fail(`${result.refused.length} line(s) not installed, their take runs over the slot: ${result.refused.join(", ")}`);
}

/** The error rate of each new take next to the take it replaces (a judgement for the reader, not a stop). */
function reportAgainstExisting(freshLines, previousById) {
  for (const l of freshLines) {
    const before = previousById.get(l.id);
    if (!before || !before.stt || typeof before.stt.cer !== "number" || !l.stt) continue;
    const delta = l.stt.cer - before.stt.cer;
    const verdict = Math.abs(delta) < 0.005 ? "about the same" : delta < 0 ? "better" : "worse";
    process.stdout.write(`${l.id}: STT error rate ${before.stt.cer.toFixed(2)} (existing take) -> ${l.stt.cer.toFixed(2)} (new take): ${verdict}\n`);
  }
}

/**
 * What freshly made lines' own waveform and level say (HEAD, TAIL, EDGE, DIP, PAUSE), stored as
 * `clipFacts` and printed. HEAD and TAIL set the line's voiceFlag (when it has none) and print a
 * WARN: the speech-to-text check cannot see a click or a cut. Never stops the run.
 */
async function inspectMadeLines(paths, freshLines) {
  for (const lineOut of freshLines) {
    const clip = readLineClip(paths, lineOut.id);
    if (!clip) continue;
    const found = findClipDefects(clip.samples, clip.sampleRate);
    if (found) lineOut.clipFacts = found; // timings.json keeps them for review.mjs
    reportClipDefects(lineOut, found);
  }
}

function reportClipDefects(lineOut, found) {
  const defects = describeDefects(found);
  if (!defects.length) return;
  const flag = waveformFlag(found);
  if (!flag) {
    process.stdout.write(`line "${lineOut.id}": ${defects.join("; ")} — facts the STT check cannot hear; listen before keeping\n`);
    return;
  }
  if (!lineOut.voiceFlag) lineOut.voiceFlag = flag;
  process.stdout.write(`WARN line "${lineOut.id}": ${flag} — ${defects.join("; ")} — waveform evidence, no transcript clears it; re-make it: voice.mjs <reel> --lines ${lineOut.id} (or --retry-flagged N)\n`);
}

/** N16: caption words after a pause start where their sound begins, on freshly made lines. */
function snapMadeLines(paths, freshLines) {
  for (const lineOut of freshLines) {
    const clip = readLineClip(paths, lineOut.id);
    if (clip) snapLineWords(lineOut, clip);
  }
}

/**
 * `--raw-status [--lines id,id]`: whether voice/raw/<id>.wav is the take each installed clip was
 * made from (timings.json `rawTake`). Report only; exit code 1 when a raw take is stale or missing,
 * so a script that rebuilds clips from voice/raw can stop before it builds the wrong audio.
 */
function runRawStatus(paths, flags = {}) {
  if (!fs.existsSync(paths.timingsJson)) throw new Error(`--raw-status: no ${paths.timingsJson} — run a full voice.mjs pass first`);
  const lines = sttOnlyLines(readJson(paths.timingsJson).lines || [], flags.lines);
  const problems = rawTakeProblems(paths.voiceDir, lines);
  process.stdout.write(`raw takes: ${lines.length - problems.length} of ${lines.length} line(s) current\n`);
  const warning = rawTakeWarning(problems);
  if (warning) process.stdout.write(`${warning}\n`);
  if (problems.some((p) => p.status !== "unrecorded")) process.exitCode = 1;
}

/** A line's text ends with a question mark (any script), closing quotes or brackets aside. */
const ENDS_WITH_QUESTION = /[?？¿؟]["”’')\]」』»\s]*$/u;

/**
 * `--pitch [--lines id,id] [--words]`: where the pitch goes in each installed line — report only.
 * Per line: voiced share, median pitch, range, and the end contour (rise / fall / level, in semitones,
 * against the voiced stretch before it); with --words each word's shape (rising, falling, level, dipping,
 * peaking, unvoiced). A line whose text ends in a question mark is marked with its measured end contour.
 * Writes out/pitch.json (every line and word). It measures; whether a contour is right for the
 * language is the reader's judgement (PITCH_LIMITS).
 */
function runPitchReport(dir, paths, flags) {
  if (!fs.existsSync(paths.timingsJson)) throw new Error(`--pitch: no ${paths.timingsJson} — run a full voice.mjs pass first`);
  const timings = readJson(paths.timingsJson);
  const wanted = typeof flags.lines === "string" ? new Set(flags.lines.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const lines = (timings.lines || []).filter((l) => !wanted || wanted.has(l.id));
  const unknown = wanted ? [...wanted].filter((id) => !lines.some((l) => l.id === id)) : [];
  if (unknown.length) throw new Error(`--pitch: unknown line id(s): ${unknown.join(", ")}`);
  const rows = [];
  for (const l of lines) {
    const clip = readLineClip(paths, l.id);
    if (!clip) {
      process.stdout.write(`${l.id}: no readable voice/line-${l.id}.wav — skipped\n`);
      continue;
    }
    const track = pitchTrack(clip.samples, clip.sampleRate);
    const words = (l.words || []).filter((w) => typeof w.start === "number" && typeof w.end === "number").map((w) => ({ w: w.w, start: w.start - l.start, end: w.end - l.start }));
    rows.push({ id: l.id, text: l.text, question: ENDS_WITH_QUESTION.test(l.text || ""), ...pitchSummary(track), end: endContour(track), words: wordContours(track, words) });
  }
  printPitchReport(rows, !!flags.words);
  const outDir = path.join(dir, "out");
  ensureDir(outDir);
  writeJson(path.join(outDir, "pitch.json"), { limits: PITCH_LIMITS, lines: rows });
  process.stdout.write(`wrote ${path.join(outDir, "pitch.json")}\n${PITCH_LIMITS}\n`);
}

function printPitchReport(rows, showWords) {
  process.stdout.write("pitch (measured; not a verdict):\nid\tvoiced\tmedian\trange\tend\tquestion\n");
  for (const r of rows) {
    const end = r.end ? `${r.end.direction} ${r.end.deltaSemitones > 0 ? "+" : ""}${r.end.deltaSemitones} st` : "-";
    const median = r.medianHz == null ? "-" : `${r.medianHz} Hz`;
    const range = r.rangeSemitones == null ? "-" : `${r.rangeSemitones} st`;
    process.stdout.write(`${r.id}\t${Math.round(r.voicedShare * 100)}%\t${median}\t${range}\t${end}\t${r.question ? "?" : "-"}\n`);
    if (showWords) process.stdout.write(`  ${r.words.map((w) => `${w.w}:${w.shape}`).join(" ")}\n`);
  }
  for (const r of rows.filter((x) => x.question)) {
    process.stdout.write(`${r.id}: the text ends with a question mark; measured end contour: ${r.end ? `${r.end.direction} (${r.end.deltaSemitones} st)` : "not measurable"} — for a language that marks questions with a rise, listen to it\n`);
  }
}

/** voice/line-<id>.wav as {samples, sampleRate}, or null when it cannot be read. */
function readLineClip(paths, id) {
  try {
    return readWav(path.join(paths.voiceDir, `line-${id}.wav`));
  } catch {
    return null;
  }
}

/**
 * N16: moves each measured word that follows a pause to where its sound begins (snapStartsToSound).
 * Words that were only spread evenly (wordsMeasured 0) stay.
 */
function snapLineWords(lineOut, clip) {
  if (!(lineOut.wordsMeasured > 0) || !lineOut.words || !lineOut.words.length) return;
  const snapped = snapStartsToSound(lineOut.words, clip.samples, clip.sampleRate, lineOut.start);
  if (!snapped.moved.length) return;
  lineOut.words = snapped.words;
  const first = snapped.moved[0];
  process.stdout.write(`line "${lineOut.id}": ${snapped.moved.length} word start(s) after a pause moved to where the sound begins (first: "${first.w}" ${first.from.toFixed(3)} -> ${first.to.toFixed(3)} s)\n`);
}

/** plan.json's meta, or {} when the plan is missing or unreadable. */
function readPlanMeta(planPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath, "utf8")).meta || {};
  } catch {
    return {};
  }
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
 * table (references/voice.md "Comparing takes"). Installed clips, timings.json
 * and narration.wav stay untouched; install with --pick (or --pick-by). A line
 * with no installed clip yet gets take 1 so the reel is complete.
 */
export async function synthesizeTakes({ dir, paths, plan, lineIds, spec, provider, providerName, voiceCfg, lineVoices = null, pronounce, lang, gapMs, tailSec, sttEnabled, keepTiming, pickBy = null }) {
  const filmVoice = { provider, providerName, voiceCfg, key: "" };
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
    const lv = voiceOf(lineVoices, line, filmVoice);
    const base = spokenText(line, pronounce, lv.voiceCfg, line.lang);
    const takeLang = lineLang(line, lang);
    const takeCode = sttLangCode(takeLang);
    const strippedText = stripCaptionBreaks(line.text);
    const strippedSay = line.say != null ? stripCaptionBreaks(line.say) : line.say;

    for (let k = 1; k <= count; k++) {
      const mark = spec.mode === "tone" ? spec.marks[k - 1] : null;
      const withMark = mark ? withForcedTone(base, mark) : applyDeliveryMark(base, lv.voiceCfg.delivery);
      const spoken = forEngine(withMark, lv.provider, lv.voiceCfg);
      const outPath = path.join(takesDir, `${id}-${k}.wav`);

      const items = [{ id, text: spoken, outPath }];
      const synthResult = typeof lv.provider.synthBatch === "function"
        ? (await withUsageLog(paths.voiceDir, lv, items, () => lv.provider.synthBatch(items, { lang: takeLang, voiceCfg: lv.voiceCfg, reelDir: dir }))).find((r) => r.id === id)
        : await withUsageLog(paths.voiceDir, lv, items, () => synthOne(lv, { id, text: spoken, lang: takeLang, outPath, reelDir: dir, lineStart: 0 }));
      if (!synthResult) throw new Error(`voice provider "${lv.providerName}" returned no result for take ${id}-${k}`);
      const durationSec = await probeDuration(synthResult.wavPath);

      let cerVal = null;
      let cerSkipped = null;
      if (sttEnabled) {
        const sttId = `${id}-${k}`;
        // On the same leveling an installed clip gets: a take's raw loudness would reorder the ranking.
        const entry = sttEntry(line, `takes/${id}-${k}.wav`, { id: sttId, langCode: takeCode, pronounce });
        const sttRes = await sttTranscribeLeveled(paths.voiceDir, [entry], takeCode, { level: lv.voiceCfg.levelLines !== false });
        if (sttRes.skipped) {
          cerSkipped = sttRes.skipped;
        } else {
          const heard = sttRes.results.get(sttId) || "";
          cerVal = compareLine({ text: strippedText, say: strippedSay, heard, lang: takeCode, names: entry.names }).cer;
        }
      }
      rows.push({ id, k, mark, durationSec, lengthSec: installedLength(durationSec, line, lv.voiceCfg, lv.provider), cer: cerVal, cerSkipped });
    }

    manifest[id] = spec.mode === "tone" ? { mode: "tone", marks: spec.marks } : { mode: "count", n: spec.n };
  }

  saveTakesManifest(paths, manifest);
  await addTakeFacts(rows, { paths, plan, lineVoices, filmVoice, keepSlots: keepTiming, withInstalled: !!pickBy, gapMs });
  const picked = pickBy ? pickTakes(rows, lineIds, pickBy) : new Map(lineIds.map((id) => [id, 1]));
  printTakesTable(rows, pickBy ? picked : null);

  // Without --pick-by, takes only compare; a line with no installed clip yet
  // still gets take 1 so the reel is complete.
  const wanted = pickBy ? lineIds : lineIds.filter((id) => !fs.existsSync(installedClipPath(paths, id)));
  const installIds = wanted.filter((id) => picked.get(id) > 0);
  reportPickOutcome(lineIds, picked);
  if (!installIds.length) {
    if (!pickBy) process.stdout.write("installed clips unchanged — install one with --pick <id>=<k>\n");
    return { rows, picked, timings: null };
  }
  keepInstalledClips(paths, installIds);
  const takeWavs = new Map(installIds.map((id) => [id, path.join(takesDir, `${id}-${picked.get(id)}.wav`)]));
  const result = await synthesizeAll({
    dir,
    paths,
    lines: plan.lines,
    provider,
    providerName,
    voiceCfg,
    lineVoices,
    pronounce,
    lang,
    gapMs,
    tailSec,
    onlyLineIds: installIds,
    sttEnabled,
    retryFlagged: 0,
    keepTiming,
    takeWavs,
  });
  writeJson(paths.timingsJson, result.timings);
  const installed = installIds.filter((id) => !result.refused.includes(id));
  process.stdout.write(`installed take(s): ${installed.map((id) => `${id}=${picked.get(id)}`).join(", ")}\n`);
  const kept = lineIds.filter((id) => !installIds.includes(id));
  if (kept.length) process.stdout.write(`installed clips unchanged: ${kept.join(", ")} — install one with --pick <id>=<k>\n`);
  process.stdout.write(partialRebuildNote(dir, result.moved));
  failIfRefused({ refused: result.refused });
  return { rows, picked, timings: result.timings };
}

/** voice/line-<id>.wav, the clip the reel plays for a line. */
function installedClipPath(paths, id) {
  return path.join(paths.voiceDir, `line-${id}.wav`);
}

/**
 * Before an install replaces voice/line-<id>.wav, keeps the current clip once
 * as voice/takes/<id>/installed-<timestamp>.wav so it can be restored with
 * --use <id>=<that file>. Prints where each one went.
 */
function keepInstalledClips(paths, ids) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (const id of ids) {
    const src = installedClipPath(paths, id);
    if (!fs.existsSync(src)) continue;
    const keepDir = path.join(paths.voiceDir, "takes", id);
    ensureDir(keepDir);
    const dest = path.join(keepDir, `installed-${stamp}.wav`);
    fs.copyFileSync(src, dest);
    process.stdout.write(`kept previous ${id} clip: ${dest}\n`);
  }
}

/** A raw take's length once the line's tempo is applied on install. */
function installedLength(durationSec, line, voiceCfg, provider) {
  const tempo = lineTempo(line, voiceCfg, provider);
  return tempo && tempo.factor ? durationSec / tempo.factor : durationSec;
}

/**
 * `--pick-by`: the chosen take number per line id; 0 = keep the installed clip (it scored as well or
 * better, no take fits its slot, or no take could be checked: the facts are printed). A take that could
 * not be measured is never chosen.
 */
function pickTakes(rows, lineIds, pickBy) {
  return new Map(lineIds.map((id) => {
    const mine = rows.filter((r) => r.id === id);
    for (const r of mine.filter((x) => x.unchecked)) {
      process.stdout.write(`${id}: take ${r.installed ? "installed" : r.k} unchecked (${r.unchecked}) — not chosen\n`);
    }
    const usable = mine.filter((r) => !r.unchecked);
    if (!usable.length) return [id, 0];
    try {
      return [id, chooseTake(usable, pickBy)];
    } catch (e) {
      if (e.code !== "NO_FIT") throw e;
      process.stdout.write(`${e.message}; the installed clip stays\n`);
      return [id, 0];
    }
  }));
}

/** Says, per line, when --pick-by keeps the installed clip instead of installing a take. */
function reportPickOutcome(lineIds, picked) {
  const kept = lineIds.filter((id) => picked.get(id) === 0);
  if (kept.length) process.stdout.write(`installed clip kept (no take beats it or fits): ${kept.join(", ")}\n`);
}

/** The length of a take once trimmed to its voiced span and pads, the clip an install would make. */
async function trimmedTakeSec(wavPath) {
  const range = voicedSpanWithPads(await measureEdgeEnvelope(wavPath), await probeDuration(wavPath));
  return range.trimmedEndSec - range.trimmedStartSec;
}

/** The row of the take a line has installed now (k = 0): its length and error rate from timings.json. */
function installedRow(paths, id, prev) {
  const wavPath = installedClipPath(paths, id);
  if (!prev || !fs.existsSync(wavPath)) return null;
  const lengthSec = prev.end - prev.start;
  const cer = prev.stt && typeof prev.stt.cer === "number" ? prev.stt.cer : null;
  return { id, k: 0, installed: true, mark: null, durationSec: lengthSec, lengthSec, cer, wavPath };
}

/**
 * Facts on each take row, from its own audio: the length it would have once trimmed, how it fits the
 * line's slot (a take that runs over is never chosen), the pitch at its end and the defects the STT check
 * cannot hear. With `withInstalled` the line's installed take joins as row k = 0, so a pick compares
 * with it. Rows stay plain data for printTakesTable and chooseTake.
 */
async function addTakeFacts(rows, { paths, plan, lineVoices, filmVoice, keepSlots, withInstalled, gapMs }) {
  const prevLines = fs.existsSync(paths.timingsJson) ? readJson(paths.timingsJson).lines || [] : [];
  const prevById = new Map(prevLines.map((l) => [l.id, l]));
  const slots = slotsWithoutPauseBefore(prevLines, plan.lines, gapMs);
  const linesById = new Map(plan.lines.map((l) => [l.id, l]));
  if (withInstalled) {
    for (const id of new Set(rows.map((r) => r.id))) {
      const row = installedRow(paths, id, prevById.get(id));
      if (row) rows.push(row);
    }
  }
  for (const r of rows) {
    const wavPath = r.wavPath || path.join(paths.voiceDir, "takes", `${r.id}-${r.k}.wav`);
    let clip;
    try {
      clip = readWav(wavPath);
    } catch (e) {
      // Not read, so not measured: it cannot pass as one that fits (pickTakes leaves it out).
      r.unchecked = `unreadable: ${e.message}`;
      continue;
    }
    const line = linesById.get(r.id);
    const lv = voiceOf(lineVoices, line, filmVoice);
    if (!r.installed) {
      // Both sides of a length comparison are the clip an install would make: trimmed, tempo applied.
      try {
        r.lengthSec = installedLength(await trimmedTakeSec(wavPath), line, lv.voiceCfg, lv.provider);
      } catch (e) {
        r.unchecked = `length not measured: ${e.message}`;
        continue;
      }
    }
    if (!r.installed && keepSlots && slots.has(r.id) && prevById.has(r.id)) {
      r.fitSec = r.lengthSec;
      r.fit = planRetakeFit(r.fitSec, slots.get(r.id));
      r.fits = r.fit.ok;
      if (!r.fit.ok) r.needs = r.fit.requiredFactor;
    }
    const end = endContour(pitchTrack(clip.samples, clip.sampleRate));
    r.end = end ? `${end.direction} ${end.deltaSemitones > 0 ? "+" : ""}${end.deltaSemitones} st` : null;
    r.defects = defectCodes(findClipDefects(clip.samples, clip.sampleRate));
  }
}

/**
 * Prints a compact `id | take | tone | cer | duration | length` comparison
 * table; `picked` (id -> k) marks the takes --pick-by chose.
 */
export function printTakesTable(rows, picked = null) {
  if (!rows.length) return;
  // Columns of facts measured on the audio appear only when some take has one.
  const extra = [
    ["end", rows.some((r) => r.end), (r) => r.end || "-"],
    ["slot", rows.some((r) => r.fit), (r) => (r.installed ? "-" : fitColumn(r.fit))],
    ["defects", rows.some((r) => r.defects && r.defects.length), (r) => (r.defects && r.defects.length ? r.defects.join(",") : "-")],
  ].filter(([, shown]) => shown);
  process.stdout.write("takes:\n");
  process.stdout.write(`id\ttake\ttone\tcer\tduration\tlength${extra.map(([name]) => `\t${name}`).join("")}${picked ? "\tpicked" : ""}\n`);
  for (const r of rows) {
    const cerStr = r.cer == null ? "-" : r.cer.toFixed(2);
    const lengthStr = r.lengthSec == null ? "-" : `${r.lengthSec.toFixed(3)}s`;
    const mark = picked ? (picked.get(r.id) === r.k ? "\t<-" : "\t") : "";
    const facts = extra.map(([, , cell]) => `\t${cell(r)}`).join("");
    process.stdout.write(`${r.id}\t${r.installed ? "installed" : r.k}\t${r.mark || "-"}\t${cerStr}\t${r.durationSec.toFixed(3)}s\t${lengthStr}${facts}${mark}\n`);
  }
  for (const why of new Set(rows.map((r) => r.cerSkipped).filter(Boolean))) {
    process.stdout.write(`cer "-": STT check skipped — ${why}\n`);
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
 * `--use id=<wav>,id=<wav>` → [{id, file}]. The file is split at the first
 * "=" only, so a path may itself contain "=".
 */
export function parseUse(useStr) {
  return String(useStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf("=");
      const id = at > 0 ? pair.slice(0, at).trim() : "";
      const file = at > 0 ? pair.slice(at + 1).trim() : "";
      if (!id || !file) throw new Error(`--use: invalid entry "${pair}" (expected id=<path to .wav>)`);
      return { id, file };
    });
}

/**
 * `--use id=<wav>`: installs finished line audio made elsewhere — another
 * reel's voice/line-<id>.wav, a take from a comparison folder, a recording —
 * without re-synthesis. The file is taken as final: no tempo is applied
 * again (a --takes take is raw and gets the film's speed on --pick; a
 * finished line already has it). It is still leveled and STT-checked, and
 * narration.wav/timings.json are rebuilt as --lines does.
 */
async function runUse({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, lineVoices = null, gapMs, tailSec, sttEnabled }) {
  const uses = parseUse(flags.use).map((u) => ({ ...u, file: path.resolve(u.file) }));
  const known = new Set(plan.lines.map((l) => l.id));
  const unknown = uses.filter((u) => !known.has(u.id));
  if (unknown.length) throw new Error(`--use: unknown line id(s): ${unknown.map((u) => u.id).join(", ")}`);
  const missing = uses.filter((u) => !fs.existsSync(u.file));
  if (missing.length) throw new Error(`--use: file(s) not found: ${missing.map((u) => u.file).join(", ")}`);
  keepInstalledClips(paths, uses.map((u) => u.id));
  const result = await synthesizeAll({
    dir,
    paths,
    lines: plan.lines,
    provider: providerMod,
    providerName,
    voiceCfg,
    lineVoices,
    pronounce: plan.meta.pronounce,
    lang: plan.meta.lang || "ko-KR",
    gapMs,
    tailSec,
    onlyLineIds: uses.map((u) => u.id),
    sttEnabled,
    retryFlagged: 0,
    keepTiming: keepOldSlots(dir, flags),
    takeWavs: new Map(uses.map((u) => [u.id, u.file])),
    finishedIds: new Set(uses.map((u) => u.id)),
  });
  writeJson(paths.timingsJson, result.timings);
  process.stdout.write(`installed finished audio: ${uses.filter((u) => !result.refused.includes(u.id)).map((u) => `${u.id} <- ${u.file}`).join(", ")}\n`);
  process.stdout.write(partialRebuildNote(dir, result.moved));
  failIfRefused(result);
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
async function runPick({ dir, paths, plan, flags, providerMod, providerName, voiceCfg, lineVoices = null, gapMs, tailSec, sttEnabled }) {
  await installPicks({ dir, paths, plan, flags, picks: parsePick(flags.pick), providerMod, providerName, voiceCfg, lineVoices, gapMs, tailSec, sttEnabled });
}

/**
 * `--pick-by length:<sec>|stt` without --takes: measures the takes already
 * in voice/takes/ for each line (duration from disk; CER by transcribing
 * them for `stt`), prints the table with the chosen take marked, and
 * installs the chosen takes as --pick does.
 */
async function runPickBy({ dir, paths, plan, flags, pickBy, lineIds, providerMod, providerName, voiceCfg, lineVoices = null, gapMs, tailSec, sttEnabled }) {
  const manifest = loadTakesManifest(paths);
  const ids = lineIds && lineIds.length ? lineIds : Object.keys(manifest);
  if (!ids.length) throw new Error("--pick-by: no takes to choose from — run --takes first, or name the lines with --lines");
  if (pickBy.by === "stt" && !sttEnabled) throw new Error("--pick-by stt needs the STT check (drop --no-stt)");
  const linesById = new Map(plan.lines.map((l) => [l.id, l]));
  const langCode = sttLangCode(plan.meta.lang || "ko-KR");
  const rows = [];
  for (const id of ids) {
    const line = linesById.get(id);
    if (!line) throw new Error(`--pick-by: unknown line id "${id}"`);
    const found = listTakeFiles(paths, id);
    if (!found.length) throw new Error(`--pick-by: no takes for "${id}" in ${path.join(paths.voiceDir, "takes")} — run --takes first`);
    const lv = voiceOf(lineVoices, line, { provider: providerMod, voiceCfg });
    const cers = pickBy.by === "stt" ? await takesCer(paths, line, found, langCode, { level: lv.voiceCfg.levelLines !== false, pronounce: plan.meta.pronounce }) : new Map();
    const marks = manifest[id] && manifest[id].mode === "tone" ? manifest[id].marks : [];
    for (const k of found) {
      const row = { id, k, mark: marks[k - 1] || null, cer: cers.get(k) ?? null };
      try {
        const durationSec = await probeDuration(path.join(paths.voiceDir, "takes", `${id}-${k}.wav`));
        rows.push({ ...row, durationSec, lengthSec: installedLength(durationSec, line, lv.voiceCfg, lv.provider) });
      } catch (e) {
        rows.push({ ...row, durationSec: 0, lengthSec: null, unchecked: `unreadable: ${String(e.message).split("\n")[0]}` });
      }
    }
  }
  const keepSlots = !flags.retime && !dubCode(dir);
  await addTakeFacts(rows, { paths, plan, lineVoices, filmVoice: { provider: providerMod, voiceCfg }, keepSlots, withInstalled: true, gapMs });
  const picked = pickTakes(rows, ids, pickBy);
  printTakesTable(rows, picked);
  reportPickOutcome(ids, picked);
  const picks = ids.filter((id) => picked.get(id) > 0).map((id) => ({ id, k: picked.get(id) }));
  if (picks.length) await installPicks({ dir, paths, plan, flags, picks, providerMod, providerName, voiceCfg, lineVoices, gapMs, tailSec, sttEnabled });
}

/** Take numbers k with a voice/takes/<id>-<k>.wav on disk, ascending. */
function listTakeFiles(paths, id) {
  const found = [];
  for (let k = 1; k <= TAKES_MAX; k++) {
    if (fs.existsSync(path.join(paths.voiceDir, "takes", `${id}-${k}.wav`))) found.push(k);
  }
  return found;
}

/**
 * CER of each take k of `line`, by transcribing the takes on disk on the leveling an
 * installed clip gets (`level` false when the voice sets levelLines: false).
 */
async function takesCer(paths, line, ks, langCode, { level = true, pronounce = null } = {}) {
  const code = line.lang ? sttLangCode(line.lang) : langCode;
  const entries = ks.map((k) => sttEntry(line, `takes/${line.id}-${k}.wav`, { id: `${line.id}-${k}`, langCode: code, pronounce }));
  const stt = await sttTranscribeLeveled(paths.voiceDir, entries, code, { level });
  if (stt.skipped) throw new Error(`--pick-by stt: ${stt.skipped}`);
  const { text, say, names } = entries[0];
  return new Map(ks.map((k) => [k, compareLine({ text, say, heard: stt.results.get(`${line.id}-${k}`) || "", lang: code, names }).cer]));
}

/**
 * Installs each picked voice/takes/<id>-<k>.wav without re-synthesis
 * (shared by --pick and --pick-by).
 */
async function installPicks({ dir, paths, plan, flags, picks, providerMod, providerName, voiceCfg, lineVoices = null, gapMs, tailSec, sttEnabled }) {
  const missing = picks.filter((p) => !fs.existsSync(path.join(paths.voiceDir, "takes", `${p.id}-${p.k}.wav`)));
  if (missing.length) {
    throw new Error(`--pick: no candidate take(s) for ${missing.map((p) => `${p.id}=${p.k}`).join(", ")} — run --takes first`);
  }

  const takeWavs = new Map(picks.map((p) => [p.id, path.join(paths.voiceDir, "takes", `${p.id}-${p.k}.wav`)]));
  keepInstalledClips(paths, picks.map((p) => p.id));
  const { lines, waiting } = splitPlanByAudio(plan.lines, picks.map((p) => p.id), (id) => fs.existsSync(installedClipPath(paths, id)));
  if (waiting.length) process.stdout.write(`no audio yet for ${waiting.join(", ")} — left out of this rebuild; make ${waiting.length === 1 ? "it" : "them"} next with --lines ${waiting.join(",")} (or a full pass)\n`);
  const result = await synthesizeAll({
    dir,
    paths,
    lines,
    provider: providerMod,
    providerName,
    voiceCfg,
    lineVoices,
    pronounce: plan.meta.pronounce,
    lang: plan.meta.lang || "ko-KR",
    gapMs,
    tailSec,
    onlyLineIds: picks.map((p) => p.id),
    sttEnabled,
    retryFlagged: 0,
    keepTiming: keepOldSlots(dir, flags),
    takeWavs,
  });
  writeJson(paths.timingsJson, result.timings);
  const installed = picks.filter((p) => !result.refused.includes(p.id));
  process.stdout.write(`installed take(s): ${installed.map((p) => `${p.id}=${p.k}`).join(", ")}\n`);
  writePickedTones({ paths, plan, picks: installed, providerName, lineVoices });
  process.stdout.write(partialRebuildNote(dir, result.moved));
  failIfRefused({ refused: result.refused });
}

/**
 * A take picked from a --takes tone comparison sets that tone in plan.json, but only once it is
 * installed: a refused pick leaves the tone unwritten.
 */
function writePickedTones({ paths, plan, picks, providerName, lineVoices }) {
  const manifest = loadTakesManifest(paths);
  const voices = lineVoices || new Map(plan.lines.map((l) => [l.id, resolveLineVoice(plan.meta, l, providerName)]));
  const written = [];
  for (const p of picks) {
    const entry = manifest[p.id];
    if (entry && entry.mode === "tone" && entry.marks && entry.marks[p.k - 1]) {
      const mark = entry.marks[p.k - 1];
      written.push({ mark, where: writePickedTone(plan, p.id, mark, voices, providerName) });
    }
  }
  if (!written.length) return;
  writeJson(paths.planJson, plan);
  for (const t of written) {
    process.stdout.write(`wrote ${t.where} = "${t.mark}" to plan.json — that speaker's remaining lines will be made in this tone\n`);
  }
}

/**
 * `--insert-pause id@word=ms`: inserts silence into finished line audio at
 * the quietest 10 ms point between word `word` and the next (no
 * re-synthesis, no tempo, no leveling), shifts the timings by exactly the
 * pause, and rebuilds narration.wav/timings.json keeping every line's
 * measured word times.
 */
export async function runInsertPause({ dir, paths, plan, spec }) {
  const edits = parseInsertPause(spec);
  if (!fs.existsSync(paths.timingsJson)) {
    throw new Error(`--insert-pause: no ${paths.timingsJson} — run a full voice.mjs pass first`);
  }
  const timings = readJson(paths.timingsJson);
  const startsBefore = new Map(timings.lines.map((l) => [l.id, l.start]));
  for (const edit of edits) {
    const line = timings.lines.find((l) => l.id === edit.id);
    if (!line) throw new Error(`--insert-pause: unknown line id "${edit.id}"`);
    const wavPath = path.join(paths.voiceDir, `line-${edit.id}.wav`);
    if (!fs.existsSync(wavPath)) throw new Error(`--insert-pause: no ${wavPath}`);
    const { rate, samples } = readWavMono16(wavPath);
    const win = pauseWindow(line.words || [], edit.word, line.start, samples.length / rate);
    const at = quietestSample(samples, rate, win.fromSec, win.toSec);
    const count = Math.round((edit.ms / 1000) * rate);
    writeWavMono16(wavPath, insertSilence(samples, at, count), rate);
    shiftForPause(timings, edit.id, edit.word, count / rate);
    const word = line.words[edit.word];
    process.stdout.write(
      `line "${edit.id}": inserted ${(count / rate).toFixed(3)}s after word ${edit.word} "${word.w ?? ""}" at ${(at / rate).toFixed(3)}s into the line\n`
    );
  }
  writeJson(paths.timingsJson, timings);

  const result = await synthesizeAll({
    dir,
    paths,
    lines: plan.lines,
    provider: {},
    providerName: timings.provider,
    voiceCfg: plan.meta.voice || {},
    pronounce: plan.meta.pronounce,
    lang: timings.lang || plan.meta.lang || "ko-KR",
    gapMs: plan.meta.gapMs == null ? 700 : plan.meta.gapMs,
    tailSec: plan.meta.tailSec == null ? TAIL_SILENCE_SEC : plan.meta.tailSec,
    onlyLineIds: [],
    sttEnabled: false,
    retryFlagged: 0,
  });
  writeJson(paths.timingsJson, result.timings);
  process.stdout.write(`wrote ${paths.narrationWav}\nwrote ${paths.timingsJson}\n`);
  const moved = result.timings.lines.filter((l) => Math.abs(l.start - startsBefore.get(l.id)) > 0.001).map((l) => l.id);
  process.stdout.write(partialRebuildNote(dir, moved));
  return result.timings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
