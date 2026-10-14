// Speech-to-text engines for the voice step's "did the voice say the line" check
// (references/voice.md). Tools report facts; it never throws. An engine that was asked
// for (SVA_STT_PYTHON or SVA_STT_ENGINE set) but cannot run at all — no Python, a Python
// without the engine's package, an unknown engine — comes back `{failed: reason}` and the caller
// fails its step. With nothing configured, a missing engine, a model not downloaded or a
// run that stops comes back `{skipped: reason}`.
//
// Engines (SVA_STT_ENGINE):
//   mlx             (default on macOS) mlx-whisper through scripts/voice/py/stt_check.py. First
//                   pass with the small model on every line; only lines whose transcript is
//                   doubtful against the line's target text get a second pass with the turbo model.
//   faster-whisper  (default elsewhere) the same script, the same small -> turbo passes and the
//                   same weights and decoding, run by faster-whisper: float16 on a CUDA GPU, int8
//                   on CPU. On CPU it is several times slower than mlx; use it with a GPU.
//   groq            Groq's hosted Whisper. Sent only when selected; the key is read from GROQ_API_KEY
//                   and is never logged. No key = skipped with one line.
//
// Env: SVA_STT_MODEL (first pass, default "small"), SVA_STT_MODEL_RECHECK (default "turbo"),
// SVA_STT_DOUBT_CER (default 0.15), SVA_STT_PYTHON (python with mlx-whisper or faster-whisper),
// SVA_STT_GROQ_MODEL (default "whisper-large-v3-turbo").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPythonBatch } from "./pyenv.mjs";
import { groupByLangCode } from "./line-lang.mjs";
import { compareLine } from "./stt-compare.mjs";
import { levelLineWav } from "./line-level.mjs";
import { parseWav } from "./wav-read.mjs";
import { isTransientDecodeError, withRetry } from "./retry.mjs";

const STT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "voice", "py", "stt_check.py");
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_FIRST_MODEL = "small";
const DEFAULT_RECHECK_MODEL = "turbo";
const DEFAULT_DOUBT_CER = 0.15;
const MODEL_NOT_DOWNLOADED_EXIT = 3;
const PROGRESS_POLL_MS = 500;
const FRAME_SEC = 0.01;
const DECODE_RETRIES = 2;
const WAYS_OUT = "or use the hosted engine (SVA_STT_ENGINE=groq with GROQ_API_KEY), or turn the check off (voice.mjs --no-stt)";
// Python could not start, or started without the engine's package: the engine is unusable, not a run that stopped.
const NO_ENGINE_PATTERNS = [/failed to start/, /No module named ['"]?(mlx_whisper|faster_whisper|ctranslate2)/];
/** The Python package each local engine imports. */
const ENGINE_PACKAGE = { mlx: "mlx-whisper", "faster-whisper": "faster-whisper" };

/** mlx-whisper model aliases and the repos they stand for (stt_check.py MODELS is the same table). */
export const MLX_MODEL_REPOS = {
  small: "mlx-community/whisper-small-mlx",
  turbo: "mlx-community/whisper-large-v3-turbo",
};

/** The same Whisper weights converted for faster-whisper (stt_check.py FW_MODELS is the same table). */
export const FW_MODEL_REPOS = {
  small: "Systran/faster-whisper-small",
  turbo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

/** The model table of a local engine. */
export function modelRepos(engine) {
  return engine === "faster-whisper" ? FW_MODEL_REPOS : MLX_MODEL_REPOS;
}

/**
 * The local engine when SVA_STT_ENGINE is not set: mlx-whisper on macOS (Apple silicon), faster-whisper
 * elsewhere (CUDA when there is an NVIDIA GPU). Both run the same weights with the same decoding.
 */
export function defaultEngine(platform = process.platform) {
  return platform === "darwin" ? "mlx" : "faster-whisper";
}

/** The Hugging Face hub cache folder: HF_HUB_CACHE, else HF_HOME/hub, else ~/.cache/huggingface/hub. */
function hubCacheDir(env) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return path.join(env.HF_HOME, "hub");
  return path.join(os.homedir(), ".cache", "huggingface", "hub");
}

/** Whether a local engine's model (alias or repo) is already on disk. No network. */
export function mlxModelCached(model, env = process.env, engine = "mlx") {
  const repo = modelRepos(engine)[model] || model;
  if (fs.existsSync(repo) && fs.statSync(repo).isDirectory()) return true;
  const snapshots = path.join(hubCacheDir(env), `models--${repo.replaceAll("/", "--")}`, "snapshots");
  try {
    return fs.readdirSync(snapshots).length > 0;
  } catch {
    return false;
  }
}

/** A short unique tag for temp folders: pid + microseconds. */
function uniqueTag() {
  const micros = BigInt(Date.now()) * 1000n + (process.hrtime.bigint() % 1000n);
  return `${process.pid}-${micros}`;
}

/** First line of an error message with the API key (if any) removed. */
function safeMessage(e, secret) {
  const first = String((e && e.message) || e).split("\n")[0];
  return secret ? first.split(secret).join("[key]") : first;
}

function readProgress(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Whether a first-pass transcript is doubtful: empty, or its error rate against the
 * entry's own target text is above the threshold. An entry with no target is never doubtful.
 */
export function isDoubtful(entry, heard, langCode, threshold = DEFAULT_DOUBT_CER) {
  if (entry.text == null) return false;
  if (!String(heard || "").trim()) return true;
  return compareLine({ text: entry.text, say: entry.say, heard, lang: langCode, names: entry.names }).cer > threshold;
}

function fromArray(arr) {
  return {
    results: new Map(arr.map((r) => [r.id, r.heard])),
    words: new Map(arr.map((r) => [r.id, r.words || []])),
  };
}

/**
 * Reads the progress file while python runs and hands every line finished so far to
 * deps.onProgress, so a caller can save each line as it lands (a killed run keeps them).
 * @returns {() => Promise<void>} stop: one last read, then waits for the saves to end
 */
function tailProgress(ctx, file, code, model) {
  if (!ctx.deps.onProgress) return async () => {};
  let seen = 0;
  let chain = Promise.resolve();
  const poll = () => {
    const arr = readProgress(file);
    if (arr.length <= seen) return;
    seen = arr.length;
    const part = { ...fromArray(arr), models: new Map(arr.map((r) => [r.id, model])) };
    chain = chain.then(() => ctx.deps.onProgress({ ...part, code, partial: true })).catch(() => {});
  };
  const timer = setInterval(poll, ctx.deps.progressPollMs ?? PROGRESS_POLL_MS);
  return async () => {
    clearInterval(timer);
    poll();
    await chain;
  };
}

/** One local Whisper run (mlx or faster-whisper): the model loads once for every entry, progress is kept per line. */
async function mlxPass(ctx, python, entries, code, model, { tail = false } = {}) {
  const jobDir = fs.mkdtempSync(path.join(ctx.voiceDir, `.stt-${uniqueTag()}-`));
  const jobPath = path.join(jobDir, "lines.json");
  const progress = path.join(jobDir, "progress.json");
  fs.writeFileSync(jobPath, JSON.stringify(entries.map(({ id, wav }) => ({ id, wav }))), "utf8");
  const stopTail = tail ? tailProgress(ctx, progress, code, model) : null;
  const env = { HF_HUB_OFFLINE: "1", SVA_STT_BACKEND: ctx.engine, SVA_STT_LANG: code, SVA_STT_MODEL: model, SVA_STT_PROGRESS: progress };
  try {
    const { stdout } = await withRetry(() => ctx.run(python, [STT_SCRIPT, ctx.voiceDir, jobPath], env), {
      isRetryable: isTransientDecodeError,
      maxRetries: DECODE_RETRIES,
      onRetry: (k) => ctx.log(`STT: transient decode error, retrying (${k}/${DECODE_RETRIES})`),
    });
    return fromArray(JSON.parse(stdout.trim() || "[]"));
  } catch (e) {
    const message = String((e && e.message) || e);
    if (new RegExp(`exited ${MODEL_NOT_DOWNLOADED_EXIT}\\b`).test(message)) {
      return { skipped: `STT model "${model}" is not downloaded (run: node scripts/setup.mjs --stt-models)` };
    }
    const why = message.split("\n").find((l) => NO_ENGINE_PATTERNS.some((re) => re.test(l)));
    if (why) {
      const pkg = ENGINE_PACKAGE[ctx.engine];
      return { failed: `STT Python ${python} cannot run ${pkg} (${why.trim()}): install ${pkg} there, point SVA_STT_PYTHON at a Python that has it, ${WAYS_OUT}`, noEngine: true };
    }
    return { ...fromArray(readProgress(progress)), failed: `stt check failed to run (${safeMessage(e)})` };
  } finally {
    if (stopTail) await stopTail();
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

/** Error rate of `heard` against the entry's own target; an empty answer is wrong in full. */
function entryCer(entry, heard, code) {
  if (!String(heard || "").trim()) return 1;
  return compareLine({ text: entry.text, say: entry.say, heard, lang: code, names: entry.names }).cer;
}

/**
 * Second pass on the doubtful lines only; a failure keeps the first-pass answer. A line takes the
 * second transcript only when its error rate is not worse than the first one's; `first.models`
 * records which model each line's transcript came from.
 */
async function recheckDoubtful(ctx, python, group, code, first) {
  const threshold = Number(ctx.env.SVA_STT_DOUBT_CER) || DEFAULT_DOUBT_CER;
  const recheckModel = ctx.env.SVA_STT_MODEL_RECHECK || DEFAULT_RECHECK_MODEL;
  const firstModel = ctx.env.SVA_STT_MODEL || DEFAULT_FIRST_MODEL;
  if (recheckModel === firstModel) return;
  const doubtful = group.filter((e) => isDoubtful(e, first.results.get(e.id), code, threshold));
  if (!doubtful.length) return;
  ctx.log(`STT second pass (${recheckModel}) on ${doubtful.length} doubtful line(s): ${doubtful.map((e) => e.id).join(", ")}`);
  const second = await mlxPass(ctx, python, doubtful, code, recheckModel);
  if (second.skipped) ctx.log(`STT second pass skipped: ${second.skipped} — the first-pass transcript stands`);
  else if (second.failed) ctx.log(`STT second pass stopped: ${second.failed} — lines it did not reach keep the first-pass transcript`);
  const byId = new Map(doubtful.map((e) => [e.id, e]));
  for (const [id, heard] of second.results || []) {
    const entry = byId.get(id);
    if (entryCer(entry, heard, code) > entryCer(entry, first.results.get(id), code)) continue;
    first.results.set(id, heard);
    first.words.set(id, second.words.get(id) || []);
    first.models.set(id, recheckModel);
  }
}

async function runMlx(ctx, group, code) {
  const python = ctx.deps.pythonPath || ctx.env.SVA_STT_PYTHON || null;
  if (!python && ctx.configured) {
    return { failed: `STT was asked for (SVA_STT_ENGINE=${ctx.engine}) but no Python is set: set SVA_STT_PYTHON to a Python with ${ENGINE_PACKAGE[ctx.engine]} installed (node scripts/setup.mjs shows how), ${WAYS_OUT}`, noEngine: true };
  }
  if (!python) return { skipped: `no python found (set SVA_STT_PYTHON to a Python with ${ENGINE_PACKAGE[ctx.engine]} installed)` };
  const firstModel = ctx.env.SVA_STT_MODEL || DEFAULT_FIRST_MODEL;
  const first = await mlxPass(ctx, python, group, code, firstModel, { tail: true });
  if (first.skipped || first.failed) return first;
  first.models = new Map([...first.results.keys()].map((id) => [id, firstModel]));
  if (ctx.deps.onProgress) await ctx.deps.onProgress({ results: first.results, words: first.words, models: first.models, code });
  await recheckDoubtful(ctx, python, group, code, first);
  return first;
}

/** Word edges from Whisper run edge to edge; pull each to where its sound starts and stops. */
export function trimWordsToSound(words, wavPath) {
  if (!words.length) return words;
  let wav;
  try {
    wav = parseWav(fs.readFileSync(wavPath));
  } catch {
    return words;
  }
  const hop = Math.max(1, Math.round(wav.sampleRate * FRAME_SEC));
  const n = Math.floor(wav.samples.length / hop);
  if (n === 0) return words;
  const rms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += wav.samples[i] * wav.samples[i];
    rms[f] = Math.sqrt(sum / hop);
  }
  const sorted = Float64Array.from(rms).sort();
  const floor = 0.1 * sorted[Math.min(n - 1, Math.floor(0.95 * (n - 1)))];
  return words.map((w) => {
    const a = Math.floor(w.start / FRAME_SEC);
    const b = Math.min(n, Math.ceil(w.end / FRAME_SEC));
    let lo = -1;
    let hi = -1;
    for (let f = a; f < b; f++) {
      if (rms[f] >= floor) {
        if (lo < 0) lo = f;
        hi = f;
      }
    }
    if (lo < 0) return w;
    return { w: w.w, start: Math.round(lo * FRAME_SEC * 1000) / 1000, end: Math.round((hi + 1) * FRAME_SEC * 1000) / 1000 };
  });
}

async function groqOne(ctx, key, entry, code) {
  const file = path.isAbsolute(entry.wav) ? entry.wav : path.join(ctx.voiceDir, entry.wav);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), path.basename(file));
  form.append("model", ctx.env.SVA_STT_GROQ_MODEL || "whisper-large-v3-turbo");
  form.append("language", code);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");
  const res = await (ctx.deps.fetch || globalThis.fetch)(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const words = (body.words || []).map((w) => ({ w: String(w.word).trim(), start: w.start, end: w.end })).filter((w) => w.w);
  return { heard: String(body.text || "").trim(), words: trimWordsToSound(words, file) };
}

async function runGroq(ctx, group, code) {
  const key = ctx.env.GROQ_API_KEY;
  if (!key) {
    return { failed: "groq engine selected (SVA_STT_ENGINE=groq) but GROQ_API_KEY is not set: set GROQ_API_KEY, or use the local engine (SVA_STT_ENGINE=mlx with SVA_STT_PYTHON pointing at a Python with mlx-whisper), or turn the check off (voice.mjs --no-stt)", noEngine: true };
  }
  const results = new Map();
  const words = new Map();
  const models = new Map();
  const model = `groq:${ctx.env.SVA_STT_GROQ_MODEL || "whisper-large-v3-turbo"}`;
  for (const entry of group) {
    try {
      const one = await groqOne(ctx, key, entry, code);
      results.set(entry.id, one.heard);
      words.set(entry.id, one.words);
      models.set(entry.id, model);
      if (ctx.deps.onProgress) await ctx.deps.onProgress({ results, words, models, code });
    } catch (e) {
      return { results, words, models, failed: `groq request failed (${safeMessage(e, key)})` };
    }
  }
  return { results, words, models };
}

const ENGINES = { mlx: runMlx, "faster-whisper": runMlx, groq: runGroq };

/**
 * Transcribe `entries` ({id, wav, langCode?, text?, say?, names?}; wav relative to
 * voiceDir or absolute) and return `{results: Map(id -> heard), words: Map(id -> [{w,start,end}])}`,
 * `{failed: reason}` when STT was configured (SVA_STT_PYTHON or SVA_STT_ENGINE set) but the engine
 * cannot run at all (no Python, a Python without mlx_whisper, an unknown engine) — the caller fails
 * its step — or `{skipped: reason}` otherwise. It never throws.
 * An entry's own `langCode` wins over `langCode`; one run per language. `text`/`say`/`names`
 * (target text and pronounceFolds) let the second pass pick the doubtful lines.
 * `models` (Map id -> model name) says which model made each line's transcript.
 * With `deps.allowPartial`, an engine that stops mid-way returns what it finished plus
 * `{incomplete: reason, missing: [ids]}` instead of `{skipped}`.
 * `deps.onProgress({results, words, code})` runs while the first pass (mlx) is going, as each
 * line is finished (polled every deps.progressPollMs, default 500), or after each line (groq),
 * so a caller can save what is done. `deps` (tests): {pythonPath, runPythonBatch, fetch, env, log}.
 */
export async function sttTranscribe(voiceDir, entries, langCode, deps = {}) {
  const env = deps.env || process.env;
  const engine = String(env.SVA_STT_ENGINE || defaultEngine(deps.platform)).toLowerCase();
  const runner = ENGINES[engine];
  if (!runner) {
    return { failed: `unknown STT engine "${engine}" (SVA_STT_ENGINE: mlx, faster-whisper or groq) — set SVA_STT_ENGINE=${defaultEngine(deps.platform)} with SVA_STT_PYTHON, ${WAYS_OUT}` };
  }
  if (!entries.length) return { results: new Map(), words: new Map() };
  const configured = Boolean(env.SVA_STT_PYTHON || env.SVA_STT_ENGINE || deps.pythonPath);
  const ctx = { voiceDir, env, deps, engine, configured, run: deps.runPythonBatch || runPythonBatch, log: deps.log || ((m) => process.stdout.write(`${m}\n`)) };
  const merged = { results: new Map(), words: new Map(), models: new Map() };
  for (const [code, group] of groupByLangCode(entries, langCode)) {
    const one = await runner(ctx, group, code);
    if (one.noEngine) return { failed: one.failed };
    if (one.skipped) return one;
    for (const [k, v] of one.results) merged.results.set(k, v);
    for (const [k, v] of one.words) merged.words.set(k, v);
    for (const [k, v] of one.models || []) merged.models.set(k, v);
    if (one.failed) {
      if (!deps.allowPartial) return { skipped: one.failed };
      return { ...merged, incomplete: one.failed, missing: entries.filter((e) => !merged.results.has(e.id)).map((e) => e.id) };
    }
  }
  return merged;
}

/**
 * sttTranscribe on leveled copies: each clip is copied, run through the same
 * per-line leveling an installed line gets (line-level.mjs), and the copy is
 * transcribed — so comparing takes sees what the installed clip will sound like.
 * The takes themselves stay raw. `deps.level === false` skips the leveling
 * (a voice with levelLines: false); `deps.levelLine` replaces the leveler (tests).
 */
export async function sttTranscribeLeveled(voiceDir, entries, langCode, deps = {}) {
  const levelFn = deps.levelLine || levelLineWav;
  const dir = fs.mkdtempSync(path.join(voiceDir, `.stt-lv-${uniqueTag()}-`));
  try {
    const copies = [];
    for (const [i, e] of entries.entries()) {
      const src = path.isAbsolute(e.wav) ? e.wav : path.join(voiceDir, e.wav);
      const dst = path.join(dir, `${i}.wav`);
      fs.copyFileSync(src, dst);
      if (deps.level !== false) await levelFn(dst);
      copies.push({ ...e, wav: dst });
    }
    return await sttTranscribe(voiceDir, copies, langCode, deps);
  } catch (e) {
    return { skipped: `leveling the STT copy failed (${safeMessage(e)})` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
