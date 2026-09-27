// Pure unit tests for the STT round-trip comparison helpers (no network, no
// python — scripts/lib/stt-compare.mjs is pure text math).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, cer, compareLine, isGrossMismatch, tailCleared } from "../scripts/lib/stt-compare.mjs";

test("normalize: lowercases and strips whitespace/punctuation, keeps letters/digits of any script", () => {
  assert.equal(normalize("Hello, World!"), "helloworld");
  assert.equal(normalize("  웨비나  입니다.  "), "웨비나입니다");
  assert.equal(normalize("UTM 2026"), "utm2026");
  assert.equal(normalize(""), "");
  assert.equal(normalize(undefined), "");
});

test("cer: identical strings -> 0", () => {
  assert.equal(cer("웨비나에 오신 것을 환영합니다", "웨비나에 오신 것을 환영합니다"), 0);
  assert.equal(cer("hello world", "Hello, World!"), 0); // punctuation/case-insensitive
});

test("cer: one substitution -> 1/length", () => {
  assert.equal(cer("abcde", "abXde"), 1 / 5);
});

test("cer: empty inputs", () => {
  assert.equal(cer("", ""), 0);
  assert.equal(cer("", "hello"), 5 / 1); // empty target floors denominator at 1
  assert.equal(cer("hello", ""), 1); // whole target missing -> full distance / length
});

test("compareLine: min over text/say — UTM (text) vs 유티엠 (say) both correct reads", () => {
  // The voice read "UTM" as "유티엠" (say), which the STT model transcribes
  // as Korean spelling. Against `text` ("UTM") this looks wrong, but
  // against `say` ("유티엠") it's a correct read — cer must pick `say`.
  const result = compareLine({ text: "UTM 대시보드를 확인하세요", say: "유티엠 대시보드를 확인하세요", heard: "유티엠 대시보드를 확인하세요" });
  assert.equal(result.against, "say");
  assert.equal(result.cer, 0);
});

test("compareLine: falls back to text when say is absent", () => {
  const result = compareLine({ text: "짧은 문장입니다", heard: "짧은 문장입니다" });
  assert.equal(result.against, "text");
  assert.equal(result.cer, 0);
});

test("compareLine: diffs on the 웨비나/웹이나 example", () => {
  const result = compareLine({ text: "웨비나에 참여해 주세요", heard: "웹이나에 참여해 주세요" });
  assert.ok(result.cer > 0);
  assert.equal(result.diffs.length, 1);
  assert.equal(result.diffs[0].want, "웨비나에");
  assert.equal(result.diffs[0].heard, "웹이나에");
});

test("compareLine: no diffs when heard matches exactly", () => {
  const result = compareLine({ text: "정확히 들렸습니다", heard: "정확히 들렸습니다" });
  assert.equal(result.diffs.length, 0);
});

test("tailCleared: true when heard ends with the target's last two normalized characters", () => {
  assert.equal(tailCleared("오늘도 좋은 하루 되세요", "오늘도 좋은 하루 되세요"), true);
  assert.equal(tailCleared("환영합니다", "환영"), false); // cut mid-word, tail missing
  assert.equal(tailCleared("환영합니다", "정말 환영합니다"), true); // tail present even with leading junk
});

test("tailCleared: false when the last syllable is clipped", () => {
  assert.equal(tailCleared("감사합니다", "감사합니"), false);
});

test("tailCleared: empty target is trivially cleared", () => {
  assert.equal(tailCleared("", "anything"), true);
});

test("isGrossMismatch: a misheard name or near-homophone passes", () => {
  const target = "하늘카페는 정반대예요 할인 코너는 자기들 거라는 거죠";
  const heard = "하늘까페는 정반대예요 할인 코너는 자기들 거라는 거죠";
  assert.equal(isGrossMismatch(target, heard, compareLine({ text: target, heard }).cer), false);
});

test("isGrossMismatch: a dropped clause, a cut take, babble or nonsense is flagged", () => {
  const target = "문제는 반품이에요 팔 점 이 퍼센트로 세 브랜드 중 가장 많아요";
  const cases = [
    "문제는 반품이에요", // dropped clause
    "문제는 반품이에요 팔 점 이 퍼센트로 세 브랜드 중 가장 많아요 그리고 좀 더 말하자면 이건", // babble
    "오늘 날씨가 참 좋네요 산책이나 갈까요 저녁은 뭐 먹지", // nonsense
  ];
  for (const heard of cases) {
    assert.equal(isGrossMismatch(target, heard, compareLine({ text: target, heard }).cer), true, heard);
  }
});
