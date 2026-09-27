// MeloTTS-Korean provider (batch-capable, MIT, native --speed): loads the
// model once for all lines via scripts/voice/py/melo_batch.py.
// Env: SVA_MELO_PYTHON.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { resolvePythonPath, runPythonBatch, parseJsonLinesById } from "../lib/pyenv.mjs";

export const name = "melotts";
// MeloTTS's --speed is a native rate control; voice.mjs must not also
// apply ffmpeg atempo on top of it.
export const nativeRate = true;

const here = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SCRIPT = path.join(here, "py", "melo_batch.py");

export function findPython() {
  return resolvePythonPath("SVA_MELO_PYTHON", null);
}

/**
 * @param {{id:string,text:string,outPath:string}[]} lines
 * @param {{voiceCfg?:object}} ctx
 * @returns {Promise<{id:string, wavPath:string}[]>}
 */
export async function synthBatch(lines, ctx) {
  const pythonPath = findPython();
  if (!pythonPath) {
    throw new Error("melotts provider: not configured. Set SVA_MELO_PYTHON to a python venv with MeloTTS installed.");
  }
  const voiceCfg = (ctx && ctx.voiceCfg) || {};
  const rawDir = fs.mkdtempSync(path.join(path.dirname(lines[0].outPath), ".melo-raw-"));
  const jobPath = path.join(rawDir, "job.json");
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      speed: voiceCfg.rate || 1.0,
      speaker: voiceCfg.voiceId || "KR",
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
      throw new Error(`melo_batch.py produced no result for line "${line.id}"`);
    }
    await ffmpeg(["-y", "-i", r.wav, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", line.outPath]);
    results.push({ id: line.id, wavPath: line.outPath });
  }
  fs.rmSync(rawDir, { recursive: true, force: true });
  return results;
}
