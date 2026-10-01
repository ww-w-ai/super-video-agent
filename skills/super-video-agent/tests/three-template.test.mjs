// 3D scaffold defects found by real films: the import map and vendor copy
// (new-reel --3d / --vendor), the monotone camera track, first-seek
// determinism (decode, bounding spheres, draw order, culling), typed-array
// SFX, and skipping the 3D scene outside its windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, findThree, installThreeVendor, threeInstallSteps } from "../scripts/new-reel.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { openReel } from "../scripts/lib/browser.mjs";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(here, "..");
await import(path.join(SKILL, "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const hasBrowser = fs.existsSync(path.join(SKILL, "node_modules", "playwright-core", "index.mjs"));
const noBrowser = !hasBrowser && "playwright-core not installed";
// three.js is never bundled: SVA_THREE_BUILD points at an installed three/build folder.
const THREE_DIRS = [process.env.SVA_THREE_BUILD, path.join(SKILL, "node_modules", "three", "build")].filter(Boolean);
const threeBuild = THREE_DIRS.find((d) => fs.existsSync(path.join(d, "three.module.js")));
const noThree = noBrowser || (!threeBuild && "three.js not installed (set SVA_THREE_BUILD)");

const TIMINGS = {
  duration: 3,
  lines: [
    { id: "l1", text: "안녕 하세요", start: 0.4, end: 1.4 },
    { id: "l2", text: "두 번째 줄", start: 1.8, end: 2.6 },
  ],
};

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeReel(threeD) {
  const dir = tmp("sva-3dt-");
  await scaffold({ dir, width: 216, height: 384, fps: 10, title: "T", ratio: "9:16", threeD });
  fs.writeFileSync(path.join(dir, "voice", "timings.json"), JSON.stringify(TIMINGS));
  // A three package next to the skill would have been copied; these tests set vendor/ themselves.
  fs.rmSync(path.join(dir, "assets", "vendor"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets", "vendor"));
  return dir;
}

async function withPage(dir, fn, query = "") {
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url.replace(/\/$/, "") + "/reel.html" + query, { width: 216, height: 384 });
    try {
      return await fn(s.page, s);
    } finally {
      await s.close();
    }
  } finally {
    await server.close();
  }
}

function fakeThree() {
  const root = tmp("sva-fake-three-");
  fs.mkdirSync(path.join(root, "build"));
  fs.mkdirSync(path.join(root, "examples", "jsm", "loaders"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "three.module.js"), "export const REVISION = 'x';\n");
  fs.writeFileSync(path.join(root, "build", "three.core.js"), "\n");
  fs.writeFileSync(path.join(root, "examples", "jsm", "loaders", "GLTFLoader.js"), "export class GLTFLoader {}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "three", version: "0.999.0" }));
  return root;
}

// ---- defect 1: import map + vendor -------------------------------------

test("3D scaffold: the import map is live, before the scene module", async () => {
  const dir = await makeReel(true);
  try {
    const html = fs.readFileSync(path.join(dir, "reel.html"), "utf8");
    const map = html.indexOf('<script type="importmap">');
    assert.ok(map > 0, "import map present");
    const before = html.slice(0, map);
    assert.ok(before.lastIndexOf("<!--") < before.lastIndexOf("-->"), "import map is not inside a comment");
    assert.ok(map < html.indexOf('<script type="module">'), "import map comes before the module script");
    assert.match(html, /"three\/addons\/": "\.\/assets\/vendor\/addons\/"/);
    const scan = scanReelHtml(path.join(dir, "reel.html"));
    assert.equal(scan.ok, true, JSON.stringify(scan.violations));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installThreeVendor: copies build files and examples/jsm as addons/, reports the version", () => {
  const three = fakeThree();
  const dir = tmp("sva-vendor-");
  try {
    assert.equal(findThree(dir, {}), fs.existsSync(path.join(SKILL, "node_modules", "three", "build", "three.module.js")) ? path.join(SKILL, "node_modules", "three") : null);
    const out = installThreeVendor(dir, { SVA_THREE_DIR: three });
    assert.deepEqual(out, { from: three, version: "0.999.0" });
    for (const f of ["three.module.js", "three.core.js", path.join("addons", "loaders", "GLTFLoader.js")]) {
      assert.ok(fs.existsSync(path.join(dir, "assets", "vendor", f)), f);
    }
  } finally {
    fs.rmSync(three, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("threeInstallSteps: names npm install and --vendor, quotes a path with spaces", () => {
  const steps = threeInstallSteps("/a b/reel");
  assert.match(steps, /npm install three --prefix "\/a b\/reel"/);
  assert.match(steps, /new-reel\.mjs"? "\/a b\/reel" --vendor/);
});

test("3D page with no three.js: ready rejects naming the install step", { skip: noBrowser }, async () => {
  const dir = await makeReel(true);
  const server = await serveDir(dir);
  try {
    await assert.rejects(
      openReel(server.url.replace(/\/$/, "") + "/reel.html", { width: 216, height: 384 }),
      /three\.js not found[\s\S]*--vendor/
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3D page with three.js but no addons: ready rejects naming the missing addons and the install step", { skip: noThree }, async () => {
  const dir = await makeReel(true);
  for (const f of ["three.module.js", "three.core.js"]) {
    fs.copyFileSync(path.join(threeBuild, f), path.join(dir, "assets", "vendor", f));
  }
  const server = await serveDir(dir);
  try {
    await assert.rejects(
      openReel(server.url.replace(/\/$/, "") + "/reel.html", { width: 216, height: 384 }),
      /addons not found[\s\S]*loaders\/GLTFLoader\.js[\s\S]*--vendor/
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- defect 2: monotone camera track -------------------------------------

test("monotoneTrack: passes through every key and never leaves the range of the two keys around t", () => {
  // A camera diving to the ground (y = 0.2) and climbing away: Catmull-Rom
  // goes below 0.2 between keys 1 and 2.
  const keys = [
    { t: 0, v: [0, 5, 6] },
    { t: 1, v: [1, 0.2, 4] },
    { t: 2, v: [2, 0.2, 2] },
    { t: 3, v: [6, 3, 2] },
  ];
  const track = Reel.monotoneTrack(keys);
  for (const k of keys) assert.deepEqual(track(k.t).map((x) => +x.toFixed(9)), k.v);
  for (let i = 0; i < keys.length - 1; i++) {
    for (let s = 0; s <= 100; s++) {
      const t = keys[i].t + (keys[i + 1].t - keys[i].t) * (s / 100);
      const p = track(t);
      for (let d = 0; d < 3; d++) {
        const lo = Math.min(keys[i].v[d], keys[i + 1].v[d]) - 1e-9;
        const hi = Math.max(keys[i].v[d], keys[i + 1].v[d]) + 1e-9;
        assert.ok(p[d] >= lo && p[d] <= hi, `dim ${d} at t=${t}: ${p[d]} outside [${lo}, ${hi}]`);
      }
    }
  }
  assert.deepEqual(track(-1), keys[0].v, "clamps before the first key");
  assert.deepEqual(track(9), keys[3].v, "clamps after the last key");
});

test("monotoneTrack: scalar values, a single key, and ease io", () => {
  assert.deepEqual(Reel.monotoneTrack([{ t: 0, v: 2 }])(5), [2]);
  const io = Reel.monotoneTrack([{ t: 0, v: 0 }, { t: 1, v: 10, ease: "io" }]);
  assert.equal(io(0.5)[0], 5);
  assert.ok(io(0.1)[0] < 1, "eases in");
  assert.throws(() => Reel.monotoneTrack([]), /at least one key/);
});

test("3D template: the camera uses Reel.monotoneTrack", () => {
  const html = fs.readFileSync(path.join(SKILL, "assets", "template", "reel-3d.html"), "utf8");
  assert.match(html, /cameraTrack = Reel\.monotoneTrack\(/);
});

// ---- defect 3: first-seek determinism -------------------------------------

test("templates: images resolve after decode(); the 3D build stabilizes the scene before ready", () => {
  for (const name of ["reel.html", "reel-3d.html"]) {
    const html = fs.readFileSync(path.join(SKILL, "assets", "template", name), "utf8");
    const loader = html.slice(html.indexOf("function loadImage"), html.indexOf("function preloadClipFrames"));
    assert.match(loader, /img\.decode\(\)\.then/, name);
  }
  const html = fs.readFileSync(path.join(SKILL, "assets", "template", "reel-3d.html"), "utf8");
  const build = html.slice(html.indexOf("function buildWorld"), html.indexOf("function render3D"));
  assert.ok(build.indexOf("stabilizeScene();") < build.indexOf("worldBuilt = true"), "stabilizeScene runs before worldBuilt");
  const stab = html.slice(html.indexOf("function stabilizeScene"), html.indexOf("function namePath"));
  for (const re of [/o\.frustumCulled = false/, /computeBoundingSphere\(\)/, /setOpaqueSort/, /setTransparentSort/, /namePath\(o\)/]) {
    assert.match(stab, re);
  }
});

test("3D page: a cold first seek draws the same pixels as a seek after others", { skip: noThree }, async () => {
  const dir = await makeReel(true);
  assert.ok(installThreeVendor(dir, { SVA_THREE_DIR: path.dirname(threeBuild) }));
  try {
    const cold = await withPage(dir, (page) => page.evaluate(async () => {
      await window.__reel.seek(1.0);
      return document.getElementById("stage").toDataURL();
    }));
    const warm = await withPage(dir, (page) => page.evaluate(async () => {
      for (const t of [2.5, 0.2, 1.7, 1.0]) await window.__reel.seek(t);
      return document.getElementById("stage").toDataURL();
    }));
    assert.equal(cold, warm);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- defect 4: typed-array SFX ---------------------------------------------

test("templates: renderSfx returns the mix's Float32Arrays, never Array.from", () => {
  for (const name of ["reel.html", "reel-3d.html"]) {
    const html = fs.readFileSync(path.join(SKILL, "assets", "template", name), "utf8");
    const fn = html.slice(html.indexOf("function renderSfx"), html.indexOf("function sfxStems"));
    assert.match(fn, /return \[m\.L, m\.R\];/, name);
    assert.doesNotMatch(html, /(^|[^\w])Array\.from\((m\.|buf\)|gen)/m, name);
  }
});

test("2D page: renderSfx reaches Node as Float32Arrays of duration * sampleRate", { skip: noBrowser }, async () => {
  const dir = await makeReel(false);
  try {
    const out = await withPage(dir, (page) => page.evaluate(() => window.__reel.audio.renderSfx(8000)));
    assert.ok(out[0] instanceof Float32Array && out[1] instanceof Float32Array);
    assert.equal(out[0].length, 3 * 8000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- defect 5: skip the 3D scene outside its windows -----------------------

test("inWindows: half-open [start, end) windows; null or empty -> false", () => {
  const w = [{ start: 1, end: 2 }, { start: 4, end: 5 }];
  assert.equal(Reel.inWindows(1, w), true);
  assert.equal(Reel.inWindows(1.99, w), true);
  assert.equal(Reel.inWindows(2, w), false);
  assert.equal(Reel.inWindows(4.5, w), true);
  assert.equal(Reel.inWindows(3, w), false);
  assert.equal(Reel.inWindows(1, null), false);
  assert.equal(Reel.inWindows(1, []), false);
});

test("3D page: outside SCENE_WINDOWS seek draws draw2D, not the 3D scene", { skip: noThree }, async () => {
  const dir = await makeReel(true);
  assert.ok(installThreeVendor(dir, { SVA_THREE_DIR: path.dirname(threeBuild) }));
  const html = path.join(dir, "reel.html");
  const src = fs.readFileSync(html, "utf8");
  const edited = src.replace("var SCENE_WINDOWS = null;", "var SCENE_WINDOWS = [{ start: 0, end: 1 }];");
  assert.notEqual(edited, src, "SCENE_WINDOWS found in the 3D scaffold");
  fs.writeFileSync(html, edited);
  try {
    const out = await withPage(dir, (page) => page.evaluate(async () => {
      const r = window.__reel;
      function distinctColors() {
        const c = document.getElementById("stage");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const set = new Set();
        for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        return set.size;
      }
      await r.seek(0.5);
      const on = distinctColors();
      await r.seek(2.0);
      const off = distinctColors();
      return { on, off, a: r.sceneOn(0.5), b: r.sceneOn(2.0) };
    }), "?captions=0");
    assert.equal(out.a, true);
    assert.equal(out.b, false);
    assert.ok(out.on > 1, "the 3D scene drew inside its window");
    assert.equal(out.off, 1, "outside it only the flat draw2D background is drawn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
