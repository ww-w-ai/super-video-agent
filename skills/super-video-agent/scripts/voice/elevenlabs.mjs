// ElevenLabs TTS provider, with-timestamps endpoint for provider-native
// word alignment (design.md §2.3). Env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
import fs from "node:fs";
import path from "node:path";
import { decodeMonoPcm } from "../lib/audio-analysis.mjs";
import { writeWavPCM16 } from "../lib/wav.mjs";
import { spokenRange, cutSpans, withQuietTail } from "../lib/line-split.mjs";
import { wordsFromCharAlignment } from "../lib/timing.mjs";
import { tagSpans } from "../lib/tags.mjs";

export const name = "elevenlabs";

const DEFAULT_MODEL = "eleven_multilingual_v2";

// Our delivery marks (lib/tags.mjs) in Eleven v3/v4 audio tags, from ElevenLabs' published tag
// list. Emphasis has no tag (ElevenLabs stresses capitalised words, which Korean and Japanese
// lack), so it is dropped; emotions pass as themselves.
const V3_TAGS = {
  pause: "[pause]",
  "long-pause": "[long pause]",
  whisper: "[whispers]",
  soft: "[softly]",
  hurry: "[rushed]",
  shout: "[shouts]",
  laugh: "[laughs]",
  chuckle: "[laughs]",
  sigh: "[sighs]",
  gasp: "[gasps]",
  "clear-throat": "[clears throat]",
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

const SAMPLE_RATE = 48000;
// One request's text stays well under the API's per-request limit; a longer script goes in
// several requests, each cut the same way.
const BATCH_MAX_CHARS = 2500;
// eleven_v3 often stops a Korean line mid-sound at the end of a request (measured 9 of 18 lines);
// a closing [pause] tag lets the last line finish (0 of 25). It is billed like text (8 characters),
// so it closes a request of several lines, never each line.
const CLOSING_PAUSE = " [pause]";
// Tags that make no sound; every other tag ([laughs], [sighs]) is part of its line's audio.
const SILENT_TAG = /^\[(?:short |long )?paus(?:e|es)\]$/i;

/**
 * A line in a joined request needs a sentence end, or the engine reads it into the next line
 * with no pause between them. A line that already ends in one is sent as it is.
 */
function withSentenceEnd(text) {
  const bare = text.replace(/(?:\s*\[[^\]\n]*\])+\s*$/, "").trim();
  return /[.!?…。！？]["'”’」』)]*$/.test(bare) ? text : `${text}.`;
}

function settings(voice, voiceCfg) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Export it, or pick another provider with --provider.");
  }
  const voiceId = voice || (voiceCfg && voiceCfg.voiceId) || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new Error("no ElevenLabs voice id: set plan.json meta.voice.voiceId or ELEVENLABS_VOICE_ID.");
  }
  return { apiKey, voiceId, model: (voiceCfg && voiceCfg.model) || DEFAULT_MODEL };
}

async function requestSpeech({ apiKey, voiceId, model }, text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

async function decodeSpeech(json, scratchPath) {
  fs.mkdirSync(path.dirname(scratchPath), { recursive: true });
  fs.writeFileSync(scratchPath, Buffer.from(json.audio_base64, "base64"));
  try {
    return await decodeMonoPcm(scratchPath, SAMPLE_RATE);
  } finally {
    fs.rmSync(scratchPath, { force: true });
  }
}

/** Where each item's text starts in the text the engine echoed back. */
function itemOffsets(chars, texts) {
  const out = [];
  let from = 0;
  for (const t of texts) {
    const at = chars.indexOf(t, from);
    if (at < 0) throw new Error(`ElevenLabs alignment does not contain the line "${t}"`);
    out.push(at);
    from = at + t.length;
  }
  return out;
}

/**
 * The item's own characters and times, rebased to `fromSec`, tags removed. Characters after the
 * last spoken one end with it, so the silence the engine times as a full stop never lengthens
 * the last word.
 */
function itemAlignment(align, at, length, fromSec, lastSpoken) {
  const slice = (xs) => xs.slice(at, at + length);
  const speechEnd = align.character_end_times_seconds[lastSpoken];
  const clamp = (t, k) => (at + k > lastSpoken ? Math.min(t, speechEnd) : t) - fromSec;
  return alignmentWithoutTags({
    characters: slice(align.characters),
    character_start_times_seconds: slice(align.character_start_times_seconds).map(clamp),
    character_end_times_seconds: slice(align.character_end_times_seconds).map(clamp),
  });
}

/**
 * One request for every item, cut into one clip per item at the silence between lines, each
 * ending in the same quiet tail. Words are timed from each clip's start.
 * @param {{id:string, text:string, outPath:string}[]} items
 */
async function speakAndCut(items, cfg) {
  const closing = items.length > 1 && tagMap({ model: cfg.model }) ? CLOSING_PAUSE : "";
  const json = await requestSpeech(cfg, items.map((it) => (items.length > 1 ? withSentenceEnd(it.text) : it.text)).join(" ") + closing);
  const samples = await decodeSpeech(json, items[0].outPath.replace(/\.wav$/, ".raw.mp3"));
  const align = json.alignment || json.normalized_alignment;
  if (!align || !Array.isArray(align.characters)) throw new Error("ElevenLabs returned no character alignment");

  const chars = align.characters.join("");
  const silentChars = new Set();
  for (const [s, e] of tagSpans(chars)) if (SILENT_TAG.test(chars.slice(s, e))) for (let i = s; i < e; i++) silentChars.add(i);
  const offsets = itemOffsets(chars, items.map((it) => it.text));
  const edges = items.map((it, k) => {
    const range = spokenRange(chars, offsets[k], offsets[k] + it.text.length, silentChars);
    if (!range) throw new Error(`ElevenLabs alignment has no spoken characters for line "${it.id}"`);
    return { start: align.character_start_times_seconds[range[0]], end: align.character_end_times_seconds[range[1]], last: range[1] };
  });
  const spans = cutSpans(edges, samples.length / SAMPLE_RATE);

  return items.map((it, k) => {
    const { from, to } = spans[k];
    const clip = samples.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
    const tailed = withQuietTail(clip, SAMPLE_RATE, undefined, (edges[k].end - from) * SAMPLE_RATE);
    fs.mkdirSync(path.dirname(it.outPath), { recursive: true });
    writeWavPCM16(it.outPath, [tailed.samples], SAMPLE_RATE);
    const spoken = itemAlignment(align, offsets[k], it.text.length, from, edges[k].last);
    const result = { id: it.id, wavPath: it.outPath, words: wordsFromCharAlignment(spoken.text, spoken.starts, spoken.ends, 0), wordsRelative: true };
    if (tailed.cut) result.flag = "TAIL";
    return result;
  });
}

/** Groups of items whose joined text stays under BATCH_MAX_CHARS. */
function batches(items) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && size + it.text.length + 1 > BATCH_MAX_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.text.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Every line in one request (several when the script is long), cut per line: the voice keeps
 * one read across the film, and one closing [pause] covers all of it. A single line is sent as
 * it is.
 * @param {{id:string, text:string, outPath:string}[]} items
 * @param {{voiceCfg?:{voiceId?:string, model?:string}}} ctx
 */
export async function synthBatch(items, ctx) {
  const cfg = settings(null, ctx && ctx.voiceCfg);
  const results = [];
  for (const group of batches(items)) results.push(...(await speakAndCut(group, cfg)));
  return results;
}

/**
 * @param {{id?:string, text:string, voice?:string, voiceCfg?:{model?:string}, outPath:string, lineStart?:number}} args
 */
export async function synth({ id = "line", text, voice, voiceCfg, outPath, lineStart = 0 }) {
  const [r] = await speakAndCut([{ id, text, outPath }], settings(voice, voiceCfg));
  return { wavPath: r.wavPath, words: r.words.map((w) => ({ ...w, start: w.start + lineStart, end: w.end + lineStart })), flag: r.flag };
}

