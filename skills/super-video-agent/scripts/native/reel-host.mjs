// Native (no-browser) host for an SVA 2D reel.
//
// Runs a reel.html's inlined ENGINE + AUDIO + SCENE scripts in Node against
// skia-canvas's Canvas2D, shimming the handful of browser globals the engine
// and scene touch (document, window, Image, createImageBitmap, fetch,
// document.fonts). After loadReel() resolves, seek(t) draws one frame into the
// stage canvas exactly as the browser page would, and capture() returns the
// pixels. seek(t) is a pure function of t (the reel contract), so no warm-up is
// needed — skia is deterministic.
//
// Only the 2D Canvas path is supported. A reel that needs WebGL (3D) is out of
// scope here and will fail when its scene calls getContext("webgl").

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import skia from "skia-canvas";

const { Canvas, Image: SkiaImage, ImageData, FontLibrary } = skia;

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

// ---- reel.html parsing -----------------------------------------------------

/**
 * Every `<script>` in document order, inline or `src="..."`, as
 * [{source, filename}]. External src is read relative to the reel dir. The
 * inlined ENGINE/AUDIO and any film helper files (src/kit.js, src/scenes-*.js)
 * all attach globals the SCENE block then uses, so they must run in order.
 * A `type="module"` or `type="importmap"` script (the 3D template) is out of
 * scope for the 2D native path and throws.
 */
export function collectScripts(html, reelDir) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/) || [])[1];
    if (type && type !== "text/javascript" && type !== "application/javascript") {
      throw new Error(`reel.html has a <script type="${type}"> — the 2D native path supports only classic scripts (3D is out of scope)`);
    }
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1];
    if (src) {
      const abs = path.resolve(reelDir, src.split("?")[0]);
      out.push({ source: fs.readFileSync(abs, "utf8"), filename: abs });
    } else {
      out.push({ source: m[2], filename: `${path.join(reelDir, "reel.html")} (inline #${out.length})` });
    }
  }
  if (!out.length) throw new Error("reel.html has no <script> blocks");
  return out;
}

/** WIDTH / HEIGHT / FPS baked into whichever script declares them (the scene block). */
export function sceneDims(sources) {
  const joined = Array.isArray(sources) ? sources.map((s) => (typeof s === "string" ? s : s.source)).join("\n") : String(sources);
  const num = (name) => {
    const m = joined.match(new RegExp("var\\s+" + name + "\\s*=\\s*(\\d+(?:\\.\\d+)?)"));
    if (!m) throw new Error(`no ${name} declared in the reel scripts`);
    return Number(m[1]);
  };
  return { width: num("WIDTH"), height: num("HEIGHT"), fps: num("FPS") };
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

// ---- browser globals shim --------------------------------------------------

function resolveLocalPath(reelDir, url) {
  if (typeof url !== "string") return url;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("file:")) return fileURLToPath(url);
  if (/^https?:/.test(url)) return url;
  const clean = url.split("?")[0].split("#")[0];
  return path.resolve(reelDir, clean);
}

// Image whose relative src resolves against the reel dir (the browser resolves
// against the page URL). Stays a real skia Image so ctx.drawImage accepts it.
function makeImageClass(reelDir) {
  const srcDesc = Object.getOwnPropertyDescriptor(SkiaImage.prototype, "src");
  class HostImage extends SkiaImage {}
  Object.defineProperty(HostImage.prototype, "src", {
    configurable: true,
    get() {
      return srcDesc.get.call(this);
    },
    set(v) {
      srcDesc.set.call(this, resolveLocalPath(reelDir, v));
    },
  });
  return HostImage;
}

function makeFetch(reelDir) {
  return async function fetch(url) {
    const p = resolveLocalPath(reelDir, url);
    if (typeof p !== "string" || /^(data|https?):/.test(p) || !fs.existsSync(p)) {
      return {
        ok: false,
        status: 404,
        async json() {
          throw new Error(`fetch 404: ${url}`);
        },
        async text() {
          return "";
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }
    const buf = fs.readFileSync(p);
    return {
      ok: true,
      status: 200,
      async json() {
        return JSON.parse(buf.toString("utf8"));
      },
      async text() {
        return buf.toString("utf8");
      },
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  };
}

/**
 * document.fonts as a FontFaceSet-like Set: iterable, each face has load() ->
 * resolved (skia already registered the file synchronously), plus .ready.
 */
function makeFontFaceSet(faces) {
  const set = new Set(
    faces.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      status: "loaded",
      load() {
        this.status = "loaded";
        return Promise.resolve(this);
      },
    }))
  );
  set.ready = Promise.resolve(set);
  return set;
}

/**
 * Install the browser globals on globalThis for this reel. One reel per
 * process (the globals are shared). `captions` false renders the picture
 * (?captions=0), matching out/picture.mp4.
 */
export function installGlobals({ reelDir, stage, faces, captions = false }) {
  const HostImage = makeImageClass(reelDir);
  const document = {
    getElementById(id) {
      return id === "stage" ? stage : null;
    },
    querySelector(sel) {
      return sel === "canvas" || sel === "#stage" ? stage : null;
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === "canvas") return new Canvas(1, 1);
      return { tagName: String(tag).toUpperCase(), style: {} };
    },
    fonts: makeFontFaceSet(faces),
  };
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = document;
  globalThis.location = { search: captions ? "" : "?captions=0", href: "file://" + reelDir + "/reel.html" };
  globalThis.Image = HostImage;
  globalThis.ImageData = ImageData;
  globalThis.fetch = makeFetch(reelDir);
  globalThis.createImageBitmap = async function createImageBitmap(src) {
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    const c = new Canvas(w, h);
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    return c;
  };
  if (typeof globalThis.OffscreenCanvas !== "undefined") delete globalThis.OffscreenCanvas;
  return document;
}

// ---- load + run ------------------------------------------------------------

/**
 * Load a reel into this process and return a handle that can draw any frame.
 * @param {string} reelDir  directory holding reel.html (+ plan.json, voice/, assets/)
 * @param {{captions?: boolean}} [opts]
 * @returns {Promise<{reel, canvas, ctx, width, height, fps, duration, meta, seek, capture, dispose}>}
 */
export async function loadReel(reelDir, opts = {}) {
  const captions = !!opts.captions;
  const htmlPath = path.join(reelDir, "reel.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const scripts = collectScripts(html, reelDir);
  const { width, height, fps } = sceneDims(scripts);
  const faces = parseFontFaces(html);
  registerFonts(faces, reelDir);

  const canvas = new Canvas(width, height);

  installGlobals({ reelDir, stage: canvas, faces, captions });

  // Run every block in document order as ONE script in this realm. Classic
  // browser scripts share a global lexical environment, so a top-level
  // `const K` in src/kit.js is visible to the SCENE block; separate
  // runInThisContext calls would each discard their own lexical bindings, so
  // the blocks are concatenated into a single script here.
  const code = scripts.map((s) => s.source).join("\n;\n");
  vm.runInThisContext(code, { filename: htmlPath });

  const reel = globalThis.window.__reel;
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
  const capture = (format = "raw") => canvas.toBufferSync(format);

  const dispose = () => {
    try {
      delete globalThis.window.__reel;
      delete globalThis.Reel;
      delete globalThis.ReelAudio;
    } catch (e) {
      /* ignore */
    }
  };

  return { reel, canvas, ctx: canvas.getContext("2d"), width: meta.width, height: meta.height, fps: meta.fps, duration: meta.duration, meta, seek, capture, dispose };
}
