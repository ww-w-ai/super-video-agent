// three.js r186 deprecated PCFSoftShadowMap (it warns and uses PCFShadowMap): the
// scaffold and the example testbed set the current constant.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

for (const rel of [
  "assets/template/reel-testbed.html",
  "assets/template/reel-3d.html",
  "examples/3d-round-plush-cast/testbed/reel.html",
]) {
  test(`${rel} does not use the deprecated PCFSoftShadowMap`, () => {
    const html = fs.readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(html, /PCFSoftShadowMap/);
    if (/shadowMap\.type/.test(html)) assert.match(html, /shadowMap\.type = THREE\.PCFShadowMap;/);
  });
}
