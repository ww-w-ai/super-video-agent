// Throughput of the native WebGPU 3D path: render a scene + read back raw RGBA,
// per frame, at the reels' internal 3D resolution (0.75 x 1080p = 1440x810).
// This is the frame cost that would feed NVENC on the server.
import { create, globals } from "webgpu";

Object.assign(globalThis, globals);
const gpu = create([]);
try { Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true }); } catch (e) {}
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();

function makeGpuCanvas(w, h) {
  return { width: w, height: h, style: {}, addEventListener() {}, removeEventListener() {},
    getContext(t) { if (t !== "webgpu") return null; let cfg = null, tex = null; return {
      configure(c) { cfg = c; tex = null; }, unconfigure() { tex = null; },
      getCurrentTexture() { if (!tex) tex = device.createTexture({ size: [w, h, 1], format: (cfg && cfg.format) || "bgra8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING }); return tex; } }; } };
}
globalThis.document = { createElementNS: () => makeGpuCanvas(1, 1), createElement: () => makeGpuCanvas(1, 1) };
globalThis.self = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const THREE = await import("three/webgpu");
const W = 1440, H = 810;
const renderer = new THREE.WebGPURenderer({ device, canvas: makeGpuCanvas(W, H), antialias: true });
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151a28);
const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
cam.position.set(3, 2.4, 4); cam.lookAt(0, 0, 0);
const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 200, 32), new THREE.MeshStandardMaterial({ color: 0x55aaff, metalness: 0.4, roughness: 0.3 }));
mesh.castShadow = true; scene.add(mesh);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x333842 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -2; floor.receiveShadow = true; scene.add(floor);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dir = new THREE.DirectionalLight(0xffffff, 2.4); dir.position.set(5, 8, 6); dir.castShadow = true; scene.add(dir);

const rt = new THREE.RenderTarget(W, H);
renderer.setRenderTarget(rt);

const N = 120;
// warm
mesh.rotation.y = 0; renderer.render(scene, cam); await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  mesh.rotation.y = (i / N) * Math.PI * 2;
  renderer.render(scene, cam);
  await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
}
const el = (performance.now() - t0) / 1000;
console.log(`native WebGPU 3D ${W}x${H} render+readback: ${(N / el).toFixed(1)} fps over ${N} frames (${el.toFixed(2)}s)`);
process.exit(0);
