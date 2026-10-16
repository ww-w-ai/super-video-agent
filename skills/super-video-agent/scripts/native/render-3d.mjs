#!/usr/bin/env node
// Native 3D POC: headless-gl (WebGL1) + three.js -> readPixels -> ffmpeg. No browser.
// headless-gl has no prebuild for node 24; run with node 22.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as THREE from "three-webgl1";

const require = createRequire(import.meta.url);
const createGL = require("gl");
const here = path.dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30, N = 300;
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "native-3d.mp4");

const gl = createGL(W, H, { preserveDrawingBuffer: true, antialias: false });
const THREE_VER = THREE.REVISION; if (!gl) throw new Error("headless-gl context creation failed");
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const RENDERER = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
console.log(`RENDERER=${RENDERER} (gl.RENDERER=${gl.getParameter(gl.RENDERER)}, VERSION=${gl.getParameter(gl.VERSION)})`);

// three expects a canvas-like object for style/size bookkeeping.
const canvasStub = { width: W, height: H, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => gl, clientWidth: W, clientHeight: H };
const renderer = new THREE.WebGLRenderer({ canvas: canvasStub, context: gl, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.setClearColor(0x101830, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
camera.position.set(0, 0, 6);
const light = new THREE.DirectionalLight(0xffffff, 2.5);
light.position.set(3, 4, 5);
scene.add(light, new THREE.AmbientLight(0x4060a0, 1.0));
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.2, 0.4, 256, 64), new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: 0.35, metalness: 0.4 }));
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 32), new THREE.MeshStandardMaterial({ color: 0x3dd1ff }));
scene.add(knot, ball);

const ff = spawn("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${W}x${H}`, "-framerate", String(FPS), "-i", "-", "-vf", "vflip", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-y", outFile], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((res) => ff.on("close", res));

const pixels = new Uint8Array(W * H * 4);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const t = i / FPS;
  knot.rotation.set(t * 0.8, t * 1.1, 0);
  ball.position.set(Math.cos(t * 2) * 2.5, Math.sin(t * 2) * 1.5, 1);
  renderer.render(scene, camera);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  // vflip is done by ffmpeg (GL origin is bottom-left).
  if (!ff.stdin.write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))) await new Promise((r) => ff.stdin.once("drain", r));
}
ff.stdin.end();
await done;
const el = (performance.now() - t0) / 1000;
console.log(`3D-NATIVE fps=${(N / el).toFixed(1)} elapsed=${el.toFixed(2)}s RENDERER=${RENDERER} out=${outFile}`);
