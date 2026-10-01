// Pure helpers voice.mjs uses to edit an existing narration without
// re-synthesis: choosing among takes (--pick-by), carrying measured word
// times across a partial rebuild, the dub-folder note, the STT language, and
// inserting a pause into a finished line (--insert-pause). No TTS, no STT,
// no ffmpeg here — only arithmetic and PCM16 WAV bytes.
import fs from "node:fs";
import path from "node:path";

/** `<reel>/dub/<code>/` → "<code>", anything else → null. */
export function dubCode(dir) {
  const root = path.resolve(dir);
  return path.basename(path.dirname(root)) === "dub" ? path.basename(root) : null;
}

/**
 * The line printed after a partial rebuild (--lines/--pick/--use/--insert-pause).
 * In a dub folder the picture is the base film's and never moves; dub.mjs
 * re-places the new lines into it. In a reel, lines whose start moved have
 * shots that re-render.
 * @param {string} dir the reel (or dub) directory voice.mjs ran on
 * @param {string[]} moved ids of lines whose start changed
 * @returns {string} "" when there is nothing to say
 */
export function partialRebuildNote(dir, moved) {
  const code = dubCode(dir);
  if (code) {
    const shifted = moved.length ? ` Lines with a shifted start: ${moved.join(", ")}.` : "";
    return `dub folder (dub/${code}/): the picture does not move — run dub.mjs --lang ${code} to re-place the lines.${shifted}\n`;
  }
  return moved.length ? `lines with shifted start (their shots will re-render): ${moved.join(", ")}\n` : "";
}

/**
 * `--pick-by`'s value: "length:<sec>" (take whose installed length is closest
 * to <sec>) or "stt" (take with the lowest character error rate).
 * @returns {{by:"length", sec:number} | {by:"stt"}}
 */
export function parsePickBy(value) {
  const s = String(value === true ? "" : value).trim();
  if (s === "stt") return { by: "stt" };
  const m = /^length:([0-9]*\.?[0-9]+)$/.exec(s);
  if (m && Number(m[1]) > 0) return { by: "length", sec: Number(m[1]) };
  throw new Error(`--pick-by: expected length:<sec> or stt, got "${s}"`);
}

/**
 * The take number to install for one line.
 * @param {{k:number, lengthSec:number, cer:number|null}[]} rows that line's takes
 * @param {{by:"length", sec:number} | {by:"stt"}} pickBy
 * @returns {number} k — ties go to the lower take number
 */
export function chooseTake(rows, pickBy) {
  const score = pickBy.by === "length" ? (r) => Math.abs(r.lengthSec - pickBy.sec) : (r) => r.cer;
  const candidates = rows.filter((r) => score(r) != null && Number.isFinite(score(r)));
  if (!candidates.length) {
    throw new Error(pickBy.by === "stt" ? "--pick-by stt: no take has an STT result (is SVA_STT_PYTHON set?)" : "--pick-by: no takes to choose from");
  }
  let best = candidates[0];
  for (const r of candidates) {
    if (score(r) < score(best) || (score(r) === score(best) && r.k < best.k)) best = r;
  }
  return best.k;
}

/**
 * A reused line's previous word times, moved by how far its start moved.
 * Returns null when there is nothing to carry or the caption text changed
 * (old words would no longer match it).
 * @param {{start:number, text?:string, words?:{start:number,end:number}[]}|undefined} prevLine
 * @param {string} timedText this run's caption text, caption breaks stripped
 * @param {number} newStart this run's start of the line
 * @param {(s:string)=>string} strip caption-break stripper applied to prevLine.text
 */
export function carriedWords(prevLine, timedText, newStart, strip = (s) => s) {
  if (!prevLine || !Array.isArray(prevLine.words) || !prevLine.words.length) return null;
  if (strip(String(prevLine.text ?? "")) !== timedText) return null;
  const delta = newStart - prevLine.start;
  return prevLine.words.map((w) => ({
    ...w,
    ...(typeof w.start === "number" ? { start: w.start + delta } : {}),
    ...(typeof w.end === "number" ? { end: w.end + delta } : {}),
  }));
}

/** meta.lang ("ko-KR", "en-US", ...) -> a faster-whisper language code. */
export function sttLangCode(lang) {
  const s = String(lang || "ko").toLowerCase();
  return s.slice(0, 2) || "ko";
}

/**
 * The language `--stt-only` transcribes in: timings.json's own lang, then
 * plan.json meta.lang, then null (sttLangCode's default).
 */
export function sttOnlyLang(timings, plan) {
  return (timings && timings.lang) || (plan && plan.meta && plan.meta.lang) || null;
}

/**
 * `--insert-pause id@word=ms,id@word=ms` → [{id, word, ms}]. `word` is the
 * 0-based index into that line's timings.json words; the pause goes between
 * it and the next word.
 */
export function parseInsertPause(value) {
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^([^@=]+)@([0-9]+)=([0-9]*\.?[0-9]+)$/.exec(entry);
      if (!m || !(Number(m[3]) > 0)) {
        throw new Error(`--insert-pause: invalid entry "${entry}" (expected <id>@<word-index>=<ms>)`);
      }
      return { id: m[1].trim(), word: Number(m[2]), ms: Number(m[3]) };
    });
}

// How far past the measured word edges the quiet point may be searched:
// measured word boundaries are approximate, so the true gap can sit a little
// outside them — but never past the middle of either word.
const PAUSE_SEARCH_PAD_SEC = 0.08;

/**
 * The span of a line (seconds from the line's own start) searched for the
 * quietest point between word `wordIndex` and the next one.
 * @param {{start:number,end:number}[]} words absolute word times
 * @param {number} wordIndex
 * @param {number} lineStart absolute line start
 * @param {number} lineDur line length
 * @returns {{fromSec:number, toSec:number}}
 */
export function pauseWindow(words, wordIndex, lineStart, lineDur) {
  const w = words[wordIndex];
  const n = words[wordIndex + 1];
  if (!w) throw new Error(`--insert-pause: no word ${wordIndex} (the line has ${words.length})`);
  if (!n) throw new Error(`--insert-pause: word ${wordIndex} is the line's last word — nothing follows it`);
  const lo = Math.min(w.end, n.start) - PAUSE_SEARCH_PAD_SEC;
  const hi = Math.max(w.end, n.start) + PAUSE_SEARCH_PAD_SEC;
  const from = Math.max(lo, (w.start + w.end) / 2) - lineStart;
  const to = Math.min(hi, (n.start + n.end) / 2) - lineStart;
  return { fromSec: Math.max(0, from), toSec: Math.min(lineDur, Math.max(to, from)) };
}

/**
 * Sample index at the centre of the quietest 10 ms window (5 ms hop) within
 * [fromSec, toSec]. A span shorter than one window returns its centre.
 * @param {Int16Array} samples mono PCM16
 * @param {number} rate
 */
export function quietestSample(samples, rate, fromSec, toSec) {
  const win = Math.max(2, Math.round(rate / 100));
  const hop = Math.max(1, Math.floor(win / 2));
  const s0 = Math.max(0, Math.floor(fromSec * rate));
  const s1 = Math.min(samples.length, Math.floor(toSec * rate));
  if (s1 - s0 < win) return Math.min(samples.length, Math.round((s0 + s1) / 2));
  let best = Infinity;
  let bestAt = s0 + Math.floor(win / 2);
  for (let s = s0; s + win <= s1; s += hop) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += samples[i] * samples[i];
    if (e < best) {
      best = e;
      bestAt = s + Math.floor(win / 2);
    }
  }
  return bestAt;
}

/** `samples` with `count` zero samples inserted at index `at`. */
export function insertSilence(samples, at, count) {
  const out = new Int16Array(samples.length + count);
  out.set(samples.subarray(0, at), 0);
  out.set(samples.subarray(at), at + count);
  return out;
}

/**
 * Timings after a pause of `pauseSec` inside line `id` after word
 * `wordIndex`: later words of that line, its end, every later line and the
 * total duration all move by exactly `pauseSec`. Mutates and returns `timings`.
 */
export function shiftForPause(timings, id, wordIndex, pauseSec) {
  const idx = timings.lines.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error(`--insert-pause: unknown line id "${id}"`);
  const line = timings.lines[idx];
  (line.words || []).forEach((w, i) => {
    if (i > wordIndex) shiftWord(w, pauseSec);
  });
  line.end += pauseSec;
  for (const later of timings.lines.slice(idx + 1)) {
    later.start += pauseSec;
    later.end += pauseSec;
    for (const w of later.words || []) shiftWord(w, pauseSec);
  }
  if (typeof timings.duration === "number") timings.duration += pauseSec;
  return timings;
}

function shiftWord(w, sec) {
  if (typeof w.start === "number") w.start += sec;
  if (typeof w.end === "number") w.end += sec;
}

/**
 * Reads a mono 16-bit PCM WAV (any chunk order).
 * @returns {{rate:number, samples:Int16Array}}
 */
export function readWavMono16(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a WAV file`);
  }
  let fmt = null;
  let data = null;
  for (let p = 12; p + 8 <= buf.length; ) {
    const tag = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (tag === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (tag === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: WAV has no fmt/data chunk`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
    throw new Error(`${file}: expected mono 16-bit PCM, got ${fmt.channels} ch ${fmt.bits}-bit format ${fmt.format}`);
  }
  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { rate: fmt.rate, samples };
}

/** Writes mono 16-bit PCM samples as a WAV. */
export function writeWavMono16(file, samples, rate) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}
