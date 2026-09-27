// Qwen3-TTS voice-clone provider (batch-capable): loads the model once for
// all lines via scripts/voice/py/qwen3_batch.py. Requires plan.json
// meta.voice.refAudio + refText (zero-shot voice clone, not a preset
// speaker). Env: SVA_QWEN3_PYTHON, SVA_QWEN3_DEVICE.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { resolvePythonPath, runPythonBatch, parseJsonLinesById } from "../lib/pyenv.mjs";

export const name = "qwen3";

const here = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SCRIPT = path.join(here, "py", "qwen3_batch.py");
const DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
const DEFAULT_BUDGET_SEC = 20;

// The 10 languages Qwen3-TTS names in its README; anything else is auto-detected.
const QWEN_LANGUAGES = {
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  ru: "Russian",
  pt: "Portuguese",
  es: "Spanish",
  it: "Italian",
};

/** BCP 47 tag (`meta.lang`) → Qwen3-TTS language name, or "Auto". */
export function qwenLanguage(lang) {
  const primary = String(lang || "").toLowerCase().split("-")[0];
  return QWEN_LANGUAGES[primary] || "Auto";
}

export function findPython() {
  return resolvePythonPath("SVA_QWEN3_PYTHON", null);
}

function resolveRefPath(p, reelDir) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(reelDir, p);
}

/**
 * @param {{id:string,text:string,outPath:string}[]} lines
 * @param {{lang?:string, voiceCfg?:object, reelDir:string}} ctx
 * @returns {Promise<{id:string, wavPath:string, flag?:string}[]>}
 */
export async function synthBatch(lines, ctx) {
  const pythonPath = findPython();
  if (!pythonPath) {
    throw new Error("qwen3 provider: not configured. Set SVA_QWEN3_PYTHON to a python venv with qwen3-tts installed.");
  }
  const voiceCfg = (ctx && ctx.voiceCfg) || {};
  const refAudio = resolveRefPath(voiceCfg.refAudio, ctx.reelDir);
  const refText = voiceCfg.refText;
  if (!refAudio || !refText) {
    throw new Error(
      "qwen3 provider requires plan.json meta.voice.refAudio and meta.voice.refText (a reference clip + its transcript to clone)."
    );
  }

  const rawDir = fs.mkdtempSync(path.join(path.dirname(lines[0].outPath), ".qwen3-raw-"));
  const jobPath = path.join(rawDir, "job.json");
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      model: voiceCfg.model || DEFAULT_MODEL,
      device: process.env.SVA_QWEN3_DEVICE || "mps",
      lang: qwenLanguage(ctx.lang),
      refAudio,
      refText,
      budgetSec: voiceCfg.budgetSec || DEFAULT_BUDGET_SEC,
      lines: lines.map((l) => ({ id: l.id, say: l.text })),
    }),
    "utf8"
  );

  const { stdout } = await runPythonBatch(pythonPath, [BATCH_SCRIPT, jobPath, rawDir]);
  const byId = parseJsonLinesById(stdout);

  const results = [];
  for (const line of lines) {
    const r = byId.get(line.id);
    if (!r) {
      throw new Error(`qwen3_batch.py produced no result for line "${line.id}"`);
    }
    // The python script deliberately keeps the model's native sample rate;
    // resample to 48kHz mono pcm16 here at the path voice.mjs expects.
    await ffmpeg(["-y", "-i", r.wav, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", line.outPath]);
    results.push({ id: line.id, wavPath: line.outPath, flag: r.flag });
  }
  fs.rmSync(rawDir, { recursive: true, force: true });
  return results;
}
