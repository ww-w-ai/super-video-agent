// Automatic caption-break fallback (reel-engine.js captionGlue / captionChunks /
// captionRows / wrapParts) and the two clocks of a dub (Reel.clocks).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const ctx = { measureText: (s) => ({ width: s.length * 10 }) };
const words = (text) => text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, start: i, end: i + 1 }));
const chunkTexts = (text, maxChars, opts) => {
  const ws = words(text);
  return Reel.captionChunks(ws, maxChars, opts).map((c) => c.map((i) => ws[i].w));
};

// ---- 8: automatic break rules -------------------------------------------------

test("fallback: a break never falls between a number and its unit", () => {
  const text = "We measured about 10 kg of data from the new field station over 30 days today";
  for (let max = 8; max <= 40; max++) {
    const chunks = chunkTexts(text, max);
    chunks.slice(0, -1).forEach((c, k) => {
      const last = c[c.length - 1];
      const first = chunks[k + 1][0];
      assert.ok(!(/\d$/.test(last) && /^(kg|days)$/.test(first)), `max ${max}: ${JSON.stringify(chunks)}`);
    });
  }
});

test("fallback: a break never follows an English article or preposition", () => {
  const text = "Tell me about the history of the old city and a bit of the people who live in the area";
  const small = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with", "from", "about"]);
  for (let max = 14; max <= 40; max++) {
    const chunks = chunkTexts(text, max, { lang: "en-US" });
    chunks.slice(0, -1).forEach((c) => {
      assert.ok(!small.has(c[c.length - 1].toLowerCase()), `max ${max}: ${JSON.stringify(chunks)}`);
    });
  }
});

test("fallback: a break never follows a French article or preposition", () => {
  const text = "Nous avons dans la maison le meilleur de la ville pour les enfants avec un grand chien";
  const small = new Set(["le", "la", "les", "un", "une", "des", "du", "de", "au", "aux", "à", "en", "dans", "sur", "avec", "pour", "par"]);
  for (let max = 14; max <= 40; max++) {
    const chunks = chunkTexts(text, max, { lang: "fr" });
    chunks.slice(0, -1).forEach((c) => {
      assert.ok(!small.has(c[c.length - 1].toLowerCase()), `max ${max}: ${JSON.stringify(chunks)}`);
    });
  }
});

test("fallback: a line that fits one chunk keeps its comma; one that does not still splits there", () => {
  assert.deepEqual(chunkTexts("Yes, we can do it", 40), [["Yes,", "we", "can", "do", "it"]]);
  const long = chunkTexts("Yes, we can do it all by tomorrow morning", 20);
  assert.deepEqual(long[0], ["Yes,"]);
  assert.ok(long.length > 1);
});

test("fallback: a writer's '|' wins over every rule", () => {
  const text = "We went to the | store, today";
  const breaks = Reel.captionBreaksFromText(text);
  const ws = words(text.replace(/\s*\|\s*/g, " "));
  const chunks = Reel.captionChunks(ws, 1000, { breaks, lang: "en" }).map((c) => c.map((i) => ws[i].w));
  assert.deepEqual(chunks, [["We", "went", "to", "the"], ["store,", "today"]]);
});

test("fallback: a Korean dependent noun and spaced particle stay with the word before", () => {
  const g = Reel.captionGlue(["이렇게", "할", "수", "밖에", "없다"], "ko-KR");
  assert.deepEqual(g, [false, true, true, true, false]);
  for (let w = 90; w <= 150; w += 10) {
    const r = Reel.captionRows(ctx, "이렇게 할 수 밖에 없다", w, "ko");
    const rowOf = (i) => r.rows.findIndex((row) => row.includes(i));
    assert.equal(rowOf(1), rowOf(2), `width ${w}: ${JSON.stringify(r.rows)}`);
    assert.equal(rowOf(2), rowOf(3), `width ${w}: ${JSON.stringify(r.rows)}`);
  }
});

test("fallback: nothing breaks inside a short parenthesis or quote span", () => {
  const g = Reel.captionGlue(["see", "(the", "old", "city", "wall)", "for", "details"], "en");
  assert.deepEqual(g.slice(1, 4), [true, true, true]);
  assert.equal(g[0], false);
  assert.equal(g[4], false);
});

test("fallback: Japanese wraps by character but keeps a number+unit and a Latin word whole", () => {
  const u = Reel.captionUnits("今日は30分間で3.5kgをPythonで運びました", "ja");
  assert.ok(u.texts.includes("30分"), JSON.stringify(u.texts));
  assert.ok(u.texts.includes("3.5kg"), JSON.stringify(u.texts));
  assert.ok(u.texts.includes("Python"), JSON.stringify(u.texts));
  assert.ok(u.texts.length > 10, "wraps by character");
  for (let w = 30; w <= 160; w += 10) {
    const r = Reel.captionRows(ctx, "今日は天気がいい、30分間で運びました。", w, "ja");
    const text = r.words;
    r.rows.forEach((row) => {
      assert.ok(!/^[、。]/.test(text[row[0]]), `row starts with a closing mark at width ${w}`);
    });
    const unitRow = r.rows.findIndex((row) => row.some((i) => text[i] === "30分"));
    assert.ok(unitRow >= 0);
  }
});

test("fallback: Chinese number+unit is not split, rows join without spaces", () => {
  const u = Reel.captionUnits("我们用了5个小时写代码", "zh-Hans");
  assert.ok(u.texts.includes("5个"), JSON.stringify(u.texts));
  assert.equal(u.sp.slice(1).some(Boolean), false);
  const lines = [];
  const c = {
    measureText: (s) => ({ width: s.length * 10 }),
    save() {}, restore() {}, set font(v) {}, set fillStyle(v) {}, set textBaseline(v) {},
    fillText(t) { lines.push(t); },
  };
  Reel.textBlock(c, "我们用了5个小时写代码", 0, 0, 60, 1000, { lineHeight: 40, lang: "zh-Hans" });
  assert.ok(lines.length > 1);
  assert.equal(lines.join(""), "我们用了5个小时写代码");
  assert.ok(lines.every((l) => !l.includes(" ")));
});

test("fallback: with no glue, rows are exactly what they were", () => {
  const r = Reel.captionRows(ctx, "aaaa bbbb cccc dddd", 90);
  assert.deepEqual(r.rows, [[0, 1], [2, 3]]);
  assert.deepEqual(r.gaps, [0, 10, 10, 10]);
});

// ---- 9: two clocks in a dub ---------------------------------------------------

const baseTimings = {
  duration: 10,
  lines: [{ id: "l1", text: "this is the big reveal", start: 1, end: 3, words: [
    { w: "this", start: 1, end: 1.3 }, { w: "is", start: 1.3, end: 1.5 }, { w: "the", start: 1.5, end: 1.7 },
    { w: "big", start: 1.7, end: 2, }, { w: "reveal", start: 2, end: 3 } ] }],
};
const dubTimings = {
  duration: 10,
  lines: [{ id: "l1", text: "dies ist die große Enthüllung", start: 1, end: 5, words: [
    { w: "dies", start: 1, end: 2 }, { w: "ist", start: 2, end: 3 }, { w: "die", start: 3, end: 3.5 },
    { w: "große", start: 3.5, end: 4.2 }, { w: "Enthüllung", start: 4.2, end: 5 } ] }],
};

test("clocks: in a dub a word cue on a non-caption layer gets the base clock, captions get the dub's", () => {
  const clk = Reel.clocks(dubTimings, baseTimings);
  assert.equal(clk.cueTime({ at: "word:reveal" }, "l1"), 2);
  assert.equal(clk.word("l1", "big").start, 1.7);
  assert.equal(clk.base.line(0).end, 3);
  assert.equal(clk.caption.word(0, 4).start, 4.2); // captions: the dub voice's time for the same word slot
  assert.equal(clk.caption.line(0).end, 5);
  assert.equal(clk.cueTime({ at: "word:reveal", offsetMs: 200 }, "l1"), 2.2);
});

test("clocks: with no dub both clocks are the same", () => {
  const clk = Reel.clocks(baseTimings);
  assert.equal(clk.base.line(0).end, clk.caption.line(0).end);
  assert.equal(clk.cueTime({ at: "start" }, "l1"), 1);
});

test("clocks: the scaffold loads the base clock in a dub's caption layer", () => {
  for (const f of ["reel.html", "reel-3d.html"]) {
    const html = fs.readFileSync(path.join(here, "..", "assets", "template", f), "utf8");
    assert.match(html, /Reel\.clocks\(timings, baseTimings\)/, f);
    assert.match(html, /voice\/timings\.json/, f);
  }
});
