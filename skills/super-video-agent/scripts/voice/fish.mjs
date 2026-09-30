// fish.audio TTS provider. Env: FISH_AUDIO_API_KEY (or FISH_API_KEY, the name Fish Audio documents), FISH_AUDIO_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "fish";

// No charge while Fish Audio offers it (announced through 2026-11-30); set meta.voice.model
// to "s2.1-pro" (the paid twin) once it ends.
const DEFAULT_MODEL = "s2.1-pro-free";

// Our delivery marks (lib/tags.mjs) in Fish Audio S2's own tags. Emotions pass as themselves.
const S2_TAGS = {
  pause: "[break]",
  "long-pause": "[long-break]",
  emphasis: "[emphasis]",
  whisper: "[whispering]",
  soft: "[soft tone]",
  hurry: "[in a hurry tone]",
  shout: "[shouting]",
  laugh: "[laughing]",
  chuckle: "[chuckling]",
  sigh: "[sighing]",
  gasp: "[gasping]",
  "clear-throat": "[clear throat]",
};

/**
 * S2 models (s2.1-pro-free, s2.1-pro, s2-pro) read `[tag]` expression tags; s1 uses another
 * syntax, so every mark is dropped for it.
 * @param {{model?:string}} voiceCfg
 */
export function tagMap(voiceCfg) {
  const model = (voiceCfg && voiceCfg.model) || DEFAULT_MODEL;
  return model.startsWith("s2") ? S2_TAGS : null;
}

/**
 * @param {{text:string, voice?:string, voiceCfg?:{model?:string}, outPath:string}} args
 */
export async function synth({ text, voice, voiceCfg, outPath }) {
  const apiKey = process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FISH_AUDIO_API_KEY (or FISH_API_KEY) is not set. Export it, or pick another provider with --provider."
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
      model: (voiceCfg && voiceCfg.model) || DEFAULT_MODEL,
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
