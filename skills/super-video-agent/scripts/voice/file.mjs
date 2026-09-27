// User-provided audio per line: expects voice/in/<id>.<ext> to already
// exist and converts it to the standard 48kHz mono PCM16 WAV.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "file";

const EXTS = [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"];

/**
 * @param {{id:string, outPath:string, reelDir:string}} args
 */
export async function synth({ id, outPath, reelDir }) {
  const inDir = path.join(reelDir, "voice", "in");
  let found;
  for (const ext of EXTS) {
    const candidate = path.join(inDir, `${id}${ext}`);
    if (fs.existsSync(candidate)) {
      found = candidate;
      break;
    }
  }
  if (!found) {
    throw new Error(
      `voice provider "file": no audio found for line "${id}" — place it at ${path.join(
        inDir,
        id + ".wav"
      )} (or .mp3/.m4a/.aac/.flac/.ogg).`
    );
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await ffmpeg(["-y", "-i", found, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  return { wavPath: outPath };
}
