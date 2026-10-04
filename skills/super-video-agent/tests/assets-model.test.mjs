// scripts/assets.mjs `model` and model-aware `search`/`fetch`: a tiny fake
// library under os.tmpdir() (never the owner's real git-ignored library/)
// and a scaffolded reel folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchModel, fetchAssets, searchLine } from "../scripts/assets.mjs";
import { openLibrary, searchAssets } from "../scripts/lib/library.mjs";
import { reelPaths, writeJson } from "../scripts/lib/reeldir.mjs";

const OWN = { kind: "own", commercialSafe: true, note: "made in-house" };
const FREE = { kind: "tripo-free", commercialSafe: false, note: "reference only" };

function makeFakeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-modellib-"));
  for (const sub of ["models/characters", "models/props", "models/owner", "models/code", "models/sets/trees", "sfx"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "models/characters/bear.glb"), "glb-bear");
  fs.writeFileSync(path.join(dir, "models/characters/plush.glb"), "glb-plush");
  fs.writeFileSync(path.join(dir, "models/owner/face.png"), "png-face");
  fs.writeFileSync(path.join(dir, "models/code/phone.js"), "export const phone = 1;");
  fs.writeFileSync(path.join(dir, "sfx/stamp.wav"), "wav");
  const treeDir = path.join(dir, "models/sets/trees");
  fs.writeFileSync(
    path.join(treeDir, "Tree.gltf"),
    JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "Tree.bin" }], images: [{ uri: "Bark.png" }, { uri: "data:image/png;base64,AAAA" }] })
  );
  fs.writeFileSync(path.join(treeDir, "Tree.bin"), "bin");
  fs.writeFileSync(path.join(treeDir, "Bark.png"), "bark");
  fs.writeFileSync(path.join(treeDir, "License_Standard.txt"), "CC0");
  fs.writeFileSync(path.join(treeDir, "Unrelated.png"), "nope");

  writeJson(path.join(dir, "catalog.json"), {
    version: 1,
    assets: [
      { id: "model-char-bear", role: "character", kind: "model", path: "models/characters/bear.glb", description: "곰 bear 캐릭터", tags: ["bear", "곰"], format: "glb", rigged: true, clips: [{ name: "Idle", sec: 2 }, { name: "Wave", sec: 1 }], triangles: 100, license: OWN },
      { id: "model-char-plush", role: "character", kind: "model", path: "models/characters/plush.glb", description: "plush cat", tags: ["cat"], format: "glb", rigged: false, clips: [], license: FREE },
      { id: "model-owner-face", role: "character-ref", kind: "image", path: "models/owner/face.png", description: "owner face", tags: ["owner"], license: OWN },
      { id: "model-code-phone", role: "prop", kind: "code", path: "models/code/phone.js", description: "phone module", tags: ["phone"], license: OWN },
      { id: "model-set-tree", role: "set", kind: "model", path: "models/sets/trees/Tree.gltf", description: "tree", tags: ["tree"], format: "gltf", rigged: false, clips: [], license: OWN },
      { id: "sfx-stamp", role: "sfx", kind: "audio", path: "sfx/stamp.wav", description: "stamp", tags: ["stamp"], durationSec: 0.5, hasAudio: true, license: OWN },
    ],
  });
  return dir;
}

function makeReel(distribution) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-reel-"));
  writeJson(reelPaths(dir).planJson, {
    meta: { title: "T", voice: { provider: "none" }, ...(distribution ? { distribution } : {}) },
    lines: [{ id: "l1", text: "hi" }],
  });
  return dir;
}

/** Runs `fn` with SVA_ASSET_LIB pointing at a fresh fake library and a fresh reel; cleans up. */
async function withFixture(distribution, fn) {
  const prev = process.env.SVA_ASSET_LIB;
  const libDir = makeFakeLibrary();
  const reelDir = makeReel(distribution);
  process.env.SVA_ASSET_LIB = libDir;
  try {
    await fn({ libDir, reelDir, assets: reelPaths(reelDir).assetsDir });
  } finally {
    fs.rmSync(libDir, { recursive: true, force: true });
    fs.rmSync(reelDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prev;
  }
}

test("fetchModel: copies a GLB into assets/models/<id>/ and prints its licence", async () => {
  await withFixture(undefined, async ({ reelDir, assets }) => {
    const logs = [];
    const r = await fetchModel({ id: "model-char-bear", dir: reelDir, log: (l) => logs.push(l) });
    assert.equal(r.fetched, 1);
    assert.equal(r.file, "assets/models/model-char-bear/bear.glb");
    assert.ok(logs.some((l) => l.includes("assets/models/model-char-bear/bear.glb")));
    assert.equal(fs.readFileSync(path.join(assets, "models", "model-char-bear", "bear.glb"), "utf8"), "glb-bear");
    assert.ok(logs.some((l) => l.includes("model-char-bear: license own (commercialSafe=true)")));
    assert.ok(logs.some((l) => l.includes("made in-house")));
  });
});

test("fetchModel: an image goes to assets/refs/, code to assets/models/", async () => {
  await withFixture(undefined, async ({ reelDir, assets }) => {
    await fetchModel({ id: "model-owner-face", dir: reelDir });
    await fetchModel({ id: "model-code-phone", dir: reelDir });
    assert.ok(fs.existsSync(path.join(assets, "refs", "model-owner-face", "face.png")));
    assert.ok(fs.existsSync(path.join(assets, "models", "model-code-phone", "phone.js")));
    assert.ok(!hasFileNamed(path.join(assets, "models"), "face.png"));
  });
});

test("fetchModel: a .gltf brings its .bin, textures and licence file, not its neighbours", async () => {
  await withFixture(undefined, async ({ reelDir, assets }) => {
    const r = await fetchModel({ id: "model-set-tree", dir: reelDir });
    const got = fs.readdirSync(path.join(assets, "models", "model-set-tree")).sort();
    assert.deepEqual(got, ["Bark.png", "License_Standard.txt", "Tree.bin", "Tree.gltf"]);
    assert.equal(r.files.length, 4);
  });
});

test("fetchModel: refuses a non-commercialSafe model unless the reel is personal or the flag is passed", async () => {
  await withFixture(undefined, async ({ reelDir, assets }) => {
    const logs = [];
    await assert.rejects(
      () => fetchModel({ id: "model-char-plush", dir: reelDir, log: (l) => logs.push(l) }),
      /refusing to fetch non-commercialSafe asset/
    );
    assert.ok(logs.some((l) => l.includes("model-char-plush: license tripo-free (commercialSafe=false)")), "licence printed before refusing");
    assert.ok(!hasFileNamed(path.join(assets, "models"), "plush.glb"), "nothing copied");

    const r = await fetchModel({ id: "model-char-plush", dir: reelDir, allowPersonalScope: true });
    assert.equal(r.fetched, 1);
  });
  await withFixture("personal", async ({ reelDir, assets }) => {
    await fetchModel({ id: "model-char-plush", dir: reelDir });
    assert.ok(fs.existsSync(path.join(assets, "models", "model-char-plush", "plush.glb")));
  });
});

test("fetchModel: unknown id and clip ids fail with a clear message", async () => {
  await withFixture(undefined, async ({ reelDir }) => {
    await assert.rejects(() => fetchModel({ id: "nope", dir: reelDir }), /unknown asset id "nope"/);
    await assert.rejects(() => fetchModel({ id: "sfx-stamp", dir: reelDir }), /is a clip \(kind audio\), not a model/);
  });
});

test("fetchModel: no library found -> fetched:0, no throw", async () => {
  const prev = process.env.SVA_ASSET_LIB;
  process.env.SVA_ASSET_LIB = path.join(os.tmpdir(), "sva-no-such-lib-" + Date.now());
  const reelDir = makeReel();
  const logs = [];
  try {
    const r = await fetchModel({ id: "model-char-bear", dir: reelDir, log: (l) => logs.push(l) });
    assert.equal(r.fetched, 0);
    assert.ok(logs.some((l) => l.includes("no library found at")));
  } finally {
    fs.rmSync(reelDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SVA_ASSET_LIB;
    else process.env.SVA_ASSET_LIB = prev;
  }
});

test("fetchAssets: a cue that names a model id is refused and points at `model`", async () => {
  await withFixture(undefined, async ({ reelDir }) => {
    writeJson(reelPaths(reelDir).planJson, {
      meta: { title: "T", voice: { provider: "none" } },
      lines: [{ id: "l1", text: "hi", cues: [{ asset: "model-char-bear", at: "start" }] }],
    });
    await assert.rejects(() => fetchAssets({ dir: reelDir }), /assets\.mjs model model-char-bear/);
  });
});

test("search: --role character finds models only, and the line shows rigged, clips and licence", async () => {
  await withFixture(undefined, async () => {
    const lib = openLibrary();
    const hits = searchAssets(lib, "", { role: "character" });
    assert.deepEqual(hits.map((a) => a.id), ["model-char-bear", "model-char-plush"]);
    const line = searchLine(hits[0]);
    assert.match(line, /^model-char-bear {2}\[character\/model\] {2}rigged=true clips=Idle,Wave {2}license:own\(commercialSafe=true\)/);
    assert.match(searchLine(hits[1]), /rigged=false clips=none {2}license:tripo-free\(commercialSafe=false\)/);
    assert.match(searchLine(lib.assets.find((a) => a.id === "sfx-stamp")), /\[sfx\] {2}0\.50s/);
    assert.match(searchLine(lib.assets.find((a) => a.id === "model-owner-face")), /\[character-ref\/image\] {2}license:own/);
  });
});

/** Adds a catalog model whose .gltf names `uris` as its buffers; returns its id. */
function addGltf(libDir, name, uris) {
  const rel = `models/sets/trees/${name}.gltf`;
  fs.writeFileSync(path.join(libDir, rel), JSON.stringify({ asset: { version: "2.0" }, buffers: uris.map((uri) => ({ uri })) }));
  const catalogPath = path.join(libDir, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const id = `model-set-${name}`;
  catalog.assets.push({ id, role: "set", kind: "model", path: rel, description: name, tags: [name], format: "gltf", rigged: false, clips: [], license: OWN });
  writeJson(catalogPath, catalog);
  return id;
}

/** True when any file under `root` has the given basename. */
function hasFileNamed(root, base) {
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root, { recursive: true }).some((f) => path.basename(String(f)) === base);
}

test("fetchModel: a gltf uri with ../ is refused and nothing leaves the library", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    fs.writeFileSync(path.join(libDir, "models/sets/secret.bin"), "secret");
    const id = addGltf(libDir, "up", ["../secret.bin"]);
    await assert.rejects(() => fetchModel({ id, dir: reelDir }), /glTF uri "\.\.\/secret\.bin"/);
    assert.ok(!hasFileNamed(assets, "secret.bin"));
    assert.ok(!hasFileNamed(assets, "up.gltf"), "nothing is copied when any uri is bad");
  });
});

test("fetchModel: an absolute gltf uri is refused", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    const outside = path.join(os.tmpdir(), "sva-abs-secret.bin");
    fs.writeFileSync(outside, "secret");
    try {
      const id = addGltf(libDir, "abs", [outside]);
      await assert.rejects(() => fetchModel({ id, dir: reelDir }), /absolute or leaves the asset folder/);
      assert.ok(!hasFileNamed(assets, "sva-abs-secret.bin"));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("fetchModel: an encoded %2e%2e/ gltf uri is refused", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    fs.writeFileSync(path.join(libDir, "models/sets/secret.bin"), "secret");
    const id = addGltf(libDir, "enc", ["%2e%2e/secret.bin"]);
    await assert.rejects(() => fetchModel({ id, dir: reelDir }), /glTF uri "%2e%2e\/secret\.bin"/);
    assert.ok(!hasFileNamed(assets, "secret.bin"));
  });
});

test("fetchModel: a valid textures/x.png uri is copied into the same subfolder", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    fs.mkdirSync(path.join(libDir, "models/sets/trees/textures"), { recursive: true });
    fs.writeFileSync(path.join(libDir, "models/sets/trees/textures/x.png"), "tex");
    const id = addGltf(libDir, "sub", ["textures/x.png"]);
    const r = await fetchModel({ id, dir: reelDir });
    assert.equal(fs.readFileSync(path.join(assets, "models", id, "textures", "x.png"), "utf8"), "tex");
    assert.ok(r.files.includes(`assets/models/${id}/textures/x.png`));
  });
});

test("fetchModel: a percent-encoded space in a valid uri is decoded to the real file name", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    fs.writeFileSync(path.join(libDir, "models/sets/trees/my tex.png"), "tex");
    const id = addGltf(libDir, "space", ["my%20tex.png"]);
    await fetchModel({ id, dir: reelDir });
    assert.ok(fs.existsSync(path.join(assets, "models", id, "my tex.png")));
  });
});

/** Makes a file or directory symlink at `link` pointing to `target`. */
function symlink(target, link) {
  fs.symlinkSync(target, link);
}

/** A file outside the library, removed by the caller's cleanup. */
function makeOutsideSecret() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-outside-"));
  fs.writeFileSync(path.join(dir, "secret.bin"), "secret");
  fs.writeFileSync(path.join(dir, "License_Stolen.txt"), "stolen");
  return dir;
}

test("fetchModel: a file symlink among the companions is refused and nothing is copied", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    const outside = makeOutsideSecret();
    try {
      const treeDir = path.join(libDir, "models/sets/trees");
      symlink(path.join(outside, "secret.bin"), path.join(treeDir, "link.bin"));
      const id = addGltf(libDir, "flink", ["link.bin"]);
      await assert.rejects(() => fetchModel({ id, dir: reelDir }), /outside the library folder/);
      assert.ok(!hasFileNamed(assets, "link.bin") && !hasFileNamed(assets, "flink.gltf"));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("fetchModel: a directory symlink among the companions is refused and nothing is copied", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    const outside = makeOutsideSecret();
    try {
      symlink(outside, path.join(libDir, "models/sets/trees/linked"));
      const id = addGltf(libDir, "dlink", ["linked/secret.bin"]);
      await assert.rejects(() => fetchModel({ id, dir: reelDir }), /outside the library folder/);
      assert.ok(!hasFileNamed(assets, "secret.bin") && !hasFileNamed(assets, "dlink.gltf"));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("fetchModel: a license*.txt symlink to a file outside the library is refused", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    const outside = makeOutsideSecret();
    try {
      symlink(path.join(outside, "License_Stolen.txt"), path.join(libDir, "models/sets/trees/License_Link.txt"));
      await assert.rejects(() => fetchModel({ id: "model-set-tree", dir: reelDir }), /outside the library folder/);
      assert.ok(!hasFileNamed(assets, "License_Link.txt") && !hasFileNamed(assets, "Tree.gltf"));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("fetchModel: a symlink that stays inside the library is still copied", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    symlink(path.join(libDir, "models/characters/bear.glb"), path.join(libDir, "models/characters/bear-alias.glb"));
    const catalogPath = path.join(libDir, "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.assets.push({ id: "model-alias", role: "character", kind: "model", path: "models/characters/bear-alias.glb", description: "alias", tags: [], format: "glb", rigged: false, clips: [], license: OWN });
    writeJson(catalogPath, catalog);
    await fetchModel({ id: "model-alias", dir: reelDir });
    assert.equal(fs.readFileSync(path.join(assets, "models", "model-alias", "bear-alias.glb"), "utf8"), "glb-bear");
  });
});

test("catalogue path ../ is refused by model and by fetch, naming the asset id", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    fs.writeFileSync(path.join(path.dirname(libDir), "sva-secret-x.txt"), "secret");
    const catalogPath = path.join(libDir, "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const rel = `../sva-secret-x.txt`;
    catalog.assets.push({ id: "model-escape", role: "prop", kind: "code", path: rel, description: "escape", tags: [], license: OWN });
    catalog.assets.push({ id: "sfx-escape", role: "sfx", kind: "audio", path: rel, description: "escape", tags: [], durationSec: 1, hasAudio: true, license: OWN });
    writeJson(catalogPath, catalog);
    try {
      await assert.rejects(() => fetchModel({ id: "model-escape", dir: reelDir }), /asset "model-escape" resolves outside the library/);
      writeJson(reelPaths(reelDir).planJson, {
        meta: { title: "T", voice: { provider: "none" } },
        lines: [{ id: "l1", text: "hi", cues: [{ asset: "sfx-escape", at: "start" }] }],
      });
      await assert.rejects(() => fetchAssets({ dir: reelDir }), /asset "sfx-escape" resolves outside the library/);
      assert.ok(!hasFileNamed(assets, "sva-secret-x.txt") && !hasFileNamed(assets, "sfx-escape.txt"));
    } finally {
      fs.rmSync(path.join(path.dirname(libDir), "sva-secret-x.txt"), { force: true });
    }
  });
});

test("fetchModel: two models with the same scene.gltf/scene.bin names both survive", async () => {
  await withFixture(undefined, async ({ libDir, reelDir, assets }) => {
    const catalogPath = path.join(libDir, "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    for (const n of ["a", "b"]) {
      const sub = path.join(libDir, "models/pack-" + n);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "scene.gltf"), JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "scene.bin" }] }));
      fs.writeFileSync(path.join(sub, "scene.bin"), "bin-" + n);
      catalog.assets.push({ id: `model-pack-${n}`, role: "prop", kind: "model", path: `models/pack-${n}/scene.gltf`, description: n, tags: [n], format: "gltf", rigged: false, clips: [], license: OWN });
    }
    writeJson(catalogPath, catalog);
    await fetchModel({ id: "model-pack-a", dir: reelDir });
    await fetchModel({ id: "model-pack-b", dir: reelDir });
    assert.equal(fs.readFileSync(path.join(assets, "models", "model-pack-a", "scene.bin"), "utf8"), "bin-a");
    assert.equal(fs.readFileSync(path.join(assets, "models", "model-pack-b", "scene.bin"), "utf8"), "bin-b");
    assert.ok(fs.existsSync(path.join(assets, "models", "model-pack-a", "scene.gltf")));
    assert.ok(fs.existsSync(path.join(assets, "models", "model-pack-b", "scene.gltf")));
  });
});
