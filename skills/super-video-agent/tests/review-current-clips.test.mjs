import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { voiceClipFacts, voiceClipFactLines } from "../scripts/review.mjs";
import { describeDefects, defectCodes, findClipDefects } from "../scripts/voice/take-check.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";
const rate = 48000;
function signal(abrupt = false) {
  const samples = new Float32Array(rate);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const gain = abrupt ? Math.min(1, (1 - t) / 0.1) : Math.max(0, Math.min(1, (t - 0.05) / 0.1, (0.9 - t) / 0.1));
    samples[i] = 0.3 * gain * Math.cos(2 * Math.PI * 1000 * t);
  }
  return samples;
}

test("review remeasures the current clip, ignoring stale stored HEAD facts and repeated changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-current-clips-"));
  try {
    const file = path.join(dir, "line-a.wav");
    const timings = {lines:[{id:"a",clipFacts:{head:{firstDb:0,abrupt:true,weak:true},dips:[],pauses:[]}}]};
    writeWavPCM16(file, [signal()], rate);
    const clean = await voiceClipFacts(timings, dir);
    assert.equal(clean.measured, 1);
    assert.equal(clean.unmeasured, 0);
    assert.deepEqual(clean.lines, []);
    assert.equal(clean.source, "current-clips");
    writeWavPCM16(file, [signal(true)], rate);
    const cut = await voiceClipFacts(timings, dir);
    assert.equal(cut.lines[0].flag, "HEAD");
    assert.match(cut.lines[0].facts.join(" "), /LU under/);
    assert.doesNotMatch(cut.lines[0].facts.join(" "), /first 10 ms|HEAD weak/);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test("missing or undecodable clips explicitly remain unmeasured, even with stored facts", async () => {
  const result = await voiceClipFacts({lines:[{id:"missing",clipFacts:{head:{abrupt:true}}}]}, "/unused", {
    decode: async () => { throw new Error("clip unavailable"); }
  });
  assert.equal(result.measured, 0);
  assert.equal(result.unmeasured, 1);
  assert.deepEqual(result.lines, []);
  assert.equal(result.unavailable[0].id, "missing");
  assert.match(voiceClipFactLines(result).join(" "), /CHECKED NOTHING.*clip unavailable/);
});

test("a decoded silent clip is measured without a defect; raw HEAD fields do not own reporting", async () => {
  const result = await voiceClipFacts({lines:[{id:"silent"}]}, "/unused", {
    decode: async () => new Float32Array(rate)
  });
  assert.equal(result.measured, 1);
  assert.equal(result.unmeasured, 0);
  assert.deepEqual(result.lines, []);
  const facts = findClipDefects(signal(), rate);
  facts.head = {firstDb:0,loudestDb:0,abrupt:true,weak:true};
  assert.deepEqual(describeDefects(facts), []);
  assert.deepEqual(defectCodes(facts), []);
});

test("fresh measurement reports current TAIL and internal PAUSE even with no stored facts", async () => {
  const tail = signal().subarray(0, rate / 2);
  const paused = signal();
  paused.fill(0, Math.round(rate * 0.3), Math.round(rate * 0.7));
  const result = await voiceClipFacts({lines:[{id:"tail"},{id:"pause"}]}, "/unused", {
    decode: async (file) => file.endsWith("line-tail.wav") ? tail : paused
  });
  assert.equal(result.measured, 2);
  assert.equal(result.lines.find((line) => line.id === "tail").flag, "TAIL");
  assert.match(result.lines.find((line) => line.id === "pause").facts.join(" "), /PAUSE 0.40 s/);
});

test("corrupt and empty current clips retain explicit failure evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-broken-clips-"));
  try {
    fs.writeFileSync(path.join(dir, "line-corrupt.wav"), "broken audio");
    const result = await voiceClipFacts({lines:[{id:"missing"},{id:"corrupt"}]}, dir);
    assert.equal(result.measured, 0);
    assert.equal(result.unavailable.length, 2);
    assert.ok(result.unavailable.every((line) => line.reason.length > 0));
    const empty = await voiceClipFacts({lines:[{id:"empty"}]}, dir, {decode:async()=>new Float32Array()});
    assert.match(empty.unavailable[0].reason, /no samples/);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test("a line marked silent is skipped and listed; an unmarked line with no voice file is still flagged", async () => {
  const result = await voiceClipFacts({ lines: [{ id: "s1", silent: true }, { id: "v1" }] }, "/unused");
  assert.deepEqual(result.silent, ["s1"]);
  assert.deepEqual(result.unavailable.map((u) => u.id), ["v1"]);
  const text = voiceClipFactLines(result).join("\n");
  assert.match(text, /CHECKED NOTHING, line "v1"/);
  assert.doesNotMatch(text, /CHECKED NOTHING, line "s1"/);
  assert.match(text, /skipped 1 silent line\(s\).*s1/);
});

test("all lines marked silent: one skipped line, no CHECKED NOTHING", async () => {
  const result = await voiceClipFacts({ lines: [{ id: "s1", silent: true }, { id: "s2", silent: true }] }, "/unused");
  const text = voiceClipFactLines(result).join("\n");
  assert.doesNotMatch(text, /CHECKED NOTHING/);
  assert.match(text, /skipped 2 silent line\(s\).*s1, s2/);
});

test("an older silent-clock file (clock, no silent flags) is still skipped", async () => {
  const timings = { clock: "silent clock from a timeline, no narration", lines: [{ id: "s1", text: "" }, { id: "s2", text: "" }] };
  const text = voiceClipFactLines(await voiceClipFacts(timings, "/unused")).join("\n");
  assert.doesNotMatch(text, /CHECKED NOTHING/);
  assert.match(text, /skipped 2 silent line/);
});

test("silent-clock.mjs writes silent: true on every line", async () => {
  const { buildClock } = await import("../scripts/lib/silent-clock.mjs");
  const { timings } = buildClock({ steps: [{ id: "a", start: 0, end: 1 }, { id: "b", start: 1, end: 2 }] });
  assert.ok(timings.lines.every((l) => l.silent === true));
});
