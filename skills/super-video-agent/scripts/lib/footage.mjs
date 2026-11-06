// Footage spans: real camera clips a page draws as a layer (references/pipeline.md "Footage spans").
// The page resolves plan.json `footage` into window.__reel.footage (Reel.footageSpans). This file is
// the Node side every script shares: the check of a resolved span, the frame math (film frame ->
// source frame), the one decode command per span, the source probe, and the field-audio cues
// render.mjs mixes. The native host (scripts/native/footage-host.mjs) decodes with it.
import { execFile } from "node:child_process";
import path from "node:path";

const EPS = 1e-6;
/** Default fades of a span's field audio: short enough to keep the cut, long enough to avoid a click. */
export const FIELD_FADE_IN_SEC = 0.015;
export const FIELD_FADE_OUT_SEC = 0.03;
const AUDIO_KEYS = new Set(["gainDb", "lufs", "stretch", "fadeInSec", "fadeOutSec"]);

/**
 * Throws, naming the entry, unless `spans` is an array of resolved spans
 * ({id, src, in, start, frames, speed, freeze, size?, filter?, audio?}), as Reel.footageSpans returns them.
 * @param {unknown} spans
 * @returns {object[]} the same array
 */
export function checkFootageSpans(spans) {
  if (!Array.isArray(spans)) throw new Error("window.__reel.footage must be an array of spans (Reel.footageSpans)");
  const seen = new Set();
  spans.forEach((s, i) => {
    const at = `footage[${i}]${s && s.id ? ` "${s.id}"` : ""}`;
    if (!s || typeof s.id !== "string" || !s.id) throw new Error(`${at} has no id`);
    if (seen.has(s.id)) throw new Error(`${at}: the id is used twice`);
    seen.add(s.id);
    if (typeof s.src !== "string" || !s.src) throw new Error(`${at} has no src`);
    for (const k of ["in", "start"]) if (!(Number.isFinite(s[k]) && s[k] >= 0)) throw new Error(`${at}: "${k}" must be seconds >= 0 (got ${s[k]})`);
    if (!(Number.isInteger(s.frames) && s.frames >= 1)) throw new Error(`${at}: "frames" must be a whole number >= 1 (got ${s.frames})`);
    if (!(Number.isFinite(s.speed) && s.speed > 0)) throw new Error(`${at}: "speed" must be > 0 (got ${s.speed})`);
    if (typeof s.freeze !== "boolean") throw new Error(`${at}: "freeze" must be true or false`);
    if (s.size != null && !(Array.isArray(s.size) && s.size.length === 2 && s.size.every((v) => Number.isInteger(v) && v > 0))) throw new Error(`${at}: "size" must be [width, height] in px`);
    if (s.filter != null && typeof s.filter !== "string") throw new Error(`${at}: "filter" must be an ffmpeg video filter string`);
    checkAudio(s.audio, at);
  });
  return spans;
}

function checkAudio(audio, at) {
  if (audio == null || audio === false) return;
  if (typeof audio !== "object" || Array.isArray(audio)) throw new Error(`${at}: "audio" must be false or an object`);
  for (const k of Object.keys(audio)) if (!AUDIO_KEYS.has(k)) throw new Error(`${at}: audio.${k} is not a field audio setting (${[...AUDIO_KEYS].join(", ")})`);
  for (const k of ["gainDb", "lufs"]) if (audio[k] != null && !Number.isFinite(audio[k])) throw new Error(`${at}: audio.${k} must be a number`);
  for (const k of ["fadeInSec", "fadeOutSec"]) if (audio[k] != null && !(Number.isFinite(audio[k]) && audio[k] >= 0)) throw new Error(`${at}: audio.${k} must be seconds >= 0`);
  if (audio.stretch != null && typeof audio.stretch !== "boolean") throw new Error(`${at}: audio.stretch must be true or false`);
}

/** The span's own frame shown at film time `t` (0 = its first film frame), clamped to the span. */
export function spanFrameAt(span, t, fps) {
  const n = Math.floor((t - span.start) * fps + EPS);
  return Math.max(0, Math.min(span.frames - 1, n));
}

/** The source frame (0 = the first decoded frame at `in`) shown at span frame `n`: a freeze holds frame 0, speed 0.5 shows each frame twice. */
export function sourceIndexAt(span, n) {
  return span.freeze ? 0 : Math.floor(n * span.speed + EPS);
}

/** The last source frame the span shows. */
export function lastSourceIndex(span) {
  return sourceIndexAt(span, span.frames - 1);
}

/** Source seconds of source frame `i`: the decoder runs at the film's fps from `in`. */
export function sourceSecOf(span, i, fps) {
  return span.in + i / fps;
}

/**
 * The fixed decode command of a span from source frame `from` on, `count` frames, as raw RGBA.
 * Frame i is always the i-th frame `fps=` makes from `in`: `select` drops the first `from` frames
 * after the fps filter, so starting later decodes the same pixels, and passthrough keeps ffmpeg
 * from filling the dropped head with copies.
 */
export function decoderArgs({ src, inSec, fps, width, height, filter = null, from = 0, count }) {
  const vf = [`fps=${fps}`, `select=gte(n\\,${from})`, filter, `scale=${width}:${height}:flags=lanczos+accurate_rnd+full_chroma_int`, "format=rgba"].filter(Boolean).join(",");
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(inSec), "-i", src, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-frames:v", String(count), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
}

/**
 * Display size (rotation applied), audio presence and length of a video file.
 * @returns {Promise<{width:number, height:number, rotation:number, hasAudio:boolean, duration:number|null}>}
 */
export function probeFootageSource(file) {
  const args = ["-v", "error", "-show_entries", "stream=codec_type,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration", "-of", "json", file];
  return new Promise((resolve, reject) => {
    execFile("ffprobe", args, { maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`footage source ${file} cannot be read: ${(stderr || err.message).trim()}`));
      try {
        resolve(sourceFacts(JSON.parse(stdout), file));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** The facts probeFootageSource returns, from ffprobe's JSON. */
export function sourceFacts(probe, file = "the source") {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`footage source ${file} has no video stream`);
  const side = (video.side_data_list || []).find((d) => d.rotation != null);
  const rotation = Number(side ? side.rotation : (video.tags && video.tags.rotate) || 0) || 0;
  const turned = Math.abs(rotation) % 180 === 90;
  const duration = probe.format && probe.format.duration != null ? Number(probe.format.duration) : null;
  return { width: turned ? video.height : video.width, height: turned ? video.width : video.height, rotation, hasAudio: streams.some((s) => s.codec_type === "audio"), duration: Number.isFinite(duration) ? duration : null };
}

/** Decode size: the span's own `size`, else the source scaled so its long side is at most the stage's long side (never enlarged), in even px. */
export function decodeSize(source, stage, size = null) {
  if (size) return { width: size[0], height: size[1] };
  const k = Math.min(1, Math.max(stage.width, stage.height) / Math.max(source.width, source.height));
  const even = (v) => Math.max(2, 2 * Math.round((v * k) / 2));
  return { width: even(source.width), height: even(source.height) };
}

/**
 * The field-audio cue of each span that sounds, in film seconds: a span at speed 1 plays its
 * source sound from `in`; a freeze is silent; another speed is silent unless audio.stretch
 * (then the sound is slowed or sped by the same factor, so it stays on its picture);
 * `audio: false` mutes. Pure.
 * @returns {{id:string, src:string, atSec:number, trimSec:number, leadSec:number, tempo:number, gainDb:number, lufs:number|null, fadeInSec:number, fadeOutSec:number}[]}
 */
export function fieldAudioPlan(spans, fps) {
  const out = [];
  for (const s of spans) {
    const a = s.audio === false ? null : s.audio || {};
    if (!a || s.freeze || (s.speed !== 1 && !a.stretch)) continue;
    out.push({
      id: s.id,
      src: s.src,
      atSec: s.start,
      trimSec: s.frames / fps,
      leadSec: s.in,
      tempo: s.speed,
      gainDb: a.gainDb || 0,
      lufs: a.lufs == null ? null : a.lufs,
      fadeInSec: a.fadeInSec == null ? FIELD_FADE_IN_SEC : a.fadeInSec,
      fadeOutSec: a.fadeOutSec == null ? FIELD_FADE_OUT_SEC : a.fadeOutSec,
    });
  }
  return out;
}

/** ffmpeg atempo stages for `tempo` (one stage takes 0.5..100). */
export function atempoChain(tempo) {
  const stages = [];
  let rest = tempo;
  while (rest < 0.5 - EPS) {
    stages.push(0.5);
    rest /= 0.5;
  }
  while (rest > 100 + EPS) {
    stages.push(100);
    rest /= 100;
  }
  stages.push(rest);
  return stages.map((v) => `atempo=${+v.toFixed(6)}`).join(",");
}

/** Integrated loudness (LUFS) of a file's sound between `fromSec` and `fromSec + sec`, or null when silent. */
export function measureSpanLufs(file, fromSec, sec) {
  const args = ["-hide_banner", "-nostdin", "-ss", String(fromSec), "-t", String(sec), "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 1 << 26 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`loudness of ${file} could not be measured: ${String(stderr).trim().split("\n").pop()}`));
      const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr);
      resolve(m && m[1] !== "-inf" && Number(m[1]) > -70 ? Number(m[1]) : null);
    });
  });
}

/**
 * The mix cues (audio-mix.mjs buildCueMixFilter) for the spans' field audio: the source level kept
 * (`levelDb`), or brought to audio.lufs over the span's own seconds, plus audio.gainDb. A source with
 * no audio stream is left out and named in `notes`.
 * @param {object[]} spans resolved spans (window.__reel.footage)
 * @param {{root:string, fps:number, duck?:boolean, probe?:Function, measure?:Function}} opts
 *   duck false: never dip under narration (a film whose clock is silent).
 * @returns {Promise<{cues:object[], notes:string[]}>}
 */
export async function fieldAudioCues(spans, { root, fps, duck = true, probe = probeFootageSource, measure = measureSpanLufs }) {
  checkFootageSpans(spans);
  const cues = [];
  const notes = [];
  const probed = new Map();
  for (const p of fieldAudioPlan(spans, fps)) {
    const absPath = path.resolve(root, p.src);
    if (!probed.has(absPath)) probed.set(absPath, await probe(absPath));
    if (!probed.get(absPath).hasAudio) {
      notes.push(`footage "${p.id}": ${p.src} has no audio stream; the span is silent`);
      continue;
    }
    let levelDb = 0;
    if (p.lufs != null) {
      const measured = await measure(absPath, p.leadSec, p.trimSec * p.tempo);
      if (measured == null) notes.push(`footage "${p.id}": no measurable sound in its span; audio.lufs left the source level as it is`);
      else levelDb = p.lufs - measured;
    }
    cues.push({ absPath, atSec: p.atSec, trimSec: p.trimSec, leadSec: p.leadSec, tempo: p.tempo, levelDb, gainDb: p.gainDb, fadeInSec: p.fadeInSec, fadeOutSec: p.fadeOutSec, duck });
  }
  return { cues, notes };
}
