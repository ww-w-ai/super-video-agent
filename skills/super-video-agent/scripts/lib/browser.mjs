// Playwright-core browser session: opens a reel page, waits for
// window.__reel.ready, seeks to a time, and captures the single <canvas>
// as a PNG buffer via toDataURL (no screenshot compositing, so we get
// exactly the pixels the engine drew).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deadAirRunsFromHashes } from "./dead-air.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pwEntry = path.join(
  here,
  "..",
  "..",
  "node_modules",
  "playwright-core",
  "index.mjs"
);

let chromiumMod = null;
async function getChromium() {
  if (!chromiumMod) {
    const mod = await import(pwEntry);
    chromiumMod = mod.chromium;
  }
  return chromiumMod;
}

/**
 * Open `url` in a fresh headless Chromium page and wait for the reel
 * contract to be ready.
 * @param {string} url
 * @param {{width?: number, height?: number}} [opts]
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
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.__reel && window.__reel.ready));
  await page.evaluate(async () => {
    await window.__reel.ready;
  });
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
  for (const shot of meta.shots) {
    await captureFrame(page, shot.readAt);
    await captureFrame(page, shot.readAt);
  }
  return {
    browser,
    page,
    meta,
    errors,
    close: () => browser.close(),
  };
}

/**
 * Seek the page to time `t` and capture the reel's <canvas> as a PNG buffer.
 * @param {import("playwright-core").Page} page
 * @param {number} t
 * @returns {Promise<Buffer>}
 */
export async function captureFrame(page, t) {
  await page.evaluate(async (time) => {
    const r = window.__reel;
    const result = r.seek(time);
    if (result && typeof result.then === "function") await result;
  }, t);
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
