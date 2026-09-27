// Silent placeholder provider. Duration is estimated (never measured from
// real speech) at 7 characters/second — a Korean-reading-speed rule of
// thumb — and the result is marked `estimated: true` so callers/timings.json
// can flag it as not measured.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "none";

const CHARS_PER_SEC = 7;

export function estimateDurationSec(text) {
  const len = String(text).replace(/\s+/g, "").length;
  return Math.max(0.3, len / CHARS_PER_SEC);
}

/**
 * @param {{text:string, outPath:string}} args
 */
export async function synth({ text, outPath }) {
  const dur = estimateDurationSec(text);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    dur.toFixed(3),
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  return { wavPath: outPath, estimated: true };
}
