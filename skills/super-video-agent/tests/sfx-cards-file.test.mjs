import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMeasure } from "../scripts/sfx-cards.mjs";
import { validateCard } from "../scripts/lib/sfx-cards-schema.mjs";
import { writeWavPCM16 } from "../scripts/lib/wav.mjs";

const SR = 48000;

function card(extra) {
  return {
    id: "thud",
    at: 1,
    event: "a lid drops",
    intent: "short dull knock",
    world: "a kitchen promo",
    recipe: { kind: "custom", custom: "film-made file" },
    ...extra,
  };
}

test("a card's file path is measured without a page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-file-"));
  try {
    const n = Math.round(0.5 * SR);
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    fs.mkdirSync(path.join(dir, "sfx"));
    writeWavPCM16(path.join(dir, "sfx", "thud.wav"), [tone, tone], SR);
    fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify([card({ file: "sfx/thud.wav" })]));

    await runMeasure(dir);

    const [out] = JSON.parse(fs.readFileSync(path.join(dir, "sound-cards.json"), "utf8"));
    assert.ok(out.measured, "card was measured");
    assert.ok(Math.abs(out.measured.durationSec - 0.5) < 0.02, `duration ${out.measured.durationSec}`);
    assert.ok(out.measured.peakDb < 0 && out.measured.peakDb > -9, `peak ${out.measured.peakDb}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing file leaves the card unmeasured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-file-"));
  try {
    fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify([card({ file: "sfx/none.wav" })]));
    await runMeasure(dir);
    const [out] = JSON.parse(fs.readFileSync(path.join(dir, "sound-cards.json"), "utf8"));
    assert.equal(out.measured, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema accepts a card with a file", () => {
  assert.deepEqual(validateCard(card({ file: "sfx/a.wav" })), []);
});
