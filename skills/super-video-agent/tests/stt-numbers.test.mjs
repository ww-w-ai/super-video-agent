// Number rules before the STT comparison (V9): English, Korean, Chinese and
// Japanese (a1-stt.test.mjs covers the last three); every other language is
// compared exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumbers, enWordsToDigits, NUMBER_RULE_LANGUAGES } from "../scripts/lib/stt-numbers.mjs";
import { compareLine, cer, isGrossMismatch, tailCleared } from "../scripts/lib/stt-compare.mjs";

test("enWordsToDigits: compound numbers join; words that cannot continue start a new number", () => {
  assert.deepEqual(enWordsToDigits(["twenty", "five"]), ["25"]);
  assert.deepEqual(enWordsToDigits(["one", "hundred", "and", "five"]), ["105"]);
  assert.deepEqual(enWordsToDigits(["two", "million", "three", "hundred", "thousand"]), ["2300000"]);
  assert.deepEqual(enWordsToDigits(["five", "point", "two"]), ["5.2"]);
  assert.deepEqual(enWordsToDigits(["one", "two", "three"]), ["1", "2", "3"]);
  assert.deepEqual(enWordsToDigits(["twenty", "twenty"]), ["20", "20"]);
  assert.deepEqual(enWordsToDigits(["nineteen", "hundred"]), ["1900"]);
  assert.deepEqual(enWordsToDigits(["five", "and"]), ["5", "and"]);
});

test("normalizeNumbers en: number words, units, dollars and percent written one way", () => {
  assert.equal(normalizeNumbers("Two nanometers", "en"), "2nm");
  assert.equal(normalizeNumbers("a 2-nanometer chip", "en"), "a 2nm chip");
  assert.equal(normalizeNumbers("5.2 mm", "en"), "5.2mm");
  assert.equal(normalizeNumbers("five point two millimeters", "en"), "5.2mm");
  assert.equal(normalizeNumbers("$5 million", "en"), "5000000 dollars");
  assert.equal(normalizeNumbers("five million dollars", "en"), "5000000 dollars");
  assert.equal(normalizeNumbers("50%", "en"), "50 percent");
  assert.equal(normalizeNumbers("fifty per cent", "en"), "50 percent");
  assert.equal(normalizeNumbers("someone and no one", "en"), "someone and no 1");
  assert.equal(normalizeNumbers("metropolitan", "en"), "metropolitan");
});

test("normalizeNumbers: languages without rules and no language are unchanged", () => {
  assert.deepEqual(NUMBER_RULE_LANGUAGES, ["en", "ko", "zh", "ja"]);
  for (const lang of ["de", "fr", null, undefined]) {
    assert.equal(normalizeNumbers("two 2 nanometers 50%", lang), "two 2 nanometers 50%");
  }
  assert.equal(normalizeNumbers("two", "en-US"), "2");
  assert.equal(normalizeNumbers("two", "english"), "2");
});

test("compareLine with lang en: a number read correctly is not an error; without lang it still is", () => {
  const args = { text: "The chip is 2 nm and costs $5.", heard: "The chip is two nanometers and costs five dollars." };
  assert.equal(compareLine({ ...args, lang: "en" }).cer, 0);
  assert.deepEqual(compareLine({ ...args, lang: "en" }).diffs, []);
  assert.ok(compareLine(args).cer > 0);
  assert.ok(cer("50%", "fifty percent", "en") === 0);
});

test("compareLine with lang en: a wrong number still counts", () => {
  const r = compareLine({ text: "It took 3 days.", heard: "It took four days.", lang: "en" });
  assert.ok(r.cer > 0);
  assert.deepEqual(r.diffs, [{ want: "3", heard: "4" }]);
});

test("isGrossMismatch / tailCleared use the same number rules", () => {
  assert.equal(isGrossMismatch("Up 25%", "up twenty five percent", 0, "en"), false);
  assert.equal(isGrossMismatch("Up 25%", "up twenty five percent", 0), true);
  assert.equal(tailCleared("It is 7", "it is seven", "en"), true);
  assert.equal(tailCleared("It is 7", "it is seven"), false);
});
