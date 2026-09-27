// Pure-ish helpers for python-backed voice providers (scripts/lib/pyenv.mjs).
// No real python or spawn here — resolvePythonPath only touches fs.existsSync,
// and parseJsonLinesById is pure string parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePythonPath, parseJsonLinesById } from "../scripts/lib/pyenv.mjs";

test("resolvePythonPath: env var wins over auto-detect path", () => {
  const envVar = "SVA_TEST_PYTHON_ENV_WINS";
  process.env[envVar] = "/env/python";
  try {
    assert.equal(resolvePythonPath(envVar, "/auto/python"), "/env/python");
  } finally {
    delete process.env[envVar];
  }
});

test("resolvePythonPath: falls back to auto-detect path when it exists on disk", () => {
  const envVar = "SVA_TEST_PYTHON_ENV_UNSET";
  delete process.env[envVar];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sva-pyenv-"));
  const fakePython = path.join(tmp, "python");
  fs.writeFileSync(fakePython, "");
  assert.equal(resolvePythonPath(envVar, fakePython), fakePython);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolvePythonPath: null when neither env var nor auto-detect path exist", () => {
  const envVar = "SVA_TEST_PYTHON_NEITHER";
  delete process.env[envVar];
  assert.equal(resolvePythonPath(envVar, "/definitely/not/a/real/path/python"), null);
});

test("parseJsonLinesById: keeps only well-formed {id,...} JSON lines, keyed by id", () => {
  const stdout = [
    '{"id":"l1","wav":"/tmp/l1.wav","durationSec":1.2,"flag":"OK"}',
    "[qwen3_batch] progress line that is not JSON",
    "",
    '{"id":"l2","wav":"/tmp/l2.wav","durationSec":0.4,"flag":"SHORT"}',
    "not json at all {{{",
  ].join("\n");
  const byId = parseJsonLinesById(stdout);
  assert.equal(byId.size, 2);
  assert.equal(byId.get("l1").flag, "OK");
  assert.equal(byId.get("l2").durationSec, 0.4);
});

test("parseJsonLinesById: empty stdout -> empty map, not a crash", () => {
  assert.equal(parseJsonLinesById("").size, 0);
});
