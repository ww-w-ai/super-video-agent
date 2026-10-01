// new-reel.mjs --testbed (T23): scaffolds a neutral GLB testbed page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldTestbed, testbedInstallSteps } from "../scripts/new-reel.mjs";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.join(here, "..", "assets", "template", "reel-testbed.html");

test("scaffoldTestbed: page, models.json from *.glb, vendor and out dirs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-testbed-"));
  try {
    const first = scaffoldTestbed({ dir, width: 1080, height: 1920, fps: 30, title: "bed" });
    assert.deepEqual(first, { keptHtml: false, models: [] });
    const html = fs.readFileSync(path.join(dir, "reel.html"), "utf8");
    assert.ok(!html.includes("{{"), "no unresolved placeholders");
    assert.match(html, /const W = 1080, H = 1920, FPS = 30;/);
    assert.match(html, /"three\/addons\/": "\.\/assets\/vendor\/addons\/"/);
    for (const helper of ["function actor(", "function setFace(", "function hold(", "function holdLevel(", "window.__reel"]) {
      assert.ok(html.includes(helper), `missing ${helper}`);
    }
    assert.ok(fs.existsSync(path.join(dir, "assets", "vendor")));
    assert.ok(fs.existsSync(path.join(dir, "out")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "assets", "models", "models.json"), "utf8")), { files: [] });

    // re-run after adding models: keeps an edited page, refreshes the list
    fs.writeFileSync(path.join(dir, "reel.html"), html + "<!-- edited -->");
    fs.writeFileSync(path.join(dir, "assets", "models", "b.glb"), "");
    fs.writeFileSync(path.join(dir, "assets", "models", "A.GLB"), "");
    fs.writeFileSync(path.join(dir, "assets", "models", "notes.txt"), "");
    const second = scaffoldTestbed({ dir, width: 1080, height: 1920, fps: 30, title: "bed" });
    assert.deepEqual(second, { keptHtml: true, models: ["A.GLB", "b.glb"] });
    assert.ok(fs.readFileSync(path.join(dir, "reel.html"), "utf8").endsWith("<!-- edited -->"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("testbed template: neutral, passes the static scan, one canvas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-testbed2-"));
  try {
    scaffoldTestbed({ dir, width: 1080, height: 1920, fps: 30, title: "bed" });
    const scan = scanReelHtml(path.join(dir, "reel.html"));
    assert.equal(scan.sceneFound, true);
    assert.equal(scan.ok, true, JSON.stringify(scan.violations));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const src = fs.readFileSync(template, "utf8");
  // no film-specific names or assets in the shipped template
  for (const word of [/pancake/i, /quaternius/i, /\.hdr\b/, /\/Users\//]) {
    assert.doesNotMatch(src, word);
  }
});

test("testbedInstallSteps: three.js build files and the addons folder", () => {
  const steps = testbedInstallSteps("/r");
  assert.match(steps, /npm install three --prefix \/r/);
  assert.match(steps, /three\.module\.js \/r\/assets\/vendor\//);
  assert.match(steps, /three\.core\.js \/r\/assets\/vendor\//);
  assert.match(steps, /cp -R \/r\/node_modules\/three\/examples\/jsm \/r\/assets\/vendor\/addons/);
  assert.match(steps, /still\.mjs \/r --at 0,1/);
});
