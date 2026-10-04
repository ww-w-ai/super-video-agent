// One request per voice for Typecast and Fish: word-to-line mapping, cut points, and the two
// providers' synthBatch through a stubbed fetch (no network). scripts/lib/line-split.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wordsToLines, silenceEdges, plausibleSplit, planCuts, groupByChars, withSentenceEnd } from "../scripts/lib/line-split.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { decodeMonoPcm } from "../scripts/lib/audio-analysis.mjs";
import * as typecast from "../scripts/voice/typecast.mjs";
import * as fish from "../scripts/voice/fish.mjs";

const SR = 48000;

function tones(totalSec, spans, amp = 0.5) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const [from, to] of spans) {
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  return out;
}

const W = (text, start, end) => ({ text, start, end });

test("wordsToLines: words are split at each line's last character", () => {
  const words = [W("안녕", 0.1, 0.5), W("하세요.", 0.5, 1.0), W("반갑습니다!", 1.5, 2.4)];
  const lines = wordsToLines(words, ["안녕 하세요.", "반갑습니다!"]);
  assert.deepEqual(lines.map((l) => l.map((w) => w.text)), [["안녕", "하세요."], ["반갑습니다!"]]);
});

test("wordsToLines: null when the words do not spell the text, miss a boundary, or are absent", () => {
  assert.equal(wordsToLines(null, ["a"]), null);
  assert.equal(wordsToLines([W("안녕", 0, 1)], ["안녕하세요."]), null);
  // one word spans the line boundary
  assert.equal(wordsToLines([W("안녕하세요.", 0, 1), W("반갑", 1, 2)], ["안녕", "하세요. 반갑"]), null);
  // blanks and non-numeric times are ignored, not counted
  assert.equal(wordsToLines([W(" ", 0, 0.1), W("가.", 0.1, 0.5), W("나.", "x", 1)], ["가.", "나."]), null);
});

test("planCuts: timestamps cut midway through the gap between lines", () => {
  const samples = tones(3.4, [[0.1, 1.2], [1.8, 3.2]]);
  const words = [W("안녕", 0.1, 0.6), W("하세요.", 0.6, 1.2), W("반갑습니다!", 1.8, 3.2)];
  const plan = planCuts({ samples, sr: SR, texts: ["안녕 하세요.", "반갑습니다!"], words });
  assert.equal(plan.by, "timestamps");
  assert.ok(Math.abs(plan.spans[0].to - 1.5) < 1e-9, `first cut ${plan.spans[0].to}`);
  assert.ok(Math.abs(plan.spans[1].from - 1.7) < 1e-9, "a clip starts 0.1 s before its first word");
  assert.equal(plan.spans[1].to, 3.4);
  assert.deepEqual(plan.edges, [{ start: 0.1, end: 1.2 }, { start: 1.8, end: 3.2 }]);
});

test("planCuts: no words falls back to the silence between lines", () => {
  const samples = tones(3.4, [[0.1, 1.2], [1.8, 3.2]]);
  const plan = planCuts({ samples, sr: SR, texts: ["안녕 하세요.", "반갑습니다!"], words: undefined });
  assert.equal(plan.by, "silence");
  assert.equal(plan.lineWords, null);
  assert.ok(Math.abs(plan.edges[0].end - 1.2) < 0.03 && Math.abs(plan.edges[1].start - 1.8) < 0.03);
  assert.ok(Math.abs(plan.spans[0].to - 1.5) < 0.03, `cut ${plan.spans[0].to}`);
});

test("planCuts: words that do not map fall back to silence", () => {
  const samples = tones(3.4, [[0.1, 1.2], [1.8, 3.2]]);
  const plan = planCuts({ samples, sr: SR, texts: ["안녕 하세요.", "반갑습니다!"], words: [W("전혀", 0, 1)] });
  assert.equal(plan.by, "silence");
});

test("silenceEdges: the longest silences are the line breaks, short pauses inside a line are not", () => {
  // a 0.2 s pause inside line 1, 0.6 s and 0.4 s between lines
  const samples = tones(6, [[0.1, 1.0], [1.2, 2.0], [2.6, 3.6], [4.0, 5.5]]);
  const edges = silenceEdges(samples, SR, 3);
  assert.equal(edges.length, 3);
  assert.ok(Math.abs(edges[0].end - 2.0) < 0.03, `line 1 ends ${edges[0].end}`);
  assert.ok(Math.abs(edges[1].start - 2.6) < 0.03 && Math.abs(edges[1].end - 3.6) < 0.03);
  assert.ok(Math.abs(edges[2].start - 4.0) < 0.03);
});

test("silenceEdges: null when there are fewer breaks than lines minus one, or no sound", () => {
  assert.equal(silenceEdges(tones(2, [[0.1, 1.9]]), SR, 2), null);
  assert.equal(silenceEdges(tones(2, []), SR, 1), null);
  assert.equal(silenceEdges(tones(2, [[0.1, 0.5], [0.55, 1.9]]), SR, 2), null);
});

test("plausibleSplit: a line far shorter or longer per character than its neighbours is rejected", () => {
  const texts = ["가나다라마바", "사아자차카타", "파하가나다라"];
  assert.equal(plausibleSplit([{ start: 0, end: 1 }, { start: 2, end: 3.1 }, { start: 4, end: 5 }], texts), true);
  assert.equal(plausibleSplit([{ start: 0, end: 1 }, { start: 2, end: 2.2 }, { start: 4, end: 5 }], texts), false);
});

test("groupByChars and withSentenceEnd", () => {
  const items = ["aaaa", "bbbb", "cccc"].map((text) => ({ text }));
  assert.deepEqual(groupByChars(items, 10).map((g) => g.length), [2, 1]);
  assert.deepEqual(groupByChars(items, 3).map((g) => g.length), [1, 1, 1]);
  assert.equal(withSentenceEnd("안녕하세요"), "안녕하세요.");
  assert.equal(withSentenceEnd("정말요?"), "정말요?");
  assert.equal(withSentenceEnd("좋아요 [softly]"), "좋아요 [softly].");
});

function stubEnv(t, name, value) {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; });
}

function stubFetch(t, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = real; });
}

test("typecast synthBatch: one request, voice emotion, clips cut by the returned words", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-tc-batch-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(3.4, [[0.1, 1.2], [1.8, 3.2]])], SR);
  stubEnv(t, "TYPECAST_API_KEY", "test");
  const sent = [];
  stubFetch(t, async (url, init) => {
    sent.push(JSON.parse(init.body));
    const words = [W("안녕", 0.1, 0.6), W("하세요.", 0.6, 1.2), W("정말요?", 1.8, 3.2)];
    return { ok: true, json: async () => ({ audio: fs.readFileSync(src).toString("base64"), words }) };
  });
  const items = [
    { id: "l1", text: "안녕 하세요", outPath: path.join(tmp, "line-l1.wav") },
    { id: "l2", text: "정말요?", outPath: path.join(tmp, "line-l2.wav") },
  ];
  const res = await typecast.synthBatch(items, { lang: "ko-KR", voiceCfg: { voiceId: "tc_1" } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "안녕 하세요. 정말요?");
  assert.equal(sent[0].prompt.emotion_preset, "normal", "a trailing ? does not turn the whole request toneup");
  assert.equal(sent[0].voice_id, "tc_1");
  assert.deepEqual(res.map((r) => r.id), ["l1", "l2"]);
  assert.deepEqual(res[0].words.map((w) => w.w), ["안녕", "하세요."]);
  assert.ok(Math.abs(res[1].words[0].start - 0.1) < 1e-6, `l2 word starts ${res[1].words[0].start} in its clip`);
  assert.equal(res[1].wordsRelative, true);
  const clip = await decodeMonoPcm(res[1].wavPath, SR);
  const sec = clip.length / SR;
  assert.ok(Math.abs(sec - (1.5 + 0.3)) < 0.05, `l2 clip is ${sec}s: from 1.7 s to its last word end 3.2 s plus 0.3 s`);
});

test("typecast synthBatch: voiceCfg.emotion applies to the whole request", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-tc-emo-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(3.4, [[0.1, 1.2], [1.8, 3.2]])], SR);
  stubEnv(t, "TYPECAST_API_KEY", "test");
  let body;
  stubFetch(t, async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ audio: fs.readFileSync(src).toString("base64") }) };
  });
  const items = [{ id: "a", text: "하나", outPath: path.join(tmp, "a.wav") }, { id: "b", text: "둘", outPath: path.join(tmp, "b.wav") }];
  const res = await typecast.synthBatch(items, { voiceCfg: { voiceId: "tc_1", emotion: "happy" } });
  assert.equal(body.prompt.emotion_preset, "happy");
  assert.equal(res.length, 2);
  assert.equal(res[0].words, undefined, "no timestamps: caption words come from the speech-to-text check");
});

test("typecast synthBatch: a single line is sent alone, normal unless the voice sets a preset", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-tc-one-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(1.5, [[0.1, 1.2]])], SR);
  stubEnv(t, "TYPECAST_API_KEY", "test");
  const sent = [];
  stubFetch(t, async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ audio: fs.readFileSync(src).toString("base64"), words: [W("정말요?", 0.1, 1.2)] }) };
  });
  const res = await typecast.synthBatch([{ id: "l9", text: "정말요?", outPath: path.join(tmp, "line-l9.wav") }], { voiceCfg: { voiceId: "tc_1" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "정말요?");
  assert.equal(sent[0].prompt.emotion_preset, "normal");
  assert.equal(res[0].id, "l9");
});

test("typecast synthBatch: splits into several requests past the text limit", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-tc-many-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(1.5, [[0.1, 1.2]])], SR);
  stubEnv(t, "TYPECAST_API_KEY", "test");
  const sent = [];
  stubFetch(t, async (url, init) => {
    sent.push(JSON.parse(init.body).text.length);
    return { ok: true, json: async () => ({ audio: fs.readFileSync(src).toString("base64") }) };
  });
  const long = "가".repeat(1500);
  const items = ["a", "b"].map((id) => ({ id, text: long, outPath: path.join(tmp, `${id}.wav`) }));
  const res = await typecast.synthBatch(items, { voiceCfg: { voiceId: "tc_1" } });
  assert.equal(sent.length, 2);
  assert.deepEqual(res.map((r) => r.id), ["a", "b"]);
});

test("fish synthBatch: one request, cut at the silences, no words returned", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fish-batch-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(3.4, [[0.1, 1.2], [1.8, 3.2]])], SR);
  stubEnv(t, "FISH_AUDIO_API_KEY", "test");
  const sent = [];
  stubFetch(t, async (url, init) => {
    sent.push(JSON.parse(init.body));
    const buf = fs.readFileSync(src);
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  const items = [
    { id: "l1", text: "안녕하세요", outPath: path.join(tmp, "line-l1.wav") },
    { id: "l2", text: "반갑습니다!", outPath: path.join(tmp, "line-l2.wav") },
  ];
  const res = await fish.synthBatch(items, { voiceCfg: { voiceId: "ref1" } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "안녕하세요. 반갑습니다!");
  assert.equal(sent[0].reference_id, "ref1");
  assert.deepEqual(res.map((r) => r.id), ["l1", "l2"]);
  assert.equal(res[0].words, undefined);
  const clip = await decodeMonoPcm(res[0].wavPath, SR);
  const sec = clip.length / SR;
  assert.ok(Math.abs(sec - (1.2 + 0.3)) < 0.06, `l1 clip is ${sec}s: speech to 1.2 s plus 0.3 s`);
});

test("fish synthBatch: audio without a break between lines is re-sent one line per request", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fish-fallback-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, "src.wav");
  writeWavPCM16(src, [tones(2, [[0.1, 1.9]])], SR);
  stubEnv(t, "FISH_AUDIO_API_KEY", "test");
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    const buf = fs.readFileSync(src);
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  const items = ["a", "b"].map((id) => ({ id, text: "가나다", outPath: path.join(tmp, `${id}.wav`) }));
  const res = await fish.synthBatch(items, { voiceCfg: { voiceId: "ref1" } });
  assert.equal(calls, 3, "one joined request, then one per line");
  assert.deepEqual(res.map((r) => r.id), ["a", "b"]);
});
