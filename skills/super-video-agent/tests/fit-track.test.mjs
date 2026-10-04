// Edge trim and fitting a language's voice lines to a picture's slots
// (scripts/lib/clip-trim.mjs, lib/fit-track.mjs, fit-track.mjs). Synthetic
// tones + ffmpeg only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trimClipToVoice, voicedSpanWithPads } from "../scripts/lib/clip-trim.mjs";
import { fitTrack } from "../scripts/fit-track.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
import { decodeMonoPcm, longestSilenceAfterFirstSound } from "../scripts/lib/audio-analysis.mjs";
import { ffmpeg, probeDuration } from "../scripts/lib/ffmpeg.mjs";

const SR = 48000;

/** lead s dead air, tone s of voice, tail s dead air. */
function clip(lead, tone, tail) {
  const out = new Float32Array(Math.round((lead + tone + tail) * SR));
  for (let i = Math.round(lead * SR); i < Math.round((lead + tone) * SR); i++) out[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / SR);
  return out;
}

function wavSamples(file) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf("data");
  return buf.readUInt32LE(at + 4) / 2;
}

/** A work folder with a voice dir: each spec is [id, voicedSec]; every clip carries 0.3 s dead air in front and 0.4 s behind. */
function voiceFolder(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-fit-"));
  const voiceDir = path.join(dir, "voice");
  fs.mkdirSync(voiceDir);
  const lines = specs.map(([id, tone], i) => {
    writeWavPCM16(path.join(voiceDir, `line-${id}.wav`), [clip(0.3, tone, 0.4)], SR);
    return { id, text: id, start: i * 5, end: i * 5 + tone + 0.7, words: [] };
  });
  fs.writeFileSync(path.join(voiceDir, "timings.json"), JSON.stringify({ duration: 20, lines }));
  return { dir, voiceDir };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

test("trim keeps the voiced span: 0.05 s head and 0.3 s tail around it, nothing of the voice cut", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 0.8]]);
  try {
    const out = path.join(dir, "trimmed.wav");
    const t = await trimClipToVoice(path.join(voiceDir, "line-a.wav"), out);
    assert.ok(Math.abs(t.sourceDurationSec - 1.5) < 0.01);
    assert.ok(Math.abs(t.trimmedDurationSec - 1.15) < 0.03, `trimmed ${t.trimmedDurationSec}s (0.8 voiced + 0.05 + 0.3)`);
    assert.ok(Math.abs(t.tailTrimSec - 0.1) < 0.03, `tail cut ${t.tailTrimSec}s of the 0.4 s dead air, 0.3 s kept`);
    assert.ok(Math.abs(t.leadTrimSec - 0.25) < 0.03, `lead ${t.leadTrimSec}s`);
    const pcm = await decodeMonoPcm(out, SR);
    const first = pcm.findIndex((v) => Math.abs(v) > 0.05);
    const last = pcm.length - 1 - [...pcm].reverse().findIndex((v) => Math.abs(v) > 0.05);
    assert.ok((last - first) / SR > 0.78 && (last - first) / SR < 0.82, `voiced span ${(last - first) / SR}s survives`);
    assert.ok(Math.abs(first / SR - 0.05) < 0.02, `head pad ${first / SR}s`);
    assert.ok(longestSilenceAfterFirstSound(pcm, SR).longestSilenceSec < 0.35, "no dead air beyond the pads");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("voicedSpanWithPads: only the two edges are cut; a pause inside the clip stays", () => {
  const w = (i, db) => ({ startSec: i * 0.01, endSec: (i + 1) * 0.01, rmsDb: db });
  const windows = [...Array(30).fill(0).map((_, i) => w(i, -80)), ...Array(50).fill(0).map((_, i) => w(30 + i, -20)), ...Array(100).fill(0).map((_, i) => w(80 + i, -80)), ...Array(50).fill(0).map((_, i) => w(180 + i, -20)), ...Array(40).fill(0).map((_, i) => w(230 + i, -80))];
  const range = voicedSpanWithPads(windows, 2.7);
  assert.ok(Math.abs(range.trimmedStartSec - 0.25) < 1e-9);
  assert.ok(Math.abs(range.trimmedEndSec - (2.3 + 0.3)) < 1e-9);
});

/** Slots: a 0..2.5, b 2.5..5, c 5..end. A voiced clip of v s trims to v + 0.35 s. */
const BASE = {
  duration: 8,
  lines: [
    { id: "a", start: 0, end: 2.3 },
    { id: "b", start: 2.5, end: 4.8 },
    { id: "c", start: 5, end: 7.5 },
  ],
};

test("fit stays within 0.95-1.1: a line over its slot is sped up and reported tight, one that fits is left alone", async () => {
  // a: voiced 1.5 + 0.35 pads = 1.85 in a 2.5 slot -> fits with 0.65 s breath; b: voiced 2.1 -> 2.45 in 2.5 -> 1.1x, 0.27 s breath (reported); c: short, last
  const { dir, voiceDir } = voiceFolder([["a", 1.5], ["b", 2.1], ["c", 1.0]]);
  try {
    writeJson(path.join(dir, "picture.timings.json"), BASE);
    const result = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "track.wav") });
    for (const l of result.fit.lines) assert.ok(l.atempoFactor >= 0.95 && l.atempoFactor <= 1.1 + 1e-9, `${l.id} ${l.atempoFactor}`);
    const b = result.fit.lines.find((l) => l.id === "b");
    assert.ok(Math.abs(b.atempoFactor - 1.1) < 1e-9, `b ${b.atempoFactor}`);
    assert.deepEqual(result.fit.breathWarnings.map((w) => w.id), ["b"]);
    assert.equal(result.fit.lines.find((l) => l.id === "a").atempoFactor, 1);
    assert.equal(result.fit.lines.find((l) => l.id === "c").atempoFactor, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("placement keeps at least 0.5 s of silence after a line when the slot has room", async () => {
  // a: voiced 1.6 -> 1.95 s in a 2.5 s slot keeps 0.55 s at 1.0x; b: voiced 1.7 -> 2.05 s is sped up (1.025x) to leave exactly 0.5 s.
  const { dir, voiceDir } = voiceFolder([["a", 1.6], ["b", 1.7], ["c", 1.0]]);
  try {
    writeJson(path.join(dir, "picture.timings.json"), BASE);
    const result = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "track.wav") });
    const a = result.fit.lines.find((l) => l.id === "a");
    assert.equal(a.atempoFactor, 1);
    assert.ok(2.5 - (a.end - a.start) >= 0.5 - 1e-9, `breath after a ${2.5 - (a.end - a.start)}s`);
    const b = result.fit.lines.find((l) => l.id === "b");
    assert.ok(2.5 - (b.end - b.start) >= 0.5 - 1e-9, `breath after b ${2.5 - (b.end - b.start)}s`);
    assert.equal(result.fit.breathWarnings.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a line that needs 1.14x is reported for rewording and no track is written", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 1.0], ["b", 2.5], ["c", 1.0]]); // b: 2.5 voiced + 0.35 pads = 2.85 s in a 2.5 s slot = 1.14x
  try {
    writeJson(path.join(dir, "picture.timings.json"), BASE);
    const out = path.join(dir, "track.wav");
    await assert.rejects(fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: out }), (e) => {
      assert.match(e.message, /b: needs 1\.\d{3}x, max is 1\.1x/);
      assert.match(e.message, /shorten this line's script/);
      const needed = Number(/b: needs (1\.\d+)x/.exec(e.message)[1]);
      assert.ok(needed > 1.12 && needed < 1.17, `needs ${needed}`);
      return true;
    });
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a line that leaves a gap over 1.0 s is slowed to 0.95x and the remaining long gap is reported with its id", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 0.8], ["b", 1.0], ["c", 1.0]]); // a: 1.15 s in a 2.5 s slot -> gap 1.35 s
  try {
    writeJson(path.join(dir, "picture.timings.json"), BASE);
    const result = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "track.wav") });
    const a = result.fit.lines.find((l) => l.id === "a");
    assert.ok(Math.abs(a.atempoFactor - 0.95) < 1e-9, `a ${a.atempoFactor}`);
    assert.ok(result.fit.longGaps.some((g) => g.id === "a" && g.gapSec > 1.0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--max-speed widens the allowance: the same 1.15x line fits at 1.2", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 1.0], ["b", 2.4], ["c", 1.0]]);
  try {
    // b: 2.75 s into a 2.4 s slot (2.5 -> 4.9) is 1.146x
    writeJson(path.join(dir, "picture.timings.json"), { duration: 8, lines: [{ id: "a", start: 0, end: 2.3 }, { id: "b", start: 2.5, end: 4.6 }, { id: "c", start: 4.9, end: 7.5 }] });
    await assert.rejects(fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "t1.wav") }), /b: needs 1\.1[45]/);
    const wide = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "t2.wav"), maxSpeed: 1.2 });
    assert.ok(wide.fit.lines.find((l) => l.id === "b").atempoFactor > 1.1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the track is exactly the reference's length, from the timings' duration and from a video", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 1.0], ["b", 1.0], ["c", 1.0]]);
  try {
    writeJson(path.join(dir, "picture.timings.json"), BASE);
    const first = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "t1.wav") });
    assert.equal(first.samples, Math.round(8 * SR));
    assert.equal(wavSamples(path.join(dir, "t1.wav")), Math.round(8 * SR));

    const video = path.join(dir, "picture.mp4");
    await ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=7.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const second = await fitTrack({ timingsPath: path.join(dir, "picture.timings.json"), voiceDir, outPath: path.join(dir, "t2.wav"), videoPath: video });
    const expected = Math.round((await probeDuration(video)) * SR);
    assert.equal(wavSamples(path.join(dir, "t2.wav")), expected);
    assert.equal(second.samples, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the silence gate names the line ids around a gap the picture does not have, and lists the picture's own pause as planned", async () => {
  const { dir, voiceDir } = voiceFolder([["a", 0.8], ["b", 0.8]]);
  try {
    // a's slot runs 0 -> 3.0; the clip is 1 s long, so 2 s of silence follow it. In the picture
    // a ends at 2.9 (no pause of its own) -> unplanned; in the second picture it ends at 1.0 -> planned.
    const unplanned = { duration: 5, lines: [{ id: "a", start: 0, end: 2.9 }, { id: "b", start: 3, end: 4 }] };
    writeJson(path.join(dir, "u.json"), unplanned);
    const u = await fitTrack({ timingsPath: path.join(dir, "u.json"), voiceDir, outPath: path.join(dir, "u.wav") });
    assert.equal(u.silence.unplanned.length, 1);
    assert.equal(u.silence.unplanned[0].afterId, "a");
    assert.equal(u.silence.unplanned[0].beforeId, "b");
    writeJson(path.join(dir, "p.json"), { duration: 5, lines: [{ id: "a", start: 0, end: 1 }, { id: "b", start: 3, end: 4 }] });
    const p = await fitTrack({ timingsPath: path.join(dir, "p.json"), voiceDir, outPath: path.join(dir, "p.wav") });
    assert.equal(p.silence.unplanned.length, 0);
    assert.equal(p.silence.planned.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
