// Pure helpers voice.mjs uses to edit an existing narration without
// re-synthesis: choosing among takes (--pick-by), carrying measured word
// times across a partial rebuild, the dub-folder note, the STT language, and
// inserting a pause into a finished line (--insert-pause), and fitting a
// re-made take into the slot of the one it replaces. No TTS, no STT,
// no ffmpeg here — only arithmetic and PCM16 WAV bytes.
import fs from "node:fs";
import path from "node:path";
import { fitLineToSlot, MIN_BREATH_SEC, MAX_BREATH_SEC, MIN_ATEMPO, MAX_ATEMPO_DEFAULT } from "../lib/dub-timing.mjs";

/** A re-made take within this many seconds of the old clip's length counts as the same length. */
export const SAME_LENGTH_SEC = 0.005;

/**
 * Each previous line's slot: its start to the next line's start (the clip and the silence after it);
 * the last line's slot is its clip plus the planned pause. The re-take limit.
 * @param {{id:string, start:number, end:number}[]} prevLines timings.json lines of the run being edited
 * @param {{id:string, pauseAfterMs?:number}[]} planLines
 * @param {number} gapMs meta.gapMs
 * @returns {Map<string, {slotSec:number, oldClipSec:number}>}
 */
export function previousSlots(prevLines, planLines, gapMs) {
  const planned = new Map(planLines.map((l) => [l.id, l]));
  const slots = new Map();
  prevLines.forEach((l, i) => {
    const oldClipSec = l.end - l.start;
    const pauseSec = ((planned.get(l.id) || {}).pauseAfterMs ?? gapMs) / 1000;
    const next = prevLines[i + 1];
    slots.set(l.id, { slotSec: next ? next.start - l.start : oldClipSec + Math.max(pauseSec, MIN_BREATH_SEC), oldClipSec });
  });
  return slots;
}

/**
 * The pause a take that borrowed breath leaves in `timings.json` (`borrowedPause`), so a later rebuild
 * that reuses the clip lays the same pause and the next line keeps its start.
 * @param {number} plannedSec the pause the plan asked for after the line
 * @param {number} laidSec the shorter pause laid after the longer clip
 * @returns {{plannedSec:number, laidSec:number}}
 */
export function borrowedPauseRecord(plannedSec, laidSec) {
  return { plannedSec, laidSec };
}

/**
 * The pause to lay after a reused line: the borrowed one from the earlier run while the plan's pause is
 * still the one it was borrowed from, else null (the plan's own pause applies).
 * @param {{borrowedPause?:{plannedSec:number, laidSec:number}}|undefined} prevLine the line in the earlier timings.json
 * @param {number} plannedSec the pause the plan asks for now
 * @returns {number|null}
 */
export function carriedBorrowedGap(prevLine, plannedSec) {
  const b = prevLine && prevLine.borrowedPause;
  if (!b || !Number.isFinite(b.plannedSec) || !Number.isFinite(b.laidSec)) return null;
  return Math.abs(b.plannedSec - plannedSec) < 1e-3 ? b.laidSec : null;
}

/**
 * Plan lines to rebuild around a set of picks: every line that has audio or is picked. A line with no
 * clip yet (new text) cannot be reused, so it waits for `--lines <ids>` or a full pass.
 * @param {{id:string}[]} planLines
 * @param {string[]} pickedIds
 * @param {(id:string)=>boolean} hasClip
 * @returns {{lines:{id:string}[], waiting:string[]}}
 */
export function splitPlanByAudio(planLines, pickedIds, hasClip) {
  const picked = new Set(pickedIds);
  const waiting = planLines.filter((l) => !picked.has(l.id) && !hasClip(l.id)).map((l) => l.id);
  const left = new Set(waiting);
  return { lines: planLines.filter((l) => !left.has(l.id)), waiting };
}

/**
 * Whether a re-made base-language take fits the slot of the take it replaces, in the order dub.mjs
 * fits a language: speed up by at most 10% when too long, keep at least 0.5 s of breath after it,
 * slow down (not below 0.95x) to close a voice-free gap over 1.0 s. A gap the film already had
 * (a planned pause) is not counted against the take.
 * @returns {ReturnType<typeof fitLineToSlot>}
 */
export function planRetakeFit(takeSec, { slotSec, oldClipSec }) {
  const maxBreathSec = Math.max(MAX_BREATH_SEC, slotSec - oldClipSec);
  return fitLineToSlot(takeSec, slotSec, MAX_ATEMPO_DEFAULT, { minBreathSec: MIN_BREATH_SEC, maxBreathSec, minAtempo: MIN_ATEMPO });
}

/**
 * The line printed for a re-made or picked take: its length against the slot and against the take it
 * replaces, and what the fit does. A take that needs more than the speed limit says it is refused.
 */
export function retakeFitMessage(id, takeSec, slot, fit) {
  const head = `${id}: take ${takeSec.toFixed(2)}s, slot ${slot.slotSec.toFixed(2)}s, existing take ${slot.oldClipSec.toFixed(2)}s`;
  if (!fit.ok) {
    return `${head} — refused: needs ${fit.requiredFactor.toFixed(2)}x to fit its slot (limit ${fit.maxAtempo}x), not installed; the old take stays. Shorten the line's text or say, or re-synthesize it`;
  }
  const how = fit.atempoFactor > 1.0005 ? `sped up ${fit.atempoFactor.toFixed(2)}x` : fit.atempoFactor < 0.9995 ? `slowed to ${fit.atempoFactor.toFixed(2)}x` : "as is";
  const notes = [`${fit.breathSec.toFixed(2)}s of silence after it`];
  if (fit.breathShort) notes.push(`under the ${MIN_BREATH_SEC}s breath`);
  if (fit.longGap) notes.push(`voice-free gap over ${MAX_BREATH_SEC}s: a longer take or a rewrite closes it`);
  return `${head} — fits (${how}; ${notes.join("; ")})`;
}

/**
 * The seconds each line has on the picture, for the lines of a reel kept with `--retime` or a dub folder:
 * a reel's own previous slots, or in a dub folder the base reel's lines (`<reel>/voice/timings.json`, each
 * line to the next line's start, the last to the film's end). Empty when there is no such timings file.
 * @param {string} dir the reel (or dub) directory voice.mjs ran on
 * @param {Map<string, {slotSec:number}>} oldSlots previousSlots of the reel being edited
 * @returns {Map<string, number>}
 */
export function pictureSlotSecs(dir, oldSlots) {
  if (!dubCode(dir)) return new Map([...oldSlots].map(([id, s]) => [id, s.slotSec]));
  const baseFile = path.join(path.resolve(dir), "..", "..", "voice", "timings.json");
  if (!fs.existsSync(baseFile)) return new Map();
  const base = JSON.parse(fs.readFileSync(baseFile, "utf8"));
  const lines = base.lines || [];
  return new Map(lines.map((l, i) => [l.id, (i === lines.length - 1 ? base.duration : lines[i + 1].start) - l.start]));
}

/**
 * The line printed when a take is installed without being fitted (`--retime`, or a dub folder): its length
 * against the slot it has on the picture, as a ratio. Over 1 means the take is longer than the slot.
 */
export function retimeRatioMessage(id, takeSec, slotSec, reason) {
  const ratio = takeSec / slotSec;
  const verdict = ratio > 1 ? `${((ratio - 1) * 100).toFixed(1)}% over its slot` : `${((1 - ratio) * 100).toFixed(1)}% under its slot`;
  return `${id}: take ${takeSec.toFixed(2)}s against slot ${slotSec.toFixed(2)}s = ${ratio.toFixed(3)}x (${verdict}); installed at its own length (${reason})`;
}

/** The "slot" column of the takes table: what fitting this take into its slot takes. */
export function fitColumn(fit) {
  if (!fit) return "-";
  if (!fit.ok) return `over (needs ${fit.requiredFactor.toFixed(2)}x)`;
  return fit.atempoFactor > 1.0005 ? `${fit.atempoFactor.toFixed(2)}x` : fit.atempoFactor < 0.9995 ? `${fit.atempoFactor.toFixed(2)}x slowed` : "fits";
}

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
  if (!moved.length) return "";
  const stale = staleDubTracks(dir);
  const placed = stale.length ? `dub tracks placed on the old times (${stale.join(", ")}): run dub.mjs --lang <code> again for each\n` : "";
  return `lines with shifted start (their shots will re-render): ${moved.join(", ")}\n${placed}`;
}

/** Language codes under <reel>/dub/ that already hold a timings.placed.json. */
function staleDubTracks(dir) {
  const root = path.join(path.resolve(dir), "dub");
  try {
    return fs.readdirSync(root).filter((code) => fs.existsSync(path.join(root, code, "timings.placed.json"))).sort();
  } catch {
    return [];
  }
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
 * A row with `fits: false` runs over the line's slot and is never chosen; when no row fits the call
 * throws an error with `code: "NO_FIT"`. The take already installed is row k = 0: it competes on
 * the same score and wins ties, and a result of 0 means "keep the installed clip".
 * @param {{k:number, lengthSec:number, cer:number|null, fits?:boolean, needs?:number}[]} rows that line's takes
 * @param {{by:"length", sec:number} | {by:"stt"}} pickBy
 * @returns {number} k — ties go to the lower take number
 */
export function chooseTake(rows, pickBy) {
  const fitting = rows.filter((r) => r.fits !== false);
  const takes = rows.filter((r) => !r.installed);
  if (takes.length && !fitting.some((r) => !r.installed)) {
    const least = Math.min(...takes.map((r) => r.needs ?? Infinity));
    const err = new Error(`--pick-by: no take of "${takes[0].id}" fits its slot (the closest needs ${Number.isFinite(least) ? `${least.toFixed(2)}x` : "more speed"}, limit ${MAX_ATEMPO_DEFAULT}x) — shorten the line or re-synthesize it`);
    err.code = "NO_FIT";
    throw err;
  }
  const score = pickBy.by === "length" ? (r) => Math.abs(r.lengthSec - pickBy.sec) : (r) => r.cer;
  const candidates = fitting.filter((r) => score(r) != null && Number.isFinite(score(r)));
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

/** meta.lang ("ko-KR", "en-US", ...) -> a Whisper language code. */
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
