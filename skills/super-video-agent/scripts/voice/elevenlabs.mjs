// ElevenLabs TTS provider, with-timestamps endpoint for provider-native
// word alignment (design.md §2.3). Env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { wordsFromCharAlignment } from "../lib/timing.mjs";
import { tagSpans } from "../lib/tags.mjs";

export const name = "elevenlabs";

const DEFAULT_MODEL = "eleven_multilingual_v2";

// Our delivery marks (lib/tags.mjs) in Eleven v3/v4 audio tags. A mark with no documented
// audio tag (emphasis, soft, hurry, shout, clear-throat) is dropped; emotions pass as themselves.
const V3_TAGS = {
  pause: "[pauses]",
  "long-pause": "[pauses]",
  whisper: "[whispers]",
  laugh: "[laughs]",
  chuckle: "[laughs]",
  sigh: "[sighs]",
  gasp: "[gasps]",
};

/**
 * Eleven v3 and v4 models read `[tag]` audio tags; older models would speak them, so every
 * mark is dropped for those.
 * @param {{model?:string}} voiceCfg
 */
export function tagMap(voiceCfg) {
  const model = (voiceCfg && voiceCfg.model) || DEFAULT_MODEL;
  return /^eleven_v[34]/.test(model) ? V3_TAGS : null;
}

/**
 * Character alignment with every `[tag]` span removed, so a tag never becomes a caption word.
 * @param {{characters:string[], character_start_times_seconds:number[], character_end_times_seconds:number[]}} align
 */
export function alignmentWithoutTags(align) {
  const chars = align.characters.join("");
  const drop = new Set();
  for (const [s, e] of tagSpans(chars)) for (let i = s; i < e; i++) drop.add(i);
  const keep = (_, i) => !drop.has(i);
  return {
    text: align.characters.filter(keep).join(""),
    starts: align.character_start_times_seconds.filter(keep),
    ends: align.character_end_times_seconds.filter(keep),
  };
}

/**
 * @param {{text:string, voice?:string, voiceCfg?:{model?:string}, outPath:string, lineStart?:number}} args
 */
export async function synth({ text, voice, voiceCfg, outPath, lineStart = 0 }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set. Export it, or pick another provider with --provider."
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
      body: JSON.stringify({ text, model_id: (voiceCfg && voiceCfg.model) || DEFAULT_MODEL }),
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
    const spoken = alignmentWithoutTags(align);
    words = wordsFromCharAlignment(spoken.text, spoken.starts, spoken.ends, lineStart);
  }
  return { wavPath: outPath, words };
}
