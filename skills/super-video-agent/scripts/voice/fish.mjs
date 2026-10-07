// fish.audio TTS provider. Env: FISH_AUDIO_API_KEY (or FISH_API_KEY, the name Fish Audio documents), FISH_AUDIO_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { decodeMonoPcm } from "../lib/audio-analysis.mjs";
import { writeWavPCM16 } from "../lib/wav.mjs";
import { planCuts, cutClips, withSentenceEnd, groupByChars, sentLength, refuseOversize } from "../lib/line-split.mjs";

export const name = "fish";

const SAMPLE_RATE = 48000;
// Fish Audio documents no fixed text limit; one request stays at the length ElevenLabs takes.
const BATCH_MAX_CHARS = 2500;

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

function credentials(voice) {
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
  return { apiKey, referenceId };
}

async function requestSpeech({ apiKey, referenceId }, text, voiceCfg) {
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
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Every line of one voice in one request (several past BATCH_MAX_CHARS), cut into one clip per
 * line at the silences: Fish returns no word times. A request whose silences do not split into
 * the lines is sent again one line per request. A single line is sent alone.
 * @param {{id:string, text:string, outPath:string}[]} items
 * @param {{voiceCfg?:{model?:string, voiceId?:string}}} ctx
 */
export async function synthBatch(items, ctx) {
  const voiceCfg = ctx && ctx.voiceCfg;
  refuseOversize(items, { limit: BATCH_MAX_CHARS, provider: "fish" });
  const results = [];
  for (const group of groupByChars(items, BATCH_MAX_CHARS, sentLength)) {
    results.push(...(await speakAndCut(group, voiceCfg)));
  }
  return results;
}

async function speakAndCut(items, voiceCfg) {
  const creds = credentials(voiceCfg && voiceCfg.voiceId);
  if (items.length > 1) {
    const sent = items.map((it) => withSentenceEnd(it.text));
    const buf = await requestSpeech(creds, sent.join(" "), voiceCfg);
    const scratch = items[0].outPath.replace(/\.wav$/, ".raw.wav");
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.writeFileSync(scratch, buf);
    let samples;
    try {
      samples = await decodeMonoPcm(scratch, SAMPLE_RATE);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    const plan = planCuts({ samples, sr: SAMPLE_RATE, texts: sent, cutOptions: voiceCfg && voiceCfg.cut });
    if (plan) return cutClips(items, samples, SAMPLE_RATE, plan, null, writeWavPCM16, voiceCfg && voiceCfg.cut);
    process.stderr.write("note: fish silences do not split into the lines; sending one request per line\n");
  }
  const out = [];
  for (const it of items) out.push({ id: it.id, ...(await synth({ text: it.text, voice: voiceCfg && voiceCfg.voiceId, voiceCfg, outPath: it.outPath })) });
  return out;
}

/**
 * @param {{text:string, voice?:string, voiceCfg?:{model?:string}, outPath:string}} args
 */
export async function synth({ text, voice, voiceCfg, outPath }) {
  const buf = await requestSpeech(credentials(voice), text, voiceCfg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, ".raw.wav");
  fs.writeFileSync(rawPath, buf);
  await ffmpeg(["-y", "-i", rawPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(rawPath, { force: true });
  return { wavPath: outPath };
}
