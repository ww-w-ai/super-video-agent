// Per-language picture (render.mjs --no-captions --lang <code>) and the
// --only neighbour probe: Reel.pictureText / Reel.lang, output and cache
// naming, the base-probe reuse decision, neighbour selection, and which
// picture dub.mjs picks. Pure logic: no ffmpeg, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../scripts/lib/cli.mjs";
import { decideLangSegment, neighbourIds } from "../scripts/lib/segments.mjs";
import { pictureUrl, segmentDirFor, pictureStem, picturePayload, isLangCode } from "../scripts/render.mjs";
import { pickPictureFiles } from "../scripts/dub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

// ---- Reel.pictureText / Reel.lang ----------------------------------------

test("pictureText: no injected state returns the fallback and lang is null", () => {
  delete globalThis.__svaPicture;
  assert.equal(Reel.pictureText("brand", "덥덥덥 AI 뉴스"), "덥덥덥 AI 뉴스");
  assert.equal(Reel.lang, null);
});

test("pictureText: a base render (own language, no strings) always returns the fallback", () => {
  globalThis.__svaPicture = { lang: "ko", strings: {} };
  try {
    assert.equal(Reel.pictureText("brand", "덥덥덥 AI 뉴스"), "덥덥덥 AI 뉴스");
    assert.equal(Reel.lang, "ko");
  } finally {
    delete globalThis.__svaPicture;
  }
});

test("pictureText: a language's string wins; a missing or empty key falls back", () => {
  globalThis.__svaPicture = { lang: "en", strings: { brand: "DubDubDub AI News", empty: "" } };
  try {
    assert.equal(Reel.pictureText("brand", "덥덥덥 AI 뉴스"), "DubDubDub AI News");
    assert.equal(Reel.pictureText("other", "기본"), "기본");
    assert.equal(Reel.pictureText("empty", "기본"), "기본");
    assert.equal(Reel.pictureText("toString", "기본"), "기본"); // not an own key
    assert.equal(Reel.lang, "en");
  } finally {
    delete globalThis.__svaPicture;
  }
});

test("pictureTextFrom: pure lookup over a strings object", () => {
  assert.equal(Reel.pictureTextFrom({ a: "x" }, "a", "f"), "x");
  assert.equal(Reel.pictureTextFrom(null, "a", "f"), "f");
  assert.equal(Reel.pictureTextFrom({ a: 3 }, "a", "f"), "f");
});

// ---- render.mjs naming ---------------------------------------------------

test("picturePayload: base render carries the plan's language and no strings; --lang carries overlay.picture", () => {
  assert.deepEqual(picturePayload({ lang: null, basePlan: { meta: { lang: "ko" } }, dubPlan: null }), { lang: "ko", strings: {} });
  assert.deepEqual(picturePayload({ lang: null, basePlan: null, dubPlan: null }), { lang: null, strings: {} });
  const dubPlan = { meta: { lang: "en", overlay: { picture: { brand: "B" }, other: "x" } } };
  assert.deepEqual(picturePayload({ lang: "en", basePlan: { meta: { lang: "ko" } }, dubPlan }), { lang: "en", strings: { brand: "B" } });
  assert.deepEqual(picturePayload({ lang: "en", basePlan: null, dubPlan: { meta: {} } }), { lang: "en", strings: {} });
});

test("language picture naming: segments-<code>/ cache, picture-<code> outputs, base names unchanged", () => {
  assert.equal(segmentDirFor("/r/out", "final", true, "en"), path.join("/r/out", "segments-en", "final-nocap"));
  assert.equal(segmentDirFor("/r/out", "preview", true, "zh-Hans"), path.join("/r/out", "segments-zh-Hans", "preview-nocap"));
  assert.equal(segmentDirFor("/r/out", "final", true), path.join("/r/out", "segments", "final-nocap"));
  assert.equal(segmentDirFor("/r/out", "final", false), path.join("/r/out", "segments", "final"));
  assert.equal(pictureStem("en"), "picture-en");
  assert.equal(pictureStem(), "picture");
  assert.equal(pictureUrl("http://h/", true, "en"), "http://h/?captions=0&lang=en");
  assert.equal(pictureUrl("http://h/", true), "http://h/?captions=0");
  assert.equal(pictureUrl("http://h/", false, "en"), "http://h/");
});

test("--lang: language code check keeps file names safe; flag parses with --no-captions", () => {
  assert.ok(isLangCode("en"));
  assert.ok(isLangCode("zh-Hans"));
  assert.ok(!isLangCode("../x"));
  assert.ok(!isLangCode(true));
  assert.ok(!isLangCode(""));
  const { flags } = parseArgs(["reels/foo", "--no-captions", "--lang", "en"]);
  assert.equal(flags["no-captions"], true);
  assert.equal(flags.lang, "en");
});

// ---- base-probe reuse ------------------------------------------------------

const current = { frameStart: 0, frameEnd: 30, fps: 30, width: 1080, height: 1920, probes: ["a", "b", "c"] };
const same = { ...current };
const other = { ...current, probes: ["a", "X", "c"] };

test("decideLangSegment: the language's own matching segment is reused", () => {
  const d = decideLangSegment({ storedLang: same, storedBase: other, current, langMp4Exists: true, baseMp4Exists: true });
  assert.equal(d.action, "REUSE");
});

test("decideLangSegment: probes equal to the base segment's copy it", () => {
  const d = decideLangSegment({ storedLang: null, storedBase: same, current, langMp4Exists: false, baseMp4Exists: true });
  assert.equal(d.action, "COPY");
});

test("decideLangSegment: differing probes, missing base mp4 or moved range render", () => {
  assert.equal(decideLangSegment({ storedLang: null, storedBase: other, current, langMp4Exists: false, baseMp4Exists: true }).action, "RENDER");
  assert.equal(decideLangSegment({ storedLang: null, storedBase: same, current, langMp4Exists: false, baseMp4Exists: false }).action, "RENDER");
  const moved = { ...same, frameEnd: 31 };
  assert.equal(decideLangSegment({ storedLang: null, storedBase: moved, current, langMp4Exists: false, baseMp4Exists: true }).action, "RENDER");
  assert.equal(decideLangSegment({ storedLang: null, storedBase: null, current, langMp4Exists: false, baseMp4Exists: false }).action, "RENDER");
});

test("decideLangSegment: a stale language segment whose probes changed falls through to the base check", () => {
  const d = decideLangSegment({ storedLang: other, storedBase: same, current, langMp4Exists: true, baseMp4Exists: true });
  assert.equal(d.action, "COPY");
});

// ---- --only neighbours -----------------------------------------------------

const segs = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

test("neighbourIds: the segments right before and after each named one, in timeline order", () => {
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["c"] }), ["b", "d"]);
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["a"] }), ["b"]);
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["e"] }), ["d"]);
});

test("neighbourIds: named segments are not neighbours; duplicates collapse; skipped ids are left out", () => {
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["b", "c"] }), ["a", "d"]);
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["b", "d"] }), ["a", "c", "e"]);
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: ["c"], skipIds: ["d"] }), ["b"]);
  assert.deepEqual(neighbourIds({ segments: segs, onlyIds: [] }), []);
});

// ---- dub.mjs picture selection ---------------------------------------------

test("pickPictureFiles: uses out/picture-<lang>.mp4 when it exists, else the base picture", () => {
  const out = "/r/out";
  const has = (set) => (p) => set.includes(p);
  const base = pickPictureFiles(out, "en", has([]));
  assert.equal(base.source, "base");
  assert.equal(base.pictureMp4, path.join(out, "picture.mp4"));
  assert.equal(base.bedWav, path.join(out, "picture.bed.wav"));
  assert.equal(base.timingsJson, path.join(out, "picture.timings.json"));

  const lang = pickPictureFiles(out, "en", has([path.join(out, "picture-en.mp4")]));
  assert.equal(lang.source, "lang");
  assert.equal(lang.pictureMp4, path.join(out, "picture-en.mp4"));
  assert.equal(lang.bedWav, path.join(out, "picture.bed.wav")); // its own bed missing: base bed, same clock
  assert.equal(lang.timingsJson, path.join(out, "picture.timings.json"));

  const full = pickPictureFiles(out, "en", has(["picture-en.mp4", "picture-en.bed.wav", "picture-en.timings.json"].map((n) => path.join(out, n))));
  assert.equal(full.bedWav, path.join(out, "picture-en.bed.wav"));
  assert.equal(full.timingsJson, path.join(out, "picture-en.timings.json"));

  // another language's picture is never picked
  assert.equal(pickPictureFiles(out, "ja", has([path.join(out, "picture-en.mp4")])).source, "base");
});
