// macOS `say` provider — zero-key default (design.md §2.3).
// synth writes AIFF via `say`, then converts to 48kHz mono PCM16 WAV.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "say";

function runSay(text, voice, outAiff) {
  return new Promise((resolve, reject) => {
    const args = ["-v", voice, "-o", outAiff];
    const child = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`\`say\` failed to start (is this macOS?): ${e.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`say\` exited ${code}: ${stderr}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * @param {{text:string, voice?:string, lang?:string, params?:object, outPath:string}} args
 * @returns {Promise<{wavPath:string, words?: {w:string,start:number,end:number}[]}>}
 */
export async function synth({ text, voice, outPath }) {
  const v = voice || process.env.SAY_VOICE || "Yuna";
  const aiff = outPath.replace(/\.wav$/, ".aiff");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await runSay(text, v, aiff);
  await ffmpeg(["-y", "-i", aiff, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(aiff, { force: true });
  return { wavPath: outPath };
}
