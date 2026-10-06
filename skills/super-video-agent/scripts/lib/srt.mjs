// SRT from timed caption lines. Pure: the engine (globalThis.Reel) is passed in, no I/O.
// Cue breaks use the engine's own caption rules (captionChunks / captionUnits / captionGlue), so a
// subtitle breaks where the on-screen caption does: a writer's "|" and "\n" win, a number stays with
// its unit, no row ends on an article, nothing breaks inside a parenthesis or quote span.
// Facts only: the checks report what they see; whether a break reads well is the reviewer's call.

export const DEFAULT_MAX_LINES = 2;
const MIN_CUE_SEC = 0.3;
const TIME_TOL_SEC = 0.05;

/** Characters per row when no --line-chars is given (per primary language subtag). */
export function defaultLineChars(lang) {
  const p = String(lang || "").split(/[-_]/)[0].toLowerCase();
  if (p === "ja" || p === "zh") return 16;
  if (p === "ko") return 22;
  return 42;
}

const isCjkLang = (lang) => ["ja", "zh"].includes(String(lang || "").split(/[-_]/)[0].toLowerCase());

/** 83.4567 -> "00:01:23,457". */
export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
}

function parseSrtTime(s) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** @param {{start:number,end:number,lines:string[]}[]} cues */
export function formatSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join("\n")}\n`).join("\n");
}

/** SRT text -> cues [{start,end,lines}]. Throws on a block whose time line cannot be read. */
export function parseSrt(text) {
  const blocks = String(text).replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).filter(Boolean);
  return blocks.map((b, bi) => {
    const rows = b.split("\n");
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti < 0) throw new Error(`srt block ${bi + 1}: no "-->" time line`);
    const [a, z] = rows[ti].split("-->");
    const start = parseSrtTime(a);
    const end = parseSrtTime(z);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`srt block ${bi + 1}: unreadable time "${rows[ti]}"`);
    return { start, end, lines: rows.slice(ti + 1) };
  });
}

/**
 * One caption part ("\n" separated) as break units with times. Each whitespace word of the part
 * takes its own timed word; a CJK word splits into character units sharing that time by length.
 * @returns {{units:{w:string,start:number,end:number,sp:boolean}[], glue:boolean[], breaks:number[]}}
 */
function partUnits(Reel, partText, timed, lang) {
  const clean = partText.split(/\s+/).filter((t) => t && t !== "|").join(" ");
  const { texts, sp, glue } = Reel.captionUnits(clean, lang);
  const tokenOf = [];
  let token = -1;
  texts.forEach((_, i) => {
    if (i === 0 || sp[i]) token++;
    tokenOf.push(token);
  });
  const charsBefore = [];
  const charsInToken = [];
  texts.forEach((w, i) => {
    const tk = tokenOf[i];
    charsBefore.push(charsInToken[tk] || 0);
    charsInToken[tk] = (charsInToken[tk] || 0) + w.length;
  });
  const units = texts.map((w, i) => {
    const t = timed[tokenOf[i]];
    const total = charsInToken[tokenOf[i]] || 1;
    const span = t.end - t.start;
    return { w, start: t.start + (span * charsBefore[i]) / total, end: t.start + (span * (charsBefore[i] + w.length)) / total, sp: i > 0 && sp[i] };
  });
  const lastUnitOfToken = new Map();
  tokenOf.forEach((tk, i) => lastUnitOfToken.set(tk, i));
  const breaks = Reel.captionBreaksFromText(partText).map((tk) => lastUnitOfToken.get(tk)).filter((i) => i !== undefined);
  return { units, glue, breaks };
}

/** Timed words for the tokens of `text`: the line's own words, else spread over start..end by letters. */
function timedWords(line, tokens) {
  const own = Array.isArray(line.words) ? line.words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
  if (own.length === tokens.length) return { words: own, proportional: false };
  const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
  let at = line.start;
  const words = tokens.map((t) => {
    const end = at + ((line.end - line.start) * t.length) / total;
    const w = { w: t, start: at, end };
    at = end;
    return w;
  });
  return { words, proportional: true };
}

/** A line's caption parts as break units. */
export function lineModel(Reel, line, lang) {
  const parts = String(line.text ?? "").split("\n").filter((p) => p.trim());
  const tokenLists = parts.map((p) => p.split(/\s+/).filter((t) => t && t !== "|"));
  const { words, proportional } = timedWords(line, tokenLists.flat());
  let at = 0;
  const models = parts.map((p, i) => {
    const n = tokenLists[i].length;
    const m = partUnits(Reel, p, words.slice(at, at + n), line.lang || lang);
    at += n;
    return m;
  });
  return { id: line.id, parts: models, proportional };
}

function rowText(units) {
  return units.map((u, i) => (i > 0 && u.sp ? " " : "") + u.w).join("");
}

const asWords = (units) => units.map((u) => ({ w: u.w, start: u.start, end: u.end }));

/**
 * Row layout of one cue chunk: one row when it fits, else the engine's even split at `lineChars`.
 * Chunk indices are relative to the chunk's units.
 */
function chunkRows(Reel, units, lineChars, lang) {
  const all = units.map((_, i) => i);
  // The engine counts one separator per unit; CJK units are single characters, so scale.
  const limit = isCjkLang(lang) ? Math.round(lineChars * 1.6) : lineChars;
  if (rowText(units).length <= lineChars) return [all];
  return Reel.captionChunks(asWords(units), limit, { lang });
}

/**
 * Cues of one line: chunks the engine would show (limit = maxLines rows), each laid out in rows;
 * a chunk needing more rows than maxLines becomes several cues.
 * @returns {{id,lines:string[],start:number,end:number,unitSpans:[number,number][],part:number}[]}
 */
function lineCues(Reel, model, opts) {
  const { lineChars, maxLines, lang } = opts;
  const cues = [];
  model.parts.forEach((part, pi) => {
    const cueLimit = lineChars * maxLines * (isCjkLang(lang) ? 1.6 : 1);
    const chunks = Reel.captionChunks(asWords(part.units), cueLimit, { breaks: part.breaks, lang });
    for (const chunk of chunks) {
      const units = chunk.map((i) => part.units[i]);
      const rows = chunkRows(Reel, units, lineChars, lang).map((r) => r.map((i) => chunk[i]));
      for (let k = 0; k < rows.length; k += maxLines) {
        const group = rows.slice(k, k + maxLines);
        const flat = group.flat().map((i) => part.units[i]);
        cues.push({
          id: model.id,
          part: pi,
          lines: group.map((r) => rowText(r.map((i) => part.units[i]))),
          start: flat[0].start,
          end: flat[flat.length - 1].end,
          rows: group,
        });
      }
    }
  });
  return cues;
}

/**
 * Cues for a list of timed lines ({id,text,start,end,words?}).
 * @param {object} Reel the engine
 * @param {{id:string,text:string,start:number,end:number,words?:object[],lang?:string}[]} lines
 * @param {{lang?:string, lineChars?:number, maxLines?:number}} [opts]
 * @returns {{cues:object[], models:Map<string,object>, opts:object}}
 */
export function buildCues(Reel, lines, opts = {}) {
  const lang = opts.lang;
  const o = { lang, lineChars: opts.lineChars > 0 ? opts.lineChars : defaultLineChars(lang), maxLines: opts.maxLines > 0 ? opts.maxLines : DEFAULT_MAX_LINES };
  const models = new Map();
  const cues = [];
  for (const line of lines) {
    const model = lineModel(Reel, line, lang);
    models.set(line.id, model);
    cues.push(...lineCues(Reel, model, { ...o, lang: line.lang || lang }));
  }
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    c.end = Math.max(c.end, c.start + MIN_CUE_SEC);
    if (next && next.start > c.start) c.end = Math.min(c.end, next.start);
  });
  return { cues, models, opts: o };
}

/**
 * Facts about the cues: rows over the limit, more rows than allowed, a break the engine's rules
 * say not to make (inside a number+unit, after an article, inside a span) that is not the writer's
 * own "|" / "\n", cues that overlap or run backwards, and lines timed proportionally.
 * @returns {{type:string,id:string,cue?:number,detail:string}[]}
 */
export function checkCues(built) {
  const { cues, models, opts } = built;
  const out = [];
  const gap = (c, i, type, detail) => out.push({ type, id: c.id, cue: i + 1, detail });
  cues.forEach((c, i) => {
    if (c.lines.length > opts.maxLines) gap(c, i, "too-many-rows", `${c.lines.length} rows`);
    c.lines.forEach((r) => {
      if (r.length > opts.lineChars) gap(c, i, "row-too-long", `${r.length} > ${opts.lineChars}: "${r}"`);
    });
    const next = cues[i + 1];
    if (next && next.start < c.end - 1e-9) gap(c, i, "overlap", `ends ${c.end.toFixed(3)}, next starts ${next.start.toFixed(3)}`);
    if (c.end <= c.start) gap(c, i, "no-duration", `${c.start.toFixed(3)} .. ${c.end.toFixed(3)}`);
    const part = models.get(c.id).parts[c.part];
    c.rows.forEach((row, ri) => {
      const last = row[row.length - 1];
      const isEnd = last === part.units.length - 1;
      if (isEnd || part.breaks.includes(last) || !part.glue[last]) return;
      gap(c, i, "glued-break", `row ${ri + 1} ends "${part.units[last].w}" before "${part.units[last + 1].w}"`);
    });
  });
  for (const m of models.values()) {
    if (m.proportional) out.push({ type: "proportional-times", id: m.id, detail: "line has no word times matching its text; words spread over the line by letters" });
  }
  return out;
}

export function formatChecks(findings, { label = "srt checks" } = {}) {
  if (!findings.length) return `${label}: no findings.\n`;
  const rows = findings.map((f) => `  ${f.id}${f.cue ? ` cue ${f.cue}` : ""}: ${f.type} — ${f.detail}`);
  return `${label} (${findings.length}; read each: does it hurt reading?):\n${rows.join("\n")}\n`;
}

/**
 * Cue count and time equality across languages. Cues group by line id (a cue without one groups
 * as "all"). Per group: every language's cue count; when the counts agree, the largest start/end
 * difference to the first language; the group's first start and last end always.
 * @param {Record<string, {start:number,end:number,id?:string}[]>} tracks language code -> cues
 * @param {{tolSec?:number}} [opts]
 * @returns {{codes:string[], rows:object[], totals:Record<string,number>, equal:boolean}}
 */
export function compareTracks(tracks, opts = {}) {
  const tol = opts.tolSec > 0 ? opts.tolSec : TIME_TOL_SEC;
  const codes = Object.keys(tracks);
  const groups = new Map();
  for (const code of codes) {
    for (const c of tracks[code]) {
      const id = c.id ?? "all";
      if (!groups.has(id)) groups.set(id, Object.fromEntries(codes.map((k) => [k, []])));
      groups.get(id)[code].push(c);
    }
  }
  const rows = [...groups].map(([id, byCode]) => groupRow(id, byCode, codes, tol));
  const totals = Object.fromEntries(codes.map((k) => [k, tracks[k].length]));
  const equal = rows.every((r) => r.countsEqual && r.timesEqual) && new Set(Object.values(totals)).size <= 1;
  return { codes, rows, totals, equal };
}

function groupRow(id, byCode, codes, tol) {
  const counts = Object.fromEntries(codes.map((k) => [k, byCode[k].length]));
  const countsEqual = new Set(Object.values(counts)).size === 1;
  const spans = Object.fromEntries(codes.map((k) => [k, byCode[k].length ? [byCode[k][0].start, byCode[k][byCode[k].length - 1].end] : null]));
  const ref = codes[0];
  let maxDelta = 0;
  let missing = false;
  for (const k of codes.slice(1)) {
    if (!spans[k] || !spans[ref]) {
      missing = true;
      continue;
    }
    maxDelta = Math.max(maxDelta, Math.abs(spans[k][0] - spans[ref][0]), Math.abs(spans[k][1] - spans[ref][1]));
    if (countsEqual) byCode[k].forEach((c, i) => (maxDelta = Math.max(maxDelta, Math.abs(c.start - byCode[ref][i].start), Math.abs(c.end - byCode[ref][i].end))));
  }
  return { id, counts, countsEqual, spans, maxDelta, timesEqual: !missing && maxDelta <= tol };
}

export function formatComparison(cmp, { tolSec = TIME_TOL_SEC } = {}) {
  const head = `cue count + time across ${cmp.codes.join(", ")} (time tolerance ${Math.round(tolSec * 1000)} ms):\n`;
  const totals = `  total cues: ${cmp.codes.map((k) => `${k}=${cmp.totals[k]}`).join("  ")}\n`;
  const bad = cmp.rows.filter((r) => !r.countsEqual || !r.timesEqual);
  if (!bad.length) return `${head}${totals}  every line: same cue count, same times.\n`;
  const rows = bad.map((r) => {
    const counts = cmp.codes.map((k) => `${k}=${r.counts[k]}`).join(" ");
    const why = [!r.countsEqual && "cue counts differ", !r.timesEqual && `times differ (max ${Math.round(r.maxDelta * 1000)} ms or a language has no cue)`].filter(Boolean).join("; ");
    return `  ${r.id}: ${counts} — ${why}`;
  });
  return `${head}${totals}${rows.join("\n")}\n`;
}

/**
 * ffmpeg arguments that turn a media file into the mono 16 kHz PCM wav the STT engine reads, or null
 * when the input already is a .wav (it is passed on as it is).
 * @returns {string[]|null}
 */
export function sttExtractArgs(media, wavOut) {
  if (/\.wav$/i.test(media)) return null;
  return ["-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavOut];
}

/**
 * Script lines [{id,text}] from a file's text: a JSON object with `lines[]` (plan.json,
 * timings.json) keeps its ids and `text`; anything else is plain text, one script line per
 * non-empty row, ids l1, l2, ....
 */
export function parseScript(raw) {
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("{")) {
    const obj = JSON.parse(trimmed);
    if (!Array.isArray(obj.lines)) throw new Error('script JSON has no "lines" array');
    return obj.lines.map((l, i) => ({ id: String(l.id ?? `l${i + 1}`), text: String(l.text ?? ""), ...(l.lang ? { lang: l.lang } : {}) })).filter((l) => l.text.trim());
  }
  return trimmed.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).map((text, i) => ({ id: `l${i + 1}`, text }));
}

/**
 * Timed lines from a whole recording's heard words and a known script. Each script line is
 * aligned (alignCaptionWords) against the next stretch of heard words, then the stretch moves on
 * past what that line used, so cost stays linear in the script. A line with under half its words
 * found in the audio is not timed: it is returned in `lowMatch` instead.
 * @param {{id:string,text:string,lang?:string}[]} script
 * @param {{w:string,start:number,end:number}[]} heard whole-recording words, seconds
 * @param {{align:Function, letters:Function, lang?:string}} deps alignCaptionWords / matchLetters (voice/word-align.mjs)
 * @returns {{lines:object[], lowMatch:{id:string,measured:number,total:number}[]}}
 */
export function alignScript(script, heard, deps) {
  const lines = [];
  const lowMatch = [];
  let p = 0;
  for (const line of script) {
    const text = String(line.text ?? "").split(/\s+/).filter((t) => t && t !== "|").join(" ");
    const lang = line.lang || deps.lang;
    const need = deps.letters(text, lang).length;
    const end = windowEnd(heard, p, Math.ceil(need * 1.15) + 4, deps.letters, lang);
    const aligned = deps.align(text, heard.slice(p, end), { lang });
    const words = aligned.words;
    // A line the audio does not say would only get invented times and eat the next line's words:
    // it is left out (listed) and the heard words stay for the next line.
    if (!words.length || aligned.measured < Math.ceil(words.length / 2)) {
      lowMatch.push({ id: line.id, measured: aligned.measured || 0, total: text.split(" ").length });
      continue;
    }
    lines.push({ id: line.id, text: line.text, start: words[0].start, end: words[words.length - 1].end, words, wordsMeasured: aligned.measured });
    const lastEnd = words[words.length - 1].end;
    let used = 0;
    while (p + used < end && heard[p + used].start < lastEnd - 1e-6) used++;
    p += Math.max(1, used);
  }
  return { lines, lowMatch };
}

function windowEnd(heard, from, letters, lettersOf, lang) {
  let n = 0;
  let i = from;
  while (i < heard.length && n < letters) n += lettersOf(heard[i++].w, lang).length;
  return i;
}
