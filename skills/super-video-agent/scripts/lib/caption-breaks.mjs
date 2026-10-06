// Caption break report: every place a plan line's caption breaks, so a reviewer
// reads all breaks in one table (references/script-review.md "Caption breaks").
// A break comes from a "|" marker, a "\n", phrase-ending punctuation, or (with
// maxChars) the engine's even split of a long phrase — the same decisions
// reel-engine.js captionChunks makes. Facts only; whether a break cuts a
// phrase is the reviewer's judgement.
import { checkedNothingNext } from "./checked-nothing.mjs";

const CONTEXT_WORDS = 3;
let reelPromise = null;

async function loadReel() {
  if (!reelPromise) {
    reelPromise = import("../engine/reel-engine.js").then(() => globalThis.Reel);
  }
  return reelPromise;
}

/**
 * The pieces of one caption line, in order. "\n" always breaks; each part
 * then goes through Reel.captionChunks, honouring its "|" markers.
 * @param {object} Reel the engine (globalThis.Reel)
 * @param {string} text a plan line's `text`
 * @param {number} maxChars chunk size limit (Infinity: no automatic split)
 * @returns {string[][]} pieces, each an array of words
 */
export function captionPieces(Reel, text, maxChars = Infinity, lang = undefined) {
  const pieces = [];
  for (const part of String(text ?? "").split("\n")) {
    const words = part.split(/\s+/).filter((t) => t && t !== "|").map((w) => ({ w }));
    if (!words.length) continue;
    const chunks = Reel.captionChunks(words, maxChars, { breaks: Reel.captionBreaksFromText(part), lang });
    for (const c of chunks) pieces.push(c.map((i) => words[i].w));
  }
  return pieces;
}

/**
 * One row per break: { id, before, after } with up to three words of context
 * each side. A line with no break gets { id, before: null, after: null }.
 * @param {object} Reel
 * @param {{id: string, text?: string}[]} lines
 * @param {{maxChars?: number, lang?: string}} [opts] lang: BCP 47 of the film (a line's own `lang` wins)
 */
export function captionBreakRows(Reel, lines, opts = {}) {
  const maxChars = opts.maxChars > 0 ? opts.maxChars : Infinity;
  const rows = [];
  for (const line of lines || []) {
    const pieces = captionPieces(Reel, line.text, maxChars, line.lang || opts.lang);
    if (pieces.length < 2) {
      rows.push({ id: line.id, before: null, after: null });
      continue;
    }
    for (let i = 0; i + 1 < pieces.length; i++) {
      rows.push({
        id: line.id,
        before: pieces[i].slice(-CONTEXT_WORDS).join(" "),
        after: pieces[i + 1].slice(0, CONTEXT_WORDS).join(" "),
      });
    }
  }
  return rows;
}

/** The table as text: "line id: …before | after…" per break. */
export function formatCaptionBreaks(rows, { label = "caption breaks" } = {}) {
  // Every line one piece: there was no break to read, so nothing was checked
  // (an all-"one piece" table must not read as a pass).
  if (rows.length && rows.every((r) => r.before === null)) {
    return `${label}: checked nothing — every line is one piece (${rows.length} lines), so there is no break to read. ${checkedNothingNext("a caption break (a | marker, a newline or phrase punctuation) in the plan text")}\n`;
  }
  if (!rows.length) return `${label}: checked nothing — the plan has no lines. ${checkedNothingNext("the plan's lines")}\n`;
  const out = [`${label} (read each: does the break cut a phrase?):`];
  for (const r of rows) {
    out.push(r.before === null ? `  ${r.id}: (one piece)` : `  ${r.id}: …${r.before} | ${r.after}…`);
  }
  return out.join("\n") + "\n";
}

/** Loads the engine, then builds the text table for a plan. */
export async function captionBreakReport(plan, opts = {}) {
  const Reel = await loadReel();
  const rows = captionBreakRows(Reel, plan.lines, { lang: plan.meta?.lang, ...opts });
  return formatCaptionBreaks(rows, { label: opts.label });
}
