// scripts/assets.mjs `fetch`: copies cued assets from a tiny fake library
// (built with ffmpeg lavfi under os.tmpdir(), never the owner's real
// git-ignored library/) into a scaffolded reel's assets/lib/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchAssets, noLibraryMessage } from "../scripts/assets.mjs";
import { reelPaths, writeJson, readJson } from "../scripts/lib/reeldir.mjs";

function makeFakeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-assetlib-"));
  fs.mkdirSync(path.join(dir, "sfx"));
  fs.mkdirSync(path.join(dir, "reactions"));

  const sfxPath = path.join(dir, "sfx", "stamp.wav");
  execFileSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-ar", "48000", sfxPath],
    { stdio: "ignore" }
  );

  const reactionPath = path.join(dir, "reactions", "laugh.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=10:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=300:duration=1",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      reactionPath,
    ],
    { stdio: "ignore" }
  );

  writeJson(path.join(dir, "catalog.json"), {
    version: 1,
    assets: [
      {
        id: "stamp-1",
        role: "sfx",
        kind: "audio",
        path: "sfx/stamp.wav",
        description: "stamp approve",
        tags: ["stamp"],
        durationSec: 0.5,
        hasAudio: true,
        license: { kind: "royalty-free", commercialSafe: true },
      },
      {
        id: "laugh-1",
        role: "reaction",
        kind: "video",
        path: "reactions/laugh.mp4",
        description: "laugh reaction",
        tags: ["laugh"],
        durationSec: 1,
        width: 320,
        height: 240,
        hasAudio: true,
        license: { kind: "personal-clip", commercialSafe: false },
      },
    ],
  });
  return dir;
}

function makeReelDirWithCues(distribution) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-reel-"));
  const paths = reelPaths(dir);
  writeJson(paths.planJson, {
    meta: { title: "T", fps: 10, voice: { provider: "none" }, ...(distribution ? { distribution } : {}) },
    lines: [
      {
        id: "l1",
        text: "hello world",
        cues: [
          { asset: "stamp-1", at: "start" },
          { asset: "laugh-1", at: "end", play: "both" },
        ],
      },
    ],
  });
  return dir;
}

test("fetchAssets: refuses a non-commercialSafe asset without an override", async () => {
  const prevEnv = process.env.SVA_ASSET_LIB;
  const libDir = makeFakeLibrary();
  process.env.SVA_ASSET_LIB = libDir;
  const reelDir = makeReelDirWithCues();
  const logs = [];
  try {
    await assert.rejects(
      () => fetchAssets({ dir: reelDir, log: (l) => logs.push(l) }),
      /refusing to fetch non-commercialSafe/
    );
    assert.ok(logs.some((l) => l.includes("laugh-1: license")), "license still printed before refusing");
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prevEnv;
  }
});

test("fetchAssets: --allow-personal-scope permits the fetch and writes manifest/cues", async () => {
  const prevEnv = process.env.SVA_ASSET_LIB;
  const libDir = makeFakeLibrary();
  process.env.SVA_ASSET_LIB = libDir;
  const reelDir = makeReelDirWithCues();
  const logs = [];
  try {
    const result = await fetchAssets({ dir: reelDir, allowPersonalScope: true, log: (l) => logs.push(l) });
    assert.equal(result.fetched, 2);
    assert.ok(logs.some((l) => l.includes("stamp-1: license")));
    assert.ok(logs.some((l) => l.includes("laugh-1: license")));

    const paths = reelPaths(reelDir);
    const libRoot = path.join(paths.assetsDir, "lib");
    assert.ok(fs.existsSync(path.join(libRoot, "stamp-1.wav")), "audio copied as-is");

    const manifest = readJson(path.join(libRoot, "manifest.json"));
    assert.equal(manifest.assets["stamp-1"].kind, "audio");
    assert.equal(manifest.assets["stamp-1"].file, "assets/lib/stamp-1.wav");

    const video = manifest.assets["laugh-1"];
    assert.equal(video.kind, "video");
    assert.equal(video.fps, 10);
    // testsrc duration=1 at fps=10 -> ~10 frames.
    assert.ok(video.frameCount >= 8 && video.frameCount <= 12, `frameCount ${video.frameCount} not near 10`);
    assert.ok(video.audio, "hasAudio:true clip should extract its own audio wav");
    assert.ok(fs.existsSync(path.join(paths.root, video.audio)));
    const frameFiles = fs.readdirSync(path.join(paths.root, video.frameDir));
    assert.equal(frameFiles.length, video.frameCount);

    const cues = readJson(path.join(libRoot, "cues.json"));
    assert.equal(cues.cues.length, 2);
    const stampCue = cues.cues.find((c) => c.asset === "stamp-1");
    const laughCue = cues.cues.find((c) => c.asset === "laugh-1");
    assert.equal(stampCue.play, "sound"); // defaulted from role sfx
    assert.equal(laughCue.play, "both"); // explicit in plan.json
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prevEnv;
  }
});

test("fetchAssets: meta.distribution 'personal' also permits non-commercialSafe fetch", async () => {
  const prevEnv = process.env.SVA_ASSET_LIB;
  const libDir = makeFakeLibrary();
  process.env.SVA_ASSET_LIB = libDir;
  const reelDir = makeReelDirWithCues("personal");
  try {
    const result = await fetchAssets({ dir: reelDir });
    assert.equal(result.fetched, 2);
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prevEnv;
  }
});

test("fetchAssets: unknown asset id fails with the id", async () => {
  const prevEnv = process.env.SVA_ASSET_LIB;
  const libDir = makeFakeLibrary();
  process.env.SVA_ASSET_LIB = libDir;
  const reelDir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-reel-"));
  const paths = reelPaths(reelDir);
  writeJson(paths.planJson, {
    meta: { title: "T", voice: { provider: "none" } },
    lines: [{ id: "l1", text: "hi", cues: [{ asset: "nope", at: "start" }] }],
  });
  try {
    await assert.rejects(() => fetchAssets({ dir: reelDir }), /unknown asset id "nope"/);
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prevEnv;
  }
});

test("fetchAssets: no library found -> fetched:0, no throw", async () => {
  const prevEnv = process.env.SVA_ASSET_LIB;
  process.env.SVA_ASSET_LIB = path.join(os.tmpdir(), "sva-no-such-lib-" + Date.now());
  const reelDir = makeReelDirWithCues();
  const logs = [];
  try {
    const result = await fetchAssets({ dir: reelDir, log: (l) => logs.push(l) });
    assert.equal(result.fetched, 0);
    assert.ok(logs.some((l) => l.includes("no library found at")));
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prevEnv;
  }
});

test("noLibraryMessage: says the library is not bundled and how to point SVA_ASSET_LIB at one", () => {
  const bundled = noLibraryMessage("/x/library", {});
  assert.match(bundled, /^no library found at \/x\/library — the asset library is not bundled with the skill\./);
  assert.match(bundled, /SVA_ASSET_LIB=<folder with catalog\.json>/);
  const pointed = noLibraryMessage("/y", { SVA_ASSET_LIB: "/y" });
  assert.match(pointed, /SVA_ASSET_LIB names no folder with catalog\.json/);
});
