// scripts/lib/library.mjs: locate, load, search, getById. Uses a tiny fake
// library under os.tmpdir() — never the owner's real library/ (git-ignored,
// third-party rights).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateLibraryDir, loadLibrary, openLibrary, getById, searchAssets } from "../scripts/lib/library.mjs";

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
  const fallback = locateLibraryDir({});
  assert.ok(fallback.endsWith(path.join("super-video-agent", "library")) || fallback.endsWith("library"));
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

test("searchAssets: every query token must match description or tags (case-insensitive)", () => {
  const dir = makeFakeLibrary();
  const lib = loadLibrary(dir);
  const hits = searchAssets(lib, "STAMP office");
  assert.deepEqual(hits.map((a) => a.id), ["stamp-1"]);
  assert.equal(searchAssets(lib, "stamp nonexistent-token").length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
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
