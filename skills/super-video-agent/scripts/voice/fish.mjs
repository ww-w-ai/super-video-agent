// fish.audio TTS provider. Env: FISH_AUDIO_API_KEY, FISH_AUDIO_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "fish";

/**
 * @param {{text:string, voice?:string, outPath:string}} args
 */
export async function synth({ text, voice, outPath }) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FISH_AUDIO_API_KEY is not set. Export it, or run with --provider say for a zero-key default."
    );
  }
  const referenceId = voice || process.env.FISH_AUDIO_VOICE_ID;
  if (!referenceId) {
    throw new Error(
      "no fish.audio voice id: set plan.json meta.voice.voiceId or FISH_AUDIO_VOICE_ID."
    );
  }
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text, reference_id: referenceId, format: "wav" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fish.audio TTS failed: ${res.status} ${res.statusText} ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, ".raw.wav");
  fs.writeFileSync(rawPath, buf);
  await ffmpeg(["-y", "-i", rawPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(rawPath, { force: true });
  return { wavPath: outPath };
}
