// Verify GLTFLoader works headless in Node (load a real reel .glb via the
// module.register hooks + a single "three" instance), render it through the
// WebGPU adapter. Surfaces exactly what GLTF texture/image decode needs shimmed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { create, globals } from "webgpu";
import skia from "skia-canvas";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, "..", "..", "..");
const threeBuild = path.join(skill, "node_modules", "three", "build");
const jsm = path.join(skill, "node_modules", "three", "examples", "jsm");

register("./loader-hooks.mjs", import.meta.url, {
  data: {
    shimUrl: pathToFileURL(path.join(here, "three-webgpu-shim.mjs")).href,
    threeWebgpuUrl: pathToFileURL(path.join(threeBuild, "three.webgpu.js")).href,
    threeTslUrl: pathToFileURL(path.join(threeBuild, "three.tsl.js")).href,
    addonsBaseUrl: pathToFileURL(jsm).href + "/",
    sceneUrls: {},
    scenes: {},
  },
});

// --- globals the loaders touch ---
Object.assign(globalThis, globals);
const gpu = create([]);
try { Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true }); } catch (e) {}
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
globalThis.__svaGpuDevice = await adapter.requestDevice();

function skiaCanvas(w, h) { const c = new skia.Canvas(w || 1, h || 1); return c; }
globalThis.document = {
  createElementNS: () => skiaCanvas(1, 1),
  createElement: (n) => (String(n).toLowerCase() === "canvas" ? skiaCanvas(1, 1) : { style: {} }),
};
globalThis.self = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// fetch for local files (GLTF FileLoader uses it for the .glb); blob:/http(s)
// (GLTF embedded textures) pass through to node's native fetch.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (req, opts) => {
  let url = typeof req === "string" ? req : (req && req.url) || String(req);
  if (url.startsWith("blob:") || url.startsWith("http:") || url.startsWith("https:") || url.startsWith("data:")) return nativeFetch(req, opts);
  const p = url.startsWith("file:") ? fileURLToPath(url) : url;
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: async () => JSON.parse(buf.toString()), text: async () => buf.toString(), blob: async () => new Blob([buf]) };
};
// Decode an embedded texture (Blob or path) to a skia Canvas (drawable, sized).
globalThis.createImageBitmap = async (src) => {
  let img;
  if (typeof Blob !== "undefined" && src instanceof Blob) { img = await skia.loadImage(Buffer.from(await src.arrayBuffer())); }
  else if (src && (src.naturalWidth || src.width)) { img = src; }
  else { img = await skia.loadImage(src); }
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const c = new skia.Canvas(w, h); c.getContext("2d").drawImage(img, 0, 0);
  return c;
};

const THREE = await import("three");
const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");

const W = 640, H = 360;
const renderer = new THREE.WebGLRenderer({ canvas: skiaCanvas(W, H), antialias: true });
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x303848);
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const dir = new THREE.DirectionalLight(0xffffff, 2.0); dir.position.set(4, 8, 6); scene.add(dir);

const glbPath = "/Users/taehyoungkim/Documents/DEV/ww-w-ai/codereel-workspace/samples/day04-foldable-iphone/reel/assets/models/desk/props-desk.glb";
console.log("loading", glbPath, "exists:", fs.existsSync(glbPath));
const loader = new GLTFLoader();
const gltf = await loader.loadAsync(pathToFileURL(glbPath).href);
const model = gltf.scene;
scene.add(model);

// frame the model
const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());
const cam = new THREE.PerspectiveCamera(45, W / H, 0.01, 1000);
const r = Math.max(size.x, size.y, size.z) || 1;
cam.position.set(center.x + r * 1.6, center.y + r * 1.2, center.z + r * 1.8);
cam.lookAt(center);

renderer.render(scene, cam);
const px = new Uint8Array(W * H * 4);
await renderer.readPixelsAsync(px);

const c = new skia.Canvas(W, H);
const ctx = c.getContext("2d");
const img = ctx.createImageData(W, H);
img.data.set(px);
ctx.putImageData(img, 0, 0);
const out = path.join(here, "..", "out", "gltf-test.png");
fs.writeFileSync(out, c.toBufferSync("png"));
let nonbg = 0;
for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - 48) + Math.abs(px[i + 1] - 56) + Math.abs(px[i + 2] - 72) > 24) nonbg++;
console.log(`GLB meshes: ${model.children.length}+, non-bg px: ${nonbg}/${W * H} -> ${out}`);
process.exit(0);
