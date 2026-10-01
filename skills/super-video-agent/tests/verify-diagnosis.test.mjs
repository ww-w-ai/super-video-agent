// verify.mjs cold probe (T07) and mismatch diagnosis (T08).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bisectOffender, uniqueTimes, describeDiff, describeOffender } from "../scripts/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyCli = path.join(here, "..", "scripts", "verify.mjs");

// changesFrame for a page whose frame changes once any seek in `offenders` ran.
const byOffenders = (offenders) => async (subset) => subset.some((t) => offenders.includes(t));

test("bisectOffender: finds the single offending seek wherever it sits", async () => {
  const history = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  for (const o of history) {
    const r = await bisectOffender(history, byOffenders([o]));
    assert.equal(r.offender, o);
    assert.equal(r.reproduced, true);
    assert.ok(r.tests <= 1 + 2 * Math.ceil(Math.log2(history.length)), `tests=${r.tests}`);
  }
});

test("bisectOffender: whole history does not reproduce → reproduced=false", async () => {
  const r = await bisectOffender([1, 2, 3], async () => false);
  assert.deepEqual([r.offender, r.reproduced, r.tests], [null, false, 1]);
  const empty = await bisectOffender([], async () => true);
  assert.equal(empty.reproduced, false);
});

test("bisectOffender: change needs seeks from both halves → returns that subset", async () => {
  const needsBoth = async (subset) => subset.includes(1) && subset.includes(4);
  const r = await bisectOffender([1, 2, 3, 4], needsBoth);
  assert.equal(r.offender, null);
  assert.deepEqual(r.subset, [1, 2, 3, 4]);
});

test("uniqueTimes keeps first occurrences in order", () => {
  assert.deepEqual(uniqueTimes([0.5, 0.5, 1.5, 0.5, 2]), [0.5, 1.5, 2]);
});

test("describeDiff / describeOffender wording", () => {
  assert.match(describeDiff({ changed: 4, maxDelta: 9, box: [2, 3, 5, 6] }), /4 px differ, max channel delta 9, box x 2–5, y 3–6 \(4×4\)/);
  assert.match(describeDiff({ changed: 0, maxDelta: 0, box: null }), /no pixel differs/);
  assert.match(describeOffender("warm", 1, { offender: 3, reproduced: true }), /seeking t=3\.000s before t=1\.000s changes the frame/);
  assert.match(describeOffender("cold", 0, { offender: 0.5, reproduced: true }), /cold: seeking t=0\.500s first/);
  assert.match(describeOffender("cold", 0, { offender: 0, reproduced: true }), /an earlier seek of the same time/);
  assert.match(describeOffender("warm", 1, { offender: null, subset: [1, 2], reproduced: true }), /together do: 1\.000, 2\.000s/);
  assert.match(describeOffender("warm", 1, { offender: null, subset: null, reproduced: false }), /did not reproduce/);
});

const SHOTS = `[{id:"a",start:0,end:1,readAt:0.5},{id:"b",start:1,end:2,readAt:1.5},{id:"c",start:2,end:3,readAt:2.5},{id:"d",start:3,end:4,readAt:3.5}]`;

function fixture(sceneBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-det-"));
  fs.writeFileSync(
    path.join(dir, "reel.html"),
    `<!doctype html><canvas width="64" height="64"></canvas><script>
/* SCENE:BEGIN */
var g = document.querySelector("canvas").getContext("2d");
function paint(color, t) { g.fillStyle = color; g.fillRect(0, 0, 64, 64); g.fillStyle = "#fff"; g.fillRect(Math.floor(t * 10) % 60, 10, 4, 4); }
${sceneBody}
window.__reel = { width: 64, height: 64, fps: 30, duration: 4, ready: Promise.resolve(), seek: seek, shots: ${SHOTS}, issues: function () { return []; } };
/* SCENE:END */
</script>`
  );
  return dir;
}

function runVerify(dir) {
  const r = spawnSync(process.execPath, [verifyCli, dir], { encoding: "utf8", timeout: 240000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test("verify: a clean seek(t) passes the warm and cold probes", () => {
  const r = runVerify(fixture(`function seek(t) { paint(t < 2 ? "#00c" : "#0a0", t); }`));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /determinism probe: ok/);
  assert.match(r.stdout, /cold probe: ok/);
});

test("verify: carried state names the prior seek time that changes the frame", () => {
  // Seeking t=3.0 (a shot start, not a warm-up readAt) flips a module flag
  // that every later frame reads.
  const r = runVerify(fixture(`var seen = false;
function seek(t) { if (t > 2.99 && t < 3.01) seen = true; paint(seen ? "#c00" : "#00c", t); }`));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not independent of seek history/);
  assert.match(r.stderr, /px differ, max channel delta \d+, box x 0–63, y 0–63/);
  assert.match(r.stderr, /warm: seeking t=3\.000s before t=\d\.\d{3}s changes the frame/);
});

test("verify: a frame built lazily on the first seek of its scene fails the cold probe", () => {
  // Warm-up seeks every shot, so the warm passes agree; a fresh page without
  // warm-up draws the first frame of each scene differently.
  const r = runVerify(fixture(`var built = {};
function seek(t) { var k = t < 2 ? "a" : "b"; var first = !built[k]; built[k] = true; paint(first ? "#0a0" : "#00c", t); }`));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /determinism probe: ok/);
  assert.match(r.stderr, /without warm-up draws a different frame on its first seek at t=0\.000/);
  assert.match(r.stderr, /cold: seeking t=0\.500s first is what turns t=0\.000s into its warm frame/);
});
