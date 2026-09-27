// Local Fish-Speech (S1-mini) provider: 2-step CLI per line
// (text2semantic/inference.py -> dac/inference.py), conditioned on a
// pre-encoded reference (plan.json meta.voice.refTokens .npy +
// meta.voice.refText) so every line shares one consistent voice.
// Env: SVA_FISH_DIR, SVA_FISH_DEVICE.
//
// WEIGHTS LICENSE: openaudio-s1-mini is CC-BY-NC-SA-4.0 — non-commercial
// only. This provider prints a warning every run; it is not a substitute
// for checking the license fits your use.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "fishspeech";

function findFishDir() {
  return process.env.SVA_FISH_DIR || null;
}

function resolveRefPath(p, reelDir) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(reelDir, p);
}

function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => reject(new Error(`${bin} failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

let warnedThisRun = false;
function warnLicenseOnce() {
  if (warnedThisRun) return;
  warnedThisRun = true;
  process.stderr.write(
    "WARNING: fishspeech provider uses openaudio-s1-mini weights, licensed CC-BY-NC-SA-4.0 " +
      "(non-commercial). Confirm this fits your use before shipping audio synthesized with it.\n"
  );
}

/**
 * @param {{id:string, text:string, outPath:string, reelDir:string,
 *   voiceCfg?: {refTokens?:string, refText?:string}}} args
 */
export async function synth({ text, outPath, reelDir, voiceCfg }) {
  warnLicenseOnce();
  const fishDir = findFishDir();
  if (!fishDir) {
    throw new Error("fishspeech provider: not configured. Set SVA_FISH_DIR to a local Fish-Speech checkout (with a .venv-tts venv).");
  }
  const repo = path.join(fishDir, "fish-speech");
  const python = path.join(fishDir, ".venv-tts", "bin", "python");
  const ckpt = path.join(repo, "checkpoints", "openaudio-s1-mini");
  const device = process.env.SVA_FISH_DEVICE || "mps";

  const cfg = voiceCfg || {};
  const refTokens = resolveRefPath(cfg.refTokens, reelDir);
  const refText = cfg.refText;
  if (!refTokens || !refText) {
    throw new Error(
      "fishspeech provider requires plan.json meta.voice.refTokens (.npy) and meta.voice.refText."
    );
  }
  if (!fs.existsSync(refTokens)) {
    throw new Error(`fishspeech provider: refTokens file not found: ${refTokens}`);
  }

  const workDir = fs.mkdtempSync(path.join(path.dirname(outPath), ".fish-work-"));
  try {
    await run(
      python,
      [
        "fish_speech/models/text2semantic/inference.py",
        "--text",
        text,
        "--prompt-text",
        refText,
        "--prompt-tokens",
        refTokens,
        "--checkpoint-path",
        ckpt,
        "--device",
        device,
        "--output-dir",
        workDir,
        "--num-samples",
        "1",
      ],
      { cwd: repo }
    );
    const codesPath = path.join(workDir, "codes_0.npy");
    if (!fs.existsSync(codesPath)) {
      throw new Error("fishspeech provider: text2semantic produced no codes_0.npy");
    }
    const rawWav = path.join(workDir, "raw.wav");
    await run(
      python,
      ["fish_speech/models/dac/inference.py", "-i", codesPath, "-o", rawWav, "--checkpoint-path", path.join(ckpt, "codec.pth"), "--device", device],
      { cwd: repo }
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await ffmpeg(["-y", "-i", rawWav, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { wavPath: outPath };
}
