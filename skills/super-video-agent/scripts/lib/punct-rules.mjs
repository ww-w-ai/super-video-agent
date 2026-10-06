// Per-language punctuation and script rules for caption text. The table below is the one the doc
// references/pipeline.md "Punctuation and script table" shows; a test keeps the two in step.
// A finding is a fact. "wrong" = the form cannot be right for the language (the check exits 1);
// "check" = a form that is usually a slip but can be meant (a brand, a quoted name): the editor decides.
import { parseLangTag } from "./lang-tag.mjs";

const LATIN = ["Latin"];
const FULLWIDTH_MARKS = /[，。！？：；（）、「」『』]/u;
const ASCII_AFTER_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][,.!?:;]/u;
const SPACE_BETWEEN_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}] +[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const FR_UNSPACED_HIGH = /\p{L}[?!;:]/u;
const SPACE_BEFORE_LOW = /\p{L} [,.]/u;

/** Scripts a language's captions are written in (letters of any other script are a "check"). */
export const LANGUAGES = {
  en: { scripts: LATIN, quotes: "curly or straight, not mixed" },
  de: { scripts: LATIN, quotes: "„…“" },
  es: { scripts: LATIN, quotes: "«…» or “…”", invertedMarks: true },
  fr: { scripts: LATIN, quotes: "«…»", highPunctSpace: true },
  it: { scripts: LATIN, quotes: "«…» or “…”" },
  pt: { scripts: LATIN, quotes: "“…” or «…»" },
  ru: { scripts: ["Cyrillic", "Latin"], quotes: "«…»" },
  ko: { scripts: ["Hangul", "Latin"], quotes: "“…” or '…'" },
  ja: { scripts: ["Hiragana", "Katakana", "Han", "Latin"], quotes: "「…」", cjk: true },
  zh: { scripts: ["Han", "Latin"], quotes: "“…” or 「…」", cjk: true },
};

const SCRIPT_TESTS = ["Latin", "Cyrillic", "Han", "Hiragana", "Katakana", "Hangul"].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")]);

/** The table row for a BCP 47 tag, or null when the language has none. */
export function ruleRowFor(tag) {
  const parsed = parseLangTag(tag);
  return parsed && LANGUAGES[parsed.lang] ? { code: parsed.lang, ...LANGUAGES[parsed.lang] } : null;
}

const excerpt = (text, i) => text.slice(Math.max(0, i - 8), i + 9).replace(/\s+/g, " ");

function finding(severity, rule, text, index, detail) {
  return { severity, rule, excerpt: excerpt(text, index), detail };
}

function scriptFindings(row, text) {
  const out = [];
  for (const ch of text) {
    const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
    if (hit && !row.scripts.includes(hit[0])) out.push(finding("check", "other-script", text, text.indexOf(ch), `${hit[0]} letter "${ch}" in ${row.code} text (a brand or a quoted name can be meant)`));
  }
  return out.slice(0, 3);
}

function markFindings(row, text) {
  const out = [];
  if (!row.cjk) {
    const m = FULLWIDTH_MARKS.exec(text);
    if (m) out.push(finding("wrong", "fullwidth-mark", text, m.index, `"${m[0]}" is a CJK form; ${row.code} text uses its own marks`));
  } else {
    const m = ASCII_AFTER_CJK.exec(text);
    if (m) out.push(finding("wrong", "ascii-mark-after-cjk", text, m.index, `"${m[0].slice(-1)}" straight after a CJK character should be the full-width form`));
    const s = SPACE_BETWEEN_CJK.exec(text);
    if (s) out.push(finding("check", "space-between-cjk", text, s.index, "a space between two CJK characters"));
  }
  const opened = (text.match(/¿/g) || []).length;
  const closed = (text.match(/\?/g) || []).length;
  const bangOpen = (text.match(/¡/g) || []).length;
  const bangClose = (text.match(/!/g) || []).length;
  if (row.invertedMarks && (closed > opened || bangClose > bangOpen)) out.push(finding("wrong", "missing-inverted-mark", text, Math.max(0, text.search(/[?!]/)), "a ? or ! without its opening ¿ or ¡"));
  if (!row.invertedMarks && /[¿¡]/.test(text)) out.push(finding("wrong", "inverted-mark-outside-es", text, text.search(/[¿¡]/), `¿ and ¡ belong to Spanish, not ${row.code}`));
  return out;
}

function spacingFindings(row, text) {
  const out = [];
  const dbl = / {2,}/.exec(text);
  if (dbl) out.push(finding("check", "double-space", text, dbl.index, "two or more spaces in a row"));
  if (row.highPunctSpace) {
    const m = FR_UNSPACED_HIGH.exec(text);
    if (m) out.push(finding("check", "fr-space-before-high-mark", text, m.index, `French sets a (narrow) space before "${m[0].slice(-1)}"`));
  } else if (!row.cjk) {
    const m = SPACE_BEFORE_LOW.exec(text);
    if (m) out.push(finding("check", "space-before-mark", text, m.index, `a space before "${m[0].slice(-1)}"`));
  }
  return out;
}

function quoteFindings(row, text) {
  const straight = /"/.exec(text);
  if (straight && row.code !== "en" && row.code !== "ko") return [finding("check", "straight-quote", text, straight.index, `a straight quote; ${row.code} writes ${row.quotes}`)];
  if (row.code === "en" && straight && /[“”]/.test(text)) return [finding("check", "mixed-quotes", text, straight.index, "straight and curly quotes in one line")];
  return [];
}

/**
 * Findings for one line of caption text in one language.
 * @param {string} tag BCP 47 tag of the text
 * @param {string} text
 * @returns {{severity:"wrong"|"check", rule:string, excerpt:string, detail:string}[]|null} null when the language has no table row
 */
export function checkText(tag, text) {
  const row = ruleRowFor(tag);
  if (!row) return null;
  const s = String(text ?? "");
  return [...markFindings(row, s), ...scriptFindings(row, s), ...spacingFindings(row, s), ...quoteFindings(row, s)];
}
