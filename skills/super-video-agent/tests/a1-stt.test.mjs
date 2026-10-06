// Sprint A1 — STT engine (N7), --stt-only (15), leveled take comparison (N13),
// gate normalization (4), setup --check engine report. No network, no model
// downloads: engines are replaced by fakes (a fake runner, a fake Python
// script, a fake fetch).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sttTranscribe, sttTranscribeLeveled, isDoubtful, mlxModelCached } from "../scripts/lib/stt-engine.mjs";
import { cer, compareLine, normalize, pronounceFolds } from "../scripts/lib/stt-compare.mjs";
import { normalizeNumbers } from "../scripts/lib/stt-numbers.mjs";
import { ZH_HANT_TO_HANS, hantToHans, kataToHira } from "../scripts/lib/stt-script-fold.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { sttReport } from "../scripts/setup.mjs";
import { synthesizeTakes } from "../scripts/voice.mjs";
import * as none from "../scripts/voice/none.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(here, "..");
const VOICE_MJS = path.join(SKILL, "scripts", "voice.mjs");
const SETUP_MJS = path.join(SKILL, "scripts", "setup.mjs");
const STT_PY = path.join(SKILL, "scripts", "voice", "py", "stt_check.py");

const tmp = (p = "sva-a1-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { log: () => {} };
// A real folder for the engine's temp job dir; the fake runners never read audio from it.
const NOWHERE = tmp("sva-a1-voice-");
after(() => fs.rmSync(NOWHERE, { recursive: true, force: true }));

/** A runPythonBatch stand-in: answers per model from `heard[model][id]`, records each call. */
function fakeRunner(heard, calls) {
  return async (_python, args, env) => {
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    calls.push({ model: env.SVA_STT_MODEL, lang: env.SVA_STT_LANG, ids: job.map((j) => j.id), offline: env.HF_HUB_OFFLINE });
    const table = heard[env.SVA_STT_MODEL] || {};
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: table[j.id] ?? "", words: [{ w: "x", start: 0, end: 1 }] }))) };
  };
}

// --- N7: engine -----------------------------------------------------------------

test("N7: first pass small on every line, turbo only on the doubtful ones, turbo's answer wins", async () => {
  const calls = [];
  const heard = { small: { l1: "안녕하세요 반갑습니다", l2: "오는 날시가 조타" }, turbo: { l2: "오늘 날씨가 좋다" } };
  const entries = [
    { id: "l1", wav: "a.wav", text: "안녕하세요 반갑습니다" },
    { id: "l2", wav: "b.wav", text: "오늘 날씨가 좋다" },
  ];
  const res = await sttTranscribe(NOWHERE, entries, "ko", { pythonPath: "/fake", runPythonBatch: fakeRunner(heard, calls), env: {}, ...quiet });
  assert.deepEqual(calls.map((c) => [c.model, c.ids]), [["small", ["l1", "l2"]], ["turbo", ["l2"]]]);
  assert.equal(calls[0].offline, "1");
  assert.equal(res.results.get("l1"), "안녕하세요 반갑습니다");
  assert.equal(res.results.get("l2"), "오늘 날씨가 좋다");
});

test("N7: no second pass when every line is clean, or when the entries carry no target", async () => {
  const calls = [];
  const heard = { small: { l1: "hello there", l2: "totally off" } };
  await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav", text: "hello there" }], "en", { pythonPath: "/fake", runPythonBatch: fakeRunner(heard, calls), env: {}, ...quiet });
  await sttTranscribe(NOWHERE, [{ id: "l2", wav: "b.wav" }], "en", { pythonPath: "/fake", runPythonBatch: fakeRunner(heard, calls), env: {}, ...quiet });
  assert.deepEqual(calls.map((c) => c.model), ["small", "small"]);
});

test("N7: isDoubtful uses the normalized comparison (a spoken number is not doubtful) and treats empty as doubtful", () => {
  assert.equal(isDoubtful({ text: "세 개를 샀다" }, "3개를 샀다", "ko"), false);
  assert.equal(isDoubtful({ text: "세 개를 샀다" }, "네 개를 샀다 그리고 더", "ko"), true);
  assert.equal(isDoubtful({ text: "abc" }, "  ", "en"), true);
  assert.equal(isDoubtful({ id: "x" }, "anything", "en"), false);
});

test("N7: a failing second pass keeps the first-pass answer and says so", async () => {
  const logs = [];
  const run = async (_p, args, env) => {
    if (env.SVA_STT_MODEL === "turbo") throw new Error("boom exited 1");
    const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
    return { stdout: JSON.stringify(job.map((j) => ({ id: j.id, heard: "zzz", words: [] }))) };
  };
  const res = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav", text: "hello world" }], "en", { pythonPath: "/fake", runPythonBatch: run, env: {}, log: (m) => logs.push(m) });
  assert.equal(res.results.get("l1"), "zzz");
  assert.ok(logs.some((m) => /second pass stopped/.test(m)));
});

test("N7: a model that is not downloaded skips the check with a pointer to setup", async () => {
  const run = async () => {
    throw new Error("/fake stt_check.py exited 3\n[stt_check] model x is not in the local cache");
  };
  const res = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav" }], "ko", { pythonPath: "/fake", runPythonBatch: run, env: {}, ...quiet });
  assert.match(res.skipped, /not downloaded/);
  assert.match(res.skipped, /setup\.mjs --stt-models/);
});

test("N7: faster-whisper is gone; an unknown engine is skipped; no python is skipped", async () => {
  const faster = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav" }], "ko", { env: { SVA_STT_ENGINE: "faster-whisper" }, ...quiet });
  assert.match(faster.skipped, /no longer supported/);
  const other = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav" }], "ko", { env: { SVA_STT_ENGINE: "nope" }, ...quiet });
  assert.match(other.skipped, /unknown STT engine/);
  const noPython = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav" }], "ko", { env: {}, ...quiet });
  assert.match(noPython.skipped, /SVA_STT_PYTHON/);
  assert.doesNotMatch(fs.readFileSync(STT_PY, "utf8"), /faster_whisper/);
});

test("N7: groq without a key is skipped with one line and no key text", async () => {
  const res = await sttTranscribe(NOWHERE, [{ id: "l1", wav: "a.wav" }], "ko", { env: { SVA_STT_ENGINE: "groq" }, ...quiet });
  assert.equal(res.skipped, "groq engine selected but GROQ_API_KEY is not set");
});

test("N7: groq with a key sends the file, parses words, and never leaks the key in an error", async () => {
  const dir = tmp();
  const wav = path.join(dir, "line-l1.wav");
  writeWavPCM16(wav, [Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 8) * 0.5)], 48000);
  const key = "gsk_SECRET_KEY_123";
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, model: init.body.get("model"), lang: init.body.get("language") });
    return { ok: true, status: 200, json: async () => ({ text: " hello there ", words: [{ word: " hello", start: 0, end: 0.05 }, { word: "there", start: 0.05, end: 0.1 }] }) };
  };
  const env = { SVA_STT_ENGINE: "groq", GROQ_API_KEY: key };
  const ok = await sttTranscribe(dir, [{ id: "l1", wav: "line-l1.wav" }], "en", { env, fetch: okFetch, ...quiet });
  assert.equal(ok.results.get("l1"), "hello there");
  assert.deepEqual(ok.words.get("l1").map((w) => w.w), ["hello", "there"]);
  assert.match(seen[0].url, /api\.groq\.com/);
  assert.equal(seen[0].auth, `Bearer ${key}`);
  assert.equal(seen[0].lang, "en");

  const badFetch = async () => {
    throw new Error(`network down for Bearer ${key}`);
  };
  const bad = await sttTranscribe(dir, [{ id: "l1", wav: "line-l1.wav" }], "en", { env, fetch: badFetch, ...quiet });
  assert.match(bad.skipped, /groq request failed/);
  assert.ok(!bad.skipped.includes(key), "the key never appears in a message");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("N7: mlxModelCached reads the hub cache and never the network", () => {
  const cache = tmp("sva-a1-hub-");
  fs.mkdirSync(path.join(cache, "models--mlx-community--whisper-small-mlx", "snapshots", "abc"), { recursive: true });
  assert.equal(mlxModelCached("small", { HF_HUB_CACHE: cache }), true);
  assert.equal(mlxModelCached("turbo", { HF_HUB_CACHE: cache }), false);
  fs.rmSync(cache, { recursive: true, force: true });
});

// --- the Python script, with a fake mlx_whisper ---------------------------------

const hasNumpy = spawnSync("python3", ["-c", "import numpy"], { stdio: "ignore" }).status === 0;

function fakePythonModules(dir) {
  fs.writeFileSync(path.join(dir, "mlx_whisper.py"), [
    "import os",
    "def transcribe(path, **kw):",
    "    if os.path.basename(path) == 'boom.wav':",
    "        raise RuntimeError('boom')",
    "    return {'text': ' hello there ', 'segments': [{'words': [{'word': ' hello', 'start': 0.0, 'end': 0.5}, {'word': ' there', 'start': 0.5, 'end': 1.0}]}]}",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "huggingface_hub.py"), [
    "def snapshot_download(repo, **kw):",
    "    raise RuntimeError('not cached')",
  ].join("\n"));
}

function runPy(dir, lines, env) {
  const jobs = path.join(dir, "jobs.json");
  fs.writeFileSync(jobs, JSON.stringify(lines));
  return spawnSync("python3", [STT_PY, dir, jobs], { encoding: "utf8", env: { ...process.env, PYTHONPATH: dir, SVA_STT_LANG: "en", ...env } });
}

test("stt_check.py: model loads once per run, progress file keeps finished lines when a later line dies", { skip: !hasNumpy }, () => {
  const dir = tmp();
  fakePythonModules(dir);
  for (const name of ["ok.wav", "boom.wav", "ok2.wav"]) writeWavPCM16(path.join(dir, name), [Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.5)], 16000);
  const progress = path.join(dir, "progress.json");
  const env = { SVA_STT_MODEL: dir, SVA_STT_PROGRESS: progress };

  const done = runPy(dir, [{ id: "a", wav: "ok.wav" }, { id: "b", wav: "ok2.wav" }], env);
  assert.equal(done.status, 0, done.stderr);
  const arr = JSON.parse(done.stdout);
  assert.deepEqual(arr.map((r) => [r.id, r.heard]), [["a", "hello there"], ["b", "hello there"]]);
  assert.deepEqual(arr[0].words.map((w) => w.w), ["hello", "there"]);
  assert.equal(JSON.parse(fs.readFileSync(progress, "utf8")).length, 2);

  fs.rmSync(progress);
  const dead = runPy(dir, [{ id: "a", wav: "ok.wav" }, { id: "b", wav: "boom.wav" }, { id: "c", wav: "ok2.wav" }], env);
  assert.notEqual(dead.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(progress, "utf8")).map((r) => r.id), ["a"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stt_check.py: a model that is not in the local cache ends with exit code 3, no download", { skip: !hasNumpy }, () => {
  const dir = tmp();
  fakePythonModules(dir);
  writeWavPCM16(path.join(dir, "ok.wav"), [new Float32Array(1600)], 16000);
  const res = runPy(dir, [{ id: "a", wav: "ok.wav" }], { SVA_STT_MODEL: "small" });
  assert.equal(res.status, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 15: --stt-only ---------------------------------------------------------------

const FAKE_PYTHON = `#!/usr/bin/env node
const fs = require("fs");
const job = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const model = process.env.SVA_STT_MODEL || "small";
const heard = JSON.parse(process.env.FAKE_HEARD || "{}");
const dieAfter = Number(process.env.FAKE_DIE_AFTER || 0);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, ids: job.map((j) => j.id), wavs: job.map((j) => j.wav) }) + "\\n");
const out = [];
for (const j of job) {
  if (dieAfter && out.length >= dieAfter && model === "small") { process.stderr.write("fake crash\\n"); process.exit(1); }
  out.push({ id: j.id, heard: heard[model + ":" + j.id] ?? heard[j.id] ?? "", words: [] });
  if (process.env.SVA_STT_PROGRESS) fs.writeFileSync(process.env.SVA_STT_PROGRESS, JSON.stringify(out));
}
process.stdout.write(JSON.stringify(out));
`;

function makeReel() {
  const dir = tmp("sva-a1-reel-");
  const voice = path.join(dir, "voice");
  fs.mkdirSync(voice, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
    meta: { lang: "ko-KR" },
    lines: [
      { id: "l1", text: "안녕하세요 반갑습니다" },
      { id: "l2", text: "오늘은 세 개를 봅니다" },
      { id: "l3", text: "마지막 줄입니다" },
    ],
  }));
  const stale = (id) => ({ id, text: "옛날 대사", start: 0, end: 1, words: [] });
  fs.writeFileSync(path.join(voice, "timings.json"), JSON.stringify({ lang: "ko-KR", provider: "none", lines: [stale("l1"), stale("l2"), stale("l3")] }));
  for (const id of ["l1", "l2", "l3"]) fs.writeFileSync(path.join(voice, `line-${id}.wav`), "x");
  const fake = path.join(dir, "fake-python");
  fs.writeFileSync(fake, FAKE_PYTHON, { mode: 0o755 });
  return { dir, fake, log: path.join(dir, "fake.log"), timings: path.join(voice, "timings.json") };
}

function sttOnly(reel, extra, env) {
  return spawnSync(process.execPath, [VOICE_MJS, reel.dir, "--stt-only", ...extra], {
    encoding: "utf8",
    env: { ...process.env, SVA_STT_PYTHON: reel.fake, FAKE_LOG: reel.log, ...env },
  });
}

const readCalls = (reel) => fs.readFileSync(reel.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("15: --stt-only compares with plan.json's current text, not the stale timings text", () => {
  const reel = makeReel();
  const heard = { l1: "안녕하세요 반갑습니다", l2: "오늘은 3개를 봅니다", l3: "마지막 줄입니다" };
  const res = sttOnly(reel, [], { FAKE_HEARD: JSON.stringify(heard) });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const t = JSON.parse(fs.readFileSync(reel.timings, "utf8"));
  assert.equal(t.lines[1].stt.target, "오늘은 세 개를 봅니다");
  assert.equal(t.lines[1].stt.cer, 0, "세 개 and 3개 are the same number");
  assert.equal(t.lines[0].voiceFlag, undefined);
  assert.equal(readCalls(reel).length, 1, "one model load for every line");
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

test("15: --lines checks only the named lines and keeps the others' earlier result", () => {
  const reel = makeReel();
  const heard = { l1: "안녕하세요 반갑습니다", l2: "오늘은 3개를 봅니다", l3: "마지막 줄입니다" };
  sttOnly(reel, ["--lines", "l1"], { FAKE_HEARD: JSON.stringify(heard) });
  sttOnly(reel, ["--lines", "l3"], { FAKE_HEARD: JSON.stringify(heard) });
  const t = JSON.parse(fs.readFileSync(reel.timings, "utf8"));
  assert.ok(t.lines[0].stt && t.lines[2].stt);
  assert.equal(t.lines[1].stt, undefined);
  assert.deepEqual(readCalls(reel).map((c) => c.ids), [["l1"], ["l3"]]);
  const bad = sttOnly(reel, ["--lines", "nope"], {});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown line id/);
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

test("15: a run that dies midway saves the finished lines, lists the rest and the rerun command", () => {
  const reel = makeReel();
  const heard = { l1: "안녕하세요 반갑습니다", l2: "오늘은 3개를 봅니다", l3: "마지막 줄입니다" };
  const res = sttOnly(reel, [], { FAKE_HEARD: JSON.stringify(heard), FAKE_DIE_AFTER: "1" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /STT stopped early/);
  assert.match(res.stdout, /not checked: l2, l3 — rerun: voice\.mjs .* --stt-only --lines l2,l3/);
  const t = JSON.parse(fs.readFileSync(reel.timings, "utf8"));
  assert.ok(t.lines[0].stt, "the finished line is on disk");
  assert.equal(t.lines[1].stt, undefined);

  const rest = sttOnly(reel, ["--lines", "l2,l3"], { FAKE_HEARD: JSON.stringify(heard) });
  assert.equal(rest.status, 0, rest.stderr);
  const after = JSON.parse(fs.readFileSync(reel.timings, "utf8"));
  assert.ok(after.lines[0].stt && after.lines[1].stt && after.lines[2].stt);
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

test("15: --stt-only runs the second pass only on doubtful lines and saves the result", () => {
  const reel = makeReel();
  const heard = { "small:l1": "안녕하세요 반갑습니다", "small:l2": "엉뚱한 소리", "small:l3": "마지막 줄입니다", "turbo:l2": "오늘은 3개를 봅니다" };
  const res = sttOnly(reel, [], { FAKE_HEARD: JSON.stringify(heard) });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readCalls(reel).map((c) => [c.model, c.ids]), [["small", ["l1", "l2", "l3"]], ["turbo", ["l2"]]]);
  const t = JSON.parse(fs.readFileSync(reel.timings, "utf8"));
  assert.equal(t.lines[1].stt.cer, 0);
  assert.equal(t.lines[1].voiceFlag, undefined);
  fs.rmSync(reel.dir, { recursive: true, force: true });
});

// --- N13: take comparison on leveled audio ---------------------------------------

test("N13: sttTranscribeLeveled transcribes a leveled copy and leaves the take untouched", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "takes"));
  const take = path.join(dir, "takes", "l1-1.wav");
  fs.writeFileSync(take, "RAW");
  const levelled = [];
  const seen = [];
  const res = await sttTranscribeLeveled(dir, [{ id: "l1-1", wav: "takes/l1-1.wav" }], "en", {
    pythonPath: "/fake",
    env: {},
    levelLine: async (p) => {
      levelled.push(p);
      fs.writeFileSync(p, "LEVELLED");
    },
    runPythonBatch: async (_py, args) => {
      const job = JSON.parse(fs.readFileSync(args[2], "utf8"));
      seen.push({ wav: job[0].wav, bytes: fs.readFileSync(job[0].wav, "utf8") });
      return { stdout: JSON.stringify([{ id: "l1-1", heard: "hi", words: [] }]) };
    },
  });
  assert.equal(res.results.get("l1-1"), "hi");
  assert.equal(seen[0].bytes, "LEVELLED");
  assert.equal(levelled[0], seen[0].wav);
  assert.notEqual(seen[0].wav, take);
  assert.equal(fs.readFileSync(take, "utf8"), "RAW");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".stt")), [], "the temp folder is gone");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("N13: a voice with levelLines false is transcribed unleveled", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "t.wav"), "RAW");
  let leveled = 0;
  await sttTranscribeLeveled(dir, [{ id: "a", wav: "t.wav" }], "en", {
    pythonPath: "/fake",
    env: {},
    level: false,
    levelLine: async () => leveled++,
    runPythonBatch: async () => ({ stdout: "[]" }),
  });
  assert.equal(leveled, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("N13: --takes compares the leveled copy (synthesizeTakes goes through the leveled path)", async () => {
  const dir = tmp("sva-a1-takes-");
  const paths = reelPaths(dir);
  fs.mkdirSync(paths.voiceDir, { recursive: true });
  fs.writeFileSync(path.join(paths.voiceDir, "line-l1.wav"), "installed");
  const fake = path.join(dir, "fake-python");
  fs.writeFileSync(fake, FAKE_PYTHON, { mode: 0o755 });
  const log = path.join(dir, "fake.log");
  const saved = { py: process.env.SVA_STT_PYTHON, log: process.env.FAKE_LOG };
  process.env.SVA_STT_PYTHON = fake;
  process.env.FAKE_LOG = log;
  try {
    await synthesizeTakes({
      dir, paths, plan: { meta: { lang: "en-US" }, lines: [{ id: "l1", text: "hello" }] }, lineIds: ["l1"], spec: { mode: "count", n: 2 },
      provider: none, providerName: "none", voiceCfg: { levelLines: true }, pronounce: null, lang: "en-US", gapMs: 250, tailSec: 0.4, sttEnabled: true, keepTiming: true,
    });
  } finally {
    for (const [k, v] of [["SVA_STT_PYTHON", saved.py], ["FAKE_LOG", saved.log]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c.model === "small").length, 2, "one first pass per take");
  for (const c of calls) assert.match(c.wavs[0], /\.stt-lv-/, "STT ran on a leveled copy, not on voice/takes/*.wav");
  assert.ok(fs.existsSync(path.join(paths.voiceDir, "takes", "l1-1.wav")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 4: gate normalization -------------------------------------------------------

test("4: Korean numbers — Sino-Korean, native with a counter, mixed digits, percent, dates", () => {
  const same = [
    ["이억 오천만 원입니다", "2억 5000만 원입니다"],
    ["세 개의 사과와 두 명", "3개의 사과와 2명"],
    ["스물한 살", "21살"],
    ["이천이십육 년 십 월 십일", "2026년 10월 10일"],
    ["삼일 동안 십일 월", "3일 동안 11월"],
    ["백만 명이 봤다", "100만 명이 봤다"],
    ["삼 점 오 퍼센트", "3.5%"],
  ];
  for (const [a, b] of same) assert.equal(cer(a, b, "ko"), 0, `${a} / ${b}`);
  assert.ok(cer("이억 오천만 원", "2억 6000만 원", "ko") > 0, "a different number is still an error");
  assert.equal(normalizeNumbers("이 영상은 좋다", "ko"), "이 영상은 좋다", "a particle is not a number");
  assert.equal(normalizeNumbers("너만 가", "ko"), "너만 가");
  assert.equal(normalizeNumbers("만들었다", "ko"), "만들었다");
});

test("4: Chinese and Japanese numerals", () => {
  assert.equal(cer("二十三个人", "23个人", "zh"), 0);
  assert.equal(cer("百分之五十", "50%", "zh-Hans"), 0);
  assert.equal(cer("二〇二六年三月", "2026年3月", "ja"), 0);
  assert.equal(cer("五十パーセント", "50%", "ja"), 0);
  assert.ok(cer("二十三个人", "24个人", "zh") > 0);
  assert.equal(normalizeNumbers("一起去", "zh"), "一起去");
});

test("4: Traditional vs Simplified — the measured case reads as correct", () => {
  const target = "會員現在據說超過了兩億五千萬。";
  const heard = "会员现在据说超过了2亿5000万";
  assert.equal(cer(target, heard, "zh-Hant"), 0);
  assert.ok(cer(target, "会员现在据说超过了2亿5000万个", "zh-Hant") > 0);
  assert.equal(hantToHans("學習漢語"), "学习汉语");
});

test("4: the character table is aligned and has no identity pairs", () => {
  assert.ok(ZH_HANT_TO_HANS.size > 300);
  for (const [trad, simp] of ZH_HANT_TO_HANS) assert.notEqual(trad, simp);
});

test("4: kana — katakana, half-width and single-reading kanji words fold", () => {
  assert.equal(kataToHira("カタカナ"), "かたかな");
  assert.equal(cer("カタカナです", "かたかなです", "ja"), 0);
  assert.equal(cer("ﾃｽﾄ です", "てすと です", "ja"), 0);
  assert.equal(cer("今日はありがとう", "きょうは有難う", "ja"), 0);
  assert.ok(cer("今日はありがとう", "あしたはありがとう", "ja") > 0);
});

test("4: names in the pronunciation dictionary fold both ways", () => {
  const names = pronounceFolds("ko", { OpenAI: { say: "오픈에이아이" } });
  const r = compareLine({ text: "OpenAI는 좋다", heard: "오픈에이아이는 좋다", lang: "ko", names });
  assert.equal(r.cer, 0);
  assert.equal(compareLine({ text: "OpenAI는 좋다", heard: "오픈에이아이는 좋다", lang: "ko" }).cer > 0, true, "without the dictionary it is an error");
  assert.equal(cer("클로드가 말했다", "Claude가 말했다", "ko", pronounceFolds("ko")), 0, "built-in default respelling");
  assert.deepEqual(pronounceFolds("en", { A: { ipa: "x" }, B: { say: "B" } }).map((p) => p[0]), ["Claude"]);
});

test("4: other languages and plain text are unchanged", () => {
  assert.equal(normalize("Hello, World! 2 nm", "de"), "helloworld2nm");
  assert.equal(normalizeNumbers("zwei 2 Meter", "de"), "zwei 2 Meter");
  assert.equal(normalize("안녕 하세요!", "ko"), "안녕하세요");
});

// --- setup --check ---------------------------------------------------------------

test("setup: sttReport lists engines and cached models; the key is never printed", () => {
  const cache = tmp("sva-a1-hub-");
  fs.mkdirSync(path.join(cache, "models--mlx-community--whisper-small-mlx", "snapshots", "abc"), { recursive: true });
  const env = { SVA_STT_PYTHON: "/fake/python", GROQ_API_KEY: "gsk_SECRET", HF_HUB_CACHE: cache };
  const lines = sttReport(env, () => true);
  const text = lines.join("\n");
  assert.match(text, /mlx-whisper: ready/);
  assert.match(text, /small downloaded, turbo not downloaded/);
  assert.match(text, /groq: key set/);
  assert.ok(!text.includes("gsk_SECRET"));
  assert.match(sttReport({ HF_HUB_CACHE: cache }, () => true).join("\n"), /SVA_STT_PYTHON is not set/);
  assert.match(sttReport({ SVA_STT_PYTHON: "/x", HF_HUB_CACHE: cache }, () => false).join("\n"), /cannot import mlx_whisper/);
  fs.rmSync(cache, { recursive: true, force: true });
});

test("setup --check prints the STT engines without a key and without downloading", () => {
  const cache = tmp("sva-a1-hub-");
  const res = spawnSync(process.execPath, [SETUP_MJS, "--check"], {
    encoding: "utf8",
    env: { ...process.env, GROQ_API_KEY: "gsk_SECRET", SVA_STT_PYTHON: "", HF_HUB_CACHE: cache, HF_HUB_OFFLINE: "1" },
  });
  const out = res.stdout + res.stderr;
  assert.match(out, /speech-to-text engines/);
  assert.match(out, /groq: key set/);
  assert.match(out, /mlx-whisper models: small not downloaded, turbo not downloaded/);
  assert.ok(!out.includes("gsk_SECRET"));
  fs.rmSync(cache, { recursive: true, force: true });
});
