// K3: a "|" break marker attached to a word ("X| Y", "X |Y", "X|Y") is still a break marker — never
// drawn, spoken or written to an SRT — and ja/zh rows, chunks and cues never break inside a word
// (Intl.Segmenter word segment of up to 14 characters). Other languages keep their output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCues, formatSrt, alignScript } from "../scripts/lib/srt.mjs";
import { stripCaptionBreaks } from "../scripts/lib/pronounce.mjs";
import { captionWords } from "../scripts/lib/cue-check.mjs";
import { captionPieces } from "../scripts/lib/caption-breaks.mjs";

await import("../scripts/engine/reel-engine.js");
const Reel = globalThis.Reel;

const ctx = { measureText: (s) => ({ width: 10 * [...s].length }) };

/** Boundaries i (between texts[i] and texts[i+1]) that fall strictly inside a segmenter word. */
function insideBoundaries(texts, lang) {
  const ends = [];
  let at = 0;
  for (const t of texts) { at += t.length; ends.push(at); }
  const inside = new Set();
  for (const s of new Intl.Segmenter(lang, { granularity: "word" }).segment(texts.join(""))) {
    if (!s.isWordLike || s.segment.length > 14) continue;
    const from = s.index;
    const to = s.index + s.segment.length;
    ends.forEach((e, i) => { if (i + 1 < texts.length && e > from && e < to) inside.add(i); });
  }
  return [...inside];
}

test("T1 an attached | is a break marker on either side", () => {
  for (const t of ["A X| Y B", "A X |Y B", "A X|Y B", "A X | Y B"]) {
    assert.deepEqual(Reel.captionBreaksFromText(t), [1], t);
  }
  assert.equal(Reel.normalizeCaptionBreaks("A X|Y B"), "A X | Y B");
});

test("T2 an attached | is never drawn", () => {
  const ja = Reel.captionRows(ctx, "前半| 後半です", 1000, "ja");
  assert.ok(ja.words.length > 0);
  assert.ok(!ja.words.some((w) => w.includes("|")), JSON.stringify(ja.words));
  assert.ok(ja.rows.length >= 2, "the marker still starts a new row");
  const en = Reel.captionRows(ctx, "first| second", 1000, "en");
  assert.deepEqual(en.words, ["first", "second"]);
  assert.equal(en.rows.length, 2);
  const lines = Reel.captionRows(ctx, "one|two", 1000, "en");
  assert.deepEqual(lines.words, ["one", "two"]);
});

test("T3 an attached | never reaches an SRT, the aligner, cue words or the break report", () => {
  const built = buildCues(Reel, [{ id: "l1", text: "前半| 後半です", start: 0, end: 2 }], { lang: "ja" });
  const srt = formatSrt(built.cues);
  assert.ok(srt.includes("前半"), srt);
  assert.ok(!srt.includes("|"), srt);

  const seen = [];
  const heard = [{ w: "X", start: 0, end: 0.5 }, { w: "Y", start: 0.5, end: 1 }];
  alignScript([{ id: "a", text: "X| Y" }, { id: "b", text: "X|Y" }], heard, {
    letters: (t) => t.replace(/\s/g, "").split(""),
    align: (text) => {
      seen.push(text);
      return { words: [{ w: "X", start: 0, end: 0.5 }, { w: "Y", start: 0.5, end: 1 }], measured: 2 };
    },
  });
  assert.deepEqual(seen, ["X Y", "X Y"]);

  assert.deepEqual(captionWords("A X|Y B"), ["A", "X", "Y", "B"]);
  assert.deepEqual(captionWords("A X| Y B"), ["A", "X", "Y", "B"]);
  assert.deepEqual(captionPieces(Reel, "A X|Y B"), [["A", "X"], ["Y", "B"]]);
  assert.deepEqual(captionPieces(Reel, "A X |Y B"), [["A", "X"], ["Y", "B"]]);
});

test("T4 an attached | is never spoken", () => {
  assert.equal(stripCaptionBreaks("X| Y"), "X Y");
  assert.equal(stripCaptionBreaks("X |Y"), "X Y");
  assert.equal(stripCaptionBreaks("X|Y"), "X Y");
  assert.equal(stripCaptionBreaks("X | Y"), "X Y");
});

test("T5 ja units are glued at every boundary inside a segmenter word", () => {
  for (const t of ["ネットフリックスを超える", "絡む", "二人が絡む場面"]) {
    const u = Reel.captionUnits(t, "ja");
    const inside = insideBoundaries(u.texts, "ja");
    assert.ok(inside.length >= 1, `${t}: the fixture has an in-word boundary`);
    for (const i of inside) assert.equal(u.glue[i], true, `${t}: ${u.texts[i]}/${u.texts[i + 1]}`);
  }
});

test("T5b segment glue never crosses a writer's space", () => {
  assert.deepEqual(insideBoundaries(["一", "个"], "zh"), [0], "一个 is one segmenter word");
  const u = Reel.captionUnits("一 个", "zh");
  assert.deepEqual(u.texts, ["一", "个"]);
  assert.equal(u.glue[0], false);
});

test("T6 ja/zh rows never end inside a segmenter word", () => {
  for (const [t, w, lang] of [["整件事情的对决", 30, "zh"], ["二人が絡む場面", 40, "ja"]]) {
    const r = Reel.captionRows(ctx, t, w, lang);
    const inside = new Set(insideBoundaries(r.words, lang));
    assert.ok(inside.size >= 1, `${t}: the fixture has an in-word boundary`);
    assert.ok(r.rows.length >= 2, `${t}: the fixture wraps`);
    for (const row of r.rows.slice(0, -1)) {
      const last = row[row.length - 1];
      assert.ok(!inside.has(last), `${t} @${w}: row ends inside a word at ${r.words[last]}/${r.words[last + 1]}`);
    }
  }
});

test("T6b a katakana loanword the segmenter splits is never broken across rows", () => {
  const t = "ネットフリックスを超える";
  const katakanaEnd = "ネットフリックス".length;
  // Widths where the 8-character run fits a row but the 12-character line wraps (main splits it 6/6).
  for (const w of [80, 90, 100, 110]) {
    const r = Reel.captionRows(ctx, t, w, "ja");
    assert.ok(r.rows.length >= 2, `@${w}: the fixture wraps`);
    let at = 0;
    for (const row of r.rows.slice(0, -1)) {
      at += row.reduce((n, i) => n + r.words[i].length, 0);
      assert.ok(at <= 0 || at >= katakanaEnd, `@${w}: a row ends inside ネットフリックス after ${at} chars`);
    }
  }
  const u = Reel.captionUnits("ネット・フリックス", "ja");
  assert.equal(u.glue[u.texts.indexOf("・")], false, "・ ends a katakana run");
});

test("T7 regression: other languages and segment-edge ja/zh lines are unchanged", () => {
  const fx = {
    en: ["The model costs 5 dollars (per month) and it runs fast, every day.",
      [true, false, false, true, false, true, false, false, false, false, false, false, false],
      [[0, 1, 2], [3, 4], [5, 6, 7, 8], [9, 10], [11, 12]]],
    es: ["El modelo cuesta 5 euros al mes y funciona en la nube.",
      [true, false, false, true, false, true, false, false, false, true, true, false],
      [[0, 1, 2], [3, 4], [5, 6, 7, 8], [9, 10, 11]]],
    pt: ["O modelo custa 5 euros por mês e roda na nuvem.",
      [true, false, false, true, false, true, false, false, false, true, false],
      [[0, 1, 2], [3, 4, 5, 6, 7], [8, 9, 10]]],
    it: ["Il modello costa 5 euro al mese e gira nel cloud.",
      [true, false, false, false, false, true, false, false, false, true, false],
      [[0, 1, 2], [3, 4], [5, 6, 7, 8], [9, 10]]],
    de: ["Das Modell kostet 5 Euro pro Monat und läuft in der Cloud.",
      [true, false, false, false, false, false, false, false, false, true, true, false],
      [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]]],
    fr: ["Le modèle coûte 5 euros par mois et l'IA tourne dans le cloud.",
      [true, false, false, true, false, true, false, false, false, false, true, true, false],
      [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9], [10, 11, 12]]],
    ko: ["이 모델은 한 달에 5 달러이고 클라우드에서 돌아갑니다.",
      [true, false, true, false, false, false, false, false],
      [[0, 1, 2, 3], [4, 5, 6, 7]]],
    ja: ["猫と犬", [false, false, false], [[0]]],
    zh: ["你和我", [false, false, false], [[0]]],
  };
  for (const [lang, [text, glue, chunks]] of Object.entries(fx)) {
    assert.deepEqual(Reel.captionUnits(text, lang).glue, glue, `${lang} glue`);
    const words = text.split(/\s+/).map((w) => ({ w }));
    assert.deepEqual(Reel.captionChunks(words, 16, { lang }), chunks, `${lang} chunks`);
  }
  const jw = ["今日は", "いい", "天気", "です"].map((w) => ({ w }));
  assert.deepEqual(Reel.captionChunks(jw, 4, { lang: "ja" }), [[0, 1], [2, 3]]);
  assert.deepEqual(Reel.captionGlue(jw.map((x) => x.w), "ja"), [false, false, false, false]);
});
