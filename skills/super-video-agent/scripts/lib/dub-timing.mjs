// Pure timing math for dub.mjs (references/pipeline.md "Picture first and
// language versions"): fitting each dub line's own audio into its base
// line's slot (base line start -> next base line start, the last line's
// slot runs to the film's end), never cutting audio and never moving the
// picture. No I/O, no ffmpeg.

const DEFAULT_MAX_ATEMPO = 1.2;

/**
 * Base-clock slots: slot i spans from base line i's start to base line
 * i+1's start (the last line's slot runs to filmDuration).
 * @param {{id:string, start:number, end:number}[]} baseLines
 * @param {number} filmDuration
 * @returns {{id:string, start:number, end:number}[]}
 */
export function computeSlots(baseLines, filmDuration) {
  return baseLines.map((l, i) => ({
    id: l.id,
    start: l.start,
    end: i === baseLines.length - 1 ? filmDuration : baseLines[i + 1].start,
  }));
}

/**
 * Whether a dub line's own clip fits its slot: unchanged if it already
 * fits, sped up (atempo) up to `maxAtempo` if it is longer, or refused if
 * even `maxAtempo` is not enough (the script needs shortening, not the
 * render — audio is never cut and the picture never moves).
 * @param {number} clipDurationSec measured duration of the dub line's own wav
 * @param {number} slotDurationSec
 * @param {number} [maxAtempo]
 * @returns {{ok:true, atempoFactor:number, actualDurationSec:number} | {ok:false, requiredFactor:number, maxAtempo:number}}
 */
export function fitLineToSlot(clipDurationSec, slotDurationSec, maxAtempo = DEFAULT_MAX_ATEMPO) {
  if (clipDurationSec <= slotDurationSec) {
    return { ok: true, atempoFactor: 1, actualDurationSec: clipDurationSec };
  }
  const requiredFactor = clipDurationSec / slotDurationSec;
  if (requiredFactor > maxAtempo + 1e-9) {
    return { ok: false, requiredFactor, maxAtempo };
  }
  const atempoFactor = Math.min(requiredFactor, maxAtempo);
  return { ok: true, atempoFactor, actualDurationSec: clipDurationSec / atempoFactor };
}

/**
 * A dub line's own measured words (voice.mjs's own timings.json, on that
 * line's own synthesis timeline) onto the base clock: clip-relative first
 * (subtract the dub line's own start), scaled by the same atempo factor
 * that fit its audio, then placed at the slot's start.
 * @param {{w:string, start:number, end:number}[]} words
 * @param {number} dubLineStart the dub line's own start, on its own timeline
 * @param {number} atempoFactor from fitLineToSlot
 * @param {number} slotStart the base slot's start (this line's new absolute start)
 */
export function shiftAndScaleWords(words, dubLineStart, atempoFactor, slotStart) {
  return (words || []).map((w) => ({
    w: w.w,
    start: slotStart + (w.start - dubLineStart) / atempoFactor,
    end: slotStart + (w.end - dubLineStart) / atempoFactor,
  }));
}

/**
 * Fits every dub line into its base slot and lays the whole dub out on the
 * base clock. Fails closed: if any line does not fit even at `maxAtempo`,
 * no line is placed — the caller reports every failing id and by how much,
 * so the script gets shortened rather than the render silently degrading.
 * @param {{id:string, start:number, end:number}[]} baseLines
 * @param {{id:string, text:string, start:number, end:number, words?:object[]}[]} dubLines dub voice/timings.json's lines
 * @param {Map<string,number>} clipDurations id -> measured duration (sec) of dub/voice/line-<id>.wav
 * @param {number} filmDuration
 * @param {number} [maxAtempo]
 * @returns {{ok:true, lines:{id:string,text:string,start:number,end:number,atempoFactor:number,words:object[]}[]} | {ok:false, failures:{id:string,requiredFactor:number|null,maxAtempo:number,reason?:string}[]}}
 */
export function fitAllLines(baseLines, dubLines, clipDurations, filmDuration, maxAtempo = DEFAULT_MAX_ATEMPO) {
  const slots = computeSlots(baseLines, filmDuration);
  const dubById = new Map(dubLines.map((l) => [l.id, l]));

  const failures = [];
  const fits = [];
  for (const slot of slots) {
    const dubLine = dubById.get(slot.id);
    if (!dubLine) {
      failures.push({ id: slot.id, requiredFactor: null, maxAtempo, reason: "no matching dub line id" });
      continue;
    }
    const clipDur = clipDurations.get(slot.id);
    if (clipDur == null) {
      failures.push({ id: slot.id, requiredFactor: null, maxAtempo, reason: "no measured clip duration" });
      continue;
    }
    const slotDur = slot.end - slot.start;
    const fit = fitLineToSlot(clipDur, slotDur, maxAtempo);
    if (!fit.ok) {
      failures.push({ id: slot.id, requiredFactor: fit.requiredFactor, maxAtempo: fit.maxAtempo });
      continue;
    }
    fits.push({ slot, dubLine, fit });
  }
  if (failures.length) return { ok: false, failures };

  const lines = fits.map(({ slot, dubLine, fit }) => ({
    id: slot.id,
    text: dubLine.text,
    start: slot.start,
    end: slot.start + fit.actualDurationSec,
    atempoFactor: fit.atempoFactor,
    words: shiftAndScaleWords(dubLine.words, dubLine.start, fit.atempoFactor, slot.start),
  }));
  return { ok: true, lines };
}

/**
 * `dub/<code>/timings.placed.json` — the dub's fitted lines (fitAllLines'
 * `.lines`) on the base clock, same shape as voice/timings.json, for a
 * reel's own caption layer (?layer=captions&dub=<code>,
 * references/pipeline.md "Picture first") to load instead of its own
 * voice/timings.json. Written before dub.mjs tries that layer, so a
 * compliant page has it ready.
 * @param {{id:string,text:string,start:number,end:number,words:object[]}[]} fittedLines fitAllLines' `.lines`
 * @param {number} filmDuration
 * @param {string|null} [lang]
 */
export function buildPlacedTimings(fittedLines, filmDuration, lang = null) {
  return { duration: filmDuration, lines: fittedLines, lang, provider: "dub" };
}

export const MAX_ATEMPO_DEFAULT = DEFAULT_MAX_ATEMPO;

/** Fit replacement narration inside frozen caption windows, without moving the picture clock. */
export function fitFrozenLines(frozen, dubLines, clipDurations) {
  if (!Number.isFinite(frozen.duration) || frozen.duration <= 0 || !Array.isArray(frozen.lines) || !frozen.lines.length) {
    throw new Error("frozen timings need a positive duration and nonempty lines");
  }
  if (dubLines.length !== frozen.lines.length) throw new Error("replacement line count differs from frozen captions");
  const seen = new Set();
  return frozen.lines.map((slot, i) => {
    const line = dubLines[i];
    if (typeof slot.id !== "string" || !/^[\w-]+$/.test(slot.id) || seen.has(slot.id)) throw new Error("invalid or duplicate frozen line id");
    seen.add(slot.id);
    if (line.id !== slot.id || typeof slot.text !== "string" || slot.text !== line.text) {
      throw new Error(`line ${slot.id}: frozen caption text or order changed; use normal dub for caption changes`);
    }
    if (![slot.start, slot.end, line.start].every(Number.isFinite) || slot.start < 0 || slot.end <= slot.start ||
        slot.end > frozen.duration || (i > 0 && slot.start < frozen.lines[i - 1].end)) {
      throw new Error(`line ${slot.id}: invalid frozen window`);
    }
    const duration = clipDurations.get(slot.id);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`line ${slot.id}: missing or invalid clip duration`);
    const fit = fitLineToSlot(duration, slot.end - slot.start);
    if (!fit.ok) throw new Error(`line ${slot.id}: needs ${fit.requiredFactor.toFixed(3)}x; edit pauses locally before regenerating`);
    return {
      id: slot.id, text: slot.text, start: slot.start, end: slot.start + fit.actualDurationSec,
      slotEnd: slot.end, atempoFactor: fit.atempoFactor,
      words: shiftAndScaleWords(line.words, line.start, fit.atempoFactor, slot.start),
    };
  });
}

const DEFAULT_TRIM_THRESHOLD_DB = -45;
const DEFAULT_TRIM_PAD_SEC = 0.04;

/**
 * How much of a dub line's own clip is edge silence, to trim before it is
 * fitted to its slot (dub.mjs, found in production: a line needed 1.238x
 * atempo — over the 1.2x cap — only because the take carried ~0.13s of
 * trailing and ~0.03s of leading silence; trimming by hand made it fit at
 * 1.16x). Only the first and last non-silent window bound the cut — an
 * internal pause never gets trimmed — and `padSec` is always kept on each
 * side so a leading/trailing consonant is never clipped. No I/O: `windows`
 * is measured elsewhere (ffmpeg silencedetect or an RMS scan) and passed in.
 * @param {{startSec:number, endSec:number, rmsDb:number}[]} windows in
 *   order, spanning [0, clipDurationSec]
 * @param {number} clipDurationSec
 * @param {{thresholdDb?:number, padSec?:number}} [opts]
 * @returns {{leadTrimSec:number, tailTrimSec:number, trimmedStartSec:number, trimmedEndSec:number}}
 */
export function trimEdgeSilence(windows, clipDurationSec, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? DEFAULT_TRIM_THRESHOLD_DB;
  const padSec = opts.padSec ?? DEFAULT_TRIM_PAD_SEC;
  const speech = (windows || []).filter((w) => w.rmsDb > thresholdDb);
  if (!speech.length) {
    return { leadTrimSec: 0, tailTrimSec: 0, trimmedStartSec: 0, trimmedEndSec: clipDurationSec };
  }
  const trimmedStartSec = Math.max(0, speech[0].startSec - padSec);
  const trimmedEndSec = Math.min(clipDurationSec, speech[speech.length - 1].endSec + padSec);
  return {
    leadTrimSec: trimmedStartSec,
    tailTrimSec: Math.max(0, clipDurationSec - trimmedEndSec),
    trimmedStartSec,
    trimmedEndSec,
  };
}

export const TRIM_THRESHOLD_DB_DEFAULT = DEFAULT_TRIM_THRESHOLD_DB;
export const TRIM_PAD_SEC_DEFAULT = DEFAULT_TRIM_PAD_SEC;
