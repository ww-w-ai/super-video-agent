// The film clock of a film with no narration: one silent line per scene, with exact starts and ends from a
// timeline, and a silent narration.wav of exactly the film's length. render.mjs reads these like a real voice,
// so `final`, `--span` and `--assemble` work (references/assembly.md "A film with no narration").
import fs from "node:fs";
import path from "node:path";
import { createWavPcm16Writer } from "./audio-mix.mjs";

export const CLOCK_SAMPLE_RATE = 48000;
const KEYS = ["steps", "stages", "scenes", "lines", "shots"];

/**
 * @param {object} timeline {duration?, steps|stages|scenes|lines|shots: [{id, start, end}]}
 * @param {{fps?:number}} [opts]
 * @returns {{timings:{duration:number, clock:string, lines:object[]}, facts:string[]}}
 */
export function buildClock(timeline, opts = {}) {
  const key = KEYS.find((k) => Array.isArray(timeline && timeline[k]));
  if (!key) throw new Error(`the timeline has none of ${KEYS.map((k) => `"${k}"`).join(", ")} as an array`);
  const items = timeline[key];
  if (!items.length) throw new Error(`the timeline's "${key}" is empty`);
  validate(items, timeline.duration);
  const duration = timeline.duration ?? items[items.length - 1].end;
  const lines = items.map((s) => ({ id: s.id, text: "", start: s.start, end: s.end, words: [] }));
  return { timings: { duration, clock: "silent clock from a timeline, no narration", lines }, facts: factsOf(items, duration, opts.fps) };
}

function validate(items, duration) {
  const seen = new Set();
  let prevStart = -Infinity;
  let prevEnd = 0;
  for (const [i, s] of items.entries()) {
    const at = `item ${i + 1}${s && s.id ? ` "${s.id}"` : ""}`;
    if (!s || typeof s.id !== "string" || !s.id) throw new Error(`${at} has no id`);
    if (seen.has(s.id)) throw new Error(`${at}: the id is used twice`);
    seen.add(s.id);
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) throw new Error(`${at} needs numeric start and end`);
    if (s.start < 0 || s.end <= s.start) throw new Error(`${at}: start ${s.start} and end ${s.end} do not make a span inside the film`);
    if (s.start < prevStart) throw new Error(`${at} starts at ${s.start}, before the item above it`);
    if (s.start < prevEnd - 1e-9) throw new Error(`${at} starts at ${s.start}, before the item above it ends (${prevEnd})`);
    prevStart = s.start;
    prevEnd = s.end;
  }
  if (duration !== undefined && prevEnd > duration + 1e-9) throw new Error(`the last item ends at ${prevEnd}, after the timeline's duration ${duration}`);
}

function factsOf(items, duration, fps) {
  const facts = [];
  if (items[0].start > 1e-9) facts.push(`the first item starts at ${items[0].start} s, not 0: the film's first ${items[0].start} s belong to no line`);
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].start - items[i - 1].end;
    if (gap > 1e-9) facts.push(`gap ${gap.toFixed(3)} s after "${items[i - 1].id}" (it belongs to that item's frames)`);
  }
  const tail = duration - items[items.length - 1].end;
  if (tail > 1e-9) facts.push(`the film runs ${tail.toFixed(3)} s past the last item's end`);
  if (fps) {
    const off = items.flatMap((s) => [s.start, s.end]).filter((t) => Math.abs(t * fps - Math.round(t * fps)) > 1e-3);
    if (off.length) facts.push(`${off.length} edge(s) are not on the ${fps} fps frame grid (first: ${off[0]} s)`);
  }
  return facts;
}

/** A timings file that holds words or text is a real voice; the clock must not replace it unasked. */
export function realVoiceIn(timingsPath) {
  if (!fs.existsSync(timingsPath)) return false;
  try {
    const t = JSON.parse(fs.readFileSync(timingsPath, "utf8"));
    return (t.lines || []).some((l) => (l.text && l.text.trim()) || (l.words && l.words.length));
  } catch {
    return false;
  }
}

/** Writes a silent 16-bit mono WAV of `durationSec`, chunk by chunk (one second at a time). */
export function writeSilentWav(wavPath, durationSec, sampleRate = CLOCK_SAMPLE_RATE) {
  const frames = Math.round(durationSec * sampleRate);
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  const w = createWavPcm16Writer(wavPath, { channels: 1, sampleRate, frames });
  for (let done = 0; done < frames; done += sampleRate) w.write([new Float32Array(Math.min(sampleRate, frames - done))]);
  w.close();
  return frames;
}
