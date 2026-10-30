import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmBinary, spawnSpec } from "../scripts/setup.mjs";
import { pointLatest } from "../scripts/render.mjs";

test("npmBinary resolves the .cmd shim on win32 only", () => {
  assert.equal(npmBinary("win32"), "npm.cmd");
  assert.equal(npmBinary("darwin"), "npm");
  assert.equal(npmBinary("linux"), "npm");
});

test("spawnSpec: a .cmd shim runs through a shell as one command line, space-bearing args quoted (Node refuses .cmd without a shell)", () => {
  const spec = spawnSpec("npm.cmd", ["ci", "--omit=dev", "--prefix", "C:\\Users\\A B\\skill"]);
  assert.equal(spec.shell, true);
  assert.equal(spec.command, 'npm.cmd ci --omit=dev --prefix "C:\\Users\\A B\\skill"');
  assert.deepEqual(spec.args, []);
});

test("spawnSpec: a bare command spawns directly with no shell and untouched args (POSIX path unchanged)", () => {
  const spec = spawnSpec("npm", ["ci", "--omit=dev", "--prefix", "/home/a b/skill"]);
  assert.equal(spec.shell, false);
  assert.equal(spec.command, "npm");
  assert.deepEqual(spec.args, ["ci", "--omit=dev", "--prefix", "/home/a b/skill"]);
});

function withSymlinkDenied(fn) {
  const real = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  try {
    return fn();
  } finally {
    fs.symlinkSync = real;
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-latest-"));
  const stamped = path.join(dir, "final-20260101-000000.mp4");
  fs.writeFileSync(stamped, "video-bytes");
  return { dir, stamped };
}

test("pointLatest uses a symlink when the platform allows it", () => {
  const { dir, stamped } = setup();
  const out = pointLatest(dir, "final.mp4", stamped);
  assert.ok(fs.lstatSync(out).isSymbolicLink());
  assert.equal(fs.readFileSync(out, "utf8"), "video-bytes");
});

test("pointLatest falls back to a hard link when symlink is denied", () => {
  const { dir, stamped } = setup();
  const out = withSymlinkDenied(() => pointLatest(dir, "final.mp4", stamped));
  assert.ok(!fs.lstatSync(out).isSymbolicLink());
  assert.equal(fs.statSync(out).ino, fs.statSync(stamped).ino);
  assert.equal(fs.readFileSync(out, "utf8"), "video-bytes");
});

test("pointLatest falls back to a copy when symlink and hard link both fail", () => {
  const { dir, stamped } = setup();
  const realLink = fs.linkSync;
  fs.linkSync = () => {
    throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  };
  try {
    const out = withSymlinkDenied(() => pointLatest(dir, "final.mp4", stamped));
    assert.notEqual(fs.statSync(out).ino, fs.statSync(stamped).ino);
    assert.equal(fs.readFileSync(out, "utf8"), "video-bytes");
  } finally {
    fs.linkSync = realLink;
  }
});

test("a repeat render after a hard-link fallback keeps the previous file under its stamp", () => {
  const { dir, stamped } = setup();
  withSymlinkDenied(() => pointLatest(dir, "final.mp4", stamped));
  const next = path.join(dir, "final-20260102-000000.mp4");
  fs.writeFileSync(next, "newer");
  const out = withSymlinkDenied(() => pointLatest(dir, "final.mp4", next));
  assert.equal(fs.readFileSync(out, "utf8"), "newer");
  assert.equal(fs.readFileSync(stamped, "utf8"), "video-bytes");
  // The hard-link pointer is replaced, not moved aside as a misdated duplicate.
  assert.deepEqual(fs.readdirSync(dir).sort(), ["final-20260101-000000.mp4", "final-20260102-000000.mp4", "final.mp4"]);
});

test("a plain file moved aside never overwrites a render whose stamp equals its mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-latest-"));
  const legacy = path.join(dir, "final.mp4");
  fs.writeFileSync(legacy, "old");
  const when = new Date(2026, 0, 2, 0, 0, 0);
  fs.utimesSync(legacy, when, when);
  const stamped = path.join(dir, "final-20260102-000000.mp4");
  fs.writeFileSync(stamped, "new");
  const out = pointLatest(dir, "final.mp4", stamped);
  assert.equal(fs.readFileSync(out, "utf8"), "new");
  assert.equal(fs.readFileSync(stamped, "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(dir, "final-20260102-000000-2.mp4"), "utf8"), "old");
});
