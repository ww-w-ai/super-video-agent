// sfx-cards.mjs measure --stub <sec>: accepted for a reel with no timings.json,
// rejected with the same messages as render.mjs otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "scripts", "sfx-cards.mjs");

function run(dir, ...args) {
  return spawnSync(process.execPath, [cli, "measure", dir, ...args], { encoding: "utf8" });
}

test("measure --stub: a bad length is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-stub-"));
  const r = run(dir, "--stub", "abc");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--stub takes a length in seconds/);
});

test("measure --stub: refused when voice/timings.json exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-stub-"));
  fs.mkdirSync(path.join(dir, "voice"));
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), "{}");
  const r = run(dir, "--stub", "4");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--stub is for a reel with no voice\/timings\.json/);
});

test("measure --stub: with a valid length it gets past flag checks to the cards file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-stub-"));
  const r = run(dir, "--stub", "4");
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr + r.stdout, /--stub/);
});
