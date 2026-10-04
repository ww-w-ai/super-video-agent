// --takes / --pick: bookkeeping, flag parsing and tone-mark forcing — with a
// mocked provider (no network, no real TTS) for the synthesis side, and the
// real CLI (`main`, provider "none") for the plan.json/manifest bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main,
  synthesizeTakes,
  parseTakesSpec,
  parsePick,
  withForcedTone,
} from "../scripts/voice.mjs";
import { reelPaths, writeJson, readJson } from "../scripts/lib/reeldir.mjs";
import { probeDuration } from "../scripts/lib/ffmpeg.mjs";
import * as none from "../scripts/voice/none.mjs";

function tmpReelDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sva-takes-"));
}

function writePlan(dir, plan) {
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
}

function basePlan(lines, metaExtra = {}) {
  return { meta: { lang: "ko-KR", gapMs: 250, ...metaExtra }, lines };
}

/** Wraps voice/none.mjs but lengthens the text a little more on every call, so
 * successive takes are measurably longer — none.mjs's own output depends
 * only on text, so same-text takes would otherwise be indistinguishable.
 * Declares a (trivial) tagMap so forEngine keeps emotion marks as `[name]`
 * instead of stripping them — otherwise a tone take and a plain take would
 * produce identical text, the same blind spot none.mjs itself has. */
function makeVaryingProvider() {
  const calls = [];
  return {
    calls,
    tagMap: () => ({}),
    async synth({ text, outPath }) {
      calls.push({ text, outPath, n: calls.length + 1 });
      return none.synth({ text: text + "다".repeat(calls.length * 4), outPath });
    },
  };
}

test("parseTakesSpec: no value defaults to count mode, n=3", () => {
  assert.deepEqual(parseTakesSpec(true), { mode: "count", n: 3 });
});

test("parseTakesSpec: an integer 2-5 is count mode", () => {
  assert.deepEqual(parseTakesSpec("2"), { mode: "count", n: 2 });
  assert.deepEqual(parseTakesSpec("5"), { mode: "count", n: 5 });
});

test("parseTakesSpec: integers outside 2-5 are rejected", () => {
  assert.throws(() => parseTakesSpec("1"), /2-5/);
  assert.throws(() => parseTakesSpec("6"), /2-5/);
});

test("parseTakesSpec: a comma list of delivery marks is tone mode", () => {
  assert.deepEqual(parseTakesSpec("confident,calm"), { mode: "tone", marks: ["confident", "calm"] });
  assert.deepEqual(parseTakesSpec(" confident , excited , calm "), { mode: "tone", marks: ["confident", "excited", "calm"] });
});

test("parseTakesSpec: an unknown delivery mark is rejected", () => {
  assert.throws(() => parseTakesSpec("confident,not-a-real-tone"), /unknown delivery mark/);
});

test("parseTakesSpec: a tone list outside 2-5 entries is rejected", () => {
  assert.throws(() => parseTakesSpec("confident"), /2-5/);
});

test("withForcedTone: a line's own mark is replaced, not layered", () => {
  assert.equal(withForcedTone("{sad} 안녕하세요", "confident"), "{confident} 안녕하세요");
  assert.equal(withForcedTone("안녕하세요", "calm"), "{calm} 안녕하세요");
});

test("withForcedTone: a non-emotion mark ({pause}) is left alone", () => {
  assert.equal(withForcedTone("{pause} 잠시만요", "excited"), "{excited} {pause} 잠시만요");
});

test("parsePick: parses id=k pairs", () => {
  assert.deepEqual(parsePick("l1=2"), [{ id: "l1", k: 2 }]);
  assert.deepEqual(parsePick("l1=2,q=1"), [
    { id: "l1", k: 2 },
    { id: "q", k: 1 },
  ]);
});

test("parsePick: rejects a malformed entry", () => {
  assert.throws(() => parsePick("l1"), /expected id=k/);
  assert.throws(() => parsePick("l1=x"), /expected id=k/);
});

test("synthesizeTakes: count mode — N candidates, one at a time, take 1 installed", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const plan = basePlan([{ id: "l1", text: "다음 토큰은 뭘까?" }]);

  const provider = makeVaryingProvider();
  const { rows } = await synthesizeTakes({
    dir,
    paths,
    plan,
    lineIds: ["l1"],
    spec: { mode: "count", n: 3 },
    provider,
    providerName: "none",
    voiceCfg: {},
    pronounce: undefined,
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false, // no python required — this test is bookkeeping, not the STT/pitch report
    keepTiming: true,
  });

  // one provider.synth call per take, in order, never overlapping (awaited sequentially)
  assert.equal(provider.calls.length, 3);
  assert.deepEqual(provider.calls.map((c) => c.n), [1, 2, 3]);

  // candidates kept on disk
  for (let k = 1; k <= 3; k++) {
    assert.ok(fs.existsSync(path.join(paths.voiceDir, "takes", `l1-${k}.wav`)), `take ${k} missing`);
  }
  assert.equal(rows.length, 3);
  assert.equal(rows[0].mark, null); // count mode: no tone per take
  assert.ok(rows.every((r) => typeof r.durationSec === "number" && r.durationSec > 0));

  // successive takes are measurably longer (the varying mock's own contract)
  assert.ok(rows[1].durationSec > rows[0].durationSec);
  assert.ok(rows[2].durationSec > rows[1].durationSec);

  // manifest records how these candidates were made, for --pick to read later
  const manifest = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  assert.deepEqual(manifest.l1, { mode: "count", n: 3 });

  // take 1 installed: line-l1.wav exists and timings.json has the line
  assert.ok(fs.existsSync(path.join(paths.voiceDir, "line-l1.wav")));
  const timings = readJson(paths.timingsJson);
  assert.equal(timings.lines.length, 1);
  assert.ok(Math.abs((timings.lines[0].end - timings.lines[0].start) - rows[0].durationSec) < 0.05);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("synthesizeTakes: tone mode — one take per mark, each forced onto the line's own text", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const plan = basePlan([{ id: "l1", text: "환영합니다", say: "{sad} 환영합니다" }]);

  const provider = makeVaryingProvider();
  const { rows } = await synthesizeTakes({
    dir,
    paths,
    plan,
    lineIds: ["l1"],
    spec: { mode: "tone", marks: ["confident", "calm"] },
    provider,
    providerName: "none",
    voiceCfg: {},
    pronounce: undefined,
    lang: "ko-KR",
    gapMs: 250,
    sttEnabled: false,
    keepTiming: true,
  });

  assert.equal(provider.calls.length, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.mark), ["confident", "calm"]);

  // the line's own {sad} never reaches the provider — each take forces its own mark
  assert.ok(provider.calls[0].text.includes("[confident]"), provider.calls[0].text);
  assert.ok(!provider.calls[0].text.includes("sad"), provider.calls[0].text);
  assert.ok(provider.calls[1].text.includes("[calm]"), provider.calls[1].text);
  assert.ok(!provider.calls[1].text.includes("sad"), provider.calls[1].text);

  const manifest = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  assert.deepEqual(manifest.l1, { mode: "tone", marks: ["confident", "calm"] });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --takes: CLI wiring installs take 1 and writes the manifest (provider none, no network)", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const paths = reelPaths(dir);

  await main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);

  assert.ok(fs.existsSync(path.join(paths.voiceDir, "takes", "l1-1.wav")));
  assert.ok(fs.existsSync(path.join(paths.voiceDir, "takes", "l1-2.wav")));
  const manifest = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  assert.deepEqual(manifest.l1, { mode: "count", n: 2 });
  assert.ok(fs.existsSync(paths.timingsJson));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --takes without --lines fails clearly", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await main([dir, "--provider", "none", "--takes", "3"]);
  } catch (e) {
    if (e.message !== "__exit__") throw e;
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCode, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --pick: installs the picked take with no re-synthesis, and writes meta.voice.delivery for a tone pick", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "다음 토큰은 뭘까?" }]));
  const paths = reelPaths(dir);

  await main([dir, "--provider", "none", "--lines", "l1", "--takes", "confident,calm", "--no-stt"]);

  // sanity: the tone-mode manifest is there before we pick
  const manifestBefore = readJson(path.join(paths.voiceDir, "takes", "manifest.json"));
  assert.deepEqual(manifestBefore.l1.marks, ["confident", "calm"]);

  await main([dir, "--provider", "none", "--pick", "l1=2", "--no-stt", "--retime"]);

  const plan = readJson(path.join(dir, "plan.json"));
  assert.equal(plan.meta.voice.delivery, "calm");

  const timings = readJson(paths.timingsJson);
  assert.equal(timings.lines.length, 1);
  assert.equal(timings.lines[0].id, "l1");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --pick: a count-mode pick never writes meta.voice.delivery", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const paths = reelPaths(dir);

  await main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);
  await main([dir, "--provider", "none", "--pick", "l1=2", "--no-stt", "--retime"]);

  const plan = readJson(path.join(dir, "plan.json"));
  assert.equal("voice" in plan.meta, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --pick: an unknown take fails clearly instead of silently doing nothing", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await main([dir, "--provider", "none", "--pick", "l1=9"]);
  } catch (e) {
    if (e.message !== "__exit__") throw e;
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCode, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --takes: an installed clip, timings.json and narration.wav stay byte-identical", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const paths = reelPaths(dir);
  await main([dir, "--provider", "none", "--lines", "l1", "--no-stt"]);
  const clip = path.join(paths.voiceDir, "line-l1.wav");
  const files = [clip, paths.timingsJson, paths.narrationWav];
  const before = files.map((f) => fs.readFileSync(f));

  await main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);

  files.forEach((f, i) => assert.ok(before[i].equals(fs.readFileSync(f)), `${f} changed`));
  assert.ok(fs.existsSync(path.join(paths.voiceDir, "takes", "l1-2.wav")));
  assert.equal(fs.existsSync(path.join(paths.voiceDir, "takes", "l1")), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main --pick: replaces the installed clip and keeps the previous one under takes/<id>/", async () => {
  const dir = tmpReelDir();
  writePlan(dir, basePlan([{ id: "l1", text: "짧은 문장" }]));
  const paths = reelPaths(dir);
  await main([dir, "--provider", "none", "--lines", "l1", "--no-stt"]);
  const clip = path.join(paths.voiceDir, "line-l1.wav");
  const previous = fs.readFileSync(clip);
  await main([dir, "--provider", "none", "--lines", "l1", "--takes", "2", "--no-stt"]);

  await main([dir, "--provider", "none", "--pick", "l1=2", "--no-stt", "--retime"]);

  const keptDir = path.join(paths.voiceDir, "takes", "l1");
  const kept = fs.readdirSync(keptDir).filter((f) => /^installed-.*\.wav$/.test(f));
  assert.equal(kept.length, 1);
  assert.ok(fs.readFileSync(path.join(keptDir, kept[0])).equals(previous));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("synthesizeTakes: a line with no installed clip gets take 1; one that has a clip is left alone", async () => {
  const dir = tmpReelDir();
  const paths = reelPaths(dir);
  const plan = basePlan([{ id: "l1", text: "첫 줄" }]);
  const args = { dir, paths, plan, lineIds: ["l1"], spec: { mode: "count", n: 2 }, providerName: "none", voiceCfg: {}, pronounce: undefined, lang: "ko-KR", gapMs: 250, sttEnabled: false, keepTiming: true };

  await synthesizeTakes({ ...args, provider: makeVaryingProvider() });
  const clip = path.join(paths.voiceDir, "line-l1.wav");
  assert.ok(fs.existsSync(clip));
  const installed = fs.readFileSync(clip);

  await synthesizeTakes({ ...args, provider: makeVaryingProvider() });
  assert.ok(fs.readFileSync(clip).equals(installed));

  fs.rmSync(dir, { recursive: true, force: true });
});
