// Number rules for Korean, Chinese and Japanese (used by stt-numbers.mjs).
// A number written in digits and the same number spoken in words are both
// turned into digits: "2억 5000만" = "이억 오천만", "會員…兩億五千萬" = "2亿5000万".
//
// A run of number characters is converted only when it is clearly a number:
//  - it holds a place word (십 百 千) or a big scale (만 億 …) next to another
//    number piece ("이만", "5000万", "二百"), or
//  - a counter follows it ("세 개", "二〇二六年", "三个").
// A lone "이" or "一" with no counter is left alone: it is usually a particle
// or part of a word. The same rule runs on both sides of a comparison, so a
// wrongly converted word still compares equal to itself.

const ASCII_NUM = /\d[\d,]*(?:\.\d+)?/y;

const KO = {
  digits: { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 },
  small: { 십: 10, 백: 100, 천: 1000 },
  big: { 만: 1e4, 억: 1e8, 조: 1e12 },
  dot: "점",
  afterHangul: /[가-힣]/,
  dayChar: "일",
  counters: [
    "개월", "시간", "퍼센트", "페이지", "킬로", "미터", "센티", "달러", "그램", "개", "명", "원", "년", "월", "일", "시", "분", "초", "번",
    "배", "살", "세", "층", "대", "권", "마리", "장", "잔", "병", "곳", "가지", "달", "주", "위", "등", "점", "회", "차", "편", "호", "쪽",
    "도", "톤", "평", "인", "곡", "줄", "군데", "채", "켤레", "송이", "그루", "벌", "통", "알", "조각", "그릇", "프로",
  ],
};

const HAN_COMMON = {
  digits: { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 },
  small: { 十: 10, 百: 100, 千: 1000 },
  dot: null,
  afterHangul: null,
  dayChar: null,
};

const ZH = {
  ...HAN_COMMON,
  big: { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 },
  counters: [
    "公里", "公斤", "厘米", "毫米", "千米", "小时", "小時", "年", "月", "日", "号", "號", "个", "個", "人", "元", "块", "塊", "回", "次", "倍", "岁", "歲",
    "分", "秒", "点", "點", "时", "時", "台", "件", "本", "枚", "只", "杯", "度", "层", "層", "位", "名", "家", "条", "條", "张", "張", "种", "種", "米", "吨", "克",
    "周", "週", "天", "岁", "门", "門", "场", "場", "页", "頁",
  ],
};

const JA = {
  ...HAN_COMMON,
  big: { 万: 1e4, 萬: 1e4, 億: 1e8, 亿: 1e8, 兆: 1e12 },
  counters: [
    "パーセント", "キロ", "メートル", "センチ", "時間", "分間", "年", "月", "日", "号", "個", "人", "円", "回", "倍", "歳", "分", "秒", "点", "時",
    "台", "件", "本", "枚", "匹", "杯", "度", "階", "位", "名", "社", "冊", "週", "割",
  ],
};

const KO_NATIVE_TENS = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const KO_NATIVE_UNITS = {
  하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 넷: 4, 네: 4, 넉: 4,
  다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
};
const KO_NATIVE_COUNTERS = [
  "개", "명", "살", "마리", "번", "시", "대", "권", "장", "잔", "병", "곳", "가지", "달", "채", "켤레", "송이", "그루", "벌", "군데", "줄", "곡", "분",
];

const byLengthDesc = (words) => [...new Set(words)].sort((a, b) => b.length - a.length);

function startsWithAny(s, pos, words) {
  const rest = s[pos] === " " ? pos + 1 : pos;
  return byLengthDesc(words).some((w) => s.startsWith(w, rest));
}

/** One number piece at `p`: ASCII digits, or one number character of `cfg`. */
function readPiece(s, p, cfg) {
  ASCII_NUM.lastIndex = p;
  const m = ASCII_NUM.exec(s);
  if (m) return { end: p + m[0].length, tok: { t: "a", v: Number(m[0].replace(/,/g, "")) } };
  const c = s[p];
  if (c === undefined) return null;
  if (Object.hasOwn(cfg.digits, c)) return { end: p + 1, tok: { t: "d", v: cfg.digits[c], c } };
  if (Object.hasOwn(cfg.small, c)) return { end: p + 1, tok: { t: "s", v: cfg.small[c], c } };
  if (Object.hasOwn(cfg.big, c)) return { end: p + 1, tok: { t: "b", v: cfg.big[c], c } };
  if (cfg.dot && c === cfg.dot) return { end: p + 1, tok: { t: "dot", c } };
  return null;
}

const isScale = (t) => t.t === "s" || t.t === "b";

/** A space may sit between two pieces only when a scale or the decimal point is on one side. */
function spaceJoins(prev, next) {
  return isScale(prev) || isScale(next) || prev.t === "dot" || next.t === "dot";
}

function readRun(s, start, cfg) {
  const tokens = [];
  let p = start;
  for (;;) {
    const q = tokens.length && s[p] === " " ? p + 1 : p;
    const piece = readPiece(s, q, cfg);
    if (!piece || (q > p && !spaceJoins(tokens[tokens.length - 1], piece.tok))) break;
    tokens.push(piece.tok);
    p = piece.end;
  }
  return tokens.length ? { end: p, tokens } : null;
}

/** The whole number of `tokens` as a digit string, or null when they do not form one number. */
function evalInt(tokens) {
  if (!tokens.some(isScale)) return tokens.every((t) => t.t === "d") ? tokens.map((t) => t.v).join("") : null;
  let total = 0;
  let section = 0;
  let cur = null;
  let lastSmall = Infinity;
  let lastBig = Infinity;
  for (const t of tokens) {
    if (t.t === "d" || t.t === "a") {
      if (cur !== null) return null;
      cur = t.v;
    } else if (t.t === "s") {
      if (t.v >= lastSmall) return null;
      section += (cur ?? 1) * t.v;
      cur = null;
      lastSmall = t.v;
    } else if (t.t === "b") {
      if (t.v >= lastBig) return null;
      total += (section + (cur ?? 0) || 1) * t.v;
      section = 0;
      cur = null;
      lastSmall = Infinity;
      lastBig = t.v;
    } else {
      return null;
    }
  }
  return String(Math.round((total + section + (cur ?? 0)) * 1e6) / 1e6);
}

function evalRun(tokens) {
  const dots = tokens.filter((t) => t.t === "dot").length;
  if (!dots) return evalInt(tokens);
  const at = tokens.findIndex((t) => t.t === "dot");
  const right = tokens.slice(at + 1);
  if (dots !== 1 || at === 0 || !right.length || !right.every((t) => t.t === "d")) return null;
  const left = evalInt(tokens.slice(0, at));
  return left === null ? null : `${left}.${right.map((t) => t.v).join("")}`;
}

/**
 * What a run turns into, or null to leave it. A run that ends in the day
 * character (Korean 일) with no other counter after it is a number plus "일":
 * "삼일" -> "3일", the same as "3일" typed in digits.
 */
function convertRun(s, run, cfg) {
  let tokens = run.tokens;
  let tail = "";
  const last = tokens[tokens.length - 1];
  const dayEnd = cfg.dayChar && tokens.length > 1 && last.t === "d" && last.c === cfg.dayChar;
  if (dayEnd && !startsWithAny(s, run.end, cfg.counters.filter((c) => c !== cfg.dayChar))) {
    tokens = tokens.slice(0, -1);
    tail = cfg.dayChar;
  }
  if (tokens.length === 1 && tokens[0].t === "a") return null;
  const value = evalRun(tokens);
  if (value === null) return null;
  const strong = tokens.length >= 2 && tokens.some(isScale) && !tokens.some((t) => t.t === "dot");
  if (!strong && !startsWithAny(s, tail ? run.end - 1 : run.end, tail ? [tail, ...cfg.counters] : cfg.counters)) return null;
  return value + tail;
}

function convertRuns(s, cfg) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const blocked = cfg.afterHangul && i > 0 && cfg.afterHangul.test(s[i - 1]);
    const run = blocked ? null : readRun(s, i, cfg);
    if (!run) {
      out += s[i++];
      continue;
    }
    const value = convertRun(s, run, cfg);
    out += value === null ? s.slice(i, run.end) : value;
    i = run.end;
  }
  return out;
}

/** Native Korean numbers before a counter: "세 개" -> "3개", "스물한 살" -> "21살". */
function convertKoreanNative(s) {
  const tens = Object.keys(KO_NATIVE_TENS).join("|");
  const units = byLengthDesc(Object.keys(KO_NATIVE_UNITS)).join("|");
  const counters = byLengthDesc(KO_NATIVE_COUNTERS).join("|");
  const re = new RegExp(`(?<![가-힣])(${tens})?\\s?(${units})?(?=\\s?(?:${counters}))`, "g");
  return s.replace(re, (m, ten, unit) => {
    if (!ten && !unit) return m;
    return String((ten ? KO_NATIVE_TENS[ten] : 0) + (unit ? KO_NATIVE_UNITS[unit] : 0));
  });
}

/** Korean: native and Sino-Korean numbers, mixed digits, percent, all written as digits. */
export function normalizeKorean(s) {
  return convertRuns(convertKoreanNative(s), KO).replace(/[%％]/g, "퍼센트");
}

const PERCENT_MARK = "";

/** Chinese: hanzi numerals as digits; "50%" and "百分之五十" both become "百分之50". */
export function normalizeChinese(s) {
  const marked = s.replace(/(\d[\d,.]*)\s*[%％]/g, `${PERCENT_MARK}$1`).replace(/百分之/g, PERCENT_MARK);
  return convertRuns(marked, ZH).replaceAll(PERCENT_MARK, "百分之");
}

/** Japanese: kanji numerals as digits; "%" written as パーセント. */
export function normalizeJapanese(s) {
  return convertRuns(s, JA).replace(/[%％]/g, "パーセント");
}
