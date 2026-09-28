// voice.mjs orchestration with a mocked provider — no network. Exercises
// synthesizeAll's timing math + concat plan end-to-end (only ffmpeg, which
// is local, is real) and the `say` field contract: voice.mjs synthesizes
// `say ?? text`, captions/timings.json keep `text`, word timings are
// computed over `text` characters (never `say`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeAll, lineTempo, withShortsRate } from "../scripts/voice.mjs";
import { reelPaths } from "../scripts/lib/reeldir.mjs";
import * as none from "../scripts/voice/none.mjs";

function tmpReelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-voice-"));
  return dir;
}

/** Wraps voice/none.mjs (real, local, no network) and records the text it was asked to synthesize. */
function makeRecordingProvider() {
  const calls = [];
  return {
    calls,
    async synth(args) {
      calls.push({ id: args.id, text: args.text });
      return none.synth(args);
    },
  };
}

test("voice: synthesizes say ?? text, keeps captions on text, records say in timings.json", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();

  const lines = [
    { id: "l1", text: "MCP를 소개합니다", say: "엠씨피를 소개합니다" },
    { id: "l2", text: "두 번째 줄" }, // no `say` -> falls back to text
  ];

  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider,
    providerName: "none",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });

  // provider received say ?? text
  assert.equal(provider.calls[0].text, "엠씨피를 소개합니다");
  assert.equal(provider.calls[1].text, "두 번째 줄");

  // timings.json keeps `text` for captions and records `say` only when present
  assert.equal(timings.lines[0].text, "MCP를 소개합니다");
  assert.equal(timings.lines[0].say, "엠씨피를 소개합니다");
  assert.equal(timings.lines[1].text, "두 번째 줄");
  assert.equal("say" in timings.lines[1], false);

  // word timings are computed over `text` characters, not `say`: line 1's
  // words must reconstruct to `text`, never mention 엠씨피.
  const reconstructed = timings.lines[0].words.map((w) => w.w).join(" ");
  assert.equal(reconstructed, "MCP를 소개합니다");
  assert.ok(!timings.lines[0].words.some((w) => w.w.includes("엠씨피")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice: meta.pronounce reaches the provider, captions keep text", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();
  const lines = [
    { id: "l1", text: "Ask Nguyen." },
    { id: "l2", text: "Ask Nguyen.", pronounce: { Nguyen: { say: "Nwen" } } },
  ];
  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider,
    providerName: "none",
    voiceCfg: {},
    pronounce: { Nguyen: { say: "Win" } },
    lang: "en-US",
    gapMs: 250,
    sttEnabled: false,
  });
  assert.equal(provider.calls[0].text, "Ask Win.");
  assert.equal(provider.calls[1].text, "Ask Nwen.");
  assert.equal(timings.lines[0].text, "Ask Nguyen.");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice: meta.tailSec replaces the default 0.4s tail silence in timings.json duration", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();
  const lines = [{ id: "l1", text: "한 줄" }];

  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider,
    providerName: "none",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 250,
    tailSec: 3.0,
    sttEnabled: false,
  });

  const lastLineEnd = timings.lines[timings.lines.length - 1].end;
  assert.ok(Math.abs(timings.duration - (lastLineEnd + 3.0)) < 1e-6);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice: prefers provider.synthBatch over per-line synth when present, and records a non-OK flag as timings.json voiceFlag", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  let synthCalled = false;
  let batchCallLines = null;
  const provider = {
    async synth() {
      synthCalled = true; // must not be called when synthBatch exists
      throw new Error("synth should not be called when synthBatch is present");
    },
    async synthBatch(lines, ctx) {
      batchCallLines = lines;
      const results = [];
      for (const line of lines) {
        const r = await none.synth({ text: "짧다", outPath: line.outPath });
        results.push({ id: line.id, wavPath: r.wavPath, flag: line.id === "b1" ? "SHORT" : "OK" });
      }
      return results;
    },
  };

  const lines = [
    { id: "b1", text: "배치 첫 줄" },
    { id: "b2", text: "배치 두 번째 줄" },
  ];

  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider,
    providerName: "qwen3",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });

  assert.equal(synthCalled, false);
  assert.equal(batchCallLines.length, 2);
  assert.equal(batchCallLines[0].id, "b1");
  assert.equal(batchCallLines[0].text, "배치 첫 줄");
  assert.equal(timings.lines[0].voiceFlag, "SHORT");
  assert.equal("voiceFlag" in timings.lines[1], false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice: meta.voice.rate applies ffmpeg atempo for providers without nativeRate, and is skipped for nativeRate providers", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const { probeDuration } = await import("../scripts/lib/ffmpeg.mjs");

  // Baseline duration with no rate.
  const dirBase = tmpReelDir();
  const pathsBase = reelPaths(dirBase);
  const { timings: baseTimings } = await synthesizeAll({
    dir: dirBase,
    paths: pathsBase,
    lines: [{ id: "r1", text: "속도 테스트 문장입니다" }],
    provider: none,
    providerName: "none",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });
  const baseDur = baseTimings.lines[0].end - baseTimings.lines[0].start;

  // rate=1.25, provider has no nativeRate -> atempo applied, duration shrinks.
  const { timings: fastTimings } = await synthesizeAll({
    dir,
    paths,
    lines: [{ id: "r1", text: "속도 테스트 문장입니다" }],
    provider: none,
    providerName: "none",
    voiceCfg: { rate: 1.25 },
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });
  const fastDur = fastTimings.lines[0].end - fastTimings.lines[0].start;
  assert.ok(fastDur < baseDur * 0.9, `rate=1.25 should shrink duration: base=${baseDur} fast=${fastDur}`);

  // Same rate, but provider declares nativeRate -> voice.mjs must not also atempo.
  const dirNative = tmpReelDir();
  const pathsNative = reelPaths(dirNative);
  const nativeRateProvider = { nativeRate: true, synth: none.synth };
  const { timings: nativeTimings } = await synthesizeAll({
    dir: dirNative,
    paths: pathsNative,
    lines: [{ id: "r1", text: "속도 테스트 문장입니다" }],
    provider: nativeRateProvider,
    providerName: "melotts",
    voiceCfg: { rate: 1.25 },
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });
  const nativeDur = nativeTimings.lines[0].end - nativeTimings.lines[0].start;
  assert.ok(
    Math.abs(nativeDur - baseDur) < 0.05,
    `nativeRate provider must not get double-sped-up by voice.mjs: base=${baseDur} native=${nativeDur}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirBase, { recursive: true, force: true });
  fs.rmSync(dirNative, { recursive: true, force: true });
});

test("voice: none provider marks lines estimated:true and narration.wav duration matches timings.json", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const lines = [
    { id: "a", text: "짧은 문장" },
    { id: "b", text: "조금 더 긴 두 번째 문장입니다" },
  ];
  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider: none,
    providerName: "none",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // orchestration tests use mocked/silent audio — STT has its own suite
  });

  assert.equal(timings.lines[0].estimated, true);
  assert.equal(timings.lines[1].estimated, true);
  assert.ok(fs.existsSync(paths.narrationWav));

  const { probeDuration } = await import("../scripts/lib/ffmpeg.mjs");
  const actualDuration = await probeDuration(paths.narrationWav);
  assert.ok(
    Math.abs(actualDuration - timings.duration) < 0.05,
    `narration.wav duration ${actualDuration} should match timings.json duration ${timings.duration}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice --lines: a regenerated take close in length keeps the old slot; --retime lets it move", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();
  const base = { dir, paths, provider, providerName: "none", voiceCfg: {}, lang: "ko-KR", gapMs: 250, sttEnabled: false };
  // none.mjs: 7 characters per second, so 14 characters = 2.0 s.
  const first = await synthesizeAll({ ...base, lines: [{ id: "a", text: "가나다라마바사아자차카타파하" }, { id: "b", text: "다음 줄" }] });
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings)); // voice.mjs main writes this between runs

  // A pronunciation fix: 15 characters (2.14 s, 7% longer) and 13 characters (1.86 s) both fit.
  for (const say of ["가나다라마바사아자차카타파하하", "가나다라마바사아자차카타파"]) {
    const lines = [{ id: "a", text: "가나다라마바사아자차카타파하", say }, { id: "b", text: "다음 줄" }];
    const { timings } = await synthesizeAll({ ...base, lines, onlyLineIds: ["a"] });
    assert.deepEqual(timings.lines.map((l) => [l.start, l.end]), first.timings.lines.map((l) => [l.start, l.end]), say);
  }

  // --retime: the take keeps its own length and the next line moves.
  const lines = [{ id: "a", text: "가나다라마바사아자차카타파하", say: "가나다라마바사" }, { id: "b", text: "다음 줄" }];
  const { timings, moved } = await synthesizeAll({ ...base, lines, onlyLineIds: ["a"], keepTiming: false });
  assert.ok(timings.lines[1].start < first.timings.lines[1].start - 0.5);
  assert.deepEqual(moved, ["b"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("lineTempo: a line's rate replaces meta.voice.rate, up to 2x; native-rate providers get the remainder", () => {
  assert.deepEqual(lineTempo({ rate: 2 }, { rate: 1.1 }, {}), { factor: 2 / 1, range: { min: 0.5, max: 2 } });
  assert.deepEqual(lineTempo({ rate: 2 }, { rate: 1.25 }, { nativeRate: true }).factor, 1.6);
  assert.deepEqual(lineTempo({}, { rate: 1.1 }, {}), { factor: 1.1, range: {} });
  assert.equal(lineTempo({}, { rate: 1.1 }, { nativeRate: true }), null);
  assert.equal(lineTempo({}, {}, {}), null);
});

test("voice: a line with rate 2 comes out about half as long", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();
  const text = "가나다라마바사아자차카타파하"; // none.mjs: 14 characters = 2.0 s
  const { timings } = await synthesizeAll({
    dir, paths, provider, providerName: "none", voiceCfg: {}, lang: "ko-KR", gapMs: 250, sttEnabled: false,
    lines: [{ id: "normal", text }, { id: "fast", text, rate: 2 }],
  });
  const [normal, fast] = timings.lines.map((l) => l.end - l.start);
  assert.ok(Math.abs(fast - normal / 2) < 0.05, `normal ${normal}, fast ${fast}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("voice: a line's pauseAfterMs overrides meta.gapMs for the silence after it", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const provider = makeRecordingProvider();
  const lines = [
    { id: "l1", text: "첫 줄인데", pauseAfterMs: 150 },
    { id: "l2", text: "이어지는 줄" },
    { id: "l3", text: "새 장면" },
  ];

  const { timings } = await synthesizeAll({
    dir,
    paths,
    lines,
    provider,
    providerName: "none",
    voiceCfg: {},
    lang: "ko-KR",
    gapMs: 600,
    sttEnabled: false,
  });

  const [a, b, c] = timings.lines;
  assert.ok(Math.abs(b.start - a.end - 0.15) < 0.01, `gap after l1 = ${b.start - a.end}`);
  assert.ok(Math.abs(c.start - b.end - 0.6) < 0.01, `gap after l2 = ${c.start - b.end}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("withShortsRate: a 9:16 film with no rate speaks at 1.1 in every language; a set rate and other ratios are untouched", () => {
  assert.equal(withShortsRate({ ratio: "9:16", lang: "en-US", voice: { provider: "qwen3" } }).rate, 1.1);
  assert.equal(withShortsRate({ ratio: "9:16", lang: "ko-KR", voice: {} }).rate, 1.1);
  assert.equal(withShortsRate({ ratio: "9:16", lang: "ja" }).rate, 1.1);
  assert.equal(withShortsRate({ ratio: "9:16", lang: "ko-KR", voice: { rate: 1.25 } }).rate, 1.25);
  assert.equal(withShortsRate({ ratio: "16:9", lang: "ko-KR", voice: {} }).rate, undefined);
  assert.equal(withShortsRate({ ratio: "9:16", lang: "ja", voice: { provider: "qwen3" } }).provider, "qwen3");
});
