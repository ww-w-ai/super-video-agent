// Per-line language: a plan line's `lang` (BCP 47) overrides meta.lang for that
// line's voice synthesis, speech-to-text check and read-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineLang, groupByLangCode } from "../scripts/lib/line-lang.mjs";
import { synthBatches, sttTranscribe } from "../scripts/voice.mjs";
import { buildBody } from "../scripts/voice/typecast.mjs";
import { validate } from "../scripts/lib/schema-check.mjs";
import { readJson } from "../scripts/lib/reeldir.mjs";
import { spokenText } from "../scripts/lib/pronounce.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));

test("lineLang: the line's own lang wins, else the film's", () => {
  assert.equal(lineLang({ lang: "en" }, "ko-KR"), "en");
  assert.equal(lineLang({}, "ko-KR"), "ko-KR");
  assert.equal(lineLang(null, "ko-KR"), "ko-KR");
});

test("schema: a line accepts a BCP 47 `lang`, and rejects a malformed one", () => {
  const plan = (lang) => ({ meta: { title: "t", lang: "ko-KR" }, lines: [{ id: "hi", text: "Hello", lang }] });
  assert.equal(validate(plan("en"), schema).valid, true);
  assert.equal(validate(plan("english please"), schema).valid, false);
});

test("synthBatches: a line with lang 'en' in a ko film is sent apart, with the English code", async () => {
  const calls = [];
  const provider = {
    async synthBatch(items, ctx) {
      calls.push({ ids: items.map((i) => i.id), lang: ctx.lang, body: buildBody({ text: items[0].text, voiceId: "tc_x", lang: ctx.lang }) });
      return items.map((i) => ({ id: i.id, wavPath: i.outPath }));
    },
  };
  const voice = { provider, providerName: "typecast", voiceCfg: { voiceId: "tc_x" }, key: "V" };
  const lines = [
    { id: "hi", text: "Hello, I'm Tae.", lang: "en" },
    { id: "a", text: "안녕하세요." },
    { id: "b", text: "오늘은 영상을 만듭니다." },
  ];
  await synthBatches({ lines, lineVoice: () => voice, pronounce: undefined, lang: "ko-KR", dir: "/tmp", voiceDir: "/tmp/voice" });
  assert.deepEqual(calls.map((c) => [c.ids, c.lang]), [[["hi"], "en"], [["a", "b"], "ko-KR"]]);
  assert.equal(calls[0].body.language, "eng");
  assert.equal(calls[1].body.language, "kor");
});

test("sttTranscribe: a line with its own langCode is transcribed in that language, the rest in the film's", async () => {
  const voiceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-stt-"));
  const runs = [];
  const runPythonBatch = async (_py, args, env) => {
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    runs.push({ lang: env.SVA_STT_LANG, ids: job.map((j) => j.id) });
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: `${env.SVA_STT_LANG}:${j.id}`, words: [] }))) };
  };
  const entries = [
    { id: "a", wav: "line-a.wav", langCode: "ko" },
    { id: "hi", wav: "line-hi.wav", langCode: "en" },
    { id: "b", wav: "line-b.wav" },
  ];
  const res = await sttTranscribe(voiceDir, entries, "ko", { pythonPath: "/fake/python", runPythonBatch });
  assert.deepEqual(runs, [{ lang: "ko", ids: ["a", "b"] }, { lang: "en", ids: ["hi"] }]);
  assert.equal(res.results.get("hi"), "en:hi");
  assert.equal(res.results.get("b"), "ko:b");
  fs.rmSync(voiceDir, { recursive: true, force: true });
});

test("groupByLangCode: first-seen order, default code for an entry without one", () => {
  const g = groupByLangCode([{ id: "1" }, { id: "2", langCode: "en" }, { id: "3" }], "ko");
  assert.deepEqual([...g.keys()], ["ko", "en"]);
  assert.deepEqual(g.get("ko").map((e) => e.id), ["1", "3"]);
});

test("read-out: a line's own lang picks that language's built-in respellings", () => {
  const line = { text: "Claude 안녕", lang: "en" };
  assert.equal(spokenText(line, undefined, {}, line.lang), "Clawd 안녕");
  assert.equal(spokenText({ text: "Claude 안녕" }, undefined, {}, "ko-KR"), "클로드 안녕");
});
