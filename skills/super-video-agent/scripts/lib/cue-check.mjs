// Sound-effect cue check: for each `word:<text>` cue, warns when the word it lands on is missing
// from the line, was not heard by the speech-to-text check, has an interpolated time, or sits where
// the waveform says the sound starts elsewhere. Pure; warnings only, nothing fails.
import { checkedNothingNext } from "./checked-nothing.mjs";

const letters = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Caption words of a line the way the engine splits them: whitespace, break marks dropped. */
export function captionWords(text) {
  return String(text || "").split(/\s+/).filter((w) => w && w !== "|");
}

/** Index of the first caption word containing `sub`, or -1 (the engine's firstWordIndexContaining). */
export function firstWordIndexContaining(text, sub) {
  return captionWords(text).findIndex((w) => w.includes(sub));
}

/**
 * @param {{lines?: {id:string, text?:string, cues?:{asset?:string, at?:string}[]}[]}} plan
 * @param {{lines?: {id:string, text?:string, words?:object[], wordsMeasured?:number, stt?:{heard?:string}}[]}} timings
 * @param {{words:{lineId:string,index:number,status:string,offsetSec:number|null,onset:number|null,recorded:number}[]}|null} onsets
 *   a word-onsets report, or null when no waveform was measured
 * @returns {{lineId:string, asset:string|undefined, word:string, type:string, detail:string}[]}
 */
export function checkWordCues(plan, timings, onsets) {
  const out = [];
  const byId = new Map((timings.lines || []).map((l) => [l.id, l]));
  const onsetOf = new Map((onsets ? onsets.words : []).map((w) => [`${w.lineId}#${w.index}`, w]));
  for (const line of plan.lines || []) {
    for (const cue of line.cues || []) {
      if (typeof cue.at !== "string" || !cue.at.startsWith("word:")) continue;
      const word = cue.at.slice(5);
      const warn = (type, detail) => out.push({ lineId: line.id, asset: cue.asset, word, type, detail });
      const tl = byId.get(line.id);
      if (!tl) { warn("cue-line-missing", "the line is not in timings.json"); continue; }
      const idx = firstWordIndexContaining(tl.text ?? line.text, word);
      if (idx === -1) { warn("cue-word-missing", `no word of the line contains "${word}"; the cue falls back to the line start`); continue; }
      const heard = tl.stt && typeof tl.stt.heard === "string" ? letters(tl.stt.heard) : null;
      if (heard !== null && !heard.includes(letters(word))) {
        warn("cue-word-not-heard", `the speech-to-text check heard "${tl.stt.heard}", which does not contain "${word}"`);
      }
      const count = (tl.words || []).length;
      if (typeof tl.wordsMeasured === "number" && tl.wordsMeasured < count) {
        warn("cue-word-uncertain", tl.wordsMeasured === 0
          ? `word times of the line are all interpolated (wordsMeasured 0 of ${count})`
          : `only ${tl.wordsMeasured} of ${count} word times in the line are measured; "${captionWords(tl.text)[idx]}" may be interpolated`);
      }
      const m = onsetOf.get(`${line.id}#${idx}`);
      if (m && m.status === "off") {
        warn("cue-word-moved", `recorded ${m.recorded.toFixed(3)} s, the sound starts ${m.onset.toFixed(3)} s (${m.offsetSec > 0 ? "+" : ""}${Math.round(m.offsetSec * 1000)} ms)`);
      } else if (m && m.status === "no-onset") {
        warn("cue-word-uncertain", `no clear sound onset near the recorded ${m.recorded.toFixed(3)} s`);
      }
    }
  }
  return out;
}

/** The line whose [start, end] holds `at`, or null. */
function lineAt(lines, at) {
  return (lines || []).find((l) => typeof l.start === "number" && typeof l.end === "number" && at >= l.start && at <= l.end) || null;
}

/** The word of `line` whose start is closest to `at`, with its index. */
function nearestWord(line, at) {
  let best = null;
  (line.words || []).forEach((w, index) => {
    const d = Math.abs(w.start - at);
    if (best === null || d < best.d) best = { index, w: w.w, start: w.start, d };
  });
  return best;
}

/**
 * Sound events the page itself makes (`window.__reel.marks`, `{at, kind}`; optional `word` and `line`
 * when the page keys the event to a spoken word). Reports each one against the recorded word times as a
 * fact: the line it lands in, the nearest word and the offset. A mark that names a word is also checked
 * like a `word:` cue and warns when it sits more than `thresholdSec` from the recorded word start.
 * Pure; warnings only.
 * @param {{at:number, kind?:string, word?:string, line?:string}[]} marks
 * @param {{lines?: {id:string, start?:number, end?:number, text?:string, words?:{w:string,start:number,end:number}[]}[]}} timings
 * @param {{thresholdSec?: number, duration?: number}} [opts]
 * @returns {{cues: {at:number, kind:string, lineId:string|null, word:string|null, wordStart:number|null, offsetMs:number|null}[], warnings: {lineId:string|null, asset:string, word:string|null, type:string, detail:string}[]}}
 */
export function checkPageMarks(marks, timings, { thresholdSec = 0.08, duration } = {}) {
  const cues = [];
  const warnings = [];
  const lines = timings.lines || [];
  const end = typeof duration === "number" ? duration : (timings.duration ?? null);
  for (const m of marks || []) {
    const kind = String(m.kind ?? "?");
    const named = typeof m.line === "string" ? lines.find((l) => l.id === m.line) : null;
    const line = named || lineAt(lines, m.at);
    const near = line ? nearestWord(line, m.at) : null;
    cues.push({
      at: m.at, kind, lineId: line ? line.id : null,
      word: near ? near.w : null, wordStart: near ? near.start : null,
      offsetMs: near ? Math.round((m.at - near.start) * 1000) : null,
    });
    const warn = (type, detail) => warnings.push({ lineId: line ? line.id : null, asset: kind, word: m.word ?? null, type, detail });
    if (typeof m.at !== "number" || m.at < 0 || (end !== null && m.at > end)) {
      warn("page-cue-outside-timeline", `the page sound event at ${m.at} s is outside the timeline (0 to ${end ?? "?"} s)`);
      continue;
    }
    if (typeof m.word !== "string" || !line) continue;
    const idx = firstWordIndexContaining(line.text, m.word);
    const w = idx === -1 ? undefined : (line.words || [])[idx];
    if (!w) { warn("page-cue-word-missing", `no word of ${line.id} contains "${m.word}"`); continue; }
    const off = m.at - w.start;
    if (Math.abs(off) > thresholdSec) {
      warn("page-cue-moved", `the page event is at ${m.at.toFixed(3)} s, the recorded word "${w.w}" starts ${w.start.toFixed(3)} s (${off > 0 ? "+" : ""}${Math.round(off * 1000)} ms)`);
    }
  }
  return { cues, warnings };
}

/** One line per page sound event, then its warnings. */
export function formatPageCues(report) {
  if (!report.cues.length) return "page sound events: none read from window.__reel.marks\n";
  const rows = report.cues.map((c) => `  ${c.at.toFixed(3)} s ${c.kind}: ${c.word !== null ? `${c.lineId}, nearest word "${c.word}" at ${c.wordStart.toFixed(3)} s (${c.offsetMs > 0 ? "+" : ""}${c.offsetMs} ms)` : "no line at this time"}\n`);
  const warns = report.warnings.map((w) => `  ${w.asset} ${w.type}: ${w.detail}\n`);
  return `${report.cues.length} page sound event${report.cues.length === 1 ? "" : "s"} read\n${rows.join("")}${warns.join("")}`;
}

/** One line per warning, or a clean line. */
export function formatCueWarnings(warnings, cueCount) {
  if (cueCount === 0) return "checked nothing: plan.json has no cue keyed to a word (at: \"word:<text>\"), so no cue was looked at. " + checkedNothingNext("a cue keyed to a word in plan.json") + "\n";
  if (!warnings.length) return `${cueCount} word cue${cueCount === 1 ? "" : "s"} checked, no warnings\n`;
  return `${cueCount} word cue${cueCount === 1 ? "" : "s"} checked, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}\n` +
    warnings.map((w) => `${w.lineId} ${w.asset ?? "?"} at word:${w.word}: ${w.type}: ${w.detail}\n`).join("");
}
