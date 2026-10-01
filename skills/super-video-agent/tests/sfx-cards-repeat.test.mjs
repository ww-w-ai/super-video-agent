// sfx-cards.mjs judge --repeat: a score near the pass mark is judged again,
// stored as mean + runs + spread, and marked "near the line" when the runs
// fall on both sides of the mark. The network judge is replaced by a mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJudge, runReport, summarizeRuns } from "../scripts/sfx-cards.mjs";

const CARD = {
  id: "s1",
  at: 1.0,
  event: "a lid pops",
  intent: "light",
  world: "a small cafe",
  recipe: { kind: "kit", kit: "pop" },
};

function makeReelDir(cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sfx-repeat-"));
  fs.writeFileSync(path.join(dir, "sound-cards.json"), JSON.stringify(cards, null, 2));
  return dir;
}

function mockJudge(sequence) {
  let i = 0;
  const calls = [];
  const judge = async (card) => {
    const fit = sequence[i % sequence.length];
    i++;
    calls.push(card.id);
    return { id: card.id, fit, backend: "mock" };
  };
  return { judge, calls };
}

test("summarizeRuns: mean, spread, and near the line when runs straddle the mark", () => {
  const s = summarizeRuns([7.9, 8.2, 7.9], 8);
  assert.equal(s.fit, 8);
  assert.equal(s.spread, 0.3);
  assert.equal(s.nearLine, true);
  assert.deepEqual(s.runs, [7.9, 8.2, 7.9]);
});

test("summarizeRuns: runs all above the mark are not near the line", () => {
  assert.equal(summarizeRuns([8.1, 8.3], 8).nearLine, false);
  assert.equal(summarizeRuns([7.1, 7.4], 8).nearLine, false);
});

test("judge (no --repeat): a first score within 0.5 of 8 gets 2 extra runs; alternating 7.9/8.2 is near the line", async () => {
  const dir = makeReelDir([CARD]);
  const { judge, calls } = mockJudge([7.9, 8.2]);
  const scores = await runJudge(dir, { judge });
  assert.equal(calls.length, 3);
  assert.equal(scores[0].nearLine, true);
  assert.deepEqual(scores[0].runs, [7.9, 8.2, 7.9]);
  assert.equal(scores[0].spread, 0.3);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "sound-scores.json"), "utf8"));
  assert.equal(written[0].nearLine, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("judge (no --repeat): a score far from the mark is judged once", async () => {
  const dir = makeReelDir([CARD]);
  const { judge, calls } = mockJudge([9.5]);
  const scores = await runJudge(dir, { judge });
  assert.equal(calls.length, 1);
  assert.equal(scores[0].fit, 9.5);
  assert.equal(scores[0].runs, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("judge --repeat 4: every card judged 4 times, even far from the mark", async () => {
  const dir = makeReelDir([CARD, { ...CARD, id: "s2" }]);
  const { judge, calls } = mockJudge([3, 4]);
  const scores = await runJudge(dir, { judge, repeat: 4 });
  assert.equal(calls.length, 8);
  assert.equal(scores[0].fit, 3.5);
  assert.equal(scores[0].runs.length, 4);
  assert.equal(scores[0].nearLine, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: a near-the-line card carries the mark in its WARN entry", async () => {
  const dir = makeReelDir([CARD]);
  fs.writeFileSync(
    path.join(dir, "sound-scores.json"),
    JSON.stringify([{ id: "s1", fit: 7.97, runs: [7.9, 8.2, 7.8], spread: 0.4, nearLine: true, backend: "mock" }])
  );
  const { rows, warnings } = await runReport(dir);
  assert.equal(rows[0].nearLine, true);
  assert.equal(warnings.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
