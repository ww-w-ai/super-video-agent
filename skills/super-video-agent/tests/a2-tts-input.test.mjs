// Sprint A2 — TTS input (1: quote marks), batching by the sent text (14), stale `say` warning (16),
// and the A1 review gaps: per-line saves that survive a kill, keep-the-lower-CER recheck, and the
// skip reason in the takes table.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spokenText, stripQuoteMarks } from "../scripts/lib/pronounce.mjs";
import { groupByChars, sentLength } from "../scripts/lib/line-split.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { staleSayWarnings } from "../scripts/validate-plan.mjs";
import { sttTranscribe } from "../scripts/lib/stt-engine.mjs";
import { printTakesTable, synthBatches } from "../scripts/voice.mjs";
import * as typecast from "../scripts/voice/typecast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VOICE_MJS = path.join(here, "..", "scripts", "voice.mjs");
const VALIDATE_MJS = path.join(here, "..", "scripts", "validate-plan.mjs");
const tmp = (p = "sva-a2-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { log: () => {} };

// --- 1: quote marks are never sent to the voice ------------------------------------

test("1: quote marks of every kind are stripped from the spoken text, the caption keeps them", () => {
  const cases = [
    ['He said "ship it" today.', "He said ship it today."],
    ["그는 “안녕하세요”라고 했다.", "그는 안녕하세요라고 했다."],
    ["彼は「こんにちは」と言った。", "彼はこんにちはと言った。"],
    ["他说『你好』。", "他说你好。"],
    ["Il dit « bonjour » à l'ami.", "Il dit bonjour à l'ami."],
    ["Er sagte „Hallo“ und ‹ging›.", "Er sagte Hallo und ging."],
    ["She said 'no' and it's fine, the dogs' bowls.", "She said no and it's fine, the dogs' bowls."],
    ["‘quoted’ and ’tis", "quoted and ’tis"],
  ];
  for (const [text, want] of cases) {
    const line = { id: "l", text };
    assert.equal(spokenText(line, {}, {}, "en"), want);
    assert.equal(line.text, text, "the caption text is never changed");
  }
});

test("1: quotes in `say` are stripped too, and an apostrophe inside a word stays", () => {
  assert.equal(spokenText({ id: "l", text: "x", say: '"Don\'t" stop' }, {}, {}, "en"), "Don't stop");
  assert.equal(stripQuoteMarks("l’été d'hiver"), "l’été d'hiver");
  assert.equal(stripQuoteMarks("no quotes here"), "no quotes here");
});

// --- 14: batches counted on the sent text ------------------------------------------

test("14: groupByChars counts the full stop a joined request adds", () => {
  const items = [{ text: "a".repeat(999) }, { text: "b".repeat(999) }];
  assert.equal(groupByChars(items, 2000).length, 1, "raw text fits");
  assert.equal(groupByChars(items, 2000, sentLength).length, 2, "999 + '.' + space twice does not");
  assert.equal(sentLength({ text: "ok." }), 4, "a text that already ends a sentence adds nothing");
});

function stubTypecast(t, sentTexts) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, "src.wav");
  writeWavPCM16(src, [new Float32Array(48000).fill(0.1)], 48000);
  const prevKey = process.env.TYPECAST_API_KEY;
  process.env.TYPECAST_API_KEY = "test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sentTexts.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({ audio: fs.readFileSync(src).toString("base64") }) };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.TYPECAST_API_KEY;
    else process.env.TYPECAST_API_KEY = prevKey;
  });
  return dir;
}

test("14: typecast never sends a request past 2,000 characters, also for the lines of --lines", async (t) => {
  const sent = [];
  const dir = stubTypecast(t, sent);
  const lines = ["a", "b", "c"].map((id) => ({ id, text: id.repeat(999) }));
  const lv = { key: "v", provider: typecast, providerName: "typecast", voiceCfg: { voiceId: "tc_1" } };
  // synthBatches receives only the lines --lines selected; the grouping happens in the provider.
  const results = await synthBatches({ lines, lineVoice: () => lv, pronounce: undefined, lang: "en-US", dir, voiceDir: dir });
  assert.ok(sent.length >= 3, `three 999-character lines are three requests, got ${sent.length}`);
  for (const text of sent) assert.ok(text.length <= 2000, `request of ${text.length} characters`);
  assert.deepEqual([...results.keys()].sort(), ["a", "b", "c"]);
});

test("14: a single line past the limit is refused with its id before any request", async (t) => {
  const sent = [];
  const dir = stubTypecast(t, sent);
  await assert.rejects(
    typecast.synthBatch([{ id: "big", text: "x".repeat(2000), outPath: path.join(dir, "big.wav") }], { voiceCfg: { voiceId: "tc_1" } }),
    /line "big" is 2001 characters as sent/,
  );
  assert.equal(sent.length, 0);
});

// --- 16: a say left from an older text -----------------------------------------------

test("16: say that no longer matches text warns; folded differences and a sayWhy do not", () => {
  const plan = {
    meta: { lang: "en-US", pronounce: { MCP: { say: "em see pee" } } },
    lines: [
      { id: "stale", text: "We shipped the new editor.", say: "We shipped the old viewer." },
      { id: "same", text: "We ship 3 files.", say: "we ship three files" },
      { id: "name", text: "MCP is here.", say: "em see pee is here." },
      { id: "why", text: "Totally new text.", say: "Something else on purpose.", sayWhy: "brand name read by letter" },
      { id: "none", text: "No say here." },
      { id: "marks", text: "Hello there.", say: "{pause} Hello there." },
    ],
  };
  const warns = staleSayWarnings(plan);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^"stale" CER 0\.\d\d/);
  assert.match(warns[0], /write why in sayWhy/);
});

test("16: validate-plan prints the warning and keeps the exit code", () => {
  const dir = tmp("sva-a2-vp-");
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    meta: { title: "t", lang: "en-US" },
    lines: [{ id: "l1", text: "New sentence.", say: "An older line about something else." }],
  }));
  const res = spawnSync(process.execPath, [VALIDATE_MJS, dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^ok\n/);
  assert.match(res.stdout, /warning: 1 line\(s\) whose say differs from text/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- review gap 1: each finished line reaches timings.json while the run is going ---------

const SLOW_PYTHON = `#!/usr/bin/env node
const fs = require("fs");
const job = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const hangAfter = Number(process.env.FAKE_HANG_AFTER || 0);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model: process.env.SVA_STT_MODEL || "small", ids: job.map((j) => j.id) }) + "\\n");
const out = [];
for (const j of job) {
  out.push({ id: j.id, heard: j.id === "l1" ? "안녕하세요 반갑습니다" : j.id === "l2" ? "오늘은 3개를 봅니다" : "마지막 줄입니다", words: [] });
  fs.writeFileSync(process.env.SVA_STT_PROGRESS, JSON.stringify(out));
  if (hangAfter && out.length === hangAfter) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
}
process.stdout.write(JSON.stringify(out));
`;

function makeReel() {
  const dir = tmp("sva-a2-reel-");
  const voice = path.join(dir, "voice");
  fs.mkdirSync(voice, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    meta: { lang: "ko-KR" },
    lines: [{ id: "l1", text: "안녕하세요 반갑습니다" }, { id: "l2", text: "오늘은 세 개를 봅니다" }, { id: "l3", text: "마지막 줄입니다" }],
  }));
  const stale = (id) => ({ id, text: "옛날 대사", start: 0, end: 1, words: [] });
  fs.writeFileSync(path.join(voice, "timings.json"), JSON.stringify({ lang: "ko-KR", provider: "none", lines: [stale("l1"), stale("l2"), stale("l3")] }));
  for (const id of ["l1", "l2", "l3"]) fs.writeFileSync(path.join(voice, `line-${id}.wav`), "x");
  const fake = path.join(dir, "fake-python");
  fs.writeFileSync(fake, SLOW_PYTHON, { mode: 0o755 });
  return { dir, fake, log: path.join(dir, "fake.log"), timings: path.join(voice, "timings.json"), pending: path.join(voice, "stt-pending.json") };
}

const runEnv = (reel, extra = {}) => ({ ...process.env, SVA_STT_PYTHON: reel.fake, FAKE_LOG: reel.log, ...extra });
const readTimings = (reel) => JSON.parse(fs.readFileSync(reel.timings, "utf8"));
const readCalls = (reel) => fs.readFileSync(reel.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("review 1: a --stt-only run killed mid-way keeps each finished line, and the rerun checks only the rest", async () => {
  const reel = makeReel();
  const child = spawn(process.execPath, [VOICE_MJS, reel.dir, "--stt-only"], { env: runEnv(reel, { FAKE_HANG_AFTER: "1" }), stdio: "ignore" });
  const saved = await waitFor(() => {
    try {
      return !!readTimings(reel).lines[0].stt;
    } catch {
      return false;
    }
  }, 60000);
  child.kill("SIGKILL");
  assert.ok(saved, "line l1 reached timings.json while the model was still running");
  assert.deepEqual(JSON.parse(fs.readFileSync(reel.pending, "utf8")).ids.sort(), ["l2", "l3"]);

  fs.rmSync(reel.log, { force: true });
  const res = spawnSync(process.execPath, [VOICE_MJS, reel.dir, "--stt-only"], { encoding: "utf8", env: runEnv(reel) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /resuming an interrupted --stt-only: 2 line\(s\) left/);
  assert.deepEqual(readCalls(reel).map((c) => c.ids), [["l2", "l3"]]);
  const t = readTimings(reel);
  assert.ok(t.lines.every((l) => l.stt));
  assert.equal(fs.existsSync(reel.pending), false, "nothing left, the pending file is gone");
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

test("review 1: a finished run leaves no pending file and the next run checks every line", () => {
  const reel = makeReel();
  const first = spawnSync(process.execPath, [VOICE_MJS, reel.dir, "--stt-only"], { encoding: "utf8", env: runEnv(reel) });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(reel.pending), false);
  const second = spawnSync(process.execPath, [VOICE_MJS, reel.dir, "--stt-only"], { encoding: "utf8", env: runEnv(reel) });
  assert.doesNotMatch(second.stdout, /resuming/);
  assert.deepEqual(readCalls(reel).map((c) => c.ids), [["l1", "l2", "l3"], ["l1", "l2", "l3"]]);
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

test("review 1: sttTranscribe hands a finished line to onProgress before the model run ends", async () => {
  const voiceDir = tmp("sva-a2-voice-");
  const events = [];
  const run = async (_python, args, env) => {
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    fs.writeFileSync(env.SVA_STT_PROGRESS, JSON.stringify([{ id: job[0].id, heard: "one", words: [] }]));
    await new Promise((r) => setTimeout(r, 400));
    events.push("run-end");
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: "x", words: [] }))) };
  };
  const onProgress = ({ results, partial, models }) => events.push(`progress:${[...results.keys()].join(",")}:${partial ? "partial" : "full"}:${models.get("l1")}`);
  await sttTranscribe(voiceDir, [{ id: "l1", wav: "a.wav" }, { id: "l2", wav: "b.wav" }], "en", { pythonPath: "/fake", runPythonBatch: run, env: {}, onProgress, progressPollMs: 40, ...quiet });
  assert.equal(events[0], "progress:l1:partial:small");
  assert.ok(events.indexOf("run-end") > 0);
  fs.rmSync(voiceDir, { recursive: true, force: true });
});

// --- review gap 2: the recheck never makes a line worse ------------------------------------

function answers(table) {
  return async (_python, args, env) => {
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: table[env.SVA_STT_MODEL][j.id] ?? "", words: [] }))) };
  };
}

test("review 2: the second model's transcript replaces the first only when its error rate is not worse", async () => {
  const voiceDir = tmp("sva-a2-voice-");
  const entries = [
    { id: "better", wav: "a.wav", text: "오늘 날씨가 좋다" },
    { id: "worse", wav: "b.wav", text: "오늘 날씨가 좋다" },
  ];
  const table = {
    small: { better: "오는 날시가 조타", worse: "오늘 날씨가 좋 다 요" },
    turbo: { better: "오늘 날씨가 좋다", worse: "엉뚱한 소리를 한다" },
  };
  const res = await sttTranscribe(voiceDir, entries, "ko", { pythonPath: "/fake", runPythonBatch: answers(table), env: { SVA_STT_DOUBT_CER: "0.05" }, ...quiet });
  assert.equal(res.results.get("better"), "오늘 날씨가 좋다");
  assert.equal(res.models.get("better"), "turbo");
  assert.equal(res.results.get("worse"), "오늘 날씨가 좋 다 요", "the worse answer is not taken");
  assert.equal(res.models.get("worse"), "small");
  fs.rmSync(voiceDir, { recursive: true, force: true });
});

// --- review gap 3: the takes table says why cer is empty -----------------------------------

test("review 3: printTakesTable names the reason when the STT check was skipped", () => {
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try {
    printTakesTable([
      { id: "l1", k: 1, mark: null, durationSec: 1, lengthSec: 1, cer: null, cerSkipped: 'STT model "small" is not downloaded' },
      { id: "l1", k: 2, mark: null, durationSec: 1, lengthSec: 1, cer: null, cerSkipped: 'STT model "small" is not downloaded' },
    ]);
  } finally {
    process.stdout.write = real;
  }
  const out = written.join("");
  assert.match(out, /cer "-": STT check skipped — STT model "small" is not downloaded/);
  assert.equal(out.match(/STT check skipped/g).length, 1, "one line per reason");
});
