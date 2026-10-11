// Allowances on freeze runs (scripts/lib/dead-air.mjs): the end hold after the last line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { excludeEndHold } from "../scripts/lib/dead-air.mjs";

test("excludeEndHold: a still end hold after the last line is not dead air", () => {
  assert.deepEqual(excludeEndHold([{ startSec: 12.3, durationSec: 1.56 }], 12.35, 0.8), []);
});

test("excludeEndHold: a still run that starts well before the last line ends stays flagged, cut at the hold", () => {
  const runs = excludeEndHold([{ startSec: 10, durationSec: 3.5 }], 12, 0.8);
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].durationSec - 2) < 1e-9);
});
