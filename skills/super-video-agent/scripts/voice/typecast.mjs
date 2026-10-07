// Typecast TTS provider, with-timestamps endpoint for provider-native word alignment.
// Env: TYPECAST_API_KEY (header X-API-KEY), TYPECAST_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { decodeMonoPcm } from "../lib/audio-analysis.mjs";
import { writeWavPCM16 } from "../lib/wav.mjs";
import { planCuts, cutClips, withSentenceEnd, groupByChars, sentLength, refuseOversize } from "../lib/line-split.mjs";

export const name = "typecast";

const SAMPLE_RATE = 48000;
// Typecast's documented text limit per request is 2,000 characters [verify against the current
// API reference]; a longer script goes in several requests, each cut the same way.
const BATCH_MAX_CHARS = 2000;

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
 * The request's emotion preset: the voice's own (voiceCfg.emotion) when it names a preset, else
 * "normal". `?` and `!` never change it; the model reads them from the text.
 * @param {{emotion?:string}} [voiceCfg]
 */
export function pickEmotionPreset(voiceCfg) {
  const forced = voiceCfg && voiceCfg.emotion;
  return EMOTION_PRESETS.includes(forced) ? forced : "normal";
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
    emotion_preset: pickEmotionPreset(cfg),
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

function credentials(voice) {
  const apiKey = process.env.TYPECAST_API_KEY;
  if (!apiKey) {
    throw new Error("TYPECAST_API_KEY is not set. Export it, or pick another provider with --provider.");
  }
  const voiceId = voice || process.env.TYPECAST_VOICE_ID;
  if (!voiceId) {
    throw new Error("no Typecast voice id: set plan.json meta.voice.voiceId or TYPECAST_VOICE_ID.");
  }
  return { apiKey, voiceId };
}

async function requestSpeech(apiKey, body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Typecast TTS failed: ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

/**
 * Every line of one voice in one request (several past BATCH_MAX_CHARS), cut into one clip per
 * line by Typecast's word times, or at the silences when the words do not map onto the lines.
 * One emotion preset covers the request (the voice's own, default normal); `?` and `!` stay in
 * the text so the model reads the intonation. A line with its own emotion is never in this
 * request: voice.mjs sends it alone (resolveLineVoice).
 * @param {{id:string, text:string, outPath:string}[]} items
 * @param {{lang?:string, voiceCfg?:object}} ctx
 */
export async function synthBatch(items, ctx) {
  const { lang, voiceCfg } = ctx || {};
  refuseOversize(items, { limit: BATCH_MAX_CHARS, provider: "typecast" });
  if (items.length === 1) {
    const [it] = items;
    return [{ id: it.id, ...(await synth({ text: it.text, voice: voiceCfg && voiceCfg.voiceId, lang, voiceCfg, outPath: it.outPath })) }];
  }
  const { apiKey, voiceId } = credentials(voiceCfg && voiceCfg.voiceId);
  const results = [];
  for (const group of groupByChars(items, BATCH_MAX_CHARS, sentLength)) {
    results.push(...(await speakAndCut(group, { apiKey, voiceId, lang, voiceCfg })));
  }
  return results;
}

async function speakAndCut(items, { apiKey, voiceId, lang, voiceCfg }) {
  if (items.length === 1) {
    const [it] = items;
    return [{ id: it.id, ...(await synth({ text: it.text, voice: voiceId, lang, voiceCfg, outPath: it.outPath })) }];
  }
  const sent = items.map((it) => withSentenceEnd(it.text));
  const json = await requestSpeech(apiKey, buildBody({ text: sent.join(" "), voiceId, lang, voiceCfg }));
  const scratch = items[0].outPath.replace(/\.wav$/, ".raw.wav");
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  fs.writeFileSync(scratch, Buffer.from(json.audio, "base64"));
  let samples;
  try {
    samples = await decodeMonoPcm(scratch, SAMPLE_RATE);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  const plan = planCuts({ samples, sr: SAMPLE_RATE, texts: sent, words: json.words, cutOptions: voiceCfg && voiceCfg.cut });
  if (!plan) {
    process.stderr.write("note: typecast words and silences do not split into the lines; sending one request per line\n");
    const out = [];
    for (const it of items) out.push({ id: it.id, ...(await synth({ text: it.text, voice: voiceId, lang, voiceCfg, outPath: it.outPath })) });
    return out;
  }
  return cutClips(items, samples, SAMPLE_RATE, plan, (k, from) => plan.lineWords && wordsFromTypecast(plan.lineWords[k], -from), writeWavPCM16, voiceCfg && voiceCfg.cut);
}

/**
 * The voices the account can use with `model` (default ssfm-v30), as the service lists them.
 * The key is sent in a header and never printed.
 * @param {{model?:string}} [opts]
 * @returns {Promise<object[]>}
 */
export async function listVoices(opts = {}) {
  const apiKey = process.env.TYPECAST_API_KEY;
  if (!apiKey) throw new Error("TYPECAST_API_KEY is not set. Export it to list voices.");
  const res = await fetch(`https://api.typecast.ai/v2/voices?model=${encodeURIComponent(opts.model || DEFAULT_MODEL)}`, { headers: { "X-API-KEY": apiKey } });
  if (!res.ok) throw new Error(`Typecast voice list failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.voices || json.result || [];
}

/**
 * @param {{text:string, voice?:string, lang?:string, voiceCfg?:object, outPath:string}} args
 */
export async function synth({ text, voice, lang, voiceCfg, outPath }) {
  const { apiKey, voiceId } = credentials(voice);
  const json = await requestSpeech(apiKey, buildBody({ text, voiceId, lang, voiceCfg }));
  const buf = Buffer.from(json.audio, "base64");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rawPath = outPath.replace(/\.wav$/, ".raw.wav");
  fs.writeFileSync(rawPath, buf);
  await ffmpeg(["-y", "-i", rawPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath]);
  fs.rmSync(rawPath, { force: true });
  // Clip-relative: voice.mjs moves them onto the timeline after the line's tempo is applied.
  return { wavPath: outPath, words: wordsFromTypecast(json.words, 0), wordsRelative: true };
}
