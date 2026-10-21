// SVA_RENDERER=native on a 3D reel (module scene, "three"): the page opens
// through the same openReel / seek / capture / evaluate surface as a 2D reel,
// on WebGPU in this process. Covers: node-frame uniforms follow t, the
// renderer's output pass (tone mapping, sRGB, MSAA), tight read-back rows, the
// declared async copy hook vs the legacy copyToStage rewrite, and the refusals.
// Needs a WebGPU adapter; skipped with the reason when the host has none.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create } from "webgpu";
import { openReel, captureRgbaFrame, captureFrame } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";

process.env.SVA_RENDERER = "native";

const gpuInstance = create([]); // kept referenced: a collected instance crashes Dawn on its next map
const adapter = await gpuInstance.requestAdapter().catch(() => null);
const gpu = adapter ? {} : { skip: "no WebGPU adapter on this host" };

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

async function withReel(html, fn, query = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-native-3d-"));
  tmpRoots.push(dir);
  fs.writeFileSync(path.join(dir, "reel.html"), html);
  const server = await serveDir(dir);
  try {
    return await fn(`${server.url}${query}`);
  } finally {
    await server.close();
  }
}

// 66x34 (264-byte rows: the read-back pads them to 512). Left half: a lit
// plane whose light intensity follows t. Top right: an sRGB #808080 square.
// Bottom right: a white square turned 30 degrees (its edges show the MSAA).
const W = 66;
const H = 34;
const SCENE_SETUP = `
import * as THREE from "three";
var W = ${W}, H = ${H}, FPS = 30;
var stage = document.getElementById("stage");
var ctx = stage.getContext("2d");
var params = new URLSearchParams(location.search);
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = params.get("tone") === "aces" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
await renderer.init();
var scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
var cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.1, 100);
cam.position.z = 10;
var lit = new THREE.Mesh(new THREE.PlaneGeometry(W / 2, H), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
lit.position.x = -W / 4;
scene.add(lit);
var light = new THREE.DirectionalLight(0xffffff, 0.2);
light.position.set(0, 0, 5);
scene.add(light);
var grey = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), new THREE.MeshBasicMaterial({ color: 0x808080 }));
grey.position.set(W / 4, H / 4, 0);
scene.add(grey);
var edge = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
edge.position.set(W / 4, -H / 4, 0);
edge.rotation.z = Math.PI / 6;
scene.add(edge);
function pose(t) { light.intensity = 0.2 + 1.2 * t; }
`;

const REEL_3D = `<!doctype html><html><body>
<canvas id="stage" width="${W}" height="${H}"></canvas>
<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.webgpu.js" } }</script>
<script type="module">
${SCENE_SETUP}
var img = ctx.createImageData(W, H);
window.__reel = {
  width: W, height: H, fps: FPS, duration: 2, layers: [],
  shots: [{ id: "a", start: 0, end: 2, readAt: 1 }],
  ready: Promise.resolve(),
  seek: async function (t) {
    pose(t);
    renderer.render(scene, cam);
    img.data.set(await renderer.readPixelsAsync());
    ctx.putImageData(img, 0, 0);
  },
  rtReadLength: async function () {
    var rt = new THREE.RenderTarget(W, H);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    var px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    rt.dispose();
    return px.length;
  },
};
</script></body></html>`;

// The shipped template's composite: render, then a synchronous
// gl.readPixels in copyToStage, flipped from WebGL's bottom-up rows.
const REEL_LEGACY = `<!doctype html><html><body>
<canvas id="stage" width="${W}" height="${H}"></canvas>
<script type="module">
${SCENE_SETUP}
var RW = W, RH = H, glPixels = new Uint8Array(W * H * 4), smallImg = ctx.createImageData(W, H);
  function copyToStage() {
    var gl = renderer.getContext();
    gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, glPixels);
    var row = RW * 4;
    for (var y = 0; y < RH; y++) smallImg.data.set(glPixels.subarray((RH - 1 - y) * row, (RH - y) * row), y * row);
    ctx.putImageData(smallImg, 0, 0);
  }
  function seek(t) {
    pose(t);
    renderer.render(scene, cam);
    copyToStage();
  }
window.__reel = { width: W, height: H, fps: FPS, duration: 2, layers: [], shots: [], ready: Promise.resolve(), seek: seek };
</script></body></html>`;

const px = (rgba, x, y) => [...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

test("native 3D: openReel/seek/capture/evaluate work on a module-scene reel", gpu, async () => {
  await withReel(REEL_3D, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.equal(s.renderer, "native");
      assert.equal(s.page.native3d, true);
      assert.equal(s.meta.duration, 2);
      assert.deepEqual(s.page.stageSize(), { width: W, height: H });
      const png = await captureFrame(s.page, 1);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(await s.page.evaluate(() => window.__reel.width + 1), W + 1);
      assert.equal(await s.page.evaluate(() => typeof document.getElementById), "function");
    } finally {
      await s.close();
    }
    assert.equal(typeof globalThis.document, "undefined", "closing the page takes its globals off Node's global");
  });
});

test("native 3D: light uniforms follow t (the node frame advances per seek), and seek stays a pure function of t", gpu, async () => {
  await withReel(REEL_3D, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      const early = await captureRgbaFrame(s.page, 0.2);
      const late = await captureRgbaFrame(s.page, 1.8);
      const a = px(early, 8, 17)[0];
      const b = px(late, 8, 17)[0];
      assert.ok(b > a + 20, `the lit plane brightens with the light (t=0.2: ${a}, t=1.8: ${b})`);
      assert.deepEqual(await captureRgbaFrame(s.page, 0.2), early);
    } finally {
      await s.close();
    }
  });
});

test("native 3D: the renderer's own target is its output target (sRGB once, tone mapping, 4x MSAA) with tight rows", gpu, async () => {
  let plainGrey;
  await withReel(REEL_3D, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      const f = await captureRgbaFrame(s.page, 1);
      plainGrey = px(f, 49, 8);
      assert.ok(Math.abs(plainGrey[0] - 128) <= 4, `#808080 reads back as ~128 (got ${plainGrey[0]}): encoded to sRGB exactly once`);
      assert.equal(plainGrey[0], plainGrey[1]);
      let mid = 0;
      for (let y = H / 2; y < H; y++) for (let x = W / 2; x < W; x++) { const v = px(f, x, y)[0]; if (v > 30 && v < 225) mid++; }
      assert.ok(mid >= 6, `the turned square's edges are antialiased (${mid} partial pixels)`);
      assert.equal(await s.page.evaluate(() => window.__reel.rtReadLength()), W * H * 4, "readRenderTargetPixelsAsync gives tight rows");
    } finally {
      await s.close();
    }
  });
  await withReel(REEL_3D, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      const toned = px(await captureRgbaFrame(s.page, 1), 49, 8);
      assert.notDeepEqual(toned, plainGrey, "ACES tone mapping changes the frame");
    } finally {
      await s.close();
    }
  }, "?tone=aces");
});

test("native 3D: the legacy copyToStage (sync gl.readPixels) is rewritten and draws the same frame upright", gpu, async () => {
  let declared;
  await withReel(REEL_3D, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      declared = await captureRgbaFrame(s.page, 1);
    } finally {
      await s.close();
    }
  });
  await withReel(REEL_LEGACY, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      const legacy = await captureRgbaFrame(s.page, 1);
      assert.deepEqual(px(legacy, 49, 8), px(declared, 49, 8), "the grey square is top right in both");
      assert.deepEqual(px(legacy, 8, 17), px(declared, 8, 17));
    } finally {
      await s.close();
    }
  });
});

test("native 3D: a page that names functions copyToStage/seek but reads pixels its own way is not rewritten", async () => {
  const page = `<!doctype html><html><body><canvas id="stage" width="8" height="8"></canvas>
<script type="module">
function copyToStage() { return "kept"; }
function seek(t) { document.getElementById("stage").getContext("2d").fillRect(0, 0, 8, 8); }
var copied = copyToStage();
window.__reel = { width: 8, height: 8, fps: 30, duration: 1, shots: [], layers: [], ready: Promise.resolve(), seek: seek, copied: copied };
</script></body></html>`;
  await withReel(page, async (url) => {
    const s = await openReel(url, { warm: false });
    try {
      assert.equal(await s.page.evaluate(() => window.__reel.copied), "kept");
      assert.equal(await s.page.evaluate(() => window.__reel.seek(0)), undefined, "seek stayed synchronous");
    } finally {
      await s.close();
    }
  });
});

test("native 3D: one 3D page per process at a time; a second open says so, a reopen after close works", async () => {
  const page = `<!doctype html><html><body><canvas id="stage" width="8" height="8"></canvas>
<script type="module">
window.__reel = { width: 8, height: 8, fps: 30, duration: 1, shots: [], layers: [], ready: Promise.resolve(), seek: function () {} };
</script></body></html>`;
  await withReel(page, async (url) => {
    const a = await openReel(url, { warm: false });
    try {
      await assert.rejects(openReel(url, { warm: false }), /one 3D reel page per process/);
    } finally {
      await a.close();
    }
    const b = await openReel(url, { warm: false });
    assert.equal(b.meta.duration, 1);
    await b.close();
  });
});

test("native 3D: a module reel with elements beside its canvas stops with the existing message", async () => {
  const page = `<!doctype html><html><body><div>caption</div><canvas id="stage" width="8" height="8"></canvas>
<script type="module">window.__reel = { ready: Promise.resolve(), seek: function () {} };</script></body></html>`;
  await withReel(page, async (url) => {
    await assert.rejects(openReel(url, { warm: false }), /draws only the <canvas>; reel\.html's <body> also has <div>/);
  });
});
