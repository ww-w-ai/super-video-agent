// Pure text-comparison helpers for the voice step's speech-to-text
// round-trip check (references/voice.md "Did the voice say the line?"):
// normalize text for comparison, measure character error rate, compare a
// transcribed line against its intended `text`/`say`, and check whether a
// synthesized clip's tail (a TAIL voiceFlag candidate) actually finished
// the last syllable. No I/O, no network — fully unit-testable. Expression tags
// (`[confident]`) are never heard as words, so every target is compared without them.

import { stripTags } from "./tags.mjs";
import { normalizeNumbers, primaryLang } from "./stt-numbers.mjs";
import { foldScript } from "./stt-script-fold.mjs";
import { DEFAULT_PRONOUNCE } from "./pronounce.mjs";

const ASCII_WORD = /[A-Za-z0-9]/;

/**
 * [written, spoken] pairs from pronunciation dictionaries (plan.json
 * meta.pronounce, a line's own `pronounce`, the built-in defaults): a name
 * written "Claude" and spoken "클로드". Only entries with a `say` count.
 * Later maps win, like pronounce.mjs spokenText.
 * @param {string|null|undefined} lang film or line language
 * @param {...(Record<string,{say?:string}>|null|undefined)} maps film dictionary, then line dictionary
 * @returns {[string,string][]}
 */
export function pronounceFolds(lang, ...maps) {
  const key = String(lang || "").slice(0, 2).toLowerCase();
  const merged = Object.assign({}, DEFAULT_PRONOUNCE[key] || DEFAULT_PRONOUNCE.en, ...maps.filter(Boolean));
  return Object.entries(merged)
    .filter(([word, e]) => word && e && typeof e.say === "string" && e.say && e.say !== word)
    .map(([word, e]) => [word, e.say])
    .sort((a, b) => b[1].length - a[1].length);
}

function spokenPattern(spoken) {
  const esc = spoken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = ASCII_WORD.test(spoken[0]) ? "(?<![A-Za-z0-9])" : "";
  const post = ASCII_WORD.test(spoken[spoken.length - 1]) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(pre + esc + post, "giu");
}

/** Writes each spoken respelling back as the written name, so a name read as its `say` form is not an error. */
function foldNames(s, names) {
  let t = s;
  for (const [written, spoken] of names || []) t = t.replace(spokenPattern(spoken), () => written);
  return t;
}

/**
 * The text as it is compared, before lowercasing and stripping: width forms
 * unified (NFKC), spoken respellings folded to written names, Traditional
 * Chinese folded to Simplified, numbers written as digits, Japanese kana
 * folded, Korean -예요/-에요 written one way. Both sides of a comparison go through the same steps.
 * @param {string} s
 * @param {string|null} [lang]
 * @param {[string,string][]|null} [names] pronounceFolds()
 */
export function fold(s, lang = null, names = null) {
  const primary = primaryLang(lang);
  let t = foldNames(String(s ?? "").normalize("NFKC"), names);
  t = foldScript(t, primary === "zh" ? "zh" : null);
  t = normalizeNumbers(t, lang);
  t = foldScript(t, primary === "ja" ? "ja" : null);
  return foldScript(t, primary === "ko" ? "ko" : null);
}

/**
 * Lowercase and strip whitespace/punctuation, keeping letters and digits of
 * any script (Korean included) so character error rate isn't inflated by
 * spacing/punctuation differences between the intended text and what the
 * STT model transcribed. The text is folded first (`fold`) so number words,
 * Traditional/Simplified Chinese, kana and name respellings do not count as errors.
 * @param {string} s
 * @param {string|null} [lang]
 * @param {[string,string][]|null} [names]
 */
export function normalize(s, lang = null, names = null) {
  return fold(s, lang, names)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein (edit) distance between two strings, character by character. */
function levenshtein(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * Character error rate: normalized edit distance between `a` (the intended
 * target) and `b` (what was heard), divided by the normalized target's
 * length (floored at 1 so an empty target never divides by zero).
 * @param {string} a target text
 * @param {string} b heard text
 * @param {string|null} [lang] the line's language, for number and script rules
 * @param {[string,string][]|null} [names] pronounceFolds()
 * @returns {number}
 */
export function cer(a, b, lang = null, names = null) {
  const na = normalize(a, lang, names);
  const nb = normalize(b, lang, names);
  return levenshtein(na, nb) / Math.max(1, na.length);
}

function tokenize(s) {
  return String(s ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Token-level diff between `target` and `heard`: aligns whitespace-split
 * tokens (normalized for comparison, original spelling reported) and
 * returns only the spans that differ, each as one {want, heard} entry
 * (consecutive differing tokens are joined into a single span).
 * @param {string} target
 * @param {string} heard
 * @returns {{want:string, heard:string}[]}
 */
function tokenDiffs(target, heard) {
  const a = tokenize(target);
  const b = tokenize(heard);
  const an = a.map((t) => normalize(t));
  const bn = b.map((t) => normalize(t));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (an[i - 1] === bn[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && an[i - 1] === bn[j - 1]) {
      ops.push({ type: "match" });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: "sub", want: a[i - 1], heard: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: "del", want: a[i - 1] });
      i--;
    } else {
      ops.push({ type: "ins", heard: b[j - 1] });
      j--;
    }
  }
  ops.reverse();

  const diffs = [];
  let cur = null;
  for (const op of ops) {
    if (op.type === "match") {
      if (cur) {
        diffs.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) cur = { want: [], heard: [] };
    if (op.want != null) cur.want.push(op.want);
    if (op.heard != null) cur.heard.push(op.heard);
  }
  if (cur) diffs.push(cur);

  return diffs.map((d) => ({ want: d.want.join(" "), heard: d.heard.join(" ") }));
}

/**
 * Compare a transcribed line against its intended `text` (caption) and, if
 * present, `say` (what was actually spoken — pronunciation-rewritten for
 * names/numbers/English terms per references/voice.md). Character error
 * rate is the MIN over both targets, since a correct reading of `say` can
 * legitimately transcribe differently from `text` (e.g. "UTM" read as
 * "유티엠" vs spelled "UTM" — either is a correct read, only `text` should
 * be penalized, `say` should not).
 * `lang` (optional) applies that language's rules (numbers, Simplified/
 * Traditional, kana) to both sides before comparing, so "2 nm" heard as "two
 * nanometers" is not an error. `names` (pronounceFolds) folds a name spoken as
 * its respelling back to the written name on both sides.
 * @param {{text:string, say?:string, heard:string, lang?:string|null, names?:[string,string][]|null}} args
 * @returns {{cer:number, against:"text"|"say", diffs:{want:string,heard:string}[]}}
 */
export function compareLine({ text, say, heard, lang = null, names = null }) {
  const candidates = [{ key: "text", value: stripTags(text) }];
  if (say != null) candidates.push({ key: "say", value: stripTags(say) });

  let best = null;
  for (const c of candidates) {
    const c_er = cer(c.value, heard, lang, names);
    if (!best || c_er < best.cer) {
      best = { against: c.key, cer: c_er, target: c.value };
    }
  }

  const diffs = tokenDiffs(fold(best.target, lang, names), fold(heard, lang, names));
  return { cer: best.cer, against: best.against, diffs };
}

// STT has its own error, so only a gross mismatch is flagged: most of the
// line wrong, or a take clearly shorter (dropped words, cut off) or longer
// (babble, words that were never in the script) than the line.
const GROSS_CER = 0.5;
const MIN_LENGTH_RATIO = 0.7;
const MAX_LENGTH_RATIO = 1.4;

/**
 * Whether a take is wrong beyond STT's own noise. Near-homophones, names and
 * spacing differences never trip it.
 * @param {string} target the line as it should be heard (`say ?? text`)
 * @param {string} heard the STT transcript
 * @param {number} lineCer the error rate from compareLine
 * @param {string|null} [lang] the line's language, for number and script rules
 * @param {[string,string][]|null} [names] pronounceFolds()
 */
export function isGrossMismatch(target, heard, lineCer, lang = null, names = null) {
  if (lineCer > GROSS_CER) return true;
  const nt = normalize(stripTags(target), lang, names).length;
  if (nt === 0) return false;
  const ratio = normalize(heard, lang, names).length / nt;
  return ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO;
}

/**
 * Whether `heard` ends with the same final two normalized characters as
 * `target` — a cheap proxy for "the last syllable was not cut off",
 * complementing the qwen3 provider's own tail-RMS gate (voiceFlag TAIL).
 * @param {string} target
 * @param {string} heard
 * @param {string|null} [lang] the line's language, for number and script rules
 * @param {[string,string][]|null} [names] pronounceFolds()
 */
export function tailCleared(target, heard, lang = null, names = null) {
  const nt = normalize(stripTags(target), lang, names);
  const nh = normalize(heard, lang, names);
  if (nt.length === 0) return true;
  const tail = nt.slice(-2);
  return nh.endsWith(tail);
}
