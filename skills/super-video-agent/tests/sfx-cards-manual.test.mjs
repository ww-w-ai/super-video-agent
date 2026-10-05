// sfx-cards.mjs judge: a hand score marked `manual: true` wins — the card is
// not judged and its entry is written back unchanged (Q6).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJudge, manualScores } from "../scripts/sfx-cards.mjs";

const card = (id) => ({ id, at: 1.0, event: "a lid pops", intent: "light", world: "a small cafe", recipe: { kind: "kit", kit: "pop" } });

function reel(cards, scores) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-manual-"));
  fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify(cards));
  if (scores) fs.writeFileSync(path.join(dir, "sound-scores.json"), JSON.stringify(scores));
  return dir;
}

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "sound-scores.json"), "utf8"));

test("judge: a manual score is skipped and kept; the other cards are judged, in card order", async () => {
  const hand = { id: "a", fit: 6, backend: "manual", reason: "owner listened", manual: true };
  const dir = reel([card("a"), card("b")], [hand, { id: "b", fit: 3, backend: "mock" }]);
  try {
    const calls = [];
    const scores = await runJudge(dir, { judge: async (c) => (calls.push(c.id), { id: c.id, fit: 9, backend: "mock" }) });
    assert.deepEqual(calls, ["b"]);
    assert.deepEqual(scores, [hand, { id: "b", fit: 9, backend: "mock" }]);
    assert.deepEqual(read(dir), scores);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("judge without a key: the hand-scoring sheet leaves out manual cards and the template keeps them", async () => {
  const hand = { id: "a", fit: 8.5, backend: "manual", reason: "", manual: true };
  const dir = reel([card("a"), card("b")], [hand]);
  const prev = { t: process.env.TYPESAFE_API_KEY, o: process.env.OPENROUTER_API_KEY };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await runJudge(dir);
    const written = read(dir);
    assert.deepEqual(written[0], hand);
    assert.equal(written[1].id, "b");
    assert.equal(written[1].fit, null);
    const sheet = fs.readFileSync(path.join(dir, "sound-judge.md"), "utf8");
    assert.doesNotMatch(sheet, /^### a$/m);
    assert.match(sheet, /^### b$/m);
  } finally {
    if (prev.t !== undefined) process.env.TYPESAFE_API_KEY = prev.t;
    if (prev.o !== undefined) process.env.OPENROUTER_API_KEY = prev.o;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manualScores: only entries with manual: true and a numeric fit count", () => {
  const dir = reel([card("a")], [
    { id: "a", fit: 7, manual: true },
    { id: "b", fit: null, manual: true },
    { id: "c", fit: 5, manual: false },
    { id: "d", fit: 5 },
  ]);
  try {
    assert.deepEqual([...manualScores(path.join(dir, "sound-scores.json")).keys()], ["a"]);
    assert.equal(manualScores(path.join(dir, "missing.json")).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
