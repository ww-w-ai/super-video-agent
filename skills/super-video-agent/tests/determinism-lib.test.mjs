// scripts/lib/determinism.mjs — probe time construction and the shuffle
// used to compare in-order vs shuffled seek hashes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProbeTimes, deterministicShuffle, sha256 } from "../scripts/lib/determinism.mjs";

test("buildProbeTimes: produces at least 12 times covering shot boundaries", () => {
  const shots = [
    { id: "a", start: 0, end: 2, readAt: 1 },
    { id: "b", start: 2, end: 4, readAt: 3 },
    { id: "c", start: 4, end: 6, readAt: 5 },
  ];
  const times = buildProbeTimes(shots, 6, 8);
  assert.ok(times.length >= 12, `got ${times.length}`);
  for (const shot of shots) {
    assert.ok(times.includes(Math.round(shot.start * 1000) / 1000));
    assert.ok(times.includes(Math.round(shot.readAt * 1000) / 1000));
  }
  // sorted ascending
  const sorted = times.slice().sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
});

test("deterministicShuffle: same input+seed -> same permutation every run", () => {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const a = deterministicShuffle(arr);
  const b = deterministicShuffle(arr);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, arr); // actually shuffled
  assert.deepEqual(a.slice().sort((x, y) => x - y), arr); // same elements
});

test("sha256: identical bytes hash identically, different bytes diverge", () => {
  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([1, 2, 3]);
  const c = Buffer.from([1, 2, 4]);
  assert.equal(sha256(a), sha256(b));
  assert.notEqual(sha256(a), sha256(c));
});
