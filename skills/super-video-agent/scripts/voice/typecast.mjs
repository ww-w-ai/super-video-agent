// Typecast TTS provider, with-timestamps endpoint for provider-native word alignment.
// Env: TYPECAST_API_KEY (header X-API-KEY), TYPECAST_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

export const name = "typecast";

const DEFAULT_MODEL = "ssfm-v30";
const ENDPOINT = "https://api.typecast.ai/v1/text-to-speech/with-timestamps?granularity=word";

export const EMOTION_PRESETS = ["normal", "happy", "sad", "angry", "whisper", "toneup", "tonedown"];

// Typecast reads no inline tags; lib/tags.mjs drops every delivery mark for a null map.
export function tagMap() {
  return null;
}

// BCP 47 primary subtag -> ISO 639-3, for the languages ssfm-v30 lists.
const ISO3 = {
  ar: "ara", bn: "ben", bg: "bul", yue: "yue", zh: "zho", hr: "hrv", cs: "ces", da: "dan",
  nl: "nld", en: "eng", fi: "fin", fr: "fra", de: "deu", el: "ell", hi: "hin", hu: "hun",
  id: "ind", it: "ita", ja: "jpn", ko: "kor", ms: "msa", nan: "nan", no: "nor", nb: "nor",
  nn: "nor", pl: "pol", pt: "por", pa: "pan", ro: "ron", ru: "rus", sk: "slk", es: "spa",
  sv: "swe", tl: "tgl", fil: "tgl", ta: "tam", th: "tha", tr: "tur", uk: "ukr", vi: "vie",
};

/**
 * Plan lang (BCP 47, e.g. "ko", "en-US", "zh-Hans") to ISO 639-3; undefined when unknown so the
 * API auto-detects. A 3-letter code that Typecast lists passes through.
 * @param {string|undefined} lang
 * @returns {string|undefined}
 */
export function languageCode(lang) {
  if (!lang) return undefined;
  const tag = String(lang).toLowerCase();
  if (tag.startsWith("zh-hant") || tag === "zh-tw" || tag === "zh-hk") return "zho";
  const primary = tag.split(/[-_]/)[0];
  if (ISO3[primary]) return ISO3[primary];
  return Object.values(ISO3).includes(primary) ? primary : undefined;
}

/**
 * Owner rule: a line whose spoken text ends with "?" or "!" (also "?!", "!?", trailing quotes
 * or spaces) gets "toneup"; every other line "normal". voiceCfg.emotion overrides for the voice.
 * @param {string} text spoken text, tags already stripped
 * @param {{emotion?:string}} [voiceCfg]
 */
export function pickEmotionPreset(text, voiceCfg) {
  const forced = voiceCfg && voiceCfg.emotion;
  if (forced && EMOTION_PRESETS.includes(forced)) return forced;
  return /[?!][\s"'`‘’“”」』)\]]*$/.test(String(text)) ? "toneup" : "normal";
}

/**
 * Request body for with-timestamps.
 * @param {{text:string, voiceId:string, lang?:string, voiceCfg?:{model?:string, emotion?:string, emotionIntensity?:number}}} a
 */
export function buildBody({ text, voiceId, lang, voiceCfg }) {
  const cfg = voiceCfg || {};
  const model = cfg.model || DEFAULT_MODEL;
  const body = { text, model, voice_id: voiceId };
  const language = languageCode(lang);
  if (language) body.language = language;
  const intensity = typeof cfg.emotionIntensity === "number" ? cfg.emotionIntensity : 1;
  body.prompt = {
    emotion_type: "preset",
    emotion_preset: pickEmotionPreset(text, cfg),
    emotion_intensity: intensity,
  };
  body.output = { audio_format: "wav" };
  if (cfg.removeSilenceMs != null) {
    if (!Number.isInteger(cfg.removeSilenceMs) || cfg.removeSilenceMs < 0 || cfg.removeSilenceMs > 1000) {
      throw new Error("typecast removeSilenceMs must be an integer from 0 to 1000 (retained silence, not removed silence)");
    }
    body.output.remove_silence_ms = cfg.removeSilenceMs;
  }
  return body;
}

/**
 * Typecast word segments (clip-relative seconds) to our words on the narration timeline.
 * @param {{text:string,start:number,end:number}[]|null|undefined} words
 * @param {number} lineStart
 */
export function wordsFromTypecast(words, lineStart = 0) {
  if (!Array.isArray(words)) return undefined;
  const out = [];
  for (const x of words) {
    const w = String(x.text ?? "").trim();
    if (w && typeof x.start === "number" && typeof x.end === "number") {
      out.push({ w, start: lineStart + x.start, end: lineStart + x.end });
    }
  }
  return out.length ? out : undefined;
}

/**
 * @param {{text:string, voice?:string, lang?:string, voiceCfg?:object, outPath:string}} args
 */
export async function synth({ text, voice, lang, voiceCfg, outPath }) {
  const apiKey = process.env.TYPECAST_API_KEY;
  if (!apiKey) {
    throw new Error("TYPECAST_API_KEY is not set. Export it, or pick another provider with --provider.");
  }
  const voiceId = voice || process.env.TYPECAST_VOICE_ID;
  if (!voiceId) {
    throw new Error("no Typecast voice id: set plan.json meta.voice.voiceId or TYPECAST_VOICE_ID.");
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
    body: JSON.stringify(buildBody({ text, voiceId, lang, voiceCfg })),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Typecast TTS failed: ${res.status} ${res.statusText} ${body}`);
  }
  const json = await res.json();
  const buf = Buffer.from(json.audio, "base64");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, ".raw.wav");
  fs.writeFileSync(rawPath, buf);
  await ffmpeg(["-y", "-i", rawPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(rawPath, { force: true });
  // Clip-relative: voice.mjs moves them onto the timeline after the line's tempo is applied.
  return { wavPath: outPath, words: wordsFromTypecast(json.words, 0), wordsRelative: true };
}
