// A language segment is reused only while the base segment .mp4 it was made
// from is unchanged (size + mtime recorded as `base` in its .json). Pure
// decision logic, the stamp writer, a source scan of the language-dir
// writers, and the --help sentence. No ffmpeg, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { baseStampMatches, decideLangSegment, decideLangUnprobed } from "../scripts/lib/segments.mjs";
import { baseStampOf, withBaseStamp } from "../scripts/render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderPath = path.join(here, "..", "scripts", "render.mjs");

const STAMP = { size: 1000, mtimeMs: 1700000000000 };
const current = { frameStart: 0, frameEnd: 30, fps: 30, width: 640, height: 360, probes: ["a", "b", "c"] };
const shape = { frameStart: 0, frameEnd: 30, fps: 30, width: 640, height: 360 };

// ---- baseStampMatches ------------------------------------------------------

test("baseStampMatches: caller did not stat (baseNow undefined) → ok", () => {
  assert.deepEqual(baseStampMatches({ base: STAMP }, undefined), { ok: true, reason: "" });
  assert.equal(baseStampMatches({}, undefined).ok, true);
});

test("baseStampMatches: legacy .json without base", () => {
  assert.equal(baseStampMatches({}, null).ok, true);
  assert.deepEqual(baseStampMatches({}, STAMP), { ok: false, reason: "no record of the base segment this language's segment was made from" });
});

test("baseStampMatches: recorded base null (no base .mp4 then)", () => {
  assert.equal(baseStampMatches({ base: null }, null).ok, true);
  assert.deepEqual(baseStampMatches({ base: null }, STAMP), { ok: false, reason: "the base segment exists now but did not when this language's segment was made" });
});

test("baseStampMatches: recorded base, base .mp4 gone now", () => {
  assert.deepEqual(baseStampMatches({ base: STAMP }, null), { ok: false, reason: "the base segment this language's segment was made from is gone" });
});

test("baseStampMatches: size or mtime differ", () => {
  const reason = "the base segment changed since this language's segment was made (size/mtime differ)";
  assert.deepEqual(baseStampMatches({ base: STAMP }, { ...STAMP, size: 1001 }), { ok: false, reason });
  assert.deepEqual(baseStampMatches({ base: STAMP }, { ...STAMP, mtimeMs: STAMP.mtimeMs + 1 }), { ok: false, reason });
});

test("baseStampMatches: same size and mtime → ok", () => {
  assert.equal(baseStampMatches({ base: { ...STAMP } }, { ...STAMP }).ok, true);
});

// ---- decideLangSegment -----------------------------------------------------

test("decideLangSegment: own probes match but base stamp changed, base probes equal → COPY", () => {
  const d = decideLangSegment({
    storedLang: { ...current, base: STAMP },
    storedBase: { ...current },
    current,
    langMp4Exists: true,
    baseMp4Exists: true,
    baseNow: { ...STAMP, mtimeMs: STAMP.mtimeMs + 5000 },
  });
  assert.equal(d.action, "COPY");
});

test("decideLangSegment: own probes match, base stamp changed, base probes differ → RENDER with the stamp reason", () => {
  const d = decideLangSegment({
    storedLang: { ...current, base: STAMP },
    storedBase: { ...current, probes: ["x", "b", "c"] },
    current,
    langMp4Exists: true,
    baseMp4Exists: true,
    baseNow: { ...STAMP, size: 2000 },
  });
  assert.equal(d.action, "RENDER");
  assert.equal(d.reason, "the base segment changed since this language's segment was made (size/mtime differ)");
});

test("decideLangSegment: same stamp → REUSE (control)", () => {
  const d = decideLangSegment({
    storedLang: { ...current, base: STAMP },
    storedBase: { ...current },
    current,
    langMp4Exists: true,
    baseMp4Exists: true,
    baseNow: { ...STAMP },
  });
  assert.equal(d.action, "REUSE");
});

test("decideLangSegment: legacy .json without base while the base .mp4 exists → not REUSE", () => {
  const d = decideLangSegment({
    storedLang: { ...current },
    storedBase: { ...current },
    current,
    langMp4Exists: true,
    baseMp4Exists: true,
    baseNow: { ...STAMP },
  });
  assert.notEqual(d.action, "REUSE");
  assert.equal(d.action, "COPY");
});

// ---- decideLangUnprobed ----------------------------------------------------

test("decideLangUnprobed: language copy current by probes, base stamp changed → COPY, not REUSE", () => {
  const storedBase = { ...current, picture: { keys: [], lang: false, all: false } };
  const args = {
    storedBase,
    storedLang: { ...current, base: STAMP },
    current: shape,
    strings: {},
    baseMp4Exists: true,
    langMp4Exists: true,
  };
  const stale = decideLangUnprobed({ ...args, baseNow: { ...STAMP, size: 999 } });
  assert.ok(stale);
  assert.equal(stale.action, "COPY");
  const fresh = decideLangUnprobed({ ...args, baseNow: { ...STAMP } });
  assert.equal(fresh.action, "REUSE");
});

// ---- baseStampOf / withBaseStamp -------------------------------------------

test("withBaseStamp: records the base .mp4's size and mtime, null when missing, nothing for a base render", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k5-base-"));
  try {
    fs.writeFileSync(path.join(dir, "C1.mp4"), Buffer.alloc(1234));
    const st = fs.statSync(path.join(dir, "C1.mp4"));
    const meta = { frameStart: 0, frameEnd: 30 };
    const withStamp = withBaseStamp(meta, dir, "C1");
    assert.deepEqual(withStamp.base, { size: st.size, mtimeMs: st.mtimeMs });
    assert.equal(withStamp.frameEnd, 30);
    assert.deepEqual(baseStampOf(dir, "C1"), { size: 1234, mtimeMs: st.mtimeMs });
    const missing = withBaseStamp(meta, dir, "C2");
    assert.ok(Object.prototype.hasOwnProperty.call(missing, "base"));
    assert.equal(missing.base, null);
    const baseRender = withBaseStamp(meta, null, "C1");
    assert.equal(Object.prototype.hasOwnProperty.call(baseRender, "base"), false);
    assert.equal(baseRender, meta);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- writer gate: every language-dir writer stamps the base ------------------

function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in render.mjs`);
  const next = src.indexOf("\nfunction ", start + 1);
  const nextAsync = src.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter((i) => i > 0);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("writer gate: each language-dir segment writer wraps its writeJson in withBaseStamp", () => {
  const src = fs.readFileSync(renderPath, "utf8");
  for (const name of ["copyBaseSegments", "renderNeeded", "rebuildSegmentSpan"]) {
    const body = functionBody(src, name);
    const writes = body.split("\n").filter((l) => l.includes("writeJson("));
    assert.ok(writes.length >= 1, `${name} has no writeJson call`);
    for (const line of writes) assert.match(line, /writeJson\(.*?,\s*withBaseStamp\(/, `${name}: ${line.trim()}`);
  }
});

test("decision gate: both language decisions receive baseNow from baseStampOf", () => {
  const src = fs.readFileSync(renderPath, "utf8");
  for (const name of ["decideWithoutPage", "decideOne"]) {
    assert.match(functionBody(src, name), /baseNow:\s*baseStampOf\(baseSegDir,\s*segment\.id\)/, name);
  }
});

// ---- --help ---------------------------------------------------------------

test("render.mjs --help states the base-stamp reuse rule", () => {
  const out = execFileSync(process.execPath, [renderPath, "--help"], { encoding: "utf8" }).replace(/\s+/g, " ");
  assert.ok(out.includes("A language segment is reused only while the base segment file it was made from is unchanged"), "help sentence missing");
});
