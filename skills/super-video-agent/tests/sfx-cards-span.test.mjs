// sfx-cards.mjs measures and judges a library asset over the part the film
// plays (0 s to maxSec, as render.mjs trims a cue), not the whole file.
// No network: the judge is mocked; ffmpeg decodes a local WAV.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetTrim, measureAssetSpan, runMeasure, runJudge, runReport } from "../scripts/sfx-cards.mjs";
import { describeSpan, describeMeasured } from "../scripts/lib/sfx-judge-rubric.mjs";
import { fitStateText } from "../scripts/lib/jev-client.mjs";
import { validateCards } from "../scripts/lib/sfx-cards-schema.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";

const SR = 48000;
const card = (recipe) => ({ id: "c", at: 1, event: "e", intent: "i", recipe });

test("assetTrim: card maxSec wins, else the maxSec plan.json cues share, else the whole file", () => {
  const plan = { lines: [{ cues: [{ asset: "a1", at: "end", maxSec: 3 }] }, { cues: [{ asset: "a1", at: "start", maxSec: 3 }, { asset: "a2", at: "end" }] }] };
  assert.deepEqual(assetTrim(card({ kind: "asset", assetId: "a1", maxSec: 2 }), plan), { maxSec: 2, from: "card", conflict: false });
  assert.deepEqual(assetTrim(card({ kind: "asset", assetId: "a1" }), plan), { maxSec: 3, from: "plan.json", conflict: false });
  assert.deepEqual(assetTrim(card({ kind: "asset", assetId: "a2" }), plan), { maxSec: null, from: null, conflict: false });
  assert.deepEqual(assetTrim(card({ kind: "asset", assetId: "a9" }), null), { maxSec: null, from: null, conflict: false });
  const mixed = { lines: [{ cues: [{ asset: "a1", at: "end", maxSec: 3 }, { asset: "a1", at: "start" }] }] };
  assert.deepEqual(assetTrim(card({ kind: "asset", assetId: "a1" }), mixed), { maxSec: null, from: null, conflict: true });
});

test("schema: recipe.maxSec is a positive number on an asset recipe only", () => {
  const ok = { ...card({ kind: "asset", assetId: "a1", maxSec: 2.5 }) };
  assert.equal(validateCards([ok]).valid, true);
  assert.equal(validateCards([card({ kind: "asset", assetId: "a1", maxSec: 0 })]).valid, false);
  assert.equal(validateCards([card({ kind: "kit", kit: "pop", maxSec: 1 })]).valid, false);
});

test("measureAssetSpan: a 10 s buffer trimmed to 3 s measures 3 s and keeps fileSec 10", async () => {
  const samples = new Float32Array(10 * SR);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const m = await measureAssetSpan(samples, SR, 3);
  assert.equal(m.durationSec, 3);
  assert.equal(m.fileSec, 10);
  const whole = await measureAssetSpan(samples, SR, null);
  assert.equal(whole.durationSec, 10);
  const longer = await measureAssetSpan(samples, SR, 20);
  assert.equal(longer.durationSec, 10);
});

test("describeSpan / describeMeasured: say which span was measured", () => {
  const base = { peakDb: -3, attackMs: 5, brightnessHz: 1000, pitchTrend: "flat", noisiness: 0.2, lufs: -14 };
  assert.equal(describeSpan({ ...base, durationSec: 3, fileSec: 10.248 }), "0.00-3.00s of a 10.25s file");
  assert.equal(describeSpan({ ...base, durationSec: 0.94, fileSec: 0.94 }), "the whole 0.94s file");
  assert.equal(describeSpan({ ...base, durationSec: 0.35 }), "the whole 0.35s sound");
  assert.equal(describeSpan(null), "(not measured)");
  assert.match(describeMeasured({ ...base, durationSec: 3, fileSec: 10.248 }), /^over 0\.00-3\.00s of a 10\.25s file: duration 3\.00s/);
});

function reelWithAsset(planMaxSec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-span-"));
  fs.mkdirSync(path.join(dir, "assets", "lib"), { recursive: true });
  // 0.2 s of silence (like an MP3's encoder padding), then 9.8 s of a 1 kHz tone
  const samples = new Float32Array(10 * SR);
  for (let i = Math.round(0.2 * SR); i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  writeWavPCM16(path.join(dir, "assets", "lib", "cheer.wav"), [samples, samples], SR);
  fs.writeFileSync(path.join(dir, "assets", "lib", "manifest.json"), JSON.stringify({ assets: { cheer: { file: "assets/lib/cheer.wav" } } }));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ meta: {}, lines: [{ id: "l1", text: "x", cues: [{ asset: "cheer", at: "end", maxSec: planMaxSec }] }] }));
  const cards = [{ id: "cheer", at: 5, event: "a crowd cheers", intent: "joyful, cut to 3 s", world: "a toy theme park", recipe: { kind: "asset", assetId: "cheer" } }];
  fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify(cards));
  return dir;
}

test("runMeasure → runJudge → runReport: the asset is measured, judged and reported over plan.json's 3 s, not the 10 s file", async () => {
  const dir = reelWithAsset(3);
  try {
    await runMeasure(dir);
    const [measured] = JSON.parse(fs.readFileSync(path.join(dir, "sound-cards.json"), "utf8"));
    assert.equal(measured.measured.durationSec, 3);
    assert.equal(measured.measured.fileSec, 10);
    // the leading silence no longer blanks the spectrum
    assert.ok(measured.measured.brightnessHz > 800, `brightness ${measured.measured.brightnessHz}`);

    const seen = [];
    const judge = async (c) => {
      seen.push(fitStateText(c));
      return { id: c.id, fit: 9, backend: "mock" };
    };
    await runJudge(dir, { judge });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /Measured: over 0\.00-3\.00s of a 10\.00s file: duration 3\.00s/);

    const { rows } = await runReport(dir);
    assert.equal(rows[0].span, "0.00-3.00s of a 10.00s file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
