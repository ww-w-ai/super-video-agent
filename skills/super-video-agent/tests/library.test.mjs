// scripts/lib/library.mjs: locate, load, search, getById. Uses a tiny fake
// library under os.tmpdir() — never the owner's real library/ (git-ignored,
// third-party rights).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateLibraryDir, loadLibrary, openLibrary, getById, searchAssets, searchAssetsRanked, isModelAsset } from "../scripts/lib/library.mjs";

function makeFakeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-lib-"));
  const catalog = {
    version: 1,
    assets: [
      {
        id: "stamp-1",
        role: "sfx",
        kind: "audio",
        path: "sfx/stamp-1.wav",
        description: "a rubber stamp slamming down",
        tags: ["stamp", "approve", "office"],
        durationSec: 0.6,
        hasAudio: true,
        license: { kind: "royalty-free", commercialSafe: true },
      },
      {
        id: "laugh-1",
        role: "reaction",
        kind: "video",
        path: "reactions/laugh-1.mp4",
        description: "a person laughing hard, surprised reaction",
        tags: ["laugh", "reaction", "funny"],
        durationSec: 1.4,
        width: 720,
        height: 1280,
        hasAudio: true,
        license: { kind: "personal-clip", commercialSafe: false },
      },
      { id: "bad-entry", role: "sfx" }, // missing required fields — must be dropped
    ],
  };
  fs.mkdirSync(path.join(dir, "sfx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
  return dir;
}

test("locateLibraryDir: SVA_ASSET_LIB overrides the default", () => {
  const overridden = locateLibraryDir({ SVA_ASSET_LIB: "/tmp/somewhere" });
  assert.equal(overridden, "/tmp/somewhere");
  assert.equal(locateLibraryDir({}, "/home/u"), path.join("/home/u", ".super-video-agent", "library"));
  assert.equal(locateLibraryDir({}), path.join(os.homedir(), ".super-video-agent", "library"));
});

test("loadLibrary: an absent default folder is reported as no library and is not created", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sva-home-"));
  try {
    const dir = locateLibraryDir({}, home);
    assert.equal(loadLibrary(dir), null);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadLibrary: missing catalog.json returns null, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-nolib-"));
  assert.equal(loadLibrary(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("openLibrary: missing directory entirely returns null, never throws", () => {
  const lib = openLibrary({ SVA_ASSET_LIB: path.join(os.tmpdir(), "sva-does-not-exist-" + Date.now()) });
  assert.equal(lib, null);
});

test("loadLibrary: drops invalid entries, keeps valid ones", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  assert.equal(lib.assets.length, 2);
  assert.ok(lib.assets.every((a) => a.id !== "bad-entry"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("getById: finds by id, undefined when absent", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  assert.equal(getById(lib, "stamp-1").kind, "audio");
  assert.equal(getById(lib, "nope"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("searchAssets: all: true keeps only assets matching every word (case-insensitive)", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  const hits = searchAssets(lib, "STAMP office", { all: true });
  assert.deepEqual(hits.map((a) => a.id), ["stamp-1"]);
  assert.equal(searchAssets(lib, "stamp nonexistent-token", { all: true }).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("searchAssetsRanked: every-word matches first, then partial matches by words matched", () => {
  const lib = {
    assets: [
      { id: "one-word", role: "sfx", description: "a door", tags: [] },
      { id: "both", role: "sfx", description: "a wooden door creak", tags: ["wood"] },
      { id: "none", role: "sfx", description: "rain", tags: [] },
      { id: "two-of-three", role: "sfx", description: "door creak", tags: [] },
    ],
  };
  const ranked = searchAssetsRanked(lib, "door creak wooden");
  assert.deepEqual(ranked.map((r) => [r.asset.id, r.matched]), [["both", 3], ["two-of-three", 2], ["one-word", 1]]);
  assert.equal(ranked[0].words, 3);
  assert.deepEqual(searchAssets(lib, "door nonexistent").map((a) => a.id), ["one-word", "both", "two-of-three"]);
  assert.equal(searchAssetsRanked(lib, "nothing-here").length, 0);
});

test("searchAssets: --role filters, --limit caps", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  assert.deepEqual(
    searchAssets(lib, "reaction", { role: "reaction" }).map((a) => a.id),
    ["laugh-1"]
  );
  assert.equal(searchAssets(lib, "", { limit: 1 }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("searchAssets: ranks by total token-occurrence count", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  const hits = searchAssets(lib, "reaction");
  assert.equal(hits[0].id, "laugh-1"); // "reaction" appears in both tags and description
  fs.rmSync(dir, { recursive: true, force: true });
});

test("searchAssets: an NFC query finds an NFD label (macOS file names)", () => {
  const lib = { assets: [{ id: "nfd", role: "sfx", description: "효과음 카툰 팝".normalize("NFD"), tags: [] }] };
  assert.deepEqual(searchAssets(lib, "팝".normalize("NFC")).map((a) => a.id), ["nfd"]);
});

const LICENSE = { kind: "own", commercialSafe: true };

function writeCatalog(assets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-modellib-"));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ version: 1, assets }));
  return dir;
}

test("loadLibrary: accepts model, code and image assets with their roles", () => {
  const dir = writeCatalog([
    { id: "m-char", role: "character", kind: "model", path: "models/characters/a.glb", description: "bear", tags: ["bear"], license: LICENSE },
    { id: "m-prop", role: "prop", kind: "model", path: "models/props/b.glb", description: "mug", license: LICENSE },
    { id: "m-set", role: "set", kind: "model", path: "models/sets/c.glb", description: "studio", license: LICENSE },
    { id: "m-code", role: "prop", kind: "code", path: "models/code/d.js", description: "phone", license: LICENSE },
    { id: "m-img", role: "character-ref", kind: "image", path: "models/owner/e.png", description: "face", license: LICENSE },
  ]);
  const lib = loadLibrary(dir);
  assert.deepEqual(lib.assets.map((a) => a.id), ["m-char", "m-prop", "m-set", "m-code", "m-img"]);
  assert.deepEqual(searchAssets(lib, "bear", { role: "character" }).map((a) => a.id), ["m-char"]);
  assert.equal(searchAssets(lib, "", { role: "set" }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadLibrary: role and kind must pair up — sfx stays audio/video, models stay model/code/image", () => {
  const dir = writeCatalog([
    { id: "sfx-model", role: "sfx", kind: "model", path: "x.glb", license: LICENSE },
    { id: "char-audio", role: "character", kind: "audio", path: "x.wav", license: LICENSE },
    { id: "char-video", role: "character", kind: "video", path: "x.mp4", license: LICENSE },
    { id: "ref-model", role: "character-ref", kind: "model", path: "x.glb", license: LICENSE },
    { id: "unknown-role", role: "background", kind: "model", path: "x.glb", license: LICENSE },
    { id: "sfx-ok", role: "sfx", kind: "audio", path: "x.wav", license: LICENSE },
    { id: "no-license", role: "prop", kind: "model", path: "x.glb" },
    { id: "bad-safe", role: "prop", kind: "model", path: "x.glb", license: { kind: "own", commercialSafe: "yes" } },
  ]);
  assert.deepEqual(loadLibrary(dir).assets.map((a) => a.id), ["sfx-ok"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isModelAsset: true for model, image and code kinds only", () => {
  assert.equal(isModelAsset({ kind: "model" }), true);
  assert.equal(isModelAsset({ kind: "image" }), true);
  assert.equal(isModelAsset({ kind: "code" }), true);
  assert.equal(isModelAsset({ kind: "audio" }), false);
  assert.equal(isModelAsset({ kind: "video" }), false);
  assert.equal(isModelAsset(undefined), false);
});
