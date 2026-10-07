// Pure timing math for dub.mjs (references/pipeline.md "Picture first and
// language versions"): fitting each dub line's own audio into its base
// line's slot (base line start -> next base line start, the last line's
// slot runs to the film's end), never cutting audio and never moving the
// picture. No I/O, no ffmpeg.

// The picture's slot is the reference. Order for every line: sped up by at most
// 10% (pitch kept) when longer than its slot, then at least MIN_BREATH_SEC of
// silence after it when the slot has room; a line that leaves more than
// MAX_BREATH_SEC is slowed down to MIN_ATEMPO. A line that needs more speed is
// reported for rewording, not sped further. `--max-speed` widens this.
const DEFAULT_MAX_ATEMPO = 1.1;

// Silence kept after a line when its slot leaves room (SKILL.md: about 0.5 s
// after each line). A slot without room is reported, never cut silently.
export const MIN_BREATH_SEC = 0.5;
// Longest silence after a line: the silence gate's limit.
export const MAX_BREATH_SEC = 1.0;
// Slowest a line may be played to close a gap over MAX_BREATH_SEC.
export const MIN_ATEMPO = 0.95;
// A line whose silence is within this of its planned pause counts as having exactly that pause.
const PLANNED_GAP_TOLERANCE_SEC = 0.05;

/**
 * The silence after a line that counts as planned: its declared pause plus a small tolerance, or
 * 0 when the line has none. `planned` maps a line id to seconds.
 * @param {Map<string,number>|null} planned
 * @param {string} id
 */
export function allowedGapSec(planned, id) {
  const sec = planned && planned.get(id);
  return sec > 0 ? sec + PLANNED_GAP_TOLERANCE_SEC : 0;
}

/**
 * Planned silence after each base line, by id, from pictureGapPlan: the larger of the dub plan's
 * pauseAfterMs and the picture's own pause when that is over the silence gate.
 * @param {{id:string,pauseAfterMs?:number}[]} gapPlan pictureGapPlan's output
 * @returns {Map<string,number>}
 */
export function plannedGapMap(gapPlan) {
  return new Map((gapPlan || []).filter((g) => g.pauseAfterMs > 0).map((g) => [g.id, g.pauseAfterMs / 1000]));
}

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
 * Whether a dub line's own clip fits its slot. Order: unchanged if it fits
 * with `minBreathSec` of silence after it; sped up (atempo) up to `maxAtempo`
 * if longer; refused if even `maxAtempo` does not fit the slot itself (the
 * script needs shortening, not the render — audio is never cut and the
 * picture never moves). A line that leaves more than `maxBreathSec` of
 * silence is slowed down (atempo, pitch kept) to at most `minAtempo` to close the rest.
 * @param {number} clipDurationSec measured duration of the dub line's own wav
 * @param {number} slotDurationSec
 * @param {number} [maxAtempo]
 * @param {{minBreathSec?:number, maxBreathSec?:number, minAtempo?:number}} [opts]
 *   minBreathSec: speed up (within maxAtempo) to leave it; if even maxAtempo cannot, the line still fits the slot and `breathShort` is set.
 *   maxBreathSec: longest silence after a line; if slowing to minAtempo still leaves more, `longGap` is set.
 * @returns {{ok:true, atempoFactor:number, actualDurationSec:number, breathSec:number, breathShort:boolean, longGap:boolean} | {ok:false, requiredFactor:number, maxAtempo:number}}
 */
export function fitLineToSlot(clipDurationSec, slotDurationSec, maxAtempo = DEFAULT_MAX_ATEMPO, opts = {}) {
  const { minBreathSec = 0, maxBreathSec = Infinity, minAtempo = 1 } = opts;
  const limits = { minBreathSec, maxBreathSec };
  const room = slotDurationSec - minBreathSec;
  if (clipDurationSec <= room) {
    const gap = slotDurationSec - clipDurationSec;
    const slowedTo = gap > maxBreathSec ? Math.max(minAtempo, clipDurationSec / (slotDurationSec - maxBreathSec)) : 1;
    return fitResult(clipDurationSec, slotDurationSec, slowedTo, limits);
  }
  const breathFactor = room > 0 ? clipDurationSec / room : Infinity;
  if (breathFactor <= maxAtempo + 1e-9) {
    return fitResult(clipDurationSec, slotDurationSec, Math.min(breathFactor, maxAtempo), limits);
  }
  // No full breath is possible: fit the slot itself, as fast as allowed to leave the most breath.
  if (clipDurationSec / slotDurationSec > maxAtempo + 1e-9) {
    return { ok: false, requiredFactor: clipDurationSec / slotDurationSec, maxAtempo };
  }
  return fitResult(clipDurationSec, slotDurationSec, maxAtempo, limits);
}

function fitResult(clipDurationSec, slotDurationSec, atempoFactor, { minBreathSec, maxBreathSec }) {
  const actualDurationSec = clipDurationSec / atempoFactor;
  const breathSec = slotDurationSec - actualDurationSec;
  return {
    ok: true, atempoFactor, actualDurationSec, breathSec,
    breathShort: breathSec < minBreathSec - 1e-9,
    longGap: breathSec > maxBreathSec + 1e-9,
  };
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
 * @param {{minBreathSec?:number, maxBreathSec?:number, minAtempo?:number, plannedGapSec?:Map<string,number>}} [breath] see fitLineToSlot;
 *   plannedGapSec: id -> a pause the plan or picture declared, which is never slowed away; lines left with
 *   less breath go to `breathWarnings`, lines left with a longer gap (not the last line) to `longGaps`
 * @returns {{ok:true, lines:{id:string,text:string,start:number,end:number,atempoFactor:number,words:object[]}[], breathWarnings:{id:string,breathSec:number,minBreathSec:number}[], longGaps:{id:string,gapSec:number,maxBreathSec:number}[]} | {ok:false, failures:{id:string,requiredFactor:number|null,maxAtempo:number,reason?:string}[]}}
 */
export function fitAllLines(baseLines, dubLines, clipDurations, filmDuration, maxAtempo = DEFAULT_MAX_ATEMPO, breath = {}) {
  const { minBreathSec = MIN_BREATH_SEC, maxBreathSec = MAX_BREATH_SEC, minAtempo = MIN_ATEMPO, plannedGapSec = null } = breath;
  const slots = computeSlots(baseLines, filmDuration);
  const dubById = new Map(dubLines.map((l) => [l.id, l]));

  const failures = [];
  const fits = [];
  for (const [slotIndex, slot] of slots.entries()) {
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
    // The last slot's tail runs to the film's end, not to a next line: no gap limit there.
    const isLast = slotIndex === slots.length - 1;
    // A pause the plan or the picture declared is planned silence: the line is not slowed to shrink it.
    const limit = Math.max(maxBreathSec, allowedGapSec(plannedGapSec, slot.id));
    const fit = fitLineToSlot(clipDur, slotDur, maxAtempo, { minBreathSec, maxBreathSec: isLast ? Infinity : limit, minAtempo });
    if (!fit.ok) {
      failures.push({ id: slot.id, requiredFactor: fit.requiredFactor, maxAtempo: fit.maxAtempo });
      continue;
    }
    fits.push({ slot, dubLine, fit });
  }
  if (failures.length) return { ok: false, failures };
  const breathWarnings = fits
    .filter(({ fit }) => fit.breathShort)
    .map(({ slot, fit }) => ({ id: slot.id, breathSec: fit.breathSec, minBreathSec }));
  const longGaps = fits
    .filter(({ fit }) => fit.longGap)
    .map(({ slot, fit }) => ({ id: slot.id, gapSec: fit.breathSec, maxBreathSec }));

  const lines = fits.map(({ slot, dubLine, fit }) => {
    const start = slot.start + placedLeadSec(dubLine, fit, slot);
    return {
      id: slot.id,
      text: dubLine.text,
      start,
      end: start + fit.actualDurationSec,
      atempoFactor: fit.atempoFactor,
      words: shiftAndScaleWords(dubLine.words, dubLine.start, fit.atempoFactor, start),
    };
  });
  return { ok: true, lines, breathWarnings, longGaps };
}

/**
 * How long after the slot start the trimmed clip starts: the lead trimmed off its head (as heard
 * after the speed change), so the speech stays where the voice's own timings put it. Never more
 * than the room left in the slot, so a line does not run into the next one.
 */
function placedLeadSec(dubLine, fit, slot) {
  const lead = (dubLine.leadTrimSec || 0) / fit.atempoFactor;
  const room = slot.end - slot.start - fit.actualDurationSec;
  return Math.max(0, Math.min(lead, room));
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
export function buildPlacedTimings(fittedLines, filmDuration, lang = null, lead = 0) {
  // The dub inherits the picture's lead: one timing for every language.
  return { duration: filmDuration, ...(lead > 0 ? { lead } : {}), lines: fittedLines, lang, provider: "dub" };
}

export const MAX_ATEMPO_DEFAULT = DEFAULT_MAX_ATEMPO;

/** Fit replacement narration inside frozen caption windows, without moving the picture clock. */
export function fitFrozenLines(frozen, dubLines, clipDurations, maxAtempo = DEFAULT_MAX_ATEMPO) {
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
      throw new Error(`line ${slot.id}: frozen caption text or order changed; use normal dub for caption changes, or --audio-only to add this language as a separate audio track`);
    }
    if (![slot.start, slot.end, line.start].every(Number.isFinite) || slot.start < 0 || slot.end <= slot.start ||
        slot.end > frozen.duration || (i > 0 && slot.start < frozen.lines[i - 1].end)) {
      throw new Error(`line ${slot.id}: invalid frozen window`);
    }
    const duration = clipDurations.get(slot.id);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`line ${slot.id}: missing or invalid clip duration`);
    const fit = fitLineToSlot(duration, slot.end - slot.start, maxAtempo);
    // Frozen caption windows keep their own pauses: no breath rule.
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
 * @param {{thresholdDb?:number, padSec?:number, headPadSec?:number, tailPadSec?:number}} [opts] head/tail pads override padSec per side
 * @returns {{leadTrimSec:number, tailTrimSec:number, trimmedStartSec:number, trimmedEndSec:number}}
 */
export function trimEdgeSilence(windows, clipDurationSec, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? DEFAULT_TRIM_THRESHOLD_DB;
  const headPadSec = opts.headPadSec ?? opts.padSec ?? DEFAULT_TRIM_PAD_SEC;
  const tailPadSec = opts.tailPadSec ?? opts.padSec ?? DEFAULT_TRIM_PAD_SEC;
  const speech = (windows || []).filter((w) => w.rmsDb > thresholdDb);
  if (!speech.length) {
    return { leadTrimSec: 0, tailTrimSec: 0, trimmedStartSec: 0, trimmedEndSec: clipDurationSec };
  }
  const trimmedStartSec = Math.max(0, speech[0].startSec - headPadSec);
  const trimmedEndSec = Math.min(clipDurationSec, speech[speech.length - 1].endSec + tailPadSec);
  return {
    leadTrimSec: trimmedStartSec,
    tailTrimSec: Math.max(0, clipDurationSec - trimmedEndSec),
    trimmedStartSec,
    trimmedEndSec,
  };
}

export const TRIM_THRESHOLD_DB_DEFAULT = DEFAULT_TRIM_THRESHOLD_DB;
export const TRIM_PAD_SEC_DEFAULT = DEFAULT_TRIM_PAD_SEC;

/**
 * Splits the film into language-dependent spans (a caption chunk or a
 * page-declared label span is on screen) and language-neutral ones (nothing
 * a language draws). Frames are the unit, so every boundary sits on the
 * picture's grid. A neutral gap shorter than `minSharedSec` is folded into
 * the language span: a tiny stream-copied piece costs more than it saves.
 * The last caption holds on screen to the film's end (the engine's caption
 * layer keeps it), so by default its span runs to the end.
 * @param {{lines: {start:number,end:number}[], duration:number, fps:number,
 *   labelSpans?: {start:number,end:number}[], minSharedSec?: number, lastLineHolds?: boolean}} o
 * @returns {{totalFrames:number, spans:{startFrame:number,endFrame:number,kind:"shared"|"lang"}[],
 *   langFrames:number, sharedFrames:number}}
 */
export function planCaptionSpans({ lines, duration, fps, labelSpans = [], minSharedSec = 1.0, lastLineHolds = true }) {
  const totalFrames = Math.round(duration * fps);
  const clampFrame = (f) => Math.max(0, Math.min(totalFrames, f));
  const held = lines.map((l, i) => ({ start: l.start, end: lastLineHolds && i === lines.length - 1 ? duration : l.end }));
  const intervals = [...held, ...labelSpans]
    .map((s) => [clampFrame(Math.floor(s.start * fps)), clampFrame(Math.ceil(s.end * fps))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const minShared = Math.round(minSharedSec * fps);
  const lang = [];
  for (const [a, b] of intervals) {
    const last = lang[lang.length - 1];
    if (last && a - last[1] < minShared) last[1] = Math.max(last[1], b);
    else lang.push([a, b]);
  }
  // A neutral stretch at the very start or end is stream-copied only when long enough.
  if (lang.length && lang[0][0] < minShared) lang[0][0] = 0;
  if (lang.length && totalFrames - lang[lang.length - 1][1] < minShared) lang[lang.length - 1][1] = totalFrames;
  const spans = [];
  let at = 0;
  for (const [a, b] of lang) {
    if (a > at) spans.push({ startFrame: at, endFrame: a, kind: "shared" });
    spans.push({ startFrame: a, endFrame: b, kind: "lang" });
    at = b;
  }
  if (at < totalFrames) spans.push({ startFrame: at, endFrame: totalFrames, kind: "shared" });
  return withTotals(totalFrames, spans);
}

function withTotals(totalFrames, spans) {
  const sum = (kind) => spans.filter((s) => s.kind === kind).reduce((n, s) => n + s.endFrame - s.startFrame, 0);
  return { totalFrames, spans, langFrames: sum("lang"), sharedFrames: sum("shared") };
}

/** Frame ranges [start, end) a caption layer must draw: the language spans only. */
export function langFrameRanges(plan) {
  return plan.spans.filter((s) => s.kind === "lang").map((s) => [s.startFrame, s.endFrame]);
}

/** Turns one shared span into a language span (a probe found a language-drawn pixel in it), merging neighbours. */
export function promoteSharedSpan(plan, index) {
  const merged = [];
  plan.spans.forEach((s, i) => {
    const next = i === index ? { ...s, kind: "lang" } : { ...s };
    const last = merged[merged.length - 1];
    if (last && last.kind === next.kind) last.endFrame = next.endFrame;
    else merged.push(next);
  });
  return withTotals(plan.totalFrames, merged);
}

const SRT_TIME = "(\\d+):(\\d\\d):(\\d\\d)([,.])(\\d{3})";
const SRT_CUE = new RegExp(`^${SRT_TIME} --> ${SRT_TIME}(.*)$`);

function srtSeconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function srtStamp(sec, sep) {
  const total = Math.round(sec * 1000);
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(Math.floor(total / 3600000), 2)}:${pad(Math.floor(total / 60000) % 60, 2)}:${pad(Math.floor(total / 1000) % 60, 2)}${sep}${pad(total % 1000, 3)}`;
}

/**
 * Shifts every SRT cue that starts at or after `at` later by `seconds`.
 * A cue that straddles `at` is a definite error: it cannot be both shifted
 * and not shifted.
 * @returns {{text: string, shifted: number}}
 */
export function shiftSrt(text, at, seconds) {
  let shifted = 0;
  const out = text.split(/\r?\n/).map((line, n) => {
    const m = SRT_CUE.exec(line);
    if (!m) return line;
    const start = srtSeconds(m[1], m[2], m[3], m[5]);
    const end = srtSeconds(m[6], m[7], m[8], m[10]);
    if (start < at && end > at) throw new Error(`SRT line ${n + 1}: the cue straddles the insertion point ${at}s`);
    if (start < at) return line;
    shifted++;
    return `${srtStamp(start + seconds, m[4])} --> ${srtStamp(end + seconds, m[9])}${m[11]}`;
  });
  return { text: out.join("\n"), shifted };
}

/**
 * Shifts a dub's placed timings for a time insert at `at` (film seconds):
 * lines (and their words) starting at or after `at` move later by
 * `seconds`; the film grows by `seconds`. A line that straddles `at` is a
 * definite error.
 */
export function shiftPlacedTimings(placed, at, seconds) {
  const move = (x) => ({ ...x, start: x.start + seconds, end: x.end + seconds });
  const lines = placed.lines.map((l) => {
    if (l.start < at && l.end > at) throw new Error(`line "${l.id}" (${l.start}s-${l.end}s) straddles the insertion point ${at}s`);
    if (l.start < at) return l;
    return { ...move(l), ...(l.words ? { words: l.words.map(move) } : {}) };
  });
  return { ...placed, duration: placed.duration + seconds, lines };
}

/** Per-language length lines for a time insert, and whether every language now has the same length. */
export function formatTimeInsertReport(rows) {
  const equal = rows.every((r) => Math.abs(r.after - rows[0].after) < 0.0005);
  const body = rows.map((r) => `  ${r.lang}: ${r.before.toFixed(3)}s -> ${r.after.toFixed(3)}s  (${r.lines} lines moved, ${r.srt} SRT cues moved)`);
  const verdict = equal ? "all languages are the same length" : "LENGTHS DIFFER — a language was already off before the insert; decide which length is right";
  return { equal, text: `${body.join("\n")}\nlength equality: ${verdict}\n` };
}
