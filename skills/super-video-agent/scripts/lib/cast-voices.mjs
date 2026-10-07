// Reuses the plan voice schema and BCP 47 comparison. Cast files own speaker voices.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./reeldir.mjs";
import { validate } from "./schema-check.mjs";
import { parseLangTag, sameLanguageTag } from "./lang-tag.mjs";

const planSchema = JSON.parse(fs.readFileSync(new URL("../plan.schema.json", import.meta.url), "utf8"));
const voiceSchema = { ...planSchema.definitions.voice, definitions: planSchema.definitions };
const IDENTITY = ["provider", "voiceId", "refAudio", "refText", "refTokens", "model"];

/** Resolve once per run. Keep source plans free of copied voice settings. */
export function loadCastVoices(plan, dir) {
  const out = new Map();
  const speakers = plan.lines.filter((line) => line.speaker != null);
  if (!speakers.length) return out;
  if (!plan.meta.cast) throw new Error("lines with speaker need meta.cast");
  const castPath = path.resolve(dir, plan.meta.cast);
  const cast = readJson(castPath);
  const resolved = new Map();
  for (const line of speakers) {
    if (IDENTITY.some((key) => line.voice?.[key] != null)) throw new Error(`line "${line.id}": speaker voice identity belongs in the cast file`);
    const voices = cast.speakers?.[line.speaker]?.voices;
    if (!voices || typeof voices !== "object" || Array.isArray(voices)) throw new Error(`line "${line.id}": unknown cast speaker "${line.speaker}"`);
    const lang = line.lang || plan.meta.lang || "ko-KR";
    if (!parseLangTag(lang)) throw new Error(`line "${line.id}": invalid cast language "${lang}"`);
    const key = JSON.stringify([line.speaker, lang]);
    if (resolved.has(key)) { out.set(line.id, resolved.get(key)); continue; }
    const exact = Object.keys(voices).filter((tag) => tag.toLowerCase() === lang.toLowerCase());
    const matches = exact.length ? exact : Object.keys(voices).filter((tag) => sameLanguageTag(tag, lang) === true);
    if (matches.length !== 1) throw new Error(`line "${line.id}": cast speaker "${line.speaker}" needs one voice for ${lang} (found ${matches.length})`);
    const voice = { ...voices[matches[0]] };
    const { errors } = validate(voice, voiceSchema);
    if (errors.length || !voice.provider) throw new Error(`line "${line.id}": invalid cast voice: ${errors.join("; ") || "provider is required"}`);
    for (const key of ["refAudio", "refTokens"]) if (voice[key]) voice[key] = path.resolve(path.dirname(castPath), voice[key]);
    resolved.set(key, voice);
    out.set(line.id, voice);
  }
  return out;
}
