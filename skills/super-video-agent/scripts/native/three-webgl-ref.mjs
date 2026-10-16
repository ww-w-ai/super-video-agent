// Render the SAME 3D scene as wgpu-three-probe.mjs, but with three's
// WebGLRenderer in a headless Chromium (the renderer + engine the shipped 3D
// reels actually use). Screenshot the canvas -> PNG. Comparing this against the
// native WebGPU PNG measures the renderer-parity ceiling: how close WebGPURenderer
// (native) can get to WebGLRenderer (browser), independent of my port.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveDir } from "../lib/server.mjs";
import { getChromium } from "../lib/playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, "..", "..");
const W = 640, H = 360;

const tmp = path.join(here, "out", "webgl-ref");
fs.mkdirSync(tmp, { recursive: true });
// vendor the WebGL three build next to the page so the importmap resolves it.
for (const f of ["three.module.js", "three.core.js"]) fs.copyFileSync(path.join(skill, "node_modules", "three", "build", f), path.join(tmp, f));

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#202838}#stage{display:block}</style>
<script type="importmap">{ "imports": { "three": "./three.module.js" } }</script>
</head><body>
<canvas id="stage" width="${W}" height="${H}"></canvas>
<script type="module">
import * as THREE from "three";
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(${W}, ${H}, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202838);
const cam = new THREE.PerspectiveCamera(50, ${W}/${H}, 0.1, 100);
cam.position.set(3, 2.4, 4); cam.lookAt(0,0,0);
const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1,0.32,160,24), new THREE.MeshStandardMaterial({color:0x55aaff, metalness:0.3, roughness:0.35}));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff,0.5));
const dir = new THREE.DirectionalLight(0xffffff,2.2); dir.position.set(5,8,6); scene.add(dir);
renderer.render(scene, cam);
window.__done = true;
</script></body></html>`;
fs.writeFileSync(path.join(tmp, "index.html"), html);

const server = await serveDir(tmp);
try {
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
  page.on("console", (m) => console.log("CONSOLE:", m.type(), m.text()));
  page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
  page.on("requestfailed", (r) => console.log("REQFAIL", r.url(), r.failure() && r.failure().errorText));
  await page.goto(server.url.replace(/\/$/, "") + "/index.html", { waitUntil: "load" });
  await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 });
  const dataUrl = await page.evaluate(() => document.getElementById("stage").toDataURL("image/png"));
  const out = path.join(here, "out", "three-webgl-ref.png");
  fs.writeFileSync(out, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  console.log("wrote", out);
  await browser.close();
} finally {
  await server.close();
}
process.exit(0);
