// Native 3D reel host: runs a WebGL 3D reel (reel.html) headless in Node on
// WebGPU/Dawn instead of a browser. Reuses the 2D host's globals (document,
// fonts, Image, stage canvas) and adds the 3D layer: a single shared "three"
// instance (via module.register) whose WebGLRenderer is a WebGPURenderer
// adapter, GLTF-in-Node texture decode, and a patched async copyToStage.
//
// WebGL-only effects the shipped reels use have no WebGPU drop-in and are
// shimmed with fidelity gaps (reported, not hidden): UnrealBloom postprocessing
// (pass-through), Reflector (GLSL ShaderMaterial -> plain metallic plane),
// RectAreaLight LTC lib (no-op; three.webgpu lights RectAreaLight natively).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { create, globals as gpuGlobals } from "webgpu";
import skia from "skia-canvas";
import { parseFontFaces, registerFonts, installGlobals, sceneDims } from "./reel-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THREE_DIR = path.resolve(HERE, "..", "..", "node_modules", "three");

/** Collect <script> blocks: skip importmap; classic blocks (engine/audio) and the module block (scene). */
function extract3DScripts(html) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const classic = [];
  const modules = [];
  let m;
  while ((m = re.exec(html))) {
    const type = (m[1].match(/type\s*=\s*["']([^"']+)["']/) || [])[1];
    if (type === "importmap") continue;
    if (type === "module") modules.push(m[2]);
    else classic.push(m[2]);
  }
  if (!modules.length) throw new Error("reel.html has no <script type=module> (scene block) — not a 3D reel");
  return { classic, scene: modules[modules.length - 1] };
}

/** Patch the scene's copyToStage: sync WebGL readback -> async WebGPU readback. */
function patchScene(src) {
  let s = src;
  s = s.replace(/function copyToStage\s*\(\)/, "async function copyToStage()");
  // copyToStage is awaited inside seek(); seek must be async (day04's is not).
  s = s.replace(/(\n\s*)function seek\s*\(t\)/, "$1async function seek(t)");
  s = s.replace(
    /gl\.readPixels\(0,\s*0,\s*RW,\s*RH,\s*gl\.RGBA,\s*gl\.UNSIGNED_BYTE,\s*glPixels\);/,
    "await renderer.__readPixelsAsync(glPixels);"
  );
  // copyToStage() call sites -> await (seek is already async)
  s = s.replace(/([^.\w])copyToStage\(\);/g, "$1await copyToStage();");
  return s;
}

export async function loadReel3D(reelDir, { captions = false } = {}) {
  const htmlPath = path.join(reelDir, "reel.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const { classic, scene } = extract3DScripts(html);
  const patched = patchScene(scene);

  // --- module resolution: one "three" instance + WebGPU addon overrides ---
  const threeBuild = path.join(THREE_DIR, "build");
  const addonOverrides = {};
  const postShim = pathToFileURL(path.join(HERE, "3d", "webgpu-post-shim.mjs")).href;
  for (const f of ["EffectComposer.js", "RenderPass.js", "UnrealBloomPass.js", "OutputPass.js"]) {
    addonOverrides["postprocessing/" + f] = postShim;
  }
  addonOverrides["objects/Reflector.js"] = pathToFileURL(path.join(HERE, "3d", "reflector-stub.mjs")).href;
  addonOverrides["lights/RectAreaLightUniformsLib.js"] = pathToFileURL(path.join(HERE, "3d", "rectarea-stub.mjs")).href;

  const sceneSentinel = "sva-scene:reel";
  const sceneUrl = pathToFileURL(path.join(reelDir, "__sva_scene__.mjs")).href;
  register("./3d/loader-hooks.mjs", import.meta.url, {
    data: {
      shimUrl: pathToFileURL(path.join(HERE, "3d", "three-webgpu-shim.mjs")).href,
      threeWebgpuUrl: pathToFileURL(path.join(threeBuild, "three.webgpu.js")).href,
      threeTslUrl: pathToFileURL(path.join(threeBuild, "three.tsl.js")).href,
      addonsBaseUrl: pathToFileURL(path.join(THREE_DIR, "examples", "jsm")).href + "/",
      addonOverrides,
      sceneUrls: { [sceneSentinel]: sceneUrl },
      scenes: { [sceneUrl]: patched },
    },
  });

  // --- WebGPU device (shared with the renderer shim) ---
  Object.assign(globalThis, gpuGlobals);
  const gpu = create([]);
  try { Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true }); } catch (e) {}
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  globalThis.__svaGpuDevice = await adapter.requestDevice();

  // --- dimensions + stage canvas ---
  const dims = sceneDims([{ source: scene }]);
  const width = dims.width, height = dims.height, fps = dims.fps;
  const stage = new skia.Canvas(width, height);

  // --- 2D globals (document, fonts, Image, stage, location ?captions=0) ---
  const faces = parseFontFaces(html);
  registerFonts(faces, reelDir);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  installGlobals({ reelDir, stage, faces, captions });

  // --- 3D-specific global overrides (after installGlobals) ---
  globalThis.self = globalThis;
  // The reel's copyToStage flips (it assumes WebGL bottom-up gl.readPixels); WebGPU
  // read-back is top-down, so have the adapter hand back bottom-up to restore it.
  globalThis.__svaFlipReadback = true;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  // three's ImageLoader does createElementNS('img') then addEventListener('load').
  // Return a skia-backed Image (resolves src against reelDir, fires onload) with an
  // addEventListener shim; anything else -> a skia Canvas.
  globalThis.document.createElementNS = (ns, tag) => {
    if (String(tag).toLowerCase() === "img") {
      const img = new globalThis.Image();
      img.addEventListener = (ev, cb) => { if (ev === "load") img.onload = cb; else if (ev === "error") img.onerror = cb; };
      img.removeEventListener = () => {};
      return img;
    }
    return new skia.Canvas(1, 1);
  };
  // GLTF embedded textures arrive as Blob; decode via skia. Other sources keep 2D behavior.
  globalThis.createImageBitmap = async (src) => {
    let img;
    if (typeof Blob !== "undefined" && src instanceof Blob) img = await skia.loadImage(Buffer.from(await src.arrayBuffer()));
    else if (src && (src.naturalWidth || src.width)) img = src;
    else img = await skia.loadImage(src);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const c = new skia.Canvas(w, h);
    c.getContext("2d").drawImage(img, 0, 0);
    return c;
  };
  // three's FileLoader builds `new Request(url)` before fetch; relative URLs have
  // no base in Node and throw. Resolve them against reelDir as file: URLs. Keep it
  // minimal (FileLoader only reads .url and passes the object to fetch).
  const reelBase = pathToFileURL(reelDir + "/").href;
  globalThis.Request = class Request {
    constructor(input, init = {}) {
      let url = typeof input === "string" ? input : (input && input.url) || String(input);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = new URL(url, reelBase).href;
      this.url = url;
      this.method = (init && init.method) || "GET";
      this.headers = (init && init.headers) || {};
      this.credentials = init && init.credentials;
    }
  };
  // fetch: local files via fs (resolved against reelDir); blob:/http/data to node native.
  globalThis.fetch = async (req, opts) => {
    let url = typeof req === "string" ? req : (req && req.url) || String(req);
    if (url.startsWith("blob:") || url.startsWith("http:") || url.startsWith("https:") || url.startsWith("data:")) return nativeFetch(req, opts);
    let p = url.startsWith("file:") ? fileURLToPath(url) : (path.isAbsolute(url) ? url : path.resolve(reelDir, url.split("?")[0]));
    const buf = fs.readFileSync(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return {
      ok: true, status: 200, statusText: "OK", url,
      headers: { get: () => null, has: () => false },
      arrayBuffer: async () => ab,
      json: async () => JSON.parse(buf.toString()),
      text: async () => buf.toString(),
      blob: async () => new Blob([buf]),
    };
  };

  // --- run engine + audio (classic scripts share the global object) ---
  for (let i = 0; i < classic.length; i++) {
    vm.runInThisContext(classic[i], { filename: `${htmlPath} (classic #${i})` });
  }

  // --- run the scene (ESM) ---
  // The scene body is a fire-and-forget `(async function(){ ... window.__reel = ... })()`
  // that awaits `import("three")` + addons before assigning __reel, so importing the
  // module resolves before __reel exists. Poll until it appears.
  await import(sceneSentinel);
  let reel = globalThis.window.__reel;
  for (let i = 0; i < 600 && !reel; i++) { await new Promise((r) => setTimeout(r, 50)); reel = globalThis.window.__reel; }
  if (!reel) throw new Error("scene did not set window.__reel within 30s");
  if (reel.ready) await reel.ready;
  if (reel.preload) await reel.preload;

  async function seek(t) { await reel.seek(t); }
  function capturePng() { return stage.toBufferSync("png"); }

  return { reel, stage, width, height, fps, duration: reel.duration, seek, capturePng };
}
