// ElevenLabs TTS provider, with-timestamps endpoint for provider-native
// word alignment (design.md §2.3). Env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { wordsFromCharAlignment } from "../lib/timing.mjs";

export const name = "elevenlabs";

/**
 * @param {{text:string, voice?:string, voiceCfg?:{model?:string}, outPath:string, lineStart?:number}} args
 */
export async function synth({ text, voice, voiceCfg, outPath, lineStart = 0 }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set. Export it, or run with --provider say for a zero-key default."
    );
  }
  const voiceId = voice || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new Error(
      "no ElevenLabs voice id: set plan.json meta.voice.voiceId or ELEVENLABS_VOICE_ID."
    );
  }
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text, model_id: (voiceCfg && voiceCfg.model) || "eleven_multilingual_v2" }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${body}`);
  }
  const json = await res.json();
  const buf = Buffer.from(json.audio_base64, "base64");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, ".raw.mp3");
  fs.writeFileSync(rawPath, buf);
  await ffmpeg(["-y", "-i", rawPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(rawPath, { force: true });

  let words;
  const align = json.alignment || json.normalized_alignment;
  if (align && Array.isArray(align.characters)) {
    words = wordsFromCharAlignment(
      align.characters.join(""),
      align.character_start_times_seconds,
      align.character_end_times_seconds,
      lineStart
    );
  }
  return { wavPath: outPath, words };
}
