import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenText, stripCaptionBreaks, DEFAULT_PRONOUNCE } from "../scripts/lib/pronounce.mjs";

const dict = {
  Nguyen: { say: "Win", ipa: "ˈŋwiən" },
  API: { say: "A P I" },
  GitHub: { say: "Git Hub" },
  "GitHub Actions": { say: "Git Hub Actions" },
  Qi: { ipa: "tʃiː" },
};

test("no dictionary: say, else text", () => {
  assert.equal(spokenText({ text: "MCP" }), "MCP");
  assert.equal(spokenText({ text: "MCP", say: "엠씨피" }), "엠씨피");
});

test("respelling replaces the word in spoken text", () => {
  assert.equal(spokenText({ text: "Ask Nguyen about the API." }, dict), "Ask Win about the A P I.");
});

test("whole words only: API inside RAPID stays", () => {
  assert.equal(spokenText({ text: "RAPID API" }, dict), "RAPID A P I");
});

test("longest entry wins", () => {
  assert.equal(spokenText({ text: "GitHub Actions on GitHub" }, dict), "Git Hub Actions on Git Hub");
});

test("phonemeTags: ipa becomes an SSML phoneme tag", () => {
  assert.equal(
    spokenText({ text: "Nguyen" }, dict, { phonemeTags: true }),
    '<phoneme alphabet="ipa" ph="ˈŋwiən">Nguyen</phoneme>'
  );
});

test("without phonemeTags an ipa-only entry is left alone", () => {
  assert.equal(spokenText({ text: "Qi" }, dict), "Qi");
});

test("applies to say, never touches text", () => {
  const line = { text: "Nguyen", say: "Nguyen, hi" };
  assert.equal(spokenText(line, dict), "Win, hi");
  assert.equal(line.text, "Nguyen");
});

test("line entries override the film's", () => {
  assert.equal(spokenText({ text: "Nguyen", pronounce: { Nguyen: { say: "Nwen" } } }, dict), "Nwen");
});

test("scripts without spaces match inside a run", () => {
  assert.equal(spokenText({ text: "유월에 만나요" }, { 유월: { say: "유월" }, 만나: { say: "만나" } }), "유월에 만나요");
  assert.equal(spokenText({ text: "六月见" }, { 六月: { say: "liù yuè" } }), "liù yuè见");
});

test("spokenText: a caption line break is read as a space", () => {
  assert.equal(spokenText({ text: "3점을 158개나\n넣었는데" }), "3점을 158개나 넣었는데");
  assert.equal(spokenText({ text: "a\nb", say: "에이\n비" }), "에이 비");
});

// --- built-in default respellings (DEFAULT_PRONOUNCE): Fish read "Claude"
// with a "cloud" vowel and STT heard "cloud" — "Clawd" fixed it.

test("spokenText: built-in default respells Claude -> Clawd with no film dictionary at all", () => {
  assert.equal(spokenText({ text: "Ask Claude about it." }), "Ask Clawd about it.");
});

test("spokenText: built-in default applies for an explicit English lang", () => {
  assert.equal(spokenText({ text: "Claude wrote this." }, undefined, undefined, "en-US"), "Clawd wrote this.");
});

test("spokenText: built-in default applies for an explicit Korean lang (문장 안 라틴 표기 대비)", () => {
  assert.equal(spokenText({ text: "Claude가 답했다" }, undefined, undefined, "ko-KR"), "클로드가 답했다");
});

test("spokenText: a film's own meta.pronounce for the same word overrides the built-in default", () => {
  assert.equal(spokenText({ text: "Claude" }, { Claude: { say: "클로드" } }), "클로드");
});

test("spokenText: a line's own pronounce overrides both the film's and the built-in default", () => {
  assert.equal(spokenText({ text: "Claude", pronounce: { Claude: { say: "클로드" } } }, { Claude: { say: "Clawd" } }), "클로드");
});

test("DEFAULT_PRONOUNCE: has both an en and a ko entry for Claude", () => {
  assert.equal(DEFAULT_PRONOUNCE.en.Claude.say, "Clawd");
  assert.equal(DEFAULT_PRONOUNCE.ko.Claude.say, "클로드");
});

// --- "|" forced-caption-break marker (references/pipeline.md "Forced
// caption breaks"): never spoken.

test("stripCaptionBreaks: removes a standalone '|' token, keeps the words", () => {
  assert.equal(stripCaptionBreaks("It rides a radio wave | to that cell tower | up there,"), "It rides a radio wave to that cell tower up there,");
});

test("stripCaptionBreaks: no marker -> unchanged (aside from whitespace normalization)", () => {
  assert.equal(stripCaptionBreaks("plain line"), "plain line");
});

test("spokenText: the '|' marker is stripped before the voice ever sees it", () => {
  assert.equal(spokenText({ text: "wave | to that tower" }), "wave to that tower");
});

test("spokenText: the marker is stripped even when say (not text) is what's spoken", () => {
  assert.equal(spokenText({ text: "wave | to that tower", say: "wave | to the tower" }), "wave to the tower");
});
