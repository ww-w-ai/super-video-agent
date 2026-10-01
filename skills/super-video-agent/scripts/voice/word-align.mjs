// Caption word times measured from spoken word times (speech-to-text or a
// provider's alignment). The caption (`text`) and what was heard differ in
// spelling, spacing and number form, so words are matched letter by letter:
// both sides are reduced to letters and digits (numbers read out as words),
// aligned as one letter stream (longest common subsequence), and each caption
// word takes the time of the heard letters it matched. A caption word with
// too few matches is interpolated between its measured neighbours. Pure: no
// I/O.

const KO_DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const KO_SMALL = ["", "십", "백", "천"];
const KO_LARGE = ["", "만", "억", "조"];
const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A caption word counts as measured when at least this share of its letters matched. */
const MIN_MATCH_SHARE = 0.5;

/**
 * Time each caption word from measured spoken words.
 * @param {string} text the caption, caption breaks already stripped
 * @param {{w:string,start:number,end:number}[]} heard spoken words in order, seconds
 * @param {{offset?:number, lang?:string}} [opts] offset added to every time (the line's start
 *   when `heard` is clip-relative); lang "ko" / "en" / other — how digits are read out
 *   (default: from the caption's script)
 * @returns {{words:{w:string,start:number,end:number}[], measured:number}} words empty when
 *   `text` or `heard` is empty; `measured` = caption words timed from their own matched letters
 */
export function alignCaptionWords(text, heard, opts = {}) {
  const offset = opts.offset || 0;
  const captionWords = String(text).split(/\s+/).filter(Boolean);
  const spoken = (heard || []).filter((h) => typeof h.start === "number" && typeof h.end === "number");
  if (!captionWords.length || !spoken.length) return { words: [], measured: 0 };
  const lang = opts.lang || scriptLang(text);

  const capLetters = captionWords.map((w) => matchLetters(w, lang));
  const heardLetters = spoken.map((h) => matchLetters(h.w, lang));
  const capStream = flatten(capLetters);
  const heardStream = flatten(heardLetters);
  const pairs = lcsPairs(capStream.letters, heardStream.letters);

  const anchors = acceptedAnchors(capLetters, capStream, heardStream, pairs);
  const timed = anchorTimes(anchors, heardStream, heardLetters, spoken);
  const words = fillUnmatched(captionWords, capLetters, timed, spoken).map((t, i) => ({
    w: captionWords[i],
    start: t.start + offset,
    end: t.end + offset,
  }));
  return { words, measured: timed.filter(Boolean).length };
}

/** "ko" for Hangul, "en" for Latin, else "" (digits stay digits). */
function scriptLang(text) {
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return "";
}

/**
 * A word as the letters it is compared by: lower case, numbers read out in the language
 * (Korean Sino numbers, English words; "9:15" is 9시 15분 / nine fifteen), everything that is
 * not a letter or digit dropped.
 * @returns {string[]}
 */
export function matchLetters(word, lang) {
  let s = String(word).normalize("NFKC").toLowerCase();
  s = s.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => readClock(Number(h), Number(m), lang));
  s = s.replace(/\d+/g, (d) => readNumber(d, lang));
  return Array.from(s.replace(/[^\p{L}\p{N}]/gu, ""));
}

function readClock(h, m, lang) {
  if (lang === "ko") return `${readNumber(String(h), lang)}시${m ? `${readNumber(String(m), lang)}분` : ""}`;
  return `${readNumber(String(h), lang)} ${m ? readNumber(String(m), lang) : ""}`;
}

function readNumber(digits, lang) {
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return digits;
  if (lang === "ko") return koNumber(n);
  if (lang === "en" && n < 1e6) return enNumber(n);
  return digits;
}

function koNumber(n) {
  if (n === 0) return "영";
  let out = "";
  let group = 0;
  while (n > 0) {
    const part = n % 10000;
    if (part) out = koUnder10000(part) + KO_LARGE[group] + out;
    n = Math.floor(n / 10000);
    group++;
  }
  return out;
}

function koUnder10000(n) {
  let out = "";
  for (let place = 3; place >= 0; place--) {
    const d = Math.floor(n / 10 ** place) % 10;
    if (!d) continue;
    out += (d === 1 && place > 0 ? "" : KO_DIGITS[d]) + KO_SMALL[place];
  }
  return out;
}

function enNumber(n) {
  if (n < 20) return EN_ONES[n];
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? EN_ONES[n % 10] : "");
  if (n < 1000) return EN_ONES[Math.floor(n / 100)] + "hundred" + (n % 100 ? enNumber(n % 100) : "");
  return enNumber(Math.floor(n / 1000)) + "thousand" + (n % 1000 ? enNumber(n % 1000) : "");
}

/** Letters of every word in one stream, each remembering its word and place in it. */
function flatten(lettersPerWord) {
  const letters = [];
  const word = [];
  const place = [];
  lettersPerWord.forEach((ls, wi) => {
    ls.forEach((ch, k) => {
      letters.push(ch);
      word.push(wi);
      place.push(k);
    });
  });
  return { letters, word, place };
}

/** Longest common subsequence of two letter arrays → [captionIndex, heardIndex] pairs, in order. */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const len = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * width + j] = a[i] === b[j] ? len[(i + 1) * width + j + 1] + 1 : Math.max(len[(i + 1) * width + j], len[i * width + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[(i + 1) * width + j] >= len[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * For each caption word: the first and last heard letters it matched, or null when it matched
 * under half its letters or its matches are scattered over more than twice its length.
 */
function acceptedAnchors(capLetters, capStream, heardStream, pairs) {
  const hits = capLetters.map(() => []);
  for (const [ci, hj] of pairs) hits[capStream.word[ci]].push(hj);
  return hits.map((h, wi) => {
    const size = capLetters[wi].length;
    if (!size || h.length < Math.ceil(size * MIN_MATCH_SHARE)) return null;
    const first = h[0];
    const last = h[h.length - 1];
    if (last - first + 1 > 2 * size + 2) return null;
    return { first, last };
  });
}

/**
 * Measured {start, end} per anchored caption word (null for the rest). A word that begins a heard
 * word takes that word's start, one that ends it takes its end; a caption word sharing a heard
 * word with another caption word takes its letters' share of that word's time.
 */
function anchorTimes(anchors, heardStream, heardLetters, spoken) {
  const owner = new Int32Array(heardStream.letters.length).fill(-1);
  anchors.forEach((a, wi) => {
    if (a) for (let g = a.first; g <= a.last; g++) owner[g] = wi;
  });
  const letterTime = (g, edge) => {
    const hw = heardStream.word[g];
    const size = heardLetters[hw].length;
    const { start, end } = spoken[hw];
    const k = heardStream.place[g] + (edge === "end" ? 1 : 0);
    return start + (k / size) * (end - start);
  };
  const sharedBefore = (g, wi) => {
    for (let x = g - heardStream.place[g]; x < g; x++) if (owner[x] !== -1 && owner[x] !== wi) return true;
    return false;
  };
  const sharedAfter = (g, wi) => {
    const hw = heardStream.word[g];
    const stop = g - heardStream.place[g] + heardLetters[hw].length;
    for (let x = g + 1; x < stop; x++) if (owner[x] !== -1 && owner[x] !== wi) return true;
    return false;
  };
  let floor = -Infinity;
  return anchors.map((a, wi) => {
    if (!a) return null;
    const start = sharedBefore(a.first, wi) ? letterTime(a.first, "start") : spoken[heardStream.word[a.first]].start;
    const end = sharedAfter(a.last, wi) ? letterTime(a.last, "end") : spoken[heardStream.word[a.last]].end;
    const s = Math.max(start, floor);
    const e = Math.max(end, s);
    floor = e;
    return { start: s, end: e };
  });
}

/**
 * Unmatched caption words share the time between their measured neighbours by letter count
 * (the first speech and the last speech bound a run at either end of the line).
 */
function fillUnmatched(captionWords, capLetters, timed, spoken) {
  const out = timed.slice();
  const speechStart = spoken[0].start;
  const speechEnd = spoken[spoken.length - 1].end;
  let i = 0;
  while (i < out.length) {
    if (out[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !out[j]) j++;
    const from = i > 0 ? out[i - 1].end : speechStart;
    const to = Math.max(from, j < out.length ? out[j].start : speechEnd);
    spread(out, capLetters, i, j, from, to);
    i = j;
  }
  return out;
}

function spread(out, capLetters, i, j, from, to) {
  const weights = capLetters.slice(i, j).map((ls) => ls.length);
  const total = weights.reduce((a, b) => a + b, 0);
  const share = total ? (k) => weights[k] / total : () => 1 / weights.length;
  let cursor = from;
  for (let k = 0; k < weights.length; k++) {
    const end = cursor + share(k) * (to - from);
    out[i + k] = { start: cursor, end };
    cursor = end;
  }
}
