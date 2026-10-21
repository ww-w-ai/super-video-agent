// The part of a Playwright page that the SVA tools use, backed by the native
// reel host instead of Chromium (SVA_RENDERER=native). lib/browser.mjs opens
// it in place of a browser page, so every tool that goes through openReel /
// seekTo / captureFrame / page.evaluate runs natively unchanged.
//
// A 2D reel runs in its own vm realm (reel-host.mjs). A reel with a module
// scene (3D, "three") runs on WebGPU in this process's main realm
// (reel-host-3d.mjs), one such page per process at a time; `native3d` says
// which one this page holds.
//
// Implemented: on("pageerror" | "console"), route(RegExp, handler) with
// route.fulfill, addInitScript(fn, arg), goto(url), waitForFunction(fn, arg,
// {timeout}), evaluate(fn, arg), close(), and capturePng() (the stage canvas as
// PNG bytes). evaluate compiles `fn` from its source in the page's realm, as
// Playwright does, and copies the argument and the result across with
// structuredClone. Any other page member, and any other use of a route or of
// the handle waitForFunction returns, throws "not supported on
// SVA_RENDERER=native: <what>".

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createReelRealm, isModuleReel } from "./reel-host.mjs";
import { servedSite, servedFilePath } from "../lib/server.mjs";

/** The error for a page feature the native backend does not provide. */
export function unsupportedNative(what) {
  return new Error(`not supported on SVA_RENDERER=native: ${what}`);
}

/**
 * `target` with every missing member throwing unsupportedNative("<name>.<member>").
 * `then` and `toJSON` read as undefined, so the object can be awaited and logged.
 */
export function strictSurface(target, name) {
  return new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === "symbol" || key in t) return Reflect.get(t, key, receiver);
      if (key === "then" || key === "toJSON") return undefined;
      throw unsupportedNative(`${name}.${key}`);
    },
  });
}

/**
 * A page (see the file comment) for one reel. Nothing is loaded until goto().
 * @returns {object} the page; `close()` disposes its realm
 */
export function createNativePage() {
  const listeners = { pageerror: [], console: [] };
  const routes = [];
  const initScripts = [];
  let realm = null;
  const emit = (event, payload) => {
    for (const fn of listeners[event]) fn(payload);
  };
  const needRealm = (what) => {
    if (!realm) throw new Error(`native page: ${what} before goto() or after close()`);
    return realm;
  };

  const page = {
    native: true,
    /** True once goto() opened a 3D (module scene) reel. */
    get native3d() {
      return !!(realm && realm.is3d);
    },
    on(event, fn) {
      if (!(event in listeners)) throw unsupportedNative(`page.on("${event}")`);
      listeners[event].push(fn);
      return page;
    },
    async route(pattern, handler) {
      if (!(pattern instanceof RegExp)) throw unsupportedNative("page.route with a glob or predicate (pass a RegExp)");
      routes.push({ pattern, handler });
    },
    async addInitScript(fn, arg) {
      if (realm) throw unsupportedNative("page.addInitScript after goto()");
      if (typeof fn !== "function") throw unsupportedNative("page.addInitScript with a script string or file");
      initScripts.push({ fn, arg });
    },
    async goto(url) {
      if (realm) throw unsupportedNative("a second page.goto on one page (open a new reel session)");
      realm = await openRealm(url, { routes, emit });
      for (const s of initScripts) realm.evaluate(s.fn, structuredClone(s.arg));
      try {
        await realm.runScripts();
      } catch (e) {
        emit("pageerror", e);
        throw crossRealmError(e);
      }
      return null;
    },
    async waitForFunction(fn, arg, { timeout = 30000 } = {}) {
      const until = Date.now() + timeout;
      for (;;) {
        if (await page.evaluate(fn, arg)) return strictSurface({}, "the handle page.waitForFunction returns");
        if (Date.now() >= until) throw new Error(`page.waitForFunction: Timeout ${timeout}ms exceeded.`);
        await new Promise((r) => setTimeout(r, 16));
      }
    },
    async evaluate(fn, arg) {
      const r = needRealm("page.evaluate");
      let value;
      try {
        value = await r.evaluate(fn, structuredClone(arg));
      } catch (e) {
        throw crossRealmError(e);
      }
      return cloneResult(value);
    },
    /** The stage canvas as PNG bytes (what captureFrame's toDataURL would decode to). */
    async capturePng() {
      return needRealm("page.capturePng").stage.toBufferSync("png");
    },
    /** The stage canvas as raw unpremultiplied RGBA bytes, the same pixels as capturePng without compressing them. */
    async captureRgba() {
      return needRealm("page.captureRgba").stage.toBufferSync("raw", { colorType: "rgba" });
    },
    /** The stage canvas's size in pixels (the raw frame's size). */
    stageSize() {
      const { stage } = needRealm("page.stageSize");
      return { width: stage.width, height: stage.height };
    },
    async close() {
      if (realm) realm.dispose();
      realm = null;
    },
  };
  return strictSurface(page, "page");
}

// The realm for `url`: a serveDir() URL maps to its root, a file: URL to its
// file. Fetches go through the page's routes, then the server's overrides.
// A module-scene reel gets the 3D host, loaded only then.
async function openRealm(url, { routes, emit }) {
  const target = new URL(url);
  const site = servedSite(url);
  let htmlPath;
  let resolveLocal;
  if (site) {
    htmlPath = servedFilePath(site.root, target.pathname);
    resolveLocal = (abs) => {
      const u = new URL(abs);
      if (u.origin === target.origin) return servedFilePath(site.root, u.pathname);
      return u.protocol === "file:" ? fileURLToPath(u) : null;
    };
  } else if (target.protocol === "file:") {
    htmlPath = fileURLToPath(target);
    resolveLocal = (abs) => (abs.startsWith("file:") ? fileURLToPath(abs) : null);
  } else {
    throw new Error(`SVA_RENDERER=native opens a reel from a lib/server.mjs serveDir() URL or a file: URL; ${url} is neither`);
  }
  if (!htmlPath) throw new Error(`native page: ${url} leaves the served folder`);
  const opts = {
    htmlPath,
    pageUrl: url,
    resolveLocal,
    answer: (abs) => answerFetch(abs, routes, site),
    onConsole: (type, text) => emit("console", { type: () => type, text: () => text }),
    onError: (e) => emit("pageerror", crossRealmError(e)),
  };
  if (!isModuleReel(fs.readFileSync(htmlPath, "utf8"))) return createReelRealm(opts);
  const { createReel3DRealm } = await import("./reel-host-3d.mjs");
  return createReel3DRealm(opts);
}

/** A Response for `url` from the first matching route, else the server's override body, else null. */
async function answerFetch(url, routes, site) {
  const hit = routes.find((r) => {
    r.pattern.lastIndex = 0;
    return r.pattern.test(url);
  });
  if (hit) return fulfilledBy(hit.handler, url);
  const body = site ? site.bodies[new URL(url).pathname] : undefined;
  if (body === undefined) return null;
  return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function fulfilledBy(handler, url) {
  let response = null;
  const request = strictSurface({ url: () => url }, "route.request()");
  const route = strictSurface(
    {
      request: () => request,
      async fulfill({ status = 200, contentType, body = "", headers = {} } = {}) {
        response = new Response(body, { status, headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) } });
      },
    },
    "route"
  );
  await handler(route);
  if (!response) throw unsupportedNative("a page.route handler that does not call route.fulfill()");
  return response;
}

function cloneResult(value) {
  try {
    return structuredClone(value);
  } catch (e) {
    throw new Error(`native page.evaluate returned a value that cannot cross back to Node (${e.message}); return plain data`);
  }
}

// An error thrown in the page's realm, as a Node Error with the same message
// (a realm's Error is not instanceof this realm's Error).
function crossRealmError(e) {
  if (e instanceof Error) return e;
  const message = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  const err = new Error(message);
  if (e && typeof e === "object" && e.stack) err.stack = `Error: ${message}\n${String(e.stack).split("\n").slice(1).join("\n")}`;
  return err;
}
