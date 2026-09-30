// End-to-end (no network, no browser) tests for scripts/sfx-cards.mjs's
// `judge` (manual-sheet path) and `report` (fit threshold), against a fixed
// temp reel directory. `measure` needs a real reel.html/browser session and
// is exercised by the real check against promo-speedhome instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJudge, runReport } from "../scripts/sfx-cards.mjs";
import { FIT_THRESHOLD } from "../scripts/lib/sfx-judge-rubric.mjs";

function makeReelDir(cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-cards-"));
  fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify(cards, null, 2));
  return dir;
}

const CARDS = [
  {
    id: "s1",
    at: 4.2,
    event: "a stamp lands",
    intent: "heavy, decisive",
    world: "a kitchen promo",
    recipe: { kind: "kit", kit: "thud" },
    measured: {
      durationSec: 0.35,
      peakDb: -0.4,
      attackMs: 1.2,
      brightnessHz: 340,
      pitchTrend: "none",
      noisiness: 0.71,
      lufs: -14.2,
    },
  },
  {
    id: "s2",
    at: 9.0,
    event: "a badge pops in",
    intent: "light, playful",
    world: "a kitchen promo",
    recipe: { kind: "asset", assetId: "sfx-pack120-091" },
    measured: {
      durationSec: 0.77,
      peakDb: -1.0,
      attackMs: 3.0,
      brightnessHz: 900,
      pitchTrend: "flat",
      noisiness: 0.3,
      lufs: -16.0,
    },
  },
];

test("runJudge: no API keys -> writes sound-judge.md and a sound-scores.json template, makes no network call", async () => {
  const savedTypesafe = process.env.TYPESAFE_API_KEY;
  const savedOpenrouter = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const dir = makeReelDir(CARDS);
    await runJudge(dir);
    const sheet = fs.readFileSync(path.join(dir, "sound-judge.md"), "utf8");
    assert.match(sheet, /# Sound card scoring sheet/);
    assert.match(sheet, /s1/);
    assert.match(sheet, /s2/);
    const scores = JSON.parse(fs.readFileSync(path.join(dir, "sound-scores.json"), "utf8"));
    assert.equal(scores.length, 2);
    assert.ok(scores.every((s) => s.fit === null && s.backend === "manual"));
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (savedTypesafe != null) process.env.TYPESAFE_API_KEY = savedTypesafe;
    if (savedOpenrouter != null) process.env.OPENROUTER_API_KEY = savedOpenrouter;
  }
});

test(`runReport: warns on fit < ${FIT_THRESHOLD}, passes at exactly ${FIT_THRESHOLD}`, async () => {
  const dir = makeReelDir(CARDS);
  fs.writeFileSync(
    path.join(dir, "sound-scores.json"),
    JSON.stringify([
      { id: "s1", fit: FIT_THRESHOLD - 1, backend: "manual", reason: "generic thud, could be any film" },
      { id: "s2", fit: FIT_THRESHOLD, backend: "manual", reason: "fits the kitchen world" },
    ])
  );
  const { warnings } = await runReport(dir);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, "s1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runReport: an unscored card (no sound-scores.json entry) warns too", async () => {
  const dir = makeReelDir(CARDS);
  fs.writeFileSync(path.join(dir, "sound-scores.json"), JSON.stringify([{ id: "s1", fit: 9, backend: "manual" }]));
  const { warnings } = await runReport(dir);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, "s2");
  assert.equal(warnings[0].fit, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runReport: every card >= threshold -> no warnings", async () => {
  const dir = makeReelDir(CARDS);
  fs.writeFileSync(
    path.join(dir, "sound-scores.json"),
    JSON.stringify([
      { id: "s1", fit: 8, backend: "manual" },
      { id: "s2", fit: 10, backend: "manual" },
    ])
  );
  const { warnings } = await runReport(dir);
  assert.deepEqual(warnings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runReport: no sound-scores.json at all -> every card warns as unscored", async () => {
  const dir = makeReelDir(CARDS);
  const { warnings } = await runReport(dir);
  assert.equal(warnings.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
