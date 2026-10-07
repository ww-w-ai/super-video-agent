// Playwright-core browser session: opens a reel page, waits for
// window.__reel.ready, seeks to a time, and captures the single <canvas>
// as a PNG buffer via toDataURL (no screenshot compositing, so we get
// exactly the pixels the engine drew).
import { deadAirRunsFromHashes } from "./dead-air.mjs";
import { getChromium } from "./playwright.mjs";

const DEFAULT_READY_TIMEOUT_MS = 120000;

/**
 * How long each page-load step may take before openReel gives up:
 * SVA_READY_TIMEOUT_MS when it is a positive number, else 120 s.
 * @param {Record<string, string|undefined>} env
 */
export function readyTimeoutMs(env = process.env) {
  const v = Number(env.SVA_READY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_READY_TIMEOUT_MS;
}

// A failed WebGL draw reaches the console as a warning, not an error, so an
// errors-only listener passes a frame that drew nothing.
const GL_MESSAGE = /webgl|\bGL[ _:]|\bgl[A-Z]\w*\s*[(:]|glsl|shader|drawElements|drawArrays|framebuffer|INVALID_(?:OPERATION|VALUE|ENUM)/i;
const GL_NOISE = /GPU stall due to ReadPixels/i;
// What a GL message must say for the frame to be definitely wrong.
const GL_DEFINITE = /INVALID_(?:OPERATION|VALUE|ENUM|FRAMEBUFFER_OPERATION)|CONTEXT[_ ]LOST|OUT_OF_MEMORY/i;

/**
 * Records a console message in `gl` when it is a WebGL one: warnings and
 * errors that name a GL call or state. definite = a GL error code or a lost
 * context (the frame is wrong); any other GL message is a warning to report.
 * @param {Map<string, {text: string, definite: boolean, count: number}>} gl
 * @param {string} type console message type
 * @param {string} text
 */
export function noteGlMessage(gl, type, text) {
  if (type !== "warning" && type !== "error") return;
  if (!GL_MESSAGE.test(text) || GL_NOISE.test(text)) return;
  const key = text.replace(/0x[0-9a-f]+/gi, "0x…").replace(/\d{3,}/g, "N");
  const seen = gl.get(key);
  if (seen) seen.count++;
  else gl.set(key, { text, definite: GL_DEFINITE.test(text), count: 1 });
}

/**
 * The session's WebGL console messages so far, split into definite (a GL
 * error: the frame is wrong, stop the step) and warnings (report).
 * @param {{gl: Map<string, {text: string, definite: boolean, count: number}>}} session
 */
export function glIssues(session) {
  const all = [...session.gl.values()];
  return { definite: all.filter((g) => g.definite), warnings: all.filter((g) => !g.definite) };
}

/**
 * Report lines for glIssues(): "GL error: ..." for each definite one,
 * "GL warning: ..." for the rest; empty when the page logged none.
 * @param {ReturnType<typeof glIssues>} issues
 */
export function glReportLines(issues) {
  const line = (kind, g) => `${kind}: ${g.text.slice(0, 300)}${g.count > 1 ? ` (x${g.count})` : ""}`;
  return [...issues.definite.map((g) => line("GL error", g)), ...issues.warnings.map((g) => line("GL warning", g))];
}

const GPU_MODES = ["default", "gpu", "swiftshader"];

/**
 * Chromium launch options from the environment (the skill's render config).
 *   SVA_GPU          default (Playwright's own flags) | gpu (ask for the real GPU:
 *                    ignore the GPU blocklist, GPU raster; ANGLE on Metal / EGL) |
 *                    swiftshader (force the software renderer).
 *   SVA_CHROME_ARGS  extra Chromium flags, added last: space separated, or a JSON
 *                    array of strings when the value starts with "[" (an argument may hold spaces).
 * @param {Record<string, string|undefined>} env
 * @param {string} [platform]
 */
export function chromeLaunchOptions(env = process.env, platform = process.platform) {
  const mode = (env.SVA_GPU || "default").toLowerCase();
  if (!GPU_MODES.includes(mode)) throw new Error(`SVA_GPU takes ${GPU_MODES.join(" | ")} (got "${env.SVA_GPU}")`);
  const args = [];
  const opts = { headless: true, args };
  if (mode === "gpu") {
    args.push("--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy");
    if (platform === "darwin") args.push("--use-angle=metal");
    else if (platform === "linux") args.push("--use-gl=angle", "--use-angle=gl-egl");
    opts.ignoreDefaultArgs = ["--disable-gpu"];
  } else if (mode === "swiftshader") {
    args.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  }
  args.push(...parseChromeArgs(env.SVA_CHROME_ARGS));
  return opts;
}

/**
 * SVA_CHROME_ARGS as a list: a value starting with "[" is a JSON array of
 * strings (an argument may then hold spaces), anything else splits on whitespace.
 * @param {string|undefined} value
 * @returns {string[]}
 */
export function parseChromeArgs(value) {
  if (!value || !value.trim()) return [];
  const text = value.trim();
  if (!text.startsWith("[")) return text.split(/\s+/).filter(Boolean);
  let list;
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw new Error(`SVA_CHROME_ARGS starts with "[" so it must be a JSON array of strings, e.g. ["--user-agent=My Agent"] (${e.message})`);
  }
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
    throw new Error('SVA_CHROME_ARGS as JSON must be an array of strings, e.g. ["--user-agent=My Agent"]');
  }
  return list.filter(Boolean);
}

/** Whether a WebGL renderer string names a software rasteriser. */
export function isSoftwareRenderer(name) {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name || "");
}

/**
 * Opens a blank page with the launch options render pages use and reads the
 * WebGL renderer: {webgl, renderer, vendor, software, mode, args}. A fact for
 * `setup.mjs --check`; nothing here fails.
 * @param {Record<string, string|undefined>} [env]
 */
export async function gpuReport(env = process.env) {
  const chromium = await getChromium();
  const opts = chromeLaunchOptions(env);
  const browser = await chromium.launch(opts);
  try {
    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return { webgl: false, renderer: "", vendor: "" };
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl: true,
        renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
        vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      };
    });
    return { ...info, software: !info.webgl || isSoftwareRenderer(info.renderer), mode: env.SVA_GPU || "default", args: opts.args };
  } finally {
    await browser.close();
  }
}

// Runs in the page: waits for the optional window.__reel.preload (a promise,
// or a function returning one) — ImageBitmaps decoded after `ready`, so the
// first seek of a cold page draws what every later seek draws.
async function awaitPreload() {
  const p = window.__reel.preload;
  await (typeof p === "function" ? p() : p);
}

/**
 * Resolves or rejects with `promise`, or rejects after `ms` with an error
 * naming `step`. A late rejection of `promise` is swallowed, so a page
 * closed under a pending evaluate() does not surface as unhandled.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} step
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, step) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`step "${step}" timed out after ${ms / 1000} s (SVA_READY_TIMEOUT_MS)`);
      err.readyTimeout = true;
      reject(err);
    }, ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The voice/timings.json a `--stub <sec>` run serves instead of the file on
 * disk: one silent line spanning the whole length (id "stub"), or with
 * `segments` > 1 that many equal silent lines "stub-1".."stub-N", so the
 * page reports that many shots and render.mjs can render them one by one.
 * Never written to disk by the page load.
 * @param {number} sec
 * @param {number} [segments]
 */
export function stubTimings(sec, segments = 1) {
  if (segments <= 1) return { duration: sec, lines: [{ id: "stub", text: "", start: 0, end: sec, words: [] }] };
  const lines = [];
  for (let i = 0; i < segments; i++) {
    const start = (sec * i) / segments;
    const end = i === segments - 1 ? sec : (sec * (i + 1)) / segments;
    lines.push({ id: `stub-${i + 1}`, text: "", start, end, words: [] });
  }
  return { duration: sec, lines };
}

/**
 * Reads a `--segments N` flag value (with --stub). Returns 1 when absent.
 * Throws unless it is a whole number >= 1 and --stub is set.
 * @param {string|boolean|undefined} value
 * @param {number|null} stubSec
 */
export function stubSegmentCount(value, stubSec) {
  if (value === undefined) return 1;
  const n = Number(value);
  if (value === true || !Number.isInteger(n) || n < 1) {
    throw new Error(`--segments takes a whole number of segments, e.g. --segments 4 (got "${value}")`);
  }
  if (!stubSec) throw new Error("--segments splits a --stub clock; add --stub <sec>");
  return n;
}

/**
 * Reads a `--stub <sec>` flag value. Returns null when the flag is absent.
 * Throws when the value is not a positive number of seconds, or when
 * `timingsPath` exists — a stub never stands in for a real clock.
 * @param {string|boolean|undefined} value
 * @param {string} timingsPath
 * @param {(p: string) => boolean} exists
 */
export function stubSeconds(value, timingsPath, exists) {
  if (value === undefined) return null;
  const sec = Number(value);
  if (value === true || !Number.isFinite(sec) || sec <= 0) {
    throw new Error(`--stub takes a length in seconds, e.g. --stub 4 (got "${value}")`);
  }
  if (exists(timingsPath)) {
    throw new Error(`--stub is for a reel with no voice/timings.json, but ${timingsPath} exists — drop --stub`);
  }
  return sec;
}

/**
 * Open `url` in a fresh headless Chromium page and wait for the reel
 * contract to be ready. Each step (load, window.__reel assigned, ready
 * settled) may take readyTimeoutMs(); the error names the step and lists
 * the page's own errors.
 * @param {string} url
 * @param {{width?: number, height?: number, stubSec?: number|null, stubSegments?: number, warm?: boolean, warmShots?: string[]|null, readyTimeoutMs?: number, picture?: {lang: string|null, strings: object}}} [opts]
 *   stubSec: serve stubTimings(stubSec, stubSegments) as voice/timings.json.
 *   warm: false skips the per-shot warm-up seeks (verify.mjs's cold probe);
 *     warmShotsOf() can warm chosen shots later.
 *   warmShots: warm only these shot ids (null = every shot). A lazily built
 *     page (one 3D world per shot group) then builds only what they need.
 *   picture: {lang, strings}, set as globalThis.__svaPicture before the page
 *     runs; every key and lang read is recorded (pictureReads()).
 */
export async function openReel(url, opts = {}) {
  const chromium = await getChromium();
  const browser = await chromium.launch(chromeLaunchOptions(process.env));
  const page = await browser.newPage({
    viewport: {
      width: opts.width || 1080,
      height: opts.height || 1920,
    },
  });
  const errors = [];
  const gl = new Map(); // WebGL console messages: text -> {text, definite, count}
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
    noteGlMessage(gl, msg.type(), msg.text());
    if (msg.type() !== "error") return;
    // Chromium logs its own "Failed to load resource: ...404..." console
    // error for ANY failed fetch, including the page's intentionally
    // optional ones (assets/lib/manifest.json, cues.json — design.md §2.5:
    // "resolve to null so a reel with no assets/lib/ works exactly as
    // before"). A REQUIRED missing file (voice/timings.json) still fails
    // loudly: loadJSON throws inside the page, caught above by pageerror.
    if (/^Failed to load resource:/.test(msg.text())) return;
    errors.push(msg.text());
  });
  if (opts.stubSec) {
    const body = JSON.stringify(stubTimings(opts.stubSec, opts.stubSegments || 1));
    await page.route(/\/voice\/timings\.json(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body })
    );
  }
  if (opts.picture) {
    // Before any page script: Reel.lang / Reel.pictureText() read this (reel-engine.js "picture strings").
    await page.addInitScript(installPictureState, opts.picture);
  }
  await waitUntilReady({ page, browser, url, errors, ms: opts.readyTimeoutMs || readyTimeoutMs() });
  // Every picture-string read this page makes, from load on, is kept for the
  // whole session (sessionPictureReads): a page may read a string once and
  // cache it, so a read during load, warm-up, a probe or an earlier segment
  // can be what a later segment's frames draw.
  const pictureReads = opts.picture ? await takePictureReads(page) : null;
  const meta = await page.evaluate(() => {
    const r = window.__reel;
    return {
      width: r.width,
      height: r.height,
      fps: r.fps,
      duration: r.duration,
      shots: r.shots || [],
      layers: r.layers || [], // e.g. ["captions"] — dub.mjs's own-caption-layer support (references/pipeline.md "Picture first")
      drift: typeof r.driftReport === "function" ? r.driftReport() : null, // reel-drift.js: graded notes for the model to judge
      parallax: typeof r.parallaxReport === "function" ? r.parallaxReport() : null, // Reel.parallaxCoverage result (references/parallax.md)
    };
  });
  // Headless Chromium's text/font rendering caches are not fully warm the
  // instant a custom @font-face resolves (document.fonts.ready only
  // guarantees the face is parsed, not that first-paint glyph shaping has
  // settled) — the first couple of canvas paints *of a given font/style
  // combination* can differ in a few subpixel-antialiased bytes from every
  // paint after. Discard two throwaway seeks per shot (covering every
  // scene, so every font/style combo gets warmed) so every *real* capture
  // from this session on is stable — which is what the determinism
  // contract (seek(t) independent of call history) actually needs.
  // `warmUp` lists these seeks in order, so a determinism diagnosis can
  // count them as seek history.
  const session = {
    browser,
    page,
    meta,
    errors,
    gl,
    warmUp: [],
    warmed: new Set(),
    pictureReads,
    close: () => browser.close(),
  };
  if (opts.warm !== false) {
    await warmShotsOf(session, opts.warmShots ? opts.warmShots : meta.shots.map((s) => s.id));
  }
  return session;
}

/**
 * Two throwaway captures at each named shot's readAt (openReel's warm-up),
 * in timeline order, skipping shots this session already warmed.
 * @param {{page: object, meta: {shots: {id: string, readAt: number}[]}, warmUp: number[], warmed: Set<string>}} session
 * @param {Iterable<string>} shotIds
 */
export async function warmShotsOf(session, shotIds) {
  const want = new Set(shotIds);
  for (const shot of session.meta.shots) {
    if (!want.has(shot.id) || session.warmed.has(shot.id)) continue;
    await captureFrame(session.page, shot.readAt);
    await captureFrame(session.page, shot.readAt);
    session.warmUp.push(shot.readAt, shot.readAt);
    session.warmed.add(shot.id);
  }
}

// Runs in the page before any page script. Wraps the picture payload so
// every read is noted in globalThis.__svaPictureReads; the values returned
// are the payload's own, so what the page draws does not change.
function installPictureState(p) {
  const reads = { keys: {}, lang: false, all: false };
  globalThis.__svaPictureReads = reads;
  const note = (k) => {
    if (typeof k === "string") reads.keys[k] = true;
  };
  const strings = new Proxy(p.strings && typeof p.strings === "object" ? p.strings : {}, {
    get(t, k, r) {
      note(k);
      return Reflect.get(t, k, r);
    },
    has(t, k) {
      note(k);
      return Reflect.has(t, k);
    },
    getOwnPropertyDescriptor(t, k) {
      note(k);
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    ownKeys(t) {
      reads.all = true;
      return Reflect.ownKeys(t);
    },
  });
  globalThis.__svaPicture = {
    get lang() {
      reads.lang = true;
      return p.lang;
    },
    strings,
  };
}

/**
 * Every picture-string read the session's page has made since it opened
 * (load, warm-up, probes, earlier segments, this one). A segment records
 * this whole set: a page that read a string once and cached it draws that
 * string without reading it again. Null for a session opened without
 * `picture`.
 * @param {{page: object, pictureReads: {keys: string[], lang: boolean, all: boolean}|null}} session
 */
export async function sessionPictureReads(session) {
  if (!session.pictureReads) return null;
  session.pictureReads = mergePictureReads(session.pictureReads, await takePictureReads(session.page));
  return session.pictureReads;
}

/**
 * Union of two picture-read records: keys merged, either flag wins; null
 * when both are absent.
 * @param {{keys: string[], lang: boolean, all: boolean}|null} a
 * @param {{keys: string[], lang: boolean, all: boolean}|null} b
 */
export function mergePictureReads(a, b) {
  if (!a && !b) return null;
  const x = a || { keys: [], lang: false, all: false };
  const y = b || { keys: [], lang: false, all: false };
  return { keys: [...new Set([...x.keys, ...y.keys])].sort(), lang: !!(x.lang || y.lang), all: !!(x.all || y.all) };
}

/**
 * The picture reads noted since the last call ({keys: sorted key names,
 * lang: Reel.lang read, all: every key enumerated}), then starts a new count.
 * @returns {Promise<{keys: string[], lang: boolean, all: boolean}>}
 */
export async function takePictureReads(page) {
  return page.evaluate(() => {
    const r = globalThis.__svaPictureReads;
    if (!r) return { keys: [], lang: false, all: false };
    const out = { keys: Object.keys(r.keys).sort(), lang: r.lang, all: r.all };
    r.keys = {};
    r.lang = false;
    r.all = false;
    return out;
  });
}

// A page that throws before assigning window.__reel, whose `ready` rejects,
// or whose `ready` never settles fails here with the step and the page's
// own errors, instead of hanging or timing out without a cause.
async function waitUntilReady({ page, browser, url, errors, ms }) {
  let step = "load reel.html";
  try {
    await withTimeout(page.goto(url, { waitUntil: "load", timeout: ms }), ms, step);
    step = "window.__reel assigned";
    await withTimeout(
      page.waitForFunction(() => !!(window.__reel && window.__reel.ready), null, { timeout: ms }),
      ms,
      step
    );
    step = "await window.__reel.ready";
    await withTimeout(page.evaluate(async () => { await window.__reel.ready; }), ms, step);
    step = "await window.__reel.preload";
    await withTimeout(page.evaluate(awaitPreload), ms, step);
  } catch (e) {
    await browser.close();
    const pageErrors = errors.length ? `\npage error(s):\n  ${errors.join("\n  ")}` : "\n(no page error was reported)";
    const cause = e.readyTimeout ? e.message : `step "${step}": ${e.message.split("\n")[0]}`;
    throw new Error(`reel page did not become ready: ${cause}${pageErrors}`);
  }
}

/** Seek the page to time `t` and wait for an async seek to settle. */
export async function seekTo(page, t) {
  await page.evaluate(async (time) => {
    const r = window.__reel;
    const result = r.seek(time);
    if (result && typeof result.then === "function") await result;
  }, t);
}

/**
 * Pixel difference between the page's <canvas> now and `refPng` (a PNG
 * captured earlier, possibly in another page). Computed in-page; only the
 * summary crosses back.
 * @returns {Promise<{changed:number, maxDelta:number, box:number[]|null}>}
 *   box = [x0, y0, x1, y1] inclusive, null when nothing differs.
 */
export async function pixelDiff(page, refPng) {
  const dataUrl = "data:image/png;base64," + refPng.toString("base64");
  return page.evaluate(async (src) => {
    const canvas = document.querySelector("canvas");
    const w = canvas.width;
    const h = canvas.height;
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext("2d");
    sctx.drawImage(img, 0, 0);
    const a = sctx.getImageData(0, 0, w, h).data;
    const b = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    let changed = 0;
    let maxDelta = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < b.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
      if (d === 0) continue;
      changed++;
      if (d > maxDelta) maxDelta = d;
      const p = i / 4;
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { changed, maxDelta, box: changed ? [x0, y0, x1, y1] : null };
  }, dataUrl);
}

/**
 * Seek the page to time `t` and capture the reel's <canvas> as a PNG buffer.
 * @param {import("playwright-core").Page} page
 * @param {number} t
 * @returns {Promise<Buffer>}
 */
export async function captureFrame(page, t) {
  await seekTo(page, t);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("no <canvas> found in reel.html");
    return canvas.toDataURL("image/png");
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Buffer.from(base64, "base64");
}

/** Read window.__reel.issues() from the live page. */
export async function readIssues(page) {
  return page.evaluate(() => (window.__reel.issues ? window.__reel.issues() : []));
}

// Engine issues that state a fact about the page (a label with no language
// string, a corner note with no counterpart); the page may mean them.
const ENGINE_FACT_TYPE = /^(note-|picture-string-missing$|overlay-text-missing$)/;

/**
 * Splits issues() entries into layout problems and engine facts.
 * @param {{type?: string}[]} issues
 * @returns {{layout: object[], facts: object[]}}
 */
export function splitEngineFacts(issues) {
  const layout = [];
  const facts = [];
  for (const issue of issues || []) (issue && ENGINE_FACT_TYPE.test(String(issue.type)) ? facts : layout).push(issue);
  return { layout, facts };
}

/**
 * Report lines for engine facts: Reel.safeAreaNote() when set, then each
 * distinct fact once with how many times it was recorded. Never a verdict.
 * @param {{note?: string|null, facts?: object[]}} args
 * @returns {string[]}
 */
export function engineFactLines({ note = null, facts = [] }) {
  const lines = [];
  if (note) lines.push(`note: ${note}`);
  const byKey = new Map();
  for (const f of facts) {
    const { type, ...rest } = f;
    const key = `${type} ${Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`.trim();
    byKey.set(key, (byKey.get(key) || 0) + 1);
  }
  for (const [key, n] of byKey) lines.push(`fact: ${key}${n > 1 ? ` (x${n})` : ""}`);
  return lines;
}

/** Reel.safeAreaNote() of the live page, or null (no engine, or nothing to say). */
export async function readSafeAreaNote(page) {
  return page.evaluate(() => (window.Reel && typeof window.Reel.safeAreaNote === "function" ? window.Reel.safeAreaNote() : null));
}

/**
 * Report lines for the drift guard's report (window.__reel.driftReport(), engine/reel-drift.js).
 * A thrown guard stops the page load before this is read, so only graded notes arrive here.
 * @param {{errors?: string[], notes?: string[], steps?: number}|null} report
 * @returns {string[]}
 */
export function driftReportLines(report) {
  if (!report) return [];
  const notes = report.notes || [];
  const head = `drift guard: ${report.steps ?? "?"} steps checked, ${notes.length ? `${notes.length} graded note(s) for you to judge` : "no drift"}`;
  return [head, ...notes.map((n) => `drift note: ${n}`)];
}

/**
 * Report lines for the page's parallax coverage (window.__reel.parallaxReport(), Reel.parallaxCoverage).
 * Reports only: a layer whose edge is bare is named with its spans and the scale factor that fixes it.
 * @param {{layers?: {layer: number, depth: number, overscan: number, spans: {from: number, to: number}[]}[]}|null} report
 * @returns {string[]}
 */
export function parallaxReportLines(report) {
  if (!report) return [];
  const layers = report.layers || [];
  if (!layers.length) return ["parallax coverage: every layer covers the frame along the camera path"];
  const fmt = (s) => `${s.from.toFixed(2)}-${s.to.toFixed(2)} s`;
  return [
    `parallax coverage: ${layers.length} layer(s) leave a frame edge bare`,
    ...layers.map((l) => `parallax layer ${l.layer} (depth ${l.depth}): edge bare at ${l.spans.map(fmt).join(", ")}; multiply its scale by ${l.overscan} or more`),
  ];
}

/** Engine facts recorded so far on the live page, as report lines. */
export async function readEngineFactLines(page) {
  const { facts } = splitEngineFacts(await readIssues(page));
  return engineFactLines({ note: await readSafeAreaNote(page), facts });
}

/**
 * Dead-air detection from what the page actually draws, not an ffmpeg
 * pixel-diff: seek(t) through the timeline at a fixed `stepSec`, hash the
 * full native-resolution canvas each time (in-page — only the hash comes
 * back, never the pixel data), and report a run when consecutive identical
 * hashes span >= `runSecMin`. Any pixel change counts as motion, so this
 * catches fine "aliveness" jitter (e.g. a thin line's boil) that a
 * downscaled 64px ffmpeg diff can lose.
 * @param {import("playwright-core").Page} page
 * @param {{duration:number, stepSec?:number, runSecMin?:number}} args
 * @returns {Promise<{runs:{startSec:number,durationSec:number}[], hashes:string[], times:number[]}>}
 */
export async function scanDeadAirBySeek(page, { duration, stepSec = 0.1, runSecMin = 0.8 }) {
  const times = [];
  for (let t = 0; t < duration - 1e-9; t += stepSec) times.push(t);
  times.push(duration); // always include the final instant, however it falls on the step grid

  const hashes = [];
  for (const t of times) {
    await page.evaluate(async (time) => {
      const r = window.__reel;
      const result = r.seek(time);
      if (result && typeof result.then === "function") await result;
    }, t);
    const hash = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("no <canvas> found in reel.html");
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // A 64-bit-ish FNV-1a-style hash over every pixel byte, computed
      // in-page so no pixel data ever crosses back to Node — only this
      // hex string does.
      let h1 = 0x811c9dc5;
      let h2 = 0x9e3779b9 ^ data.length;
      for (let i = 0; i < data.length; i++) {
        h1 = Math.imul(h1 ^ data[i], 16777619);
        h2 = Math.imul(h2 ^ data[i], 2654435761);
      }
      return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16));
    });
    hashes.push(hash);
  }

  return { times, hashes, runs: deadAirRunsFromHashes(times, hashes, runSecMin) };
}

/**
 * Dense layout scan: seek(t) through the whole film at a fixed `stepSec`,
 * clearing and re-reading window.__reel.issues() at every step, so a
 * problem that only shows up mid-shot (e.g. a label sliding in from
 * off-screen) is caught — the normal Layout gate (review.mjs) reads
 * issues() once per shot, at its `readAt` (qa.md "What the tools cannot
 * see"). Only the issues themselves cross back to Node, same as
 * scanDeadAirBySeek only returning a hash.
 * @param {import("playwright-core").Page} page
 * @param {{duration:number, stepSec?:number}} args
 * @returns {Promise<{times:number[], issuesByTime:Array[]}>}
 */
export async function scanIssuesBySeek(page, { duration, stepSec = 0.1 }) {
  const times = [];
  for (let t = 0; t < duration - 1e-9; t += stepSec) times.push(t);
  times.push(duration); // always include the final instant, however it falls on the step grid

  const issuesByTime = [];
  for (const t of times) {
    await page.evaluate(() => window.Reel.clearIssues());
    await page.evaluate(async (time) => {
      const r = window.__reel;
      const result = r.seek(time);
      if (result && typeof result.then === "function") await result;
    }, t);
    const issues = await page.evaluate(() => window.__reel.issues());
    issuesByTime.push(issues);
  }

  return { times, issuesByTime };
}
