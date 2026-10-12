// --insert-pause gate: a pause is spliced only into silence (-40 dB against
// the line's loudest 10 ms, window plus 5 ms each side), with 4 ms fades, in
// the measured word gap; a refused pause leaves its clip and timings alone
// and the run exits 1. Local only: hand-written PCM and voice/none.mjs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeAll, runInsertPause } from "../scripts/voice.mjs";
import { pauseWindow, spliceSilence, readWavMono16, writeWavMono16 } from "../scripts/voice/line-edit.mjs";
import { reelPaths, readJson } from "../scripts/lib/reeldir.mjs";
import * as none from "../scripts/voice/none.mjs";

const RATE = 48000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  process.exitCode = 0;
});

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== "string") return orig.call(process.stdout, chunk, ...rest);
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

/**
 * 1 s clip: 220 Hz tone at amp 12000 for the two words [0, 0.4) and
 * [0.5, 1.0); `gap(t)` fills [0.4, 0.5); `extra(t)` overrides any sample.
 */
function clip({ gap, extra = () => null }) {
  const n = Math.round(1.0 * RATE);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const tone = Math.round(12000 * Math.sin(2 * Math.PI * 220 * t));
    const x = extra(t);
    s[i] = x != null ? x : t >= 0.4 && t < 0.5 ? gap(t) : tone;
  }
  return s;
}

const quietGap = () => clip({ gap: () => 60 });
const voicedGap = () => clip({ gap: (t) => Math.round(3000 * Math.sin(2 * Math.PI * 220 * t)) });

const REL_WORDS = [
  [0, 0.4],
  [0.5, 1.0],
];

/**
 * A reel whose lines are the given clips (id → Int16Array; others from
 * voice/none.mjs). Each custom line's word times are set to REL_WORDS.
 */
async function reel(clips, ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-k1-"));
  const paths = reelPaths(dir);
  const plan = {
    meta: { lang: "ko-KR", gapMs: 250, voice: { levelLines: false } },
    lines: ids.map((id) => ({ id, text: clips[id] ? "가나 다라" : "셋" })),
  };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  const provider = {
    async synth(args) {
      if (!clips[args.id]) return none.synth(args);
      fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
      writeWavMono16(args.outPath, clips[args.id], RATE);
      return { wavPath: args.outPath };
    },
  };
  const first = await synthesizeAll({ dir, paths, provider, providerName: "none", voiceCfg: { levelLines: false }, lang: "ko-KR", gapMs: 250, sttEnabled: false, lines: plan.lines });
  for (const line of first.timings.lines) {
    if (!clips[line.id]) continue;
    line.words = line.words.slice(0, 2).map((w, i) => ({ ...w, start: line.start + REL_WORDS[i][0], end: line.start + REL_WORDS[i][1] }));
  }
  fs.writeFileSync(paths.timingsJson, JSON.stringify(first.timings));
  return { dir, paths, plan };
}

const bytes = (p) => fs.readFileSync(p);

test("T1 voiced splice refused: clip, timings.json and narration.wav unchanged, exit 1", async () => {
  const { dir, paths, plan } = await reel({ l1: voicedGap() }, ["l1", "l2"]);
  const wav = path.join(paths.voiceDir, "line-l1.wav");
  const before = { wav: bytes(wav), timings: bytes(paths.timingsJson), narration: bytes(paths.narrationWav) };
  const out = await captureStdout(() => runInsertPause({ dir, paths, plan, spec: "l1@0=300" }));
  assert.match(
    out,
    /line "l1": pause after word 0 "[^"]*" refused — the quietest 10 ms between 0\.400s and 0\.500s is -\d+\.\d dB against the line's loudest 10 ms \(needs -40 dB or quieter\); clip unchanged/
  );
  assert.doesNotMatch(out, /inserted/);
  assert.equal(process.exitCode, 1);
  assert.ok(bytes(wav).equals(before.wav), "clip unchanged");
  assert.ok(bytes(paths.timingsJson).equals(before.timings), "timings.json unchanged");
  assert.ok(bytes(paths.narrationWav).equals(before.narration), "narration.wav unchanged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T2 quiet gap accepted: -43 dB flat gap, zeros at the point, 4 ms fades reach 0 at both edges", () => {
  const s = quietGap();
  const count = Math.round(0.3 * RATE);
  const res = spliceSilence(s, RATE, 0.4, 0.5, count);
  assert.ok(!res.refused, JSON.stringify(res.refused));
  assert.ok(res.levelDb <= -40 && res.levelDb > -46, `level ${res.levelDb}`);
  const { samples: o, at } = res;
  assert.equal(o.length, s.length + count);
  assert.ok(at / RATE >= 0.41 && at / RATE <= 0.49, `at ${at / RATE}`);
  assert.ok(o.subarray(at, at + count).every((v) => v === 0));
  assert.ok(Math.abs(o[at - 1]) <= 1 && Math.abs(o[at + count]) <= 1, `edges ${o[at - 1]} ${o[at + count]}`);
  const fade = Math.round(0.004 * RATE);
  assert.equal(o[at - fade - 1], 60, "outside the fade the gap is untouched");
  assert.ok(Math.abs(o[at - Math.floor(fade / 2)] - 30) <= 1, "linear mid-fade");
  assert.deepEqual([...o.subarray(0, at - fade)], [...s.subarray(0, at - fade)]);
  assert.ok(s.subarray(Math.round(0.4 * RATE), Math.round(0.5 * RATE)).every((v) => v === 60), "input untouched");
});

test("T3 span is the word gap: a silent stop closure inside a word is not chosen", () => {
  const s = clip({ gap: () => 60, extra: (t) => (t >= 0.33 && t < 0.36 ? 0 : null) });
  const words = [
    { start: 10.0, end: 10.4 },
    { start: 10.5, end: 11.0 },
  ];
  const win = pauseWindow(words, 0, 10, 1.0);
  assert.ok(Math.abs(win.fromSec - 0.4) < 1e-9 && Math.abs(win.toSec - 0.5) < 1e-9, JSON.stringify(win));
  const res = spliceSilence(s, RATE, win.fromSec, win.toSec, 4800);
  assert.ok(!res.refused);
  assert.ok(res.at / RATE >= 0.4 && res.at / RATE <= 0.5, `at ${res.at / RATE}`);
});

test("T3b narrow gap: widened to 20 ms around the boundary, never past either word's middle", () => {
  const touching = pauseWindow([{ start: 1.0, end: 1.5 }, { start: 1.5, end: 2.0 }], 0, 1.0, 1.0);
  assert.ok(Math.abs(touching.fromSec - 0.49) < 1e-9 && Math.abs(touching.toSec - 0.51) < 1e-9, JSON.stringify(touching));
  const tiny = pauseWindow([{ start: 1.0, end: 1.006 }, { start: 1.006, end: 1.5 }], 0, 1.0, 0.5);
  assert.ok(Math.abs(tiny.fromSec - 0.003) < 1e-9, JSON.stringify(tiny));
});

test("T4 mixed edits: the quiet one applies (later lines move by it only), the voiced one is refused, exit 1", async () => {
  const { dir, paths, plan } = await reel({ l1: quietGap(), l2: voicedGap() }, ["l1", "l2", "l3"]);
  const before = readJson(paths.timingsJson);
  const l2wav = path.join(paths.voiceDir, "line-l2.wav");
  const l2before = bytes(l2wav);
  let after;
  const out = await captureStdout(async () => {
    after = await runInsertPause({ dir, paths, plan, spec: "l1@0=300,l2@0=300" });
  });
  assert.match(out, /line "l1": inserted 0\.300s after word 0/);
  assert.match(out, /line "l2": pause after word 0 "[^"]*" refused/);
  assert.match(out, /--insert-pause: 1 of 2 pause\(s\) refused; pick a word gap that is silent in the audio/);
  assert.equal(process.exitCode, 1);
  assert.ok(bytes(l2wav).equals(l2before), "refused clip unchanged");
  assert.equal(readWavMono16(path.join(paths.voiceDir, "line-l1.wav")).samples.length, RATE + Math.round(0.3 * RATE));
  for (const id of ["l2", "l3"]) {
    const b = before.lines.find((l) => l.id === id);
    const a = after.lines.find((l) => l.id === id);
    assert.ok(Math.abs(a.start - b.start - 0.3) < 1e-3, `${id} moved by ${a.start - b.start}`);
  }
  assert.ok(Math.abs(after.duration - before.duration - 0.3) < 1e-3);
  assert.deepEqual(readJson(paths.timingsJson).lines.map((l) => l.start), after.lines.map((l) => l.start));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T5 all refused: no write, no rebuild", async () => {
  const { dir, paths, plan } = await reel({ l1: voicedGap() }, ["l1", "l2"]);
  const t0 = bytes(paths.timingsJson);
  const n0 = bytes(paths.narrationWav);
  const out = await captureStdout(() => runInsertPause({ dir, paths, plan, spec: "l1@0=300" }));
  assert.doesNotMatch(out, /^wrote /m);
  assert.match(out, /--insert-pause: 1 of 1 pause\(s\) refused/);
  assert.equal(process.exitCode, 1);
  assert.ok(bytes(paths.timingsJson).equals(t0));
  assert.ok(bytes(paths.narrationWav).equals(n0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T6 docs: the insert-pause bullet states the -40 dB gate and the refusal", () => {
  const md = fs.readFileSync(path.join(HERE, "../references/voice.md"), "utf8");
  const start = md.indexOf("`--insert-pause <id>@<word-index>=<ms>`");
  assert.ok(start > 0);
  const bulletStart = md.lastIndexOf("\n- ", start);
  const bulletEnd = md.indexOf("\n- ", start);
  const bullet = md.slice(bulletStart, bulletEnd);
  assert.match(bullet, /-40 dB/);
  assert.match(bullet, /refused/);
  assert.match(bullet, /4 ms/);
});
