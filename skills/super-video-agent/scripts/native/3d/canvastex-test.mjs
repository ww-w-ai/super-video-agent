// Does a CanvasTexture backed by a skia Canvas upload to WebGPU? (The reel draws
// screens/skyline/face onto canvases.) Draw a red gradient, map it on a plane,
// render, check the center is red — black means canvas-source upload is a host gap.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { create, globals } from "webgpu";
import skia from "skia-canvas";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, "..", "..", "..");
const threeBuild = path.join(skill, "node_modules", "three", "build");
register("./loader-hooks.mjs", import.meta.url, { data: {
  shimUrl: pathToFileURL(path.join(here, "three-webgpu-shim.mjs")).href,
  threeWebgpuUrl: pathToFileURL(path.join(threeBuild, "three.webgpu.js")).href,
  threeTslUrl: pathToFileURL(path.join(threeBuild, "three.tsl.js")).href,
  addonsBaseUrl: pathToFileURL(path.join(skill, "node_modules", "three", "examples", "jsm")).href + "/",
  sceneUrls: {}, scenes: {},
} });

Object.assign(globalThis, globals);
const gpu = create([]);
try { Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true }); } catch (e) {}
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
globalThis.__svaGpuDevice = await adapter.requestDevice();
const { patchCanvasTextureUpload } = await import("./gpu-texture-upload-fix.mjs");
patchCanvasTextureUpload(globalThis.__svaGpuDevice);
globalThis.document = { createElementNS: () => new skia.Canvas(1, 1), createElement: (n) => (String(n).toLowerCase() === "canvas" ? new skia.Canvas(1, 1) : { style: {} }) };
globalThis.self = globalThis;
globalThis.requestAnimationFrame = () => 0;

const THREE = await import("three");
const W = 256, H = 256;
const renderer = new THREE.WebGLRenderer({ canvas: new skia.Canvas(W, H), antialias: false });
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();

// a skia canvas with an obvious red->yellow gradient
const cv = new skia.Canvas(128, 128);
const g = cv.getContext("2d");
const grad = g.createLinearGradient(0, 0, 128, 128);
grad.addColorStop(0, "#ff0000"); grad.addColorStop(1, "#ffff00");
g.fillStyle = grad; g.fillRect(0, 0, 128, 128);

const tex = new THREE.CanvasTexture(cv);
tex.colorSpace = THREE.SRGBColorSpace;
tex.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
cam.position.z = 2;
const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex }));
scene.add(plane);
renderer.render(scene, cam);
const px = new Uint8Array(W * H * 4);
await renderer.readPixelsAsync(px);
const c = px.length / 2 + W * 2; // near center
console.log(`center px RGBA = ${px[c]},${px[c + 1]},${px[c + 2]},${px[c + 3]}  (expect reddish/orange, NOT 0,0,0)`);
const out = path.join(here, "..", "out", "canvastex-test.png");
const oc = new skia.Canvas(W, H); const octx = oc.getContext("2d"); const img = octx.createImageData(W, H); img.data.set(px); octx.putImageData(img, 0, 0);
fs.writeFileSync(out, oc.toBufferSync("png"));
console.log("wrote", out);
process.exit(0);
