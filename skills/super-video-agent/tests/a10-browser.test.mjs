// Sprint A10: WebGL console warnings, still warm-up/--out-dir, verify --only,
// Chrome GPU options, setup disk/cache checks, window.__reel.preload, src/ scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { noteGlMessage, glIssues, glReportLines, chromeLaunchOptions, isSoftwareRenderer, openReel, warmShotsOf, captureFrame } from "../scripts/lib/browser.mjs";
import { serveDir } from "../scripts/lib/server.mjs";
import { parseTimeRange } from "../scripts/lib/determinism.mjs";
import { scanReelHtml } from "../scripts/lib/static-scan.mjs";
import { parseScopeFlags, onlyShots, staticScanLine } from "../scripts/verify.mjs";
import { shotsAt } from "../scripts/still.mjs";
import { progressPrinter } from "../scripts/state-checks.mjs";
import { collectFrameStates } from "../scripts/lib/page-probe.mjs";
import { playwrightCacheDir, diskLines, chromiumMissingHint, freeBytes } from "../scripts/setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- 9 / L2: WebGL console messages ---------------------------------------

test("noteGlMessage: a GL error code is definite, other GL warnings are reported, noise and non-GL are ignored", () => {
  const gl = new Map();
  noteGlMessage(gl, "warning", "[.WebGL-0x1a2b] GL_INVALID_OPERATION: glDrawElements: attempt to access out of range vertices");
  noteGlMessage(gl, "warning", "[.WebGL-0x3c4d] GL_INVALID_OPERATION: glDrawElements: attempt to access out of range vertices");
  noteGlMessage(gl, "warning", "THREE.WebGLRenderer: Texture marked for update but no image data found.");
  noteGlMessage(gl, "warning", "WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost");
  noteGlMessage(gl, "warning", "[.WebGL-0x1] GPU stall due to ReadPixels");
  noteGlMessage(gl, "warning", "Deprecated API for something else");
  noteGlMessage(gl, "log", "WebGL: INVALID_OPERATION in a log line");
  const { definite, warnings } = glIssues({ gl });
  assert.equal(definite.length, 2);
  assert.equal(definite[0].count, 2, "same message with another context id counts as one");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /Texture marked for update/);
  const lines = glReportLines({ definite, warnings });
  assert.match(lines[0], /^GL error: .*\(x2\)$/);
  assert.match(lines[2], /^GL warning: THREE\.WebGLRenderer/);
});

// A page whose seek logs a GL warning, after waiting for window.__reel.preload.
function glPage(message) {
  return `<!doctype html><canvas width="8" height="8"></canvas><script>
window.__pre = false;
var pre = new Promise(function (r) { setTimeout(function () { window.__pre = true; r(); }, 300); });
window.__reel = {
  width: 8, height: 8, fps: 30, duration: 6, ready: Promise.resolve(), preload: function () { return pre; },
  shots: [{ id: "a", start: 0, end: 2, readAt: 1 }, { id: "b", start: 2, end: 4, readAt: 3 }, { id: "c", start: 4, end: 6, readAt: 5 }],
  seek: function (t) {
    if (!window.__pre) throw new Error("seek before preload");
    var g = document.querySelector("canvas").getContext("2d"); g.fillStyle = "#123456"; g.fillRect(0, 0, 8, 8);
    ${message ? `console.warn(${JSON.stringify(message)});` : ""}
  },
};
</script>`;
}

test("openReel: collects WebGL warnings, waits for window.__reel.preload before the first seek, warms only chosen shots", async () => {
  const dir = tmp("sva-a10-gl-");
  fs.writeFileSync(path.join(dir, "reel.html"), glPage("[.WebGL-0x9] GL_INVALID_OPERATION: glDrawElements: bad"));
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url, { warm: false, readyTimeoutMs: 20000 });
    try {
      await warmShotsOf(s, ["b"]);
      assert.deepEqual(s.warmUp, [3, 3], "only shot b is warmed (two throwaway seeks)");
      await captureFrame(s.page, 5);
      assert.equal(glIssues(s).definite.length, 1);
      assert.deepEqual(s.errors, [], "a GL warning is not a page error");
    } finally {
      await s.close();
    }
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("still.mjs --out-dir: writes there; a GL error exits 1 after writing, a plain GL warning exits 0", () => {
  const bad = tmp("sva-a10-still-bad-");
  const warn = tmp("sva-a10-still-warn-");
  const outDir = tmp("sva-a10-out-");
  try {
    fs.writeFileSync(path.join(bad, "reel.html"), glPage("GL_INVALID_OPERATION: glDrawElements: bad"));
    fs.writeFileSync(path.join(warn, "reel.html"), glPage("THREE.WebGLRenderer: Texture marked for update but no image data found."));
    const rb = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), bad, "--at", "b,5", "--out-dir", outDir], { encoding: "utf8", timeout: 60000 });
    assert.equal(rb.status, 1, rb.stderr);
    assert.match(rb.stderr, /GL error: GL_INVALID_OPERATION/);
    assert.ok(fs.existsSync(path.join(outDir, "still-b.png")) && fs.existsSync(path.join(outDir, "still-5.png")));
    assert.equal(fs.existsSync(path.join(bad, "out")), false, "nothing lands in <reel>/out with --out-dir");
    const rw = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), warn, "--at", "1"], { encoding: "utf8", timeout: 60000 });
    assert.equal(rw.status, 0, rw.stderr);
    assert.match(rw.stderr, /GL warning: THREE\.WebGLRenderer/);
    const both = spawnSync(process.execPath, [path.join(scripts, "still.mjs"), warn, "--at", "1", "--out", "/x.png", "--out-dir", outDir], { encoding: "utf8", timeout: 60000 });
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /use one/);
  } finally {
    for (const d of [bad, warn, outDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---- 38: warm only captured shots; state-checks range + progress ------------

test("shotsAt: the shot covering each time; the last shot covers its end; a gap warms nothing", () => {
  const shots = [{ id: "a", start: 0, end: 2 }, { id: "b", start: 2, end: 4 }, { id: "c", start: 5, end: 6 }];
  assert.deepEqual(shotsAt(shots, [2]), ["b"]);
  assert.deepEqual(shotsAt(shots, [0.5, 1.5, 5.5, 6]), ["a", "c"]);
  assert.deepEqual(shotsAt(shots, [4.5, 9]), []);
});

test("collectFrameStates: --range limits the frames and reports progress", async () => {
  const dir = tmp("sva-a10-range-");
  fs.writeFileSync(path.join(dir, "reel.html"), glPage(null));
  const server = await serveDir(dir);
  try {
    const s = await openReel(server.url, { warm: false, readyTimeoutMs: 20000 });
    try {
      await s.page.evaluate(() => { window.__svaProbe = { texts: [] }; });
      const seen = [];
      const { frames } = await collectFrameStates(s.page, { fps: 30, duration: 6, step: 10, range: { from: 1, to: 2 }, onProgress: (d, t) => seen.push([d, t]) });
      assert.deepEqual(frames.map((f) => f.frame), [30, 40, 50, 60]);
      assert.deepEqual(seen.at(-1), [4, 4]);
    } finally {
      await s.close();
    }
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("progressPrinter: silent inside 10 s, a line at 10 s and at the end", () => {
  let clock = 0;
  const lines = [];
  const p = progressPrinter(() => clock, (l) => lines.push(l));
  p(1, 100);
  clock = 4000;
  p(30, 100);
  assert.equal(lines.length, 0);
  clock = 12000;
  p(60, 100);
  clock = 13000;
  p(100, 100);
  assert.deepEqual(lines, ["frames 60/100 (60%, 12 s)\n", "frames 100/100 (100%, 13 s)\n"]);
});

test("parseTimeRange: t0-t1 with t1 > t0", () => {
  assert.deepEqual(parseTimeRange("42-61.5"), { from: 42, to: 61.5 });
  assert.throws(() => parseTimeRange("9-4"), /t1 > t0/);
  assert.throws(() => parseTimeRange(true), /--range takes/);
});

// ---- N15: verify --only ------------------------------------------------------

test("parseScopeFlags: --only ids, one narrowing flag at a time; onlyShots keeps exactly those shots", () => {
  assert.deepEqual(parseScopeFlags({ only: "s3, s4,s3" }), { only: ["s3", "s4"] });
  assert.throws(() => parseScopeFlags({ only: true }), /--only takes shot ids/);
  assert.throws(() => parseScopeFlags({ only: "s1", range: "1-2" }), /use one/);
  const shots = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  assert.deepEqual(onlyShots(shots, ["s3", "s1"]).map((s) => s.id), ["s1", "s3"]);
  assert.throws(() => onlyShots(shots, ["s9"]), /no shot with id s9 \(shots: s1, s2, s3\)/);
});

test("verify.mjs --only with an unknown shot id fails and lists the page's ids", () => {
  const dir = tmp("sva-a10-only-");
  try {
    fs.writeFileSync(path.join(dir, "reel.html"), glPage(null).replace("<script>", "<script>/* SCENE:BEGIN *//* SCENE:END */"));
    const r = spawnSync(process.execPath, [path.join(scripts, "verify.mjs"), dir, "--only", "zzz"], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--only: no shot with id zzz \(shots: a, b, c\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 18 + carry: preload contract, src/ scan, "checked nothing" -------------

test("scanReelHtml: scans src/ scripts too; an empty scene and no src is 'checked nothing'", () => {
  const dir = tmp("sva-a10-scan-");
  try {
    const html = path.join(dir, "reel.html");
    fs.writeFileSync(html, "<canvas></canvas><script>\n/* SCENE:BEGIN */\n/* SCENE:END */\n</script>");
    const empty = scanReelHtml(html);
    assert.equal(empty.scannedChars, 0);
    assert.match(staticScanLine(empty), /checked nothing/);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "world.js"), "export const r = Math.random();\n");
    const withSrc = scanReelHtml(html);
    assert.equal(withSrc.srcFiles, 1);
    assert.deepEqual(withSrc.violations.map((v) => v.name), ["Math.random"]);
    fs.writeFileSync(path.join(dir, "src", "world.js"), "export const r = 1;\n");
    const clean = scanReelHtml(html);
    assert.equal(clean.ok, true);
    assert.match(staticScanLine(clean), /ok \(scene block \+ 1 script\(s\) under src\/\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 41: Chrome GPU options --------------------------------------------------

test("chromeLaunchOptions: default adds nothing; gpu asks for the real GPU per OS; swiftshader forces software; extra args last", () => {
  assert.deepEqual(chromeLaunchOptions({}, "linux"), { headless: true, args: [] });
  const mac = chromeLaunchOptions({ SVA_GPU: "gpu" }, "darwin");
  assert.ok(mac.args.includes("--ignore-gpu-blocklist") && mac.args.includes("--use-angle=metal"));
  const linux = chromeLaunchOptions({ SVA_GPU: "GPU", SVA_CHROME_ARGS: "--foo  --bar=1" }, "linux");
  assert.ok(linux.args.includes("--use-angle=gl-egl"));
  assert.deepEqual(linux.args.slice(-2), ["--foo", "--bar=1"]);
  assert.deepEqual(linux.ignoreDefaultArgs, ["--disable-gpu"]);
  assert.ok(chromeLaunchOptions({ SVA_GPU: "swiftshader" }, "linux").args.includes("--enable-unsafe-swiftshader"));
  assert.throws(() => chromeLaunchOptions({ SVA_GPU: "turbo" }), /SVA_GPU takes default \| gpu \| swiftshader/);
});

test("isSoftwareRenderer: SwiftShader / llvmpipe are software, an Apple or NVIDIA renderer is not", () => {
  assert.equal(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"), true);
  assert.equal(isSoftwareRenderer("Mesa llvmpipe (LLVM 15.0.7, 256 bits)"), true);
  assert.equal(isSoftwareRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"), false);
  assert.equal(isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA A100-SXM4-40GB/PCIe/SSE2, OpenGL 4.5.0)"), false);
});

// ---- 50: setup cache + disk ---------------------------------------------------

test("playwrightCacheDir: env override, then the per-OS default", () => {
  assert.equal(playwrightCacheDir({ PLAYWRIGHT_BROWSERS_PATH: "/data/pw" }, "linux", "/h"), "/data/pw");
  assert.equal(playwrightCacheDir({}, "darwin", "/Users/x"), "/Users/x/Library/Caches/ms-playwright");
  assert.equal(playwrightCacheDir({}, "linux", "/home/x"), "/home/x/.cache/ms-playwright");
  assert.equal(playwrightCacheDir({ XDG_CACHE_HOME: "/c" }, "linux", "/home/x"), "/c/ms-playwright");
});

test("diskLines + chromiumMissingHint: a low cache volume warns with ENOSPC guidance; a missing cache folder is named", () => {
  const gbs = (n) => n * 1024 ** 3;
  const low = diskLines({ dir: "/c/ms-playwright", exists: false, free: gbs(0.2), low: true }, { dir: "/w", free: gbs(2), low: true });
  assert.match(low.join("\n"), /does not exist yet.*0\.2 GB free/);
  assert.match(low.join("\n"), /fails with ENOSPC/);
  assert.match(low.join("\n"), /renders write PNG frames/);
  const ok = diskLines({ dir: "/c", exists: true, free: gbs(50), low: false }, { dir: "/w", free: gbs(80), low: false });
  assert.equal(ok.length, 2);
  const hint = chromiumMissingHint({ dir: "/c/ms-playwright", exists: false, low: false }, "not installed");
  assert.match(hint, /cache folder \/c\/ms-playwright is missing/);
  assert.ok(freeBytes(os.tmpdir()) > 0);
  assert.ok(freeBytes(path.join(os.tmpdir(), "no", "such", "dir")) > 0, "a missing folder reports its nearest existing parent");
});
