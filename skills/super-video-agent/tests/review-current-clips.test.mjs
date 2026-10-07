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
