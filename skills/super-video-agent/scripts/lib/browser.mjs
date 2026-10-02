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
 * disk: one silent line spanning the whole length. Never written to disk.
 * @param {number} sec
 */
export function stubTimings(sec) {
  return { duration: sec, lines: [{ id: "stub", text: "", start: 0, end: sec, words: [] }] };
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
 * @param {{width?: number, height?: number, stubSec?: number|null, warm?: boolean, readyTimeoutMs?: number}} [opts]
 *   stubSec: serve stubTimings(stubSec) as voice/timings.json.
 *   warm: false skips the per-shot warm-up seeks (verify.mjs's cold probe).
   picture: {lang, strings}, set as globalThis.__svaPicture before the page runs.
 */
export async function openReel(url, opts = {}) {
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: {
      width: opts.width || 1080,
      height: opts.height || 1920,
    },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
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
    const body = JSON.stringify(stubTimings(opts.stubSec));
    await page.route(/\/voice\/timings\.json(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body })
    );
  }
  if (opts.picture) {
    // Before any page script: Reel.lang / Reel.pictureText() read this (reel-engine.js "picture strings").
    await page.addInitScript((p) => {
      globalThis.__svaPicture = p;
    }, opts.picture);
  }
  await waitUntilReady({ page, browser, url, errors, ms: opts.readyTimeoutMs || readyTimeoutMs() });
  const meta = await page.evaluate(() => {
    const r = window.__reel;
    return {
      width: r.width,
      height: r.height,
      fps: r.fps,
      duration: r.duration,
      shots: r.shots || [],
      layers: r.layers || [], // e.g. ["captions"] — dub.mjs's own-caption-layer support (references/pipeline.md "Picture first")
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
  const warmUp = [];
  if (opts.warm !== false) {
    for (const shot of meta.shots) {
      await captureFrame(page, shot.readAt);
      await captureFrame(page, shot.readAt);
      warmUp.push(shot.readAt, shot.readAt);
    }
  }
  return {
    browser,
    page,
    meta,
    errors,
    warmUp,
    close: () => browser.close(),
  };
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
