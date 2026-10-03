// Typecast provider: emotion preset rule, language mapping, request shape and word conversion
// through a stubbed global fetch (no network). ffmpeg converts a tiny real wav.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as typecast from "../scripts/voice/typecast.mjs";

const { pickEmotionPreset, languageCode, buildBody, wordsFromTypecast } = typecast;

test("typecast: provider name and no inline tags", () => {
  assert.equal(typecast.name, "typecast");
  assert.equal(typecast.tagMap({}), null);
});

test("pickEmotionPreset: ? and ! endings get toneup, others normal", () => {
  for (const t of ["정말요?", "드디어 나왔습니다!", "뭐?!", "뭐!?", "그래요? ", '"진짜?"', "정말?」", "Really?)"]) {
    assert.equal(pickEmotionPreset(t), "toneup", t);
  }
  for (const t of ["그렇습니다.", "뭐? 그렇습니다", "끝", "wait... ok"]) {
    assert.equal(pickEmotionPreset(t), "normal", t);
  }
});

test("pickEmotionPreset: voiceCfg.emotion overrides, unknown value is ignored", () => {
  assert.equal(pickEmotionPreset("정말요?", { emotion: "whisper" }), "whisper");
  assert.equal(pickEmotionPreset("끝.", { emotion: "happy" }), "happy");
  assert.equal(pickEmotionPreset("정말요?", { emotion: "bogus" }), "toneup");
});

test("languageCode: BCP 47 to ISO 639-3, unknown omitted", () => {
  assert.equal(languageCode("ko"), "kor");
  assert.equal(languageCode("ko-KR"), "kor");
  assert.equal(languageCode("en-US"), "eng");
  assert.equal(languageCode("ja"), "jpn");
  assert.equal(languageCode("zh-Hans"), "zho");
  assert.equal(languageCode("zh-Hant"), "zho");
  assert.equal(languageCode("fra"), "fra");
  assert.equal(languageCode("xx"), undefined);
  assert.equal(languageCode(undefined), undefined);
});

test("buildBody: defaults, overrides, language omitted when unknown", () => {
  const b = buildBody({ text: "안녕?", voiceId: "tc_1", lang: "ko-KR", voiceCfg: {} });
  assert.deepEqual(b, {
    text: "안녕?",
    model: "ssfm-v30",
    voice_id: "tc_1",
    language: "kor",
    prompt: { emotion_type: "preset", emotion_preset: "toneup", emotion_intensity: 1 },
    output: { audio_format: "wav" },
  });
  const c = buildBody({ text: "끝.", voiceId: "tc_1", lang: "xx", voiceCfg: { model: "ssfm-v21", emotionIntensity: 1.5 } });
  assert.equal("language" in c, false);
  assert.equal(c.model, "ssfm-v21");
  assert.deepEqual(c.prompt, { emotion_type: "preset", emotion_preset: "normal", emotion_intensity: 1.5 });
});

test("wordsFromTypecast: offsets by lineStart, drops blanks, empty gives undefined", () => {
  const w = wordsFromTypecast([{ text: "드디어", start: 0.1, end: 0.5 }, { text: " ", start: 0.5, end: 0.6 }, { text: "나왔습니다!", start: 0.6, end: 1.2 }], 2);
  assert.deepEqual(w, [{ w: "드디어", start: 2.1, end: 2.5 }, { w: "나왔습니다!", start: 2.6, end: 3.2 }]);
  assert.equal(wordsFromTypecast(null, 0), undefined);
  assert.equal(wordsFromTypecast([], 0), undefined);
});

function tinyWavBase64(dir) {
  const p = path.join(dir, "tiny.wav");
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.2", p]);
  assert.equal(r.status, 0, "ffmpeg available");
  return fs.readFileSync(p).toString("base64");
}

test("synth: request url/headers/body and word conversion via stubbed fetch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const realFetch = globalThis.fetch;
  const prevKey = process.env.TYPECAST_API_KEY;
  process.env.TYPECAST_API_KEY = "test-key";
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      json: async () => ({ audio: tinyWavBase64(dir), audio_format: "wav", audio_duration: 0.2, words: [{ text: "안녕", start: 0, end: 0.1 }] }),
    };
  };
  try {
    const outPath = path.join(dir, "out.wav");
    const res = await typecast.synth({ text: "안녕!", voice: "tc_9", lang: "ko", voiceCfg: {}, outPath, lineStart: 1 });
    assert.match(seen.url, /^https:\/\/api\.typecast\.ai\/v1\/text-to-speech\/with-timestamps/);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["X-API-KEY"], "test-key");
    const body = JSON.parse(seen.init.body);
    assert.equal(body.voice_id, "tc_9");
    assert.equal(body.language, "kor");
    assert.equal(body.prompt.emotion_preset, "toneup");
    assert.deepEqual(res.words, [{ w: "안녕", start: 0, end: 0.1 }]);
    assert.equal(res.wordsRelative, true);
    assert.ok(fs.existsSync(outPath));
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.TYPECAST_API_KEY;
    else process.env.TYPECAST_API_KEY = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synth: clear errors when key or voice id is missing", async () => {
  const prevKey = process.env.TYPECAST_API_KEY;
  const prevVoice = process.env.TYPECAST_VOICE_ID;
  delete process.env.TYPECAST_API_KEY;
  delete process.env.TYPECAST_VOICE_ID;
  try {
    await assert.rejects(typecast.synth({ text: "a", outPath: "/tmp/x.wav" }), /TYPECAST_API_KEY/);
    process.env.TYPECAST_API_KEY = "k";
    await assert.rejects(typecast.synth({ text: "a", outPath: "/tmp/x.wav" }), /TYPECAST_VOICE_ID/);
  } finally {
    if (prevKey === undefined) delete process.env.TYPECAST_API_KEY;
    else process.env.TYPECAST_API_KEY = prevKey;
    if (prevVoice !== undefined) process.env.TYPECAST_VOICE_ID = prevVoice;
  }
});

 test("removeSilenceMs: retained milliseconds, including zero, with invalid values rejected", () => {
  for (const value of [0,100,1000]) assert.equal(buildBody({text:"a",voiceId:"v",voiceCfg:{removeSilenceMs:value}}).output.remove_silence_ms,value);
  for (const value of [-1,1001,1.5,true,"100",NaN]) assert.throws(()=>buildBody({text:"a",voiceId:"v",voiceCfg:{removeSilenceMs:value}}),/integer/);
  assert.equal("remove_silence_ms" in buildBody({text:"a",voiceId:"v"}).output,false);
});
