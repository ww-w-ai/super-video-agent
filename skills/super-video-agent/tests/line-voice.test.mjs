// Per-line voices (several speakers in one film): merge rules, schema,
// batch grouping per resolved voice, timings.json speaker records, takes /
// --pick / --use with a line's own voice, and a dub plan with its own line
// voices. Local only: voice/none.mjs and in-memory providers, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  main,
  mergedVoice,
  resolveLineVoice,
  lineSpeed,
  speakerOf,
  speakerSummary,
  synthBatches,
  synthesizeAll,
  writePickedTone,
} from "../scripts/voice.mjs";
import { validate } from "../scripts/lib/schema-check.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import { probeDuration } from "../scripts/lib/ffmpeg.mjs";
import * as none from "../scripts/voice/none.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readJson(path.join(here, "..", "scripts", "plan.schema.json"));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sva-line-voice-"));
}

function writePlan(dir, plan) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
}

/** Two speakers: the film-wide voice and an off-screen one on l2. */
function twoSpeakerPlan(extraLine2Voice = {}) {
  return {
    meta: { title: "Two speakers", lang: "ko-KR", gapMs: 250, voice: { provider: "none", voiceId: "voice-a" } },
    lines: [
      { id: "l1", text: "첫 번째 줄입니다" },
      { id: "l2", text: "두 번째 줄입니다", voice: { voiceId: "voice-b", ...extraLine2Voice } },
      { id: "l3", text: "세 번째 줄입니다" },
    ],
  };
}

/** Runs `fn` and returns what it wrote to stdout. Writes still pass through:
 * the test runner reports over the same stream. */
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

/** none.mjs wrapped to record each call; tagMap keeps emotion marks visible as [name]. */
function recordingProvider() {
  const calls = [];
  return {
    calls,
    tagMap: () => ({}),
    async synth(args) {
      calls.push({ id: args.id, text: args.text, voice: args.voice, voiceCfg: args.voiceCfg });
      return none.synth(args);
    },
  };
}

// --- merge rules ---------------------------------------------------------------

test("mergedVoice: line keys win over meta.voice; a line without voice uses meta.voice", () => {
  const meta = { voice: { provider: "fish", voiceId: "voice-a", rate: 1.2, model: "m1" } };
  assert.deepEqual(mergedVoice(meta, { id: "x", voice: { voiceId: "voice-b", rate: 0.9 } }), {
    provider: "fish",
    voiceId: "voice-b",
    rate: 0.9,
    model: "m1",
  });
  assert.deepEqual(mergedVoice(meta, { id: "y" }), meta.voice);
  assert.deepEqual(mergedVoice({}, { id: "z", voice: { voiceId: "voice-b" } }), { voiceId: "voice-b" });
});

test("resolveLineVoice: a line's provider wins over the base provider; others take the base", () => {
  const meta = { voice: { provider: "none", voiceId: "voice-a" } };
  assert.equal(resolveLineVoice(meta, { id: "a", voice: { provider: "say" } }, "none").providerName, "say");
  assert.equal(resolveLineVoice(meta, { id: "b" }, "file").providerName, "file");
});

test("resolveLineVoice: the 9:16 default rate and the fish default delivery apply per resolved voice", () => {
  const meta = { ratio: "9:16", voice: { provider: "none", voiceId: "voice-a" } };
  const anchor = resolveLineVoice(meta, { id: "a" }, "none");
  assert.equal(anchor.voiceCfg.rate, 1.1);
  assert.equal(anchor.voiceCfg.delivery, undefined);
  const fishLine = resolveLineVoice(meta, { id: "b", voice: { provider: "fish", voiceId: "voice-b", rate: 1.3 } }, "none");
  assert.equal(fishLine.voiceCfg.rate, 1.3);
  assert.equal(fishLine.voiceCfg.delivery, "confident");
  const calmFish = resolveLineVoice(meta, { id: "c", voice: { provider: "fish", delivery: "calm" } }, "none");
  assert.equal(calmFish.voiceCfg.delivery, "calm");
  assert.notEqual(anchor.key, fishLine.key);
  assert.equal(anchor.key, resolveLineVoice(meta, { id: "d" }, "none").key);
});

test("lineSpeed: a line's own voice rate sets its speed; its own rate still wins", () => {
  const meta = { ratio: "9:16", voice: { rate: 1 } };
  assert.equal(lineSpeed(meta, { id: "a" }), 1);
  assert.equal(lineSpeed(meta, { id: "b", voice: { rate: 1.25 } }), 1.25);
  assert.equal(lineSpeed(meta, { id: "c", voice: { rate: 1.25 }, rate: 2 }), 2);
  assert.equal(lineSpeed({ ratio: "9:16" }, { id: "d" }), 1.1);
});

// --- schema --------------------------------------------------------------------

test("schema: a line-level voice with meta.voice keys is accepted", () => {
  const plan = twoSpeakerPlan({ provider: "elevenlabs", model: "m", rate: 1.1, delivery: "calm", levelLines: false });
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, true, errors.join("; "));
});

test("schema: a line-level voice still rejects unknown keys and bad values", () => {
  const unknownKey = twoSpeakerPlan({ speaker: "anchor" });
  const r1 = validate(unknownKey, schema);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some((e) => e.includes("$.lines[1].voice") && e.includes('unexpected property "speaker"')), r1.errors.join("; "));

  const badProvider = twoSpeakerPlan({ provider: "robot" });
  assert.ok(validate(badProvider, schema).errors.some((e) => e.startsWith("$.lines[1].voice.provider")));

  const badDelivery = twoSpeakerPlan({ delivery: "loud" });
  assert.ok(validate(badDelivery, schema).errors.some((e) => e.startsWith("$.lines[1].voice.delivery")));
});

test("schema: meta.voice keeps its own checks through the shared definition", () => {
  const plan = twoSpeakerPlan();
  plan.meta.voice.extra = true;
  const { valid, errors } = validate(plan, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('$.meta.voice: unexpected property "extra"')), errors.join("; "));
});

// --- grouping ------------------------------------------------------------------

test("synthBatches: one synthBatch call per resolved voice, each with its own voiceCfg; non-batch lines skipped", async () => {
  const batchCalls = [];
  const batchProvider = {
    async synthBatch(items, ctx) {
      batchCalls.push({ ids: items.map((i) => i.id), voiceId: ctx.voiceCfg.voiceId });
      return items.map((i) => ({ id: i.id, wavPath: i.outPath }));
    },
  };
  const voices = {
    a: { provider: batchProvider, providerName: "qwen3", voiceCfg: { voiceId: "voice-a" }, key: "A" },
    b: { provider: batchProvider, providerName: "qwen3", voiceCfg: { voiceId: "voice-b" }, key: "B" },
    s: { provider: { synth() {} }, providerName: "say", voiceCfg: {}, key: "S" },
  };
  const lines = [
    { id: "l1", text: "one", who: "a" },
    { id: "l2", text: "two", who: "b" },
    { id: "l3", text: "three", who: "a" },
    { id: "l4", text: "four", who: "s" },
  ];
  const results = await synthBatches({ lines, lineVoice: (l) => voices[l.who], pronounce: undefined, lang: "en-US", dir: "/tmp", voiceDir: "/tmp/voice" });
  assert.deepEqual(batchCalls, [
    { ids: ["l1", "l3"], voiceId: "voice-a" },
    { ids: ["l2"], voiceId: "voice-b" },
  ]);
  assert.deepEqual([...results.keys()].sort(), ["l1", "l2", "l3"]);
});

// --- synthesis, tempo, delivery, timings ----------------------------------------

test("synthesizeAll: each line goes to its own provider and voice, with its own delivery and rate; timings record who spoke", async () => {
  const dir = tmpDir();
  const paths = reelPaths(dir);
  const anchor = recordingProvider();
  const field = recordingProvider();
  const lines = [
    { id: "l1", text: "같은 길이의 문장입니다" },
    { id: "l2", text: "같은 길이의 문장입니다" },
  ];
  const lineVoices = new Map([
    ["l1", { provider: anchor, providerName: "none", voiceCfg: { voiceId: "voice-a" }, key: "A" }],
    ["l2", { provider: field, providerName: "say", voiceCfg: { voiceId: "voice-b", rate: 1.25, delivery: "calm" }, key: "B" }],
  ]);
  const out = await captureStdout(async () => {
    const { timings } = await synthesizeAll({
      dir,
      paths,
      lines,
      provider: anchor,
      providerName: "none",
      voiceCfg: { voiceId: "voice-a" },
      lineVoices,
      lang: "ko-KR",
      gapMs: 250,
      sttEnabled: false,
    });
    assert.deepEqual(timings.lines[0].voice, { provider: "none", voiceId: "voice-a" });
    assert.deepEqual(timings.lines[1].voice, { provider: "say", voiceId: "voice-b" });
    const d1 = timings.lines[0].end - timings.lines[0].start;
    const d2 = timings.lines[1].end - timings.lines[1].start;
    assert.ok(Math.abs(d1 - none.estimateDurationSec(anchor.calls[0].text)) < 0.05, `l1 at speed 1: ${d1}`);
    const raw2 = none.estimateDurationSec(field.calls[0].text);
    assert.ok(Math.abs(d2 - raw2 / 1.25) < 0.05, `l2 at its voice rate 1.25: raw ${raw2}s, got ${d2}`);
  });
  assert.deepEqual(anchor.calls.map((c) => [c.id, c.voice]), [["l1", "voice-a"]]);
  assert.deepEqual(field.calls.map((c) => [c.id, c.voice]), [["l2", "voice-b"]]);
  assert.ok(field.calls[0].text.startsWith("[calm]"), field.calls[0].text);
  assert.ok(!anchor.calls[0].text.includes("[calm]"));
  assert.ok(out.includes("speakers: none/voice-a (l1) | say/voice-b (l2)"), out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("speakerOf / speakerSummary: provider and voiceId per speaker, ids in first-heard order", () => {
  assert.deepEqual(speakerOf({ providerName: "none", voiceCfg: {} }), { provider: "none" });
  const summary = speakerSummary([
    { id: "l1", voice: { provider: "fish", voiceId: "voice-a" } },
    { id: "l2", voice: { provider: "fish", voiceId: "voice-b" } },
    { id: "l3", voice: { provider: "fish", voiceId: "voice-a" } },
  ]);
  assert.equal(summary, "speakers: fish/voice-a (l1, l3) | fish/voice-b (l2)");
});

// --- CLI: full run, --lines, --takes/--pick, --use ------------------------------

test("main: a full run records each line's resolved voice; --lines keeps the recorded speaker of reused lines", async () => {
  const dir = tmpDir();
  writePlan(dir, twoSpeakerPlan());
  const paths = reelPaths(dir);
  const out = await captureStdout(() => main([dir, "--no-stt"]));
  let timings = readJson(paths.timingsJson);
  assert.deepEqual(timings.lines.map((l) => l.voice), [
    { provider: "none", voiceId: "voice-a" },
    { provider: "none", voiceId: "voice-b" },
    { provider: "none", voiceId: "voice-a" },
  ]);
  assert.ok(out.includes("speakers: none/voice-a (l1, l3) | none/voice-b (l2)"), out);

  await captureStdout(() => main([dir, "--lines", "l1", "--no-stt"]));
  timings = readJson(paths.timingsJson);
  assert.deepEqual(timings.lines[1].voice, { provider: "none", voiceId: "voice-b" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --takes/--pick: a tone picked for a line with its own voice is written to that speaker's lines only", async () => {
  const dir = tmpDir();
  writePlan(dir, twoSpeakerPlan());
  const paths = reelPaths(dir);
  await captureStdout(() => main([dir, "--no-stt"]));
  await captureStdout(() => main([dir, "--lines", "l2", "--takes", "confident,calm", "--no-stt"]));
  await captureStdout(() => main([dir, "--pick", "l2=2", "--no-stt", "--retime"]));

  const plan = readJson(path.join(dir, "plan.json"));
  assert.equal(plan.lines[1].voice.delivery, "calm");
  assert.equal(plan.lines[1].voice.voiceId, "voice-b");
  assert.equal(plan.meta.voice.delivery, undefined);
  assert.equal(plan.lines[0].voice, undefined);
  const timings = readJson(paths.timingsJson);
  assert.deepEqual(timings.lines[1].voice, { provider: "none", voiceId: "voice-b" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writePickedTone: a tone for the film-wide voice goes to meta.voice; other speakers keep the delivery they had", () => {
  const plan = twoSpeakerPlan();
  const voices = new Map(plan.lines.map((l) => [l.id, resolveLineVoice(plan.meta, l, "none")]));
  const where = writePickedTone(plan, "l1", "warm", voices, "none");
  assert.equal(where, "meta.voice.delivery");
  assert.equal(plan.meta.voice.delivery, "warm");
  assert.equal(plan.lines[1].voice.delivery, "none");
  assert.equal(plan.lines[2].voice, undefined);
  assert.equal(resolveLineVoice(plan.meta, plan.lines[1], "none").voiceCfg.delivery, "none");
});

test("main --use: finished audio installed for a line with its own voice keeps that speaker in timings", async () => {
  const dir = tmpDir();
  writePlan(dir, twoSpeakerPlan());
  const paths = reelPaths(dir);
  await captureStdout(() => main([dir, "--no-stt"]));
  const finished = path.join(dir, "finished-l2.wav");
  await none.synth({ text: "두 번째 줄입니다 조금 더 길게", outPath: finished });
  await captureStdout(() => main([dir, "--use", `l2=${finished}`, "--no-stt", "--retime"]));
  const timings = readJson(paths.timingsJson);
  assert.deepEqual(timings.lines[1].voice, { provider: "none", voiceId: "voice-b" });
  const dur = await probeDuration(path.join(paths.voiceDir, "line-l2.wav"));
  assert.ok(Math.abs(dur - (timings.lines[1].end - timings.lines[1].start)) < 0.01);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- dubs ----------------------------------------------------------------------

test("dub: dub/<code>/plan.json lines may carry their own voice; the dub is voiced the same way", async () => {
  const dir = tmpDir();
  writePlan(dir, twoSpeakerPlan());
  const dubDir = path.join(dir, "dub", "en");
  const dubPlan = {
    meta: { title: "Two speakers", lang: "en-US", gapMs: 250, voice: { provider: "none", voiceId: "voice-c" } },
    lines: [
      { id: "l1", text: "This is the first line" },
      { id: "l2", text: "This is the second line", voice: { voiceId: "voice-d", rate: 1.2 } },
      { id: "l3", text: "This is the third line" },
    ],
  };
  writePlan(dubDir, dubPlan);
  const { valid, errors } = validate(dubPlan, schema);
  assert.equal(valid, true, errors.join("; "));

  const out = await captureStdout(() => main([dubDir, "--no-stt"]));
  const timings = readJson(reelPaths(dubDir).timingsJson);
  assert.deepEqual(timings.lines.map((l) => l.voice.voiceId), ["voice-c", "voice-d", "voice-c"]);
  assert.ok(out.includes("speakers: none/voice-c (l1, l3) | none/voice-d (l2)"), out);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- per-line emotion -------------------------------------------------------------

test("resolveLineVoice: typecast line with its own emotion gets a key of its own; same-as-voice and tag providers do not", () => {
  const meta = { voice: { provider: "typecast", voiceId: "tc_1" } };
  const film = resolveLineVoice(meta, { id: "a" }, "typecast");
  const same = resolveLineVoice(meta, { id: "b", emotion: "normal" }, "typecast");
  const own = resolveLineVoice(meta, { id: "c", emotion: "happy" }, "typecast");
  assert.equal(same.key, film.key);
  assert.equal(own.voiceCfg.emotion, "happy");
  assert.notEqual(own.key, film.key);
  assert.notEqual(own.key, resolveLineVoice(meta, { id: "d", emotion: "happy" }, "typecast").key, "two lines never share a request");
  const tag = resolveLineVoice({ voice: { provider: "elevenlabs" } }, { id: "e", emotion: "happy" }, "elevenlabs");
  assert.equal(tag.voiceCfg.emotion, undefined);
});

test("synthBatches: a typecast line with its own emotion is split out of the batch and made alone with that preset", async () => {
  const calls = [];
  const provider = {
    async synthBatch(items, ctx) {
      calls.push({ ids: items.map((i) => i.id), emotion: ctx.voiceCfg.emotion });
      return items.map((i) => ({ id: i.id, wavPath: i.outPath }));
    },
  };
  const meta = { voice: { provider: "typecast", voiceId: "tc_1" } };
  const lines = [{ id: "l1", text: "one" }, { id: "l2", text: "two", emotion: "sad" }, { id: "l3", text: "three" }];
  const lv = new Map(lines.map((l) => [l.id, { ...resolveLineVoice(meta, l, "typecast"), provider }]));
  const results = await synthBatches({ lines, lineVoice: (l) => lv.get(l.id), pronounce: undefined, lang: "ko-KR", dir: "/tmp", voiceDir: "/tmp/voice" });
  assert.deepEqual(calls, [
    { ids: ["l1", "l3"], emotion: undefined },
    { ids: ["l2"], emotion: "sad" },
  ]);
  assert.deepEqual([...results.keys()].sort(), ["l1", "l2", "l3"]);
});

test("synthBatches: a tag provider keeps the emotion tag inline in the one batch", async () => {
  const calls = [];
  const provider = {
    tagMap: () => ({}),
    async synthBatch(items, ctx) {
      calls.push(items.map((i) => ({ id: i.id, text: i.text })));
      return items.map((i) => ({ id: i.id, wavPath: i.outPath }));
    },
  };
  const meta = { voice: { provider: "elevenlabs" } };
  const lines = [{ id: "l1", text: "one" }, { id: "l2", text: "two", say: "{excited} two" }];
  const lv = new Map(lines.map((l) => [l.id, { ...resolveLineVoice(meta, l, "elevenlabs"), provider }]));
  await synthBatches({ lines, lineVoice: (l) => lv.get(l.id), pronounce: undefined, lang: "en-US", dir: "/tmp", voiceDir: "/tmp/voice" });
  assert.equal(calls.length, 1, "one request for both lines");
  assert.match(calls[0][1].text, /\[excited\]/);
});

test("plan schema: line emotion takes a Typecast preset only", () => {
  const plan = (emotion) => ({ meta: { title: "t" }, lines: [{ id: "l1", text: "x", emotion }] });
  assert.equal(validate(plan("happy"), schema).valid, true);
  assert.equal(validate(plan("furious"), schema).valid, false);
});
