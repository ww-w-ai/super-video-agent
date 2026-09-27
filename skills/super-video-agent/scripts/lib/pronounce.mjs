// Pronunciation dictionary (plan.json meta.pronounce): one place to say how a
// word is read, applied to every line's spoken text before synthesis.
//   { "<word>": { say?: "<respelling or replacement word>", ipa?: "<IPA>" } }
// With meta.voice.phonemeTags true (an engine that accepts SSML phoneme tags),
// an entry with `ipa` becomes <phoneme alphabet="ipa" ph="…">word</phoneme>;
// otherwise `say` replaces the word. An entry with neither is left alone.
// The caption (`text`) is never changed. See references/readout.md.

const ASCII_WORD = /[A-Za-z0-9]/;

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
 * A line's own `pronounce` entries override the film's for that line.
 * @param {{text:string, say?:string, pronounce?:Record<string, {say?:string, ipa?:string}>}} line
 * @param {Record<string, {say?:string, ipa?:string}>} [filmPronounce] plan.meta.pronounce
 * @param {{phonemeTags?:boolean}} [voiceCfg]
 * @returns {string}
 */
export function spokenText(line, filmPronounce, voiceCfg) {
  let out = line.say != null ? line.say : line.text;
  const pronounce = line.pronounce ? { ...filmPronounce, ...line.pronounce } : filmPronounce;
  if (!pronounce) return out;
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
