// verify.mjs --no-cue-check: the stale-cues warning can be turned off.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warnOnCueDrift } from "../scripts/verify.mjs";

function driftingReel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cue-"));
  const planJson = path.join(dir, "plan.json");
  fs.writeFileSync(planJson, JSON.stringify({ lines: [{ id: "l1", cues: [{ asset: "pop", at: 0.5 }] }] }));
  return { dir, paths: { planJson, assetsDir: path.join(dir, "assets") } };
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = (s) => ((out += s), true);
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

test("warnOnCueDrift: warns when cues.json is missing", () => {
  const { dir, paths } = driftingReel();
  assert.match(captureStderr(() => warnOnCueDrift(dir, paths)), /no assets\/lib\/cues\.json/);
});

test("warnOnCueDrift: skip silences the warning", () => {
  const { dir, paths } = driftingReel();
  assert.equal(captureStderr(() => warnOnCueDrift(dir, paths, { skip: true })), "");
});
