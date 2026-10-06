// Number spelling before the speech-to-text comparison (stt-compare.mjs).
// A line written "2 nm" and heard "two nanometers" is read correctly, but a
// character error rate over the raw text counts it as wrong. Both sides go
// through the same per-language rules first, so only a real misreading
// raises the rate. Rules exist only where they are unambiguous; a language
// without a rule table is compared exactly as before.
//
// Covered: English (en, en-*); Korean (Sino-Korean and native numbers with a
// counter, mixed digits such as "2억 5000만"); Chinese and Japanese (hanzi/kanji
// numerals, "百分之N"). Every other language: unchanged.

import { normalizeKorean, normalizeChinese, normalizeJapanese } from "./stt-numbers-cjk.mjs";

const EN_SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_SCALE = { thousand: 1e3, million: 1e6, billion: 1e9 };

// Long unit names after a number, and the short form a script writes.
const EN_UNITS = [
  [/nanomet(?:er|re)s?/, "nm"],
  [/millimet(?:er|re)s?/, "mm"],
  [/centimet(?:er|re)s?/, "cm"],
  [/kilomet(?:er|re)s?/, "km"],
  [/met(?:er|re)s?/, "m"],
  [/milligrams?/, "mg"],
  [/kilograms?/, "kg"],
  [/grams?/, "g"],
  [/kilobytes?/, "kb"],
  [/megabytes?/, "mb"],
  [/gigabytes?/, "gb"],
  [/terabytes?/, "tb"],
  [/megahertz/, "mhz"],
  [/gigahertz/, "ghz"],
];

const EN_NUMBER_WORD = new RegExp(
  `\\b(?:${[...Object.keys(EN_SMALL), "hundred", ...Object.keys(EN_SCALE)].join("|")})\\b` +
    `(?:(?:[\\s-]+)(?:${[...Object.keys(EN_SMALL), "hundred", ...Object.keys(EN_SCALE), "and", "point"].join("|")})\\b)*`,
  "g"
);

/**
 * Splits a run of English number words into numbers, each written in
 * digits. A word that cannot continue the number before it starts a new
 * one ("one two" stays 1 2, "twenty twenty" stays 20 20); "and" is kept as a
 * word unless it sits between "hundred"/a scale and a smaller number;
 * "point" followed by digit words makes a decimal.
 * @param {string[]} words lowercase
 * @returns {string[]} digits and leftover words, in order
 */
export function enWordsToDigits(words) {
  const out = [];
  let total = 0;
  let group = 0; // 0..999 part being built
  let last = null; // "unit" | "teen" | "tens" | "hundred" | "scale"
  let lastScale = Infinity;
  let decimals = null;
  let any = false;

  const flush = () => {
    if (!any) return;
    let s = String(total + group);
    if (decimals !== null) s += "." + decimals;
    out.push(s);
    total = 0;
    group = 0;
    last = null;
    lastScale = Infinity;
    decimals = null;
    any = false;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (decimals !== null) {
      if (w in EN_SMALL && EN_SMALL[w] < 10) {
        decimals += String(EN_SMALL[w]);
        continue;
      }
      flush();
    }
    if (w === "point") {
      if (any && next in EN_SMALL && EN_SMALL[next] < 10) {
        decimals = "";
        continue;
      }
      flush();
      out.push(w);
      continue;
    }
    if (w === "and") {
      const joins = (last === "hundred" || last === "scale") && next in EN_SMALL;
      if (!joins) {
        flush();
        out.push(w);
      }
      continue;
    }
    if (w in EN_SMALL) {
      const v = EN_SMALL[w];
      const kind = v < 10 ? "unit" : v < 20 ? "teen" : "tens";
      const fits =
        last === null || last === "hundred" || last === "scale" || (kind === "unit" && last === "tens" && group % 10 === 0);
      if (!fits) flush();
      group += v;
      last = kind;
      any = true;
      continue;
    }
    if (w === "hundred") {
      if (!any || group === 0 || group >= 100 || last === "hundred") {
        flush();
        group = 1;
      }
      group *= 100;
      last = "hundred";
      any = true;
      continue;
    }
    if (w in EN_SCALE) {
      const scale = EN_SCALE[w];
      if (!any || scale >= lastScale || (group === 0 && last !== null)) {
        flush();
        group = 1;
      }
      total += (group || 1) * scale;
      group = 0;
      last = "scale";
      lastScale = scale;
      any = true;
      continue;
    }
    flush();
    out.push(w);
  }
  flush();
  return out;
}

function scaleDigits(numText, scaleWord) {
  const n = Number(numText.replace(/,/g, "")) * EN_SCALE[scaleWord];
  return Number.isInteger(n) ? String(n) : null;
}

/** The English rules, applied to lowercase text. */
function normalizeEnglish(s) {
  let t = s.toLowerCase();
  // "5 million" (digits + scale word) -> 5000000, before the scale word alone is read as a number
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s+(thousand|million|billion)\b/g, (m, num, scale) => scaleDigits(num, scale) ?? m);
  t = t.replace(EN_NUMBER_WORD, (run) => enWordsToDigits(run.split(/[\s-]+/).filter(Boolean)).join(" "));
  // "$5" is read "5 dollars"; "%" is read "percent"
  t = t.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars");
  t = t.replace(/%/g, " percent").replace(/\bper cent\b/g, "percent");
  for (const [long, short] of EN_UNITS) {
    t = t.replace(new RegExp(`(\\d)[\\s-]*${long.source}\\b`, "g"), `$1${short}`);
  }
  // "5.2 mm" and "5.2mm" are the same: no space between a number and its short unit
  const shorts = EN_UNITS.map(([, short]) => short).join("|");
  return t.replace(new RegExp(`(\\d)[\\s-]+(${shorts})\\b`, "g"), "$1$2");
}

/** Rule table: primary language subtag -> rules. Add a language only with rules that are unambiguous. */
const NUMBER_RULES = { en: normalizeEnglish, ko: normalizeKorean, zh: normalizeChinese, ja: normalizeJapanese };

/** Languages whose numbers are normalized before the comparison. */
export const NUMBER_RULE_LANGUAGES = Object.keys(NUMBER_RULES);

/**
 * Writes the numbers of `s` the way that language's rules say (English:
 * number words to digits, "$5" -> "5 dollars", "%" -> "percent", "2
 * nanometers" -> "2nm"). Korean, Chinese and Japanese numerals are written as digits
 * too (stt-numbers-cjk.mjs). Any other or missing language returns `s` as is.
 * @param {string} s
 * @param {string|null|undefined} lang BCP 47 code or STT language name ("en", "en-US", "english")
 */
export function normalizeNumbers(s, lang) {
  const rules = NUMBER_RULES[primaryLang(lang)];
  return rules ? rules(String(s ?? "")) : String(s ?? "");
}

/** Primary language subtag of a BCP 47 code or an STT language name ("zh-Hant" -> "zh"); null when none. */
export function primaryLang(lang) {
  if (!lang) return null;
  const l = String(lang).toLowerCase();
  const names = { english: "en", korean: "ko", chinese: "zh", japanese: "ja" };
  if (names[l]) return names[l];
  return l.split(/[-_]/)[0];
}
