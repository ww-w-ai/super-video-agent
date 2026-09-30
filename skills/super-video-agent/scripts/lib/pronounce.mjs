// Pronunciation dictionary (plan.json meta.pronounce): one place to say how a
// word is read, applied to every line's spoken text before synthesis.
//   { "<word>": { say?: "<respelling or replacement word>", ipa?: "<IPA>" } }
// With meta.voice.phonemeTags true (an engine that accepts SSML phoneme tags),
// an entry with `ipa` becomes <phoneme alphabet="ipa" ph="…">word</phoneme>;
// otherwise `say` replaces the word. An entry with neither is left alone.
// The caption (`text`) is never changed. See references/readout.md.
//
// DEFAULT_PRONOUNCE holds built-in respellings that apply before a film's own
// dictionary (so a film's meta.pronounce/line.pronounce for the same word
// always wins), keyed by the language TTS reads Latin script as — the lang
// code's first two letters, lowercased ("en-US" -> "en"). Unknown/missing
// lang falls back to "en", since these entries exist to fix how an engine
// reads a Latin-script word, which is an English-TTS problem first.

const ASCII_WORD = /[A-Za-z0-9]/;

/**
 * Built-in respellings, per language (first two letters of meta.lang,
 * lowercased). Found in production: Fish read "Claude" with a "cloud"
 * vowel, and STT then heard "cloud" instead of "Claude"; "Clawd" respells
 * the vowel the engine actually needs. Korean scripts already write 클로드
 * by hand rather than the Latin word, so the `ko` entry only matters if a
 * script literally writes "Claude" inside Korean text.
 */
export const DEFAULT_PRONOUNCE = {
  en: { Claude: { say: "Clawd" } },
  ko: { Claude: { say: "클로드" } },
};

function defaultPronounceFor(lang) {
  const key = String(lang || "").slice(0, 2).toLowerCase();
  return DEFAULT_PRONOUNCE[key] || DEFAULT_PRONOUNCE.en;
}

/**
 * `text` with every standalone "|" forced-caption-break marker
 * (reel-engine.js captionChunks' `opts.breaks`, references/pipeline.md
 * "Forced caption breaks") removed — never spoken, never counted as a
 * word. validate-plan.mjs's captionBreakErrors requires "|" to appear as
 * its own whitespace-separated token, so removing whitespace-bounded "|"
 * tokens and rejoining with single spaces is exact.
 * @param {string} text
 * @returns {string}
 */
export function stripCaptionBreaks(text) {
  return String(text ?? "")
    .split(/\s+/)
    .filter((t) => t && t !== "|")
    .join(" ");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Match `word` as a whole word where it starts or ends with a Latin letter or
 * digit ("API" not inside "RAPID"); scripts without spaces (CJK) match anywhere.
 */
function wordPattern(word) {
  const pre = ASCII_WORD.test(word[0]) ? "(?<![A-Za-z0-9])" : "";
  const post = ASCII_WORD.test(word[word.length - 1]) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(pre + escapeRegExp(word) + post, "g");
}

/**
 * The text the voice engine receives for `line`.
 * A line's own `pronounce` entries override the film's for that line. Built-in
 * defaults (DEFAULT_PRONOUNCE, e.g. Claude -> Clawd) apply first, so both the
 * film's own meta.pronounce and a line's own pronounce always win over them.
 * A "|" forced-caption-break marker is stripped (stripCaptionBreaks) — it is
 * never spoken.
 * @param {{text:string, say?:string, pronounce?:Record<string, {say?:string, ipa?:string}>}} line
 * @param {Record<string, {say?:string, ipa?:string}>} [filmPronounce] plan.meta.pronounce
 * @param {{phonemeTags?:boolean}} [voiceCfg]
 * @param {string} [lang] plan.meta.lang, to pick DEFAULT_PRONOUNCE's language bucket
 * @returns {string}
 */
export function spokenText(line, filmPronounce, voiceCfg, lang) {
  // A "\n" in `text` only breaks the caption; the voice reads it as a space.
  let out = stripCaptionBreaks((line.say != null ? line.say : line.text).replace(/\s*\n\s*/g, " "));
  const pronounce = { ...defaultPronounceFor(lang), ...filmPronounce, ...line.pronounce };
  if (!Object.keys(pronounce).length) return out;
  const useTags = !!(voiceCfg && voiceCfg.phonemeTags);
  // Longest words first, so "GitHub Actions" wins over "GitHub".
  const words = Object.keys(pronounce).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const word of words) {
    const entry = pronounce[word] || {};
    let replacement = null;
    if (useTags && entry.ipa) replacement = `<phoneme alphabet="ipa" ph="${escapeAttr(entry.ipa)}">${word}</phoneme>`;
    else if (entry.say != null) replacement = entry.say;
    if (replacement == null) continue;
    out = out.replace(wordPattern(word), () => replacement);
  }
  return out;
}
