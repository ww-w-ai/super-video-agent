// Per-line cutting of one ElevenLabs request (scripts/lib/line-split.mjs and
// voice/elevenlabs.mjs synthBatch) on synthetic audio through a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spokenRange, cutSpans, speechEnd, withQuietTail, TAIL_SEC } from "../scripts/lib/line-split.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import * as elevenlabs from "../scripts/voice/elevenlabs.mjs";

const SR = 48000;

/** Silence with 440 Hz tone over each [from, to) second span. */
function tones(totalSec, spans, amp = 0.5) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const [from, to, a = amp] of spans) {
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) out[i] = a * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  return out;
}

test("spokenRange: skips tags, spaces and end punctuation", () => {
  const chars = "[excited] 드디어요?! [pause]";
  const tagChars = new Set();
  for (const [s, e] of [[0, 9], [chars.indexOf("[pause]"), chars.length]]) for (let i = s; i < e; i++) tagChars.add(i);
  const [first, last] = spokenRange(chars, 0, chars.indexOf(" [pause]"), tagChars);
  assert.equal(chars[first], "드");
  assert.equal(chars[last], "요");
});

test("spokenRange: a sounding tag such as [laughs] belongs to the line", () => {
  const chars = "[laughs] 진짜요?";
  const [first, last] = spokenRange(chars, 0, chars.length, new Set());
  assert.equal(first, 0);
  assert.equal(chars[last], "요");
});

test("withQuietTail: minEnd keeps a short last word after a pause", () => {
  const clip = tones(2.2, [[0.1, 1.0], [1.3, 1.5]]);
  assert.ok(speechEnd(clip, SR) / SR < 1.05, "without minEnd the short word reads as a burst");
  const kept = withQuietTail(clip, SR, TAIL_SEC, 1.5 * SR);
  assert.ok(Math.abs(kept.samples.length / SR - 1.5 - 0.2 - TAIL_SEC) < 0.001, "the last word, 0.2 s of room, then the quiet tail");
});

test("cutSpans: a clip runs to 20 ms before the next line's speech; the last line runs to the end", () => {
  const spans = cutSpans([{ start: 0.2, end: 1.0 }, { start: 1.6, end: 2.4 }], 3.0);
  assert.deepEqual(spans, [{ from: 0.1, to: 1.58 }, { from: 1.5, to: 3.0 }]);
});

test("speechEnd: a short burst after a quiet gap is noise, not speech", () => {
  const clip = tones(3.0, [[0.1, 1.5], [2.6, 2.75, 0.3]]);
  const end = speechEnd(clip, SR) / SR;
  assert.ok(end > 1.45 && end < 1.55, `end ${end}`);
});

test("speechEnd: a short gap inside speech is not a burst boundary", () => {
  const clip = tones(2.0, [[0.1, 1.0], [1.08, 1.9]]);
  assert.ok(speechEnd(clip, SR) / SR > 1.85);
});

test("withQuietTail: 0.2 s of room and exactly TAIL_SEC of silence after speech; cut only when sound reaches the end", () => {
  const clean = withQuietTail(tones(2.0, [[0.1, 1.2]]), SR);
  assert.equal(clean.cut, false);
  const endSec = speechEnd(clean.samples, SR) / SR;
  assert.ok(Math.abs(clean.samples.length / SR - endSec - 0.2 - TAIL_SEC) < 0.001);
  assert.equal(withQuietTail(tones(1.0, [[0.1, 1.0]]), SR).cut, true);
});

/** Alignment for `text` where each listed line's characters spread evenly over its span. */
function alignmentFor(text, lineSpans) {
  const chars = [...text];
  const starts = new Array(chars.length).fill(0), ends = new Array(chars.length).fill(0);
  let t = 0;
  for (let i = 0; i < chars.length; i++) {
    const span = lineSpans.find(([from, to]) => i >= from && i < to);
    if (span) {
      const [from, to, s, e] = span;
      starts[i] = s + ((e - s) * (i - from)) / (to - from);
      ends[i] = s + ((e - s) * (i - from + 1)) / (to - from);
      t = ends[i];
    } else {
      starts[i] = t;
      ends[i] = t;
    }
  }
  return { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

test("synthBatch: one request with one closing [pause], one clip per line with relative words", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-el-batch-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const audioPath = path.join(tmp, "src.wav");
  writeWavPCM16(audioPath, [tones(3.4, [[0.1, 1.2], [1.8, 3.2]])], SR);

  const a = "안녕 하세요", b = "반갑습니다!";
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const text = body.text;
    const bAt = text.indexOf(b);
    const align = alignmentFor(text, [[0, a.length - 1, 0.1, 1.2], [bAt, bAt + b.length - 1, 1.8, 3.2]]);
    return { ok: true, json: async () => ({ audio_base64: fs.readFileSync(audioPath).toString("base64"), alignment: align }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const realKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test";
  t.after(() => { if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realKey; });

  const items = [{ id: "l1", text: a, outPath: path.join(tmp, "line-l1.wav") }, { id: "l2", text: b, outPath: path.join(tmp, "line-l2.wav") }];
  const res = await elevenlabs.synthBatch(items, { voiceCfg: { voiceId: "v", model: "eleven_v3" } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `${a}. ${b} [pause]`);
  assert.deepEqual(res.map((r) => r.id), ["l1", "l2"]);
  for (const r of res) {
    assert.ok(fs.existsSync(r.wavPath));
    assert.equal(r.wordsRelative, true);
    assert.equal(r.flag, undefined);
  }
  assert.deepEqual(res[0].words.map((w) => w.w), ["안녕", "하세요"]);
  assert.ok(res[1].words[0].start >= 0 && res[1].words[0].start < 0.2, `l2 starts ${res[1].words[0].start}`);
});

test("synthBatch: a single line is sent as it is, with no closing tag", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-el-one-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const audioPath = path.join(tmp, "src.wav");
  writeWavPCM16(audioPath, [tones(1.5, [[0.1, 1.2]])], SR);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const text = JSON.parse(init.body).text;
    sent.push(text);
    return { ok: true, json: async () => ({ audio_base64: fs.readFileSync(audioPath).toString("base64"), alignment: alignmentFor(text, [[0, text.length, 0.1, 1.2]]) }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const realKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test";
  t.after(() => { if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realKey; });

  await elevenlabs.synthBatch([{ id: "l1", text: "다시 만든 줄.", outPath: path.join(tmp, "line-l1.wav") }], { voiceCfg: { voiceId: "v", model: "eleven_v3" } });
  assert.deepEqual(sent, ["다시 만든 줄."]);
});
