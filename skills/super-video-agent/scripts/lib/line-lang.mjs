// Per-line language: a plan line's `lang` (BCP 47) overrides plan.meta.lang for
// that line's voice synthesis, speech-to-text check, read-out rules and caption
// break rules (references/voice.md "A line in another language").

/**
 * The language a line is spoken in.
 * @param {{lang?: string}|null|undefined} line
 * @param {string|undefined} filmLang plan.meta.lang
 * @returns {string|undefined}
 */
export function lineLang(line, filmLang) {
  return (line && typeof line.lang === "string" && line.lang) || filmLang;
}

/**
 * Entries grouped by language, in first-seen order: one speech-to-text pass
 * per language, since a transcription run takes a single language code.
 * @template {{langCode?: string}} E
 * @param {E[]} entries each may carry its own `langCode`
 * @param {string} defaultCode used for an entry with none
 * @returns {Map<string, E[]>} language code -> entries
 */
export function groupByLangCode(entries, defaultCode) {
  const groups = new Map();
  for (const e of entries) {
    const code = e.langCode || defaultCode;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(e);
  }
  return groups;
}
