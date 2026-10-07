import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickPictureFiles, sceneSpanVerdict, sceneSpanNote, requireMatchedPair } from "../scripts/dub.mjs";
import { parseArgs } from "../scripts/lib/cli.mjs";

const scene = { spans: [{ start: 0, end: 8, in: "scene" }], lang: "en", baseLang: "ko", pictureSource: "base", dir: "/reel" };

test("cross-language scene guard stays on by default and only explicit opt-in bypasses it", () => {
  assert.match(sceneSpanVerdict(scene), /Render this language's picture first/);
  assert.equal(sceneSpanVerdict({ ...scene, keepBasePictureText: true }), null);
  assert.match(sceneSpanVerdict({ ...scene, keepBasePictureText: "true" }), /Render/);
  assert.equal(sceneSpanVerdict({ ...scene, pictureSource: "lang" }), null);
  assert.match(sceneSpanNote({ ...scene, keepBasePictureText: true }), /intentionally retained.*ko.*en/);
});

test("explicit reuse selects every base pair file even when a language picture exists", () => {
  const normal = pickPictureFiles("/reel/out", "en", () => true);
  assert.equal(normal.source, "lang");
  const reuse = pickPictureFiles("/reel/out", "en", () => true, true);
  assert.deepEqual(reuse, { source: "base", pictureMp4: "/reel/out/picture.mp4", bedWav: "/reel/out/picture.bed.wav", timingsJson: "/reel/out/picture.timings.json" });
  assert.equal(parseArgs(["/reel", "--lang", "en", "--keep-base-picture-text"]).flags["keep-base-picture-text"], true);
});

test("the selected base pair still runs the real pair guard", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-retain-picture-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outDir, "picture.mp4"), "fixture");
  fs.writeFileSync(path.join(outDir, "picture-en.mp4"), "fixture");
  const picked = pickPictureFiles(outDir, "en", fs.existsSync, true);
  await assert.rejects(requireMatchedPair({ outDir, picked, lang: "en" }), /not one render.*missing.*picture.bed.wav/);
});
