// Every ffmpeg amix in the scripts must set normalize=0. amix's default
// (normalize=1) divides the sum by the number of inputs still playing, so a
// voice gets louder each time a line or an effect ends: the narration drifts
// and jumps with the effects. Nothing else fails when it is left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

/** amix filter specs in `src` that do not set normalize=0. */
export function amixWithoutNormalizeOff(src) {
  const specs = src.match(/amix=[^\[\]`"';]*/g) || [];
  return specs.filter((spec) => !/(^|:)normalize=0(\b|$)/.test(spec.slice("amix=".length)));
}

function scriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : scriptFiles(p);
    return /\.(mjs|js)$/.test(e.name) ? [p] : [];
  });
}

test("amixWithoutNormalizeOff: flags an amix that leaves normalize at its default", () => {
  assert.deepEqual(amixWithoutNormalizeOff("[a][b]amix=inputs=2:duration=first[out]"), ["amix=inputs=2:duration=first"]);
  assert.deepEqual(amixWithoutNormalizeOff("[a][b]amix=inputs=2:normalize=1[out]"), ["amix=inputs=2:normalize=1"]);
  assert.deepEqual(amixWithoutNormalizeOff("[a][b]amix=inputs=2:duration=first:normalize=0[out]"), []);
});

test("every amix in scripts/ sets normalize=0", () => {
  const found = scriptFiles(SCRIPTS).reduce((n, f) => n + (fs.readFileSync(f, "utf8").match(/amix=/g) || []).length, 0);
  assert.ok(found >= 3, `scan found only ${found} amix filters; the scan itself is broken`);
  const offenders = scriptFiles(SCRIPTS).flatMap((f) =>
    amixWithoutNormalizeOff(fs.readFileSync(f, "utf8")).map((spec) => `${path.relative(SCRIPTS, f)}: ${spec}`)
  );
  assert.deepEqual(offenders, []);
});
