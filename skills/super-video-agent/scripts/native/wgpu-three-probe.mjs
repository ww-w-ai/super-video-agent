// Probe: three.js WebGPURenderer rendering a 3D scene HEADLESS in Node via Dawn,
// to a RenderTarget, read back to raw RGBA, written as PNG (no browser, no canvas).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create, globals } from "webgpu";
import skia from "skia-canvas";

Object.assign(globalThis, globals);
const gpu = create([]);
try {
  Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true });
} catch (e) {
  /* read-only; three gets the device directly */
}
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();

// three's WebGPURenderer wants a canvas with a "webgpu" context. Dawn cannot
// present to a canvas, but we only ever render to RenderTargets + read back, so
// a stub whose getCurrentTexture() returns a real Dawn texture is enough.
function makeGpuCanvas(w, h) {
  return {
    width: w,
    height: h,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext(type) {
      if (type !== "webgpu") return null;
      let cfg = null;
      let tex = null;
      return {
        configure(c) {
          cfg = c;
          tex = null;
        },
        unconfigure() {
          tex = null;
        },
        getCurrentTexture() {
          if (!tex) {
            tex = device.createTexture({
              size: [this._w, this._h, 1],
              format: (cfg && cfg.format) || "bgra8unorm",
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
            });
          }
          return tex;
        },
        _w: w,
        _h: h,
      };
    },
  };
}
globalThis.document = {
  createElementNS(ns, name) {
    return makeGpuCanvas(1, 1);
  },
  createElement(name) {
    return makeGpuCanvas(1, 1);
  },
};
globalThis.self = globalThis;
globalThis.requestAnimationFrame = () => 0; // frames are driven manually via renderAsync
globalThis.cancelAnimationFrame = () => {};

const THREE = await import("three/webgpu");
const here = path.dirname(fileURLToPath(import.meta.url));
const W = 640, H = 360;

const renderer = new THREE.WebGPURenderer({ device, canvas: makeGpuCanvas(W, H), antialias: true });
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202838);
const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
cam.position.set(3, 2.4, 4);
cam.lookAt(0, 0, 0);

const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 160, 24), new THREE.MeshStandardMaterial({ color: 0x55aaff, metalness: 0.3, roughness: 0.35 }));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dir = new THREE.DirectionalLight(0xffffff, 2.2);
dir.position.set(5, 8, 6);
scene.add(dir);

const rt = new THREE.RenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
renderer.setRenderTarget(rt);
renderer.render(scene, cam);

const pixels = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
const buf = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

const c = new skia.Canvas(W, H);
const ctx = c.getContext("2d");
const img = ctx.createImageData(W, H);
img.data.set(buf);
ctx.putImageData(img, 0, 0);
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "wgpu-three-probe.png");
fs.writeFileSync(out, c.toBufferSync("png"));

let nonzero = 0;
for (let i = 0; i < buf.length; i += 4) if (buf[i] || buf[i + 1] || buf[i + 2]) nonzero++;
console.log(`rendered ${W}x${H}, non-black pixels: ${nonzero}/${W * H} -> ${out}`);
process.exit(0);
