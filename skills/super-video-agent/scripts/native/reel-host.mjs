// Native (no-browser) host for an SVA 2D reel.
//
// Runs a reel.html's inlined ENGINE + AUDIO + SCENE scripts in Node against
// skia-canvas's Canvas2D, shimming the handful of browser globals the engine
// and scene touch (document, window, location, Image, createImageBitmap,
// fetch, document.fonts, timers, console). Each reel runs in its own realm
// (a vm context with its own globals and its own CanvasRenderingContext2D
// prototype), so two reels open in one process share no page state. After
// the scripts run and __reel.ready resolves, seek(t) draws one frame into the
// stage canvas exactly as the browser page would.
//
// This realm runs classic scripts on the 2D Canvas. A reel with a module
// scene (the 3D template) runs in reel-host-3d.mjs instead; a classic scene
// that asks for a WebGL canvas context fails with a message that says so.
// Both hosts clear the stage before each seek (trapReelSeek).

import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import skia from "skia-canvas";
import { mimeOf } from "../lib/server.mjs";
import { nativeRaster } from "./raster.mjs";

const { Canvas, Image: SkiaImage, ImageData, FontLibrary, Path2D, DOMMatrix, CanvasGradient, CanvasPattern } = skia;

// Every 2D context skia hands out gets Chromium-matching text defaults. Chromium
// canvas text is grayscale-AA with no hinting; skia's "optimizeLegibility" text
// rendering measured closer to it than the default on Korean + Latin reel text
// (image smoothing is left at skia's default to match Chromium's "low"). Applied
// once at module load so the film's own offscreen contexts get it too.
const _origGetContext = Canvas.prototype.getContext;
Canvas.prototype.getContext = function patchedGetContext(...args) {
  const ctx = _origGetContext.apply(this, args);
  if (ctx && typeof ctx === "object") {
    try {
      ctx.textRendering = "optimizeLegibility";
    } catch (e) {
      /* older skia without the setter */
    }
  }
  return ctx;
};

/** The error a scene asking for a WebGL canvas context throws: what it asked for and what to run instead. */
export function noGlContext(kind) {
  return new Error(`the native renderer has no WebGL canvas context: the scene asked for a "${kind}" canvas context. It draws 2D canvas reels and three.js reels (a module scene that imports "three"); render this reel in the browser (SVA_RENDERER=browser, the default)`);
}

// ---- reel.html parsing -----------------------------------------------------

const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript"]);

/**
 * Every script the browser would run, in document order, inline or
 * `src="..."`, as [{kind: "classic"|"module", source, filename}]. External src
 * is read relative to the reel dir. The inlined ENGINE/AUDIO and any film
 * helper files (src/kit.js, src/scenes-*.js) attach globals the SCENE block
 * then uses, so they run in order. An importmap is skipped (the 3D host
 * resolves "three" itself), as is any other non-script type (data blocks).
 */
export function scriptBlocks(html, reelDir) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const type = ((attrs.match(/\btype\s*=\s*["']([^"']+)["']/) || [])[1] || "").trim().toLowerCase();
    const kind = type === "module" ? "module" : CLASSIC_TYPES.has(type) ? "classic" : null;
    if (!kind) continue;
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1];
    if (src) {
      const abs = path.resolve(reelDir, src.split("?")[0]);
      out.push({ kind, source: fs.readFileSync(abs, "utf8"), filename: abs });
    } else {
      out.push({ kind, source: m[2], filename: `${path.join(reelDir, "reel.html")} (inline #${out.length})` });
    }
  }
  if (!out.length) throw new Error("reel.html has no <script> blocks");
  return out;
}

/** Whether reel.html runs a module script (a 3D reel: reel-host-3d.mjs hosts it). */
export function isModuleReel(html) {
  return /<script\b[^>]*\btype\s*=\s*["']\s*module\s*["']/i.test(html);
}

/** The classic scripts of a reel without a module scene; a module reel throws (it needs the 3D host). */
export function collectScripts(html, reelDir) {
  const blocks = scriptBlocks(html, reelDir);
  if (blocks.some((b) => b.kind === "module")) throw new Error("reel.html has a <script type=\"module\"> scene (a 3D reel): open it through scripts/lib/browser.mjs, which hosts it in scripts/native/reel-host-3d.mjs");
  return blocks;
}

/**
 * Throws the native refusal when reel.html's <body> holds elements beside
 * the canvas: the native renderer draws only the canvas.
 */
export function assertCanvasOnly(html) {
  const extra = bodyElementsBesideCanvas(html);
  if (extra.length) throw new Error(`the native renderer draws only the <canvas>; reel.html's <body> also has <${extra.join(">, <")}>, which would be missing from the picture. Render this reel in the browser (SVA_RENDERER=browser, the default)`);
}

/**
 * Elements in reel.html's <body> other than <canvas>, <script>, <style> and
 * <noscript>, as tag names. The native renderer draws only the canvas, so a
 * page with any other visible element would lose it from the picture.
 */
export function bodyElementsBesideCanvas(html) {
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)(<\/body>|$)/i) || [])[1] || "";
  const bare = body.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const tags = [...bare.matchAll(/<([a-zA-Z][\w-]*)\b/g)].map((t) => t[1].toLowerCase());
  return [...new Set(tags.filter((t) => t !== "canvas"))];
}

/**
 * The first <canvas>'s width and height attributes, as the browser sizes it
 * (300 x 150 when an attribute is missing). Throws when the page has no canvas.
 */
export function stageSize(html) {
  const tag = (html.match(/<canvas\b[^>]*>/i) || [])[0];
  if (!tag) throw new Error("reel.html has no <canvas>");
  const attr = (name, fallback) => {
    const v = Number((tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i")) || [])[1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { width: attr("width", 300), height: attr("height", 150) };
}

/**
 * The @font-face rules in the reel's <style>, as [{family, weight, style, file}].
 * `file` is the url() path relative to the reel dir.
 */
export function parseFontFaces(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/i);
  if (!style) return [];
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(style[1]))) {
    const body = m[1];
    const family = (body.match(/font-family:\s*['"]?([^'";]+)['"]?/) || [])[1];
    const file = (body.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/) || [])[1];
    if (!family || !file) continue;
    const weight = (body.match(/font-weight:\s*([^;]+)/) || [])[1];
    const style2 = (body.match(/font-style:\s*([^;]+)/) || [])[1];
    faces.push({ family: family.trim(), weight: (weight || "400").trim(), style: (style2 || "normal").trim(), file: file.trim() });
  }
  return faces;
}

/** Register every declared face with skia-canvas, grouped by family. */
export function registerFonts(faces, reelDir) {
  const byFamily = new Map();
  for (const f of faces) {
    const abs = path.resolve(reelDir, f.file);
    if (!fs.existsSync(abs)) continue;
    if (!byFamily.has(f.family)) byFamily.set(f.family, []);
    byFamily.get(f.family).push(abs);
  }
  for (const [family, files] of byFamily) {
    try {
      FontLibrary.use(family, files);
    } catch (e) {
      // A face skia cannot parse is reported but does not stop the render;
      // the engine's own font-load-failed issue would surface a real gap.
      process.stderr.write(`font register failed for ${family}: ${e.message}\n`);
    }
  }
  return byFamily;
}

// ---- canvas classes ---------------------------------------------------------

const GL_KINDS = /^(webgl2?|experimental-webgl|webgpu|bitmaprenderer)$/i;

/**
 * A Canvas class and CanvasRenderingContext2D for one realm. Every 2D context
 * a canvas of this class hands out gets the realm's own prototype (inheriting
 * skia's), so a page that wraps CanvasRenderingContext2D.prototype (the
 * state-checks probe) changes only its own realm. Asking for a WebGL context
 * throws noGlContext.
 */
let gpuFallbackWarned = false;

/** Says once per process when SVA_NATIVE_RASTER=gpu got a CPU canvas (no usable GPU). */
function warnGpuFallback(canvas, write = (l) => process.stderr.write(l)) {
  if (nativeRaster() !== "gpu" || gpuFallbackWarned) return;
  const engine = canvas.engine ?? {};
  if (engine.renderer === "GPU") return;
  gpuFallbackWarned = true;
  write(`native raster: GPU asked for but not available, drawing on the CPU${engine.error ? ` (${engine.error})` : ""}\n`);
}

export function realmCanvasClasses(raster = nativeRaster()) {
  const proto = Object.create(skia.CanvasRenderingContext2D.prototype);
  function CanvasRenderingContext2D() {
    throw new TypeError("Illegal constructor (use canvas.getContext(\"2d\"))");
  }
  CanvasRenderingContext2D.prototype = proto;
  Object.defineProperty(proto, "constructor", { value: CanvasRenderingContext2D, writable: true, configurable: true });
  class RealmCanvas extends Canvas {
    // Every canvas of the reel (stage and offscreen) rasterizes the same way
    // (SVA_NATIVE_RASTER): CPU and GPU output differ by rounding, and a frame
    // mixing both would differ from either. Each is repeatable on its own.
    constructor(width, height, opts = {}) {
      super(width, height, { ...opts, gpu: raster === "gpu" });
    }
    getContext(kind, settings) {
      if (GL_KINDS.test(String(kind))) throw noGlContext(kind);
      const ctx = super.getContext(kind, settings);
      if (ctx && Object.getPrototypeOf(ctx) !== proto) Object.setPrototypeOf(ctx, proto);
      return ctx;
    }
    get isConnected() {
      return false;
    }
  }
  return { Canvas: RealmCanvas, CanvasRenderingContext2D };
}

// ---- browser globals shim --------------------------------------------------

/** A resolver from an absolute URL to a local file for a page opened from a file: URL. */
function fileUrlResolver(url) {
  return url.startsWith("file:") ? fileURLToPath(url) : null;
}

// Image whose relative src resolves against the page URL, as the browser
// resolves it. Stays a real skia Image so ctx.drawImage accepts it.
function makeImageClass(pageUrl, resolveLocal) {
  const srcDesc = Object.getOwnPropertyDescriptor(SkiaImage.prototype, "src");
  class HostImage extends SkiaImage {}
  Object.defineProperty(HostImage.prototype, "src", {
    configurable: true,
    get() {
      return srcDesc.get.call(this);
    },
    set(v) {
      const s = String(v);
      if (s.startsWith("data:")) return srcDesc.set.call(this, s);
      const abs = new URL(s, pageUrl).href;
      srcDesc.set.call(this, resolveLocal(abs) || abs);
    },
  });
  return HostImage;
}

/**
 * fetch for the page: `answer(url)` first (routes and served overrides; null
 * passes), then data: URLs, then the local file the URL maps to; anything
 * else is a 404 like the reel server's.
 */
function makeFetch(pageUrl, resolveLocal, answer) {
  return async function fetch(input) {
    const url = new URL(String(input), pageUrl).href;
    const answered = answer ? await answer(url) : null;
    if (answered) return answered;
    if (url.startsWith("data:")) return globalThis.fetch(url);
    const file = resolveLocal(url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response(`not found: ${url}`, { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200, headers: { "content-type": mimeOf(file) } });
  };
}

/**
 * document.fonts as a FontFaceSet-like Set: iterable, each face "loaded" when
 * its file exists (skia registered it synchronously) and "error" otherwise,
 * face.load(), set.load(font) -> the faces of the families the CSS font names,
 * set.check(), and .ready.
 */
function makeFontFaceSet(faces, reelDir) {
  const set = new Set(
    faces.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      status: fs.existsSync(path.resolve(reelDir, f.file)) ? "loaded" : "error",
      load() {
        return this.status === "loaded" ? Promise.resolve(this) : Promise.reject(new Error(`font file not found: ${f.file}`));
      },
    }))
  );
  const named = (font) => {
    const families = cssFontFamilies(font);
    return [...set].filter((f) => families.includes(f.family.toLowerCase()));
  };
  set.load = async (font) => named(font).filter((f) => f.status === "loaded");
  set.check = (font) => named(font).every((f) => f.status === "loaded");
  set.ready = Promise.resolve(set);
  return set;
}

/** The family names of a CSS font shorthand ("bold 64px 'Do Hyeon', sans-serif"), lower-cased, quotes removed. */
export function cssFontFamilies(font) {
  const m = /\d(?:[\d.]*)(?:px|pt|em|rem|%)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(String(font));
  if (!m) return [];
  return m[1].split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
}

function makeDocument({ stage, faces, reelDir, CanvasClass }) {
  return {
    body: null, // no DOM is drawn natively: DOM probes find no element over the canvas
    getElementById(id) {
      return id === "stage" ? stage : null;
    },
    querySelector(sel) {
      return sel === "canvas" || sel === "#stage" ? stage : null;
    },
    querySelectorAll(sel) {
      return sel === "canvas" || sel === "#stage" ? [stage] : [];
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === "canvas") return new CanvasClass(1, 1);
      return { tagName: String(tag).toUpperCase(), style: {} };
    },
    fonts: makeFontFaceSet(faces, reelDir),
  };
}

function makeLocation(pageUrl) {
  const u = new URL(pageUrl);
  return { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash };
}

// Timers whose callbacks report a throw through onError (the page's uncaught
// error), and that dispose() clears so a closed realm leaves nothing running.
function makeTimers(onError) {
  const live = new Set();
  const guard = (fn) => (...a) => {
    try {
      fn(...a);
    } catch (e) {
      onError(e);
    }
  };
  const globals = {
    setTimeout(fn, ms, ...a) {
      const h = setTimeout((...x) => {
        live.delete(h);
        guard(fn)(...x);
      }, ms, ...a);
      live.add(h);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clearTimeout(h);
    },
    setInterval(fn, ms, ...a) {
      const h = setInterval(guard(fn), ms, ...a);
      live.add(h);
      return h;
    },
    clearInterval(h) {
      live.delete(h);
      clearInterval(h);
    },
    queueMicrotask(fn) {
      queueMicrotask(guard(fn));
    },
  };
  const clearAll = () => {
    for (const h of live) {
      clearTimeout(h);
      clearInterval(h);
    }
    live.clear();
  };
  return { globals, clearAll };
}

/** A console whose every call reaches onConsole(type, text), with Playwright's type names. */
export function makeConsole(onConsole) {
  const say = (type) => (...args) => onConsole(type, util.format(...args));
  return { log: say("log"), info: say("info"), debug: say("debug"), trace: say("trace"), warn: say("warning"), error: say("error") };
}

// ---- seek ------------------------------------------------------------------

const HOSTED_SEEK = Symbol.for("sva.native.hostedSeek");
const baseCtx = skia.CanvasRenderingContext2D.prototype;

/**
 * Clears the whole stage to transparent, whatever transform the page left
 * set. skia-canvas keeps every drawing command since the last full clear and
 * replays them on each read, so a page that paints the stage without
 * clearRect would grow memory and slow down with every frame. Calls skia's
 * own methods, so a page that wraps its context prototype sees nothing.
 */
export function clearStage(stage) {
  const ctx = stage.getContext("2d");
  baseCtx.save.call(ctx);
  baseCtx.setTransform.call(ctx, 1, 0, 0, 1, 0, 0);
  baseCtx.clearRect.call(ctx, 0, 0, stage.width, stage.height);
  baseCtx.restore.call(ctx);
}

/**
 * Makes `global.__reel` an accessor that wraps the reel's seek(t) when the
 * page assigns it (or first reads it back): the stage is cleared, then
 * `beforeSeek(t, reel)` runs, then the page's own seek. A reel with
 * `nativeKeepStage: true` draws over the last frame instead (a page that
 * means to accumulate). Every caller (seekTo, probes, the page itself) goes
 * through the wrapped seek. A sync seek stays sync.
 */
export function trapReelSeek(global, { stage, beforeSeek = () => {} }) {
  let reel;
  Object.defineProperty(global, "__reel", {
    configurable: true,
    enumerable: true,
    get() {
      hostSeek(reel, stage, beforeSeek);
      return reel;
    },
    set(v) {
      reel = v;
      hostSeek(reel, stage, beforeSeek);
    },
  });
}

function hostSeek(reel, stage, beforeSeek) {
  if (!reel || typeof reel !== "object") return;
  const own = Object.getOwnPropertyDescriptor(reel, "seek");
  if (!own || !own.writable || typeof own.value !== "function" || own.value[HOSTED_SEEK]) return;
  const seek = own.value;
  const hosted = function (t) {
    if (reel.nativeKeepStage !== true) clearStage(stage);
    beforeSeek(t, reel);
    return seek.apply(this, arguments);
  };
  hosted[HOSTED_SEEK] = true;
  reel.seek = hosted;
}

/**
 * The globals a reel page sees. `pageUrl` is the URL the page was opened at
 * (its search is location.search: ?captions=0, ?layer=..., ?lang=...);
 * `resolveLocal(absUrl)` maps a URL to the local file it serves (or null);
 * `reelDir` is where the @font-face files resolve.
 */
export function pageGlobals({ reelDir, pageUrl, resolveLocal = fileUrlResolver, answer = null, stage, faces, classes = { Canvas, CanvasRenderingContext2D: skia.CanvasRenderingContext2D }, timers = {}, console: pageConsole = globalThis.console }) {
  return {
    document: makeDocument({ stage, faces, reelDir, CanvasClass: classes.Canvas }),
    location: makeLocation(pageUrl),
    Image: makeImageClass(pageUrl, resolveLocal),
    ImageData,
    Path2D,
    DOMMatrix,
    CanvasGradient,
    CanvasPattern,
    CanvasRenderingContext2D: classes.CanvasRenderingContext2D,
    fetch: makeFetch(pageUrl, resolveLocal, answer),
    Response,
    async createImageBitmap(src) {
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight || src.height;
      const c = new classes.Canvas(w, h);
      c.getContext("2d").drawImage(src, 0, 0, w, h);
      return c;
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    console: pageConsole,
    ...timers,
  };
}

// ---- realm -----------------------------------------------------------------

// A context whose global is an ordinary object (Node >= 22.8) keeps global
// lookups as fast as in the main realm; older Nodes get a contextified one.
function newContext() {
  if (vm.constants && vm.constants.DONT_CONTEXTIFY) {
    const g = vm.createContext(vm.constants.DONT_CONTEXTIFY);
    return { context: g, global: g };
  }
  const context = vm.createContext({});
  return { context, global: vm.runInContext("globalThis", context) };
}

/**
 * The page's stage: a canvas of the realm's classes at the <canvas> tag's
 * size, connected and laid out at the origin, with the reel's fonts registered.
 */
export function reelStage(html, reelDir) {
  const { width, height } = stageSize(html);
  const faces = parseFontFaces(html);
  registerFonts(faces, reelDir);
  const classes = realmCanvasClasses();
  const stage = new classes.Canvas(width, height);
  warnGpuFallback(stage);
  Object.defineProperty(stage, "isConnected", { value: true });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 });
  return { classes, stage, width, height, faces };
}

/**
 * A realm holding one reel page, its scripts not yet run.
 * @param {{htmlPath: string, pageUrl?: string, resolveLocal?: (url: string) => string|null,
 *   answer?: ((url: string) => Promise<Response|null>)|null,
 *   onConsole?: (type: string, text: string) => void, onError?: (e: unknown) => void}} opts
 *   pageUrl: the URL the page is opened at (default: the file's URL);
 *   answer: fetch responses the caller supplies (routes, served overrides).
 * @returns {{global: object, stage: object, width: number, height: number,
 *   evaluate: (fn: Function|string, arg?: unknown) => unknown, runScripts: () => void, dispose: () => void}}
 */
export function createReelRealm({ htmlPath, pageUrl = pathToFileURL(htmlPath).href, resolveLocal = fileUrlResolver, answer = null, onConsole = consoleToStdio, onError = (e) => process.stderr.write(`page error: ${e && e.stack ? e.stack : e}\n`) }) {
  const reelDir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, "utf8");
  const scripts = collectScripts(html, reelDir);
  assertCanvasOnly(html);
  const { classes, stage, width, height, faces } = reelStage(html, reelDir);

  const timers = makeTimers(onError);
  const { context, global } = newContext();
  Object.assign(global, pageGlobals({ reelDir, pageUrl, resolveLocal, answer, stage, faces, classes, timers: timers.globals, console: makeConsole(onConsole) }));
  global.window = global;
  global.self = global;
  trapReelSeek(global, { stage });

  const compiled = new Map();
  const evaluate = (fn, arg) => {
    if (typeof fn !== "function") return vm.runInContext(String(fn), context, { filename: "page.evaluate" });
    const src = fn.toString();
    let f = compiled.get(src);
    if (!f) {
      f = vm.runInContext(`(${src})`, context, { filename: `page.evaluate ${fn.name || "(anonymous)"}` });
      compiled.set(src, f);
    }
    return f(arg);
  };

  // Every block in document order as ONE script. Classic browser scripts share
  // a global lexical environment, so a top-level `const K` in src/kit.js is
  // visible to the SCENE block; separate scripts would each keep their own
  // lexical bindings.
  const runScripts = () => vm.runInContext(scripts.map((s) => s.source).join("\n;\n"), context, { filename: htmlPath });

  const dispose = () => {
    timers.clearAll();
    compiled.clear();
  };

  return { global, stage, width, height, evaluate, runScripts, dispose };
}

function consoleToStdio(type, text) {
  if (type === "error" || type === "warning") process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

// ---- load + run ------------------------------------------------------------

/**
 * Load a reel into its own realm and return a handle that can draw any frame.
 * @param {string} reelDir  directory holding reel.html (+ plan.json, voice/, assets/)
 * @param {{captions?: boolean}} [opts] captions false (default) opens ?captions=0
 * @returns {Promise<{reel, canvas, ctx, width, height, fps, duration, meta, seek, capture, dispose}>}
 */
export async function loadReel(reelDir, opts = {}) {
  const htmlPath = path.join(reelDir, "reel.html");
  const pageUrl = pathToFileURL(htmlPath).href + (opts.captions ? "" : "?captions=0");
  const realm = createReelRealm({ htmlPath, pageUrl });
  realm.runScripts();

  const reel = realm.global.__reel;
  if (!reel) throw new Error("reel did not assign window.__reel");
  await reel.ready;
  if (reel.preload) await (typeof reel.preload === "function" ? reel.preload() : reel.preload);

  const meta = {
    width: reel.width,
    height: reel.height,
    fps: reel.fps,
    duration: reel.duration,
    shots: reel.shots || [],
    layers: reel.layers || [],
  };

  const seek = async (t) => {
    const r = reel.seek(t);
    if (r && typeof r.then === "function") await r;
  };

  // Raw RGBA (what the ffmpeg rawvideo pipe wants) or a PNG buffer matching the
  // browser's toDataURL capture, for frame-accurate SSIM.
  const capture = (format = "raw") => realm.stage.toBufferSync(format);

  return { reel, canvas: realm.stage, ctx: realm.stage.getContext("2d"), width: meta.width, height: meta.height, fps: meta.fps, duration: meta.duration, meta, seek, capture, dispose: realm.dispose };
}
