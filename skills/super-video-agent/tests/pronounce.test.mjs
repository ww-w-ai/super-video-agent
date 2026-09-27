import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenText } from "../scripts/lib/pronounce.mjs";

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
