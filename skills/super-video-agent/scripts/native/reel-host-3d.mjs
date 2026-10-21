// Native 3D reel host: runs a 3D reel (reel.html with a module scene that
// imports "three") headless in Node on WebGPU/Dawn instead of a browser.
//
// The page gets the 2D host's browser globals (document, fonts, Image, fetch
// through the page's routes, the stage canvas) on Node's own global object,
// because Node runs ES modules only in its main realm. So one 3D page can be
// open per process at a time; closing it takes every global it added back off.
// The 3D layer: a single shared "three" instance (via module.register) whose
// WebGLRenderer is a WebGPURenderer adapter (3d/three-webgpu-shim.mjs), GLTF
// texture decode through skia, and image textures uploaded with writeTexture.
//
// Before each seek the host clears the stage and starts a new node frame at t
// (light uniforms follow the clock), then calls the page's own __reel.seek.
//
// The copy hook: a page's async __reel.seek renders, then awaits
// renderer.readPixelsAsync() (tight RGBA rows, top-down) and puts them on the
// stage; three's readRenderTargetPixelsAsync also returns tight rows here.
// A page that still copies with a synchronous gl.readPixels in copyToStage()
// (the shipped 3D template) is rewritten to await the hook instead.
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
import skia from "skia-canvas";
import { scriptBlocks, assertCanvasOnly, reelStage, pageGlobals, makeConsole, trapReelSeek } from "./reel-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The real path: Node resolves the shim's own `import "three/webgpu"` through
// symlinks, and the hooks must hand out the same URL or three loads twice.
const THREE_DIR = fs.realpathSync(path.resolve(HERE, "..", "..", "node_modules", "three"));
const SHIM_URL = pathToFileURL(path.join(HERE, "3d", "three-webgpu-shim.mjs")).href;

// The synchronous read the shipped template's copyToStage() makes.
const LEGACY_READ = /gl\.readPixels\(0,\s*0,\s*RW,\s*RH,\s*gl\.RGBA,\s*gl\.UNSIGNED_BYTE,\s*glPixels\);/;

/** Whether a scene composites with the template's synchronous copyToStage() (gl.readPixels into glPixels). */
export function usesSyncCopy(src) {
  return /function copyToStage\s*\(\)/.test(src) && LEGACY_READ.test(src);
}

/**
 * The scene with its synchronous copyToStage() made to await the copy hook.
 * Only a scene usesSyncCopy() names is changed; any other source is returned
 * as is. Remove once assets/template/reel-3d.html awaits
 * renderer.readPixelsAsync() and no reel from the older template is rendered
 * natively.
 */
export function rewriteSyncCopy(src) {
  if (!usesSyncCopy(src)) return src;
  let s = src;
  s = s.replace(/function copyToStage\s*\(\)/, "async function copyToStage()");
  s = s.replace(/(\n\s*)function seek\s*\(t\)/, "$1async function seek(t)");
  s = s.replace(LEGACY_READ, "await renderer.readPixelsAsync(glPixels, { bottomUp: true });");
  s = s.replace(/([^.\w])copyToStage\(\);/g, "$1await copyToStage();");
  return s;
}

let gpuDevice = null;
// The GPU instance must stay referenced for the device's life: once it is
// garbage collected, the next buffer map crashes the process (Dawn, segfault).
let gpuInstance = null;

/**
 * The process's one WebGPU device (Dawn), created on first use, with the
 * WebGPU globals (GPUBufferUsage, ...) set on globalThis for this page.
 * Throws when the host has no adapter.
 */
async function device() {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  if (!gpuDevice) {
    gpuDevice = (async () => {
      gpuInstance = create([]);
      const adapter = await gpuInstance.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("native 3D: no WebGPU adapter on this host (Dawn found no GPU); render this reel in the browser (SVA_RENDERER=browser, the default)");
      const dev = await adapter.requestDevice();
      // Image/CanvasTexture sources are skia canvases; Dawn's copyExternalImageToTexture
      // can't consume them (uploads silent black). Route those through writeTexture.
      const { patchCanvasTextureUpload } = await import("./3d/gpu-texture-upload-fix.mjs");
      patchCanvasTextureUpload(dev);
      return dev;
    })();
  }
  return gpuDevice;
}

let openPage = null;
let opens = 0;

/**
 * Every own property of globalThis now, so restoreGlobals() can put back
 * exactly this set after a page added and replaced some.
 */
function snapshotGlobals() {
  return Object.getOwnPropertyDescriptors(globalThis);
}

function restoreGlobals(before) {
  for (const key of Reflect.ownKeys(globalThis)) {
    const was = before[key];
    const now = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!was) {
      if (now && now.configurable) delete globalThis[key];
      continue;
    }
    if (now.value !== was.value || now.get !== was.get || now.set !== was.set) Object.defineProperty(globalThis, key, was);
  }
}

/**
 * The 3D page globals for one open: the 2D host's page globals plus what
 * three and its loaders need in Node (requestAnimationFrame that never fires,
 * createElementNS("img"), Blob image decode, Request with page-relative URLs,
 * fetch that hands blob: URLs to Node).
 */
function globals3d({ reelDir, pageUrl, resolveLocal, answer, stage, faces, classes, onConsole }) {
  const g = pageGlobals({ reelDir, pageUrl, resolveLocal, answer, stage, faces, classes, console: makeConsole(onConsole) });
  const pageFetch = g.fetch;
  const nodeFetch = globalThis.fetch;
  const NodeRequest = globalThis.Request;
  const PageImage = g.Image;
  g.document.createElementNS = (ns, tag) => {
    if (String(tag).toLowerCase() === "img") {
      const img = new PageImage();
      img.addEventListener = (ev, cb) => { if (ev === "load") img.onload = cb; else if (ev === "error") img.onerror = cb; };
      img.removeEventListener = () => {};
      return img;
    }
    return new classes.Canvas(1, 1);
  };
  return {
    ...g,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    // three's FileLoader reports streamed download progress with it.
    ProgressEvent: class ProgressEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.lengthComputable = !!init.lengthComputable;
        this.loaded = init.loaded || 0;
        this.total = init.total || 0;
      }
    },
    // GLTF embedded textures arrive as Blob; decode via skia.
    async createImageBitmap(src) {
      const img = typeof Blob !== "undefined" && src instanceof Blob ? await skia.loadImage(Buffer.from(await src.arrayBuffer())) : src;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const c = new classes.Canvas(w, h);
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c;
    },
    // three's FileLoader builds `new Request(url)` before fetch; resolve a
    // relative URL against the page, as the browser does.
    Request: class Request extends NodeRequest {
      constructor(input, init) {
        super(typeof input === "string" || input instanceof URL ? new URL(String(input), pageUrl).href : input, init);
      }
    },
    fetch(input, init) {
      const url = input && typeof input === "object" && "url" in input ? input.url : String(input);
      return url.startsWith("blob:") ? nodeFetch(input, init) : pageFetch(url);
    },
  };
}

function loaderConfig({ reelDir, scenes, openId }) {
  const threeBuild = path.join(THREE_DIR, "build");
  const postShim = pathToFileURL(path.join(HERE, "3d", "webgpu-post-shim.mjs")).href;
  const addonOverrides = {};
  for (const f of ["EffectComposer.js", "RenderPass.js", "UnrealBloomPass.js", "OutputPass.js"]) addonOverrides["postprocessing/" + f] = postShim;
  addonOverrides["objects/Reflector.js"] = pathToFileURL(path.join(HERE, "3d", "reflector-stub.mjs")).href;
  addonOverrides["lights/RectAreaLightUniformsLib.js"] = pathToFileURL(path.join(HERE, "3d", "rectarea-stub.mjs")).href;
  const sceneUrls = {};
  const sources = {};
  scenes.forEach((source, i) => {
    const sentinel = `sva-scene:${openId}-${i}`;
    const url = `${pathToFileURL(path.join(reelDir, `__sva_scene_${i}__.mjs`)).href}?sva-open=${openId}`;
    sceneUrls[sentinel] = url;
    sources[url] = source;
  });
  return {
    sentinels: Object.keys(sceneUrls),
    data: {
      shimUrl: SHIM_URL,
      threeWebgpuUrl: pathToFileURL(path.join(threeBuild, "three.webgpu.js")).href,
      threeTslUrl: pathToFileURL(path.join(threeBuild, "three.tsl.js")).href,
      addonsBaseUrl: pathToFileURL(path.join(THREE_DIR, "examples", "jsm")).href + "/",
      addonOverrides,
      sceneUrls,
      scenes: sources,
      openId,
    },
  };
}

/**
 * A 3D reel page, its scripts not yet run: the same shape as reel-host.mjs's
 * createReelRealm, except runScripts() is async (it imports the module scene).
 * Throws when another 3D page is open in this process, or when reel.html has
 * elements beside its canvas.
 * @param {{htmlPath: string, pageUrl?: string, resolveLocal?: (url: string) => string|null,
 *   answer?: ((url: string) => Promise<Response|null>)|null,
 *   onConsole?: (type: string, text: string) => void}} opts
 */
export function createReel3DRealm({ htmlPath, pageUrl = pathToFileURL(htmlPath).href, resolveLocal = (u) => (u.startsWith("file:") ? fileURLToPath(u) : null), answer = null, onConsole = consoleToStdio }) {
  if (openPage) throw new Error("native 3D: one 3D reel page per process can be open at a time and another is open; close it first (render.mjs runs a 3D reel with --workers 1)");
  const reelDir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, "utf8");
  assertCanvasOnly(html);
  const blocks = scriptBlocks(html, reelDir);
  const { classes, stage, width, height, faces } = reelStage(html, reelDir);

  const token = {};
  openPage = token;
  let shim = null;
  const before = snapshotGlobals();
  Object.assign(globalThis, globals3d({ reelDir, pageUrl, resolveLocal, answer, stage, faces, classes, onConsole }));
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  trapReelSeek(globalThis, { stage, beforeSeek: (t, reel) => shim && shim.beginSeek(t, reel.fps) });

  const compiled = new Map();
  const evaluate = (fn, arg) => {
    if (typeof fn !== "function") return vm.runInThisContext(String(fn), { filename: "page.evaluate" });
    const src = fn.toString();
    let f = compiled.get(src);
    if (!f) {
      f = vm.runInThisContext(`(${src})`, { filename: `page.evaluate ${fn.name || "(anonymous)"}` });
      compiled.set(src, f);
    }
    return f(arg);
  };

  const runScripts = async () => {
    globalThis.__svaGpuDevice = await device();
    shim = await import(SHIM_URL);
    const openId = ++opens;
    const scenes = blocks.filter((b) => b.kind === "module").map((b) => rewriteSyncCopy(b.source));
    const { sentinels, data } = loaderConfig({ reelDir, scenes, openId });
    register("./3d/loader-hooks.mjs", import.meta.url, { data });
    const classic = blocks.filter((b) => b.kind === "classic").map((b) => b.source);
    // One script, as in the 2D realm: classic scripts share one lexical scope.
    if (classic.length) vm.runInThisContext(classic.join("\n;\n"), { filename: htmlPath });
    for (const s of sentinels) await import(s);
  };

  const dispose = () => {
    if (openPage !== token) return;
    if (shim) shim.disposeRenderers();
    compiled.clear();
    restoreGlobals(before);
    openPage = null;
  };

  return { global: globalThis, stage, width, height, is3d: true, evaluate, runScripts, dispose };
}

function consoleToStdio(type, text) {
  if (type === "error" || type === "warning") process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

/**
 * Load a 3D reel straight from its folder (the bench and smoke scripts; the
 * tools open reels through scripts/lib/browser.mjs). captions false (default)
 * opens ?captions=0, matching out/picture.mp4.
 * @returns {Promise<{reel, stage, width, height, fps, duration, seek, capturePng, captureRgba, dispose}>}
 */
export async function loadReel3D(reelDir, { captions = false } = {}) {
  const htmlPath = path.join(reelDir, "reel.html");
  const realm = createReel3DRealm({ htmlPath, pageUrl: pathToFileURL(htmlPath).href + (captions ? "" : "?captions=0") });
  await realm.runScripts();
  let reel = globalThis.__reel;
  for (let i = 0; i < 600 && !reel; i++) {
    await new Promise((r) => setTimeout(r, 50));
    reel = globalThis.__reel;
  }
  if (!reel) throw new Error("scene did not set window.__reel within 30s");
  if (reel.ready) await reel.ready;
  if (reel.preload) await (typeof reel.preload === "function" ? reel.preload() : reel.preload);
  return {
    reel,
    stage: realm.stage,
    width: realm.width,
    height: realm.height,
    fps: reel.fps,
    duration: reel.duration,
    seek: async (t) => { await globalThis.__reel.seek(t); },
    capturePng: () => realm.stage.toBufferSync("png"),
    captureRgba: () => realm.stage.toBufferSync("raw", { colorType: "rgba" }),
    dispose: realm.dispose,
  };
}
