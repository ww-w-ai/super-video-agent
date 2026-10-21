// Verify the WebGLRenderer->WebGPU adapter reproduces the reel's idiom:
// new WebGLRenderer({canvas}); setSize; render(scene,cam); getContext()+readback.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create, globals } from "webgpu";
import skia from "skia-canvas";

Object.assign(globalThis, globals);
const gpu = create([]);
try { Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true }); } catch (e) {}
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
globalThis.__svaGpuDevice = await adapter.requestDevice();

function makeGpuCanvas(w, h) {
  const device = globalThis.__svaGpuDevice;
  return { width: w, height: h, style: {}, addEventListener() {}, removeEventListener() {},
    getContext(t) { if (t !== "webgpu") return null; let cfg = null, tex = null; return {
      configure(c) { cfg = c; tex = null; }, unconfigure() { tex = null; },
      getCurrentTexture() { if (!tex) tex = device.createTexture({ size: [w, h, 1], format: (cfg && cfg.format) || "bgra8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING }); return tex; } }; } };
}
globalThis.document = { createElementNS: () => makeGpuCanvas(1, 1), createElement: (n) => (String(n).toLowerCase() === "canvas" ? new skia.Canvas(1, 1) : { style: {} }) };
globalThis.self = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const THREE = await import("./three-webgpu-shim.mjs");
const here = path.dirname(fileURLToPath(import.meta.url));
const W = 640, H = 360;

// --- exactly the reel idiom ---
const glCanvas = globalThis.document.createElement("canvas");
glCanvas.width = W; glCanvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202838);
const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
cam.position.set(3, 2.4, 4); cam.lookAt(0, 0, 0);
const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 160, 24), new THREE.MeshStandardMaterial({ color: 0x55aaff, metalness: 0.3, roughness: 0.35 }));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dir = new THREE.DirectionalLight(0xffffff, 2.2); dir.position.set(5, 8, 6); scene.add(dir);

renderer.render(scene, cam);

// The copy hook a 3D page awaits after render(): tight RGBA rows, top-down.
const glPixels = new Uint8Array(W * H * 4);
await renderer.readPixelsAsync(glPixels);

console.log("top-left px (bg?):", glPixels[0], glPixels[1], glPixels[2], glPixels[3]);
console.log("center px:", glPixels[(H / 2 * W + W / 2) * 4], glPixels[(H / 2 * W + W / 2) * 4 + 1], glPixels[(H / 2 * W + W / 2) * 4 + 2]);
const small = new skia.Canvas(W, H);
const sctx = small.getContext("2d");
const img = sctx.createImageData(W, H);
img.data.set(glPixels);
sctx.putImageData(img, 0, 0);

const out = path.join(here, "..", "out", "adapter-test.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, small.toBufferSync("png"));
console.log("wrote", out);
process.exit(0);
