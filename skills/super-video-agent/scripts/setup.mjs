#!/usr/bin/env node
// Install what the skill needs into its own folder, then check the tools it cannot install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, printHelpAndExit, fail } from "./lib/cli.mjs";
import { mlxModelCached, MLX_MODEL_REPOS } from "./lib/stt-engine.mjs";
import { gpuReport } from "./lib/browser.mjs";

const HELP = `usage: setup.mjs [--check] [--stt-models] [--dir <reel>]

Makes this skill folder ready to run:
  1. Node 22 or newer
  2. playwright-core in <skill>/node_modules (npm ci from package-lock.json)
  3. Playwright's Chromium
  4. ffmpeg and ffprobe on PATH (checked only; install them yourself)

Both modes also report the Playwright browser cache folder (PLAYWRIGHT_BROWSERS_PATH
or the OS default) and the free disk there and where renders write: under 0.8 GB
at the cache blocks the Chromium install (ENOSPC), under 5 GB where renders write
warns. A deleted cache shows as Chromium missing, with the folder named.
Both limits are set by SVA_MIN_CACHE_GB and SVA_MIN_WORK_GB (GB, e.g. 2).
They also report whether rendering uses a real GPU or a software renderer
(SwiftShader), from a WebGL probe in the render browser. SVA_GPU=gpu asks Chromium
for the real GPU (default = Playwright's flags; swiftshader forces software);
SVA_CHROME_ARGS adds raw Chromium flags. Information only.

--check        report what is missing without installing anything.
--dir <reel>   measure the free disk of <reel>/out (where renders write). Without
               it the current folder is measured and the output says so.
--stt-models   download the mlx-whisper models (small, turbo) into the Hugging
               Face cache with the Python in SVA_STT_PYTHON. The only step
               that fetches models; several hundred MB to a few GB.
               Ignored with --check.
Exits 0 when everything is ready, 1 otherwise.

Both modes also list the speech-to-text engines (mlx-whisper, groq) and which
models are already downloaded. That list is information only: it never
changes the exit code and nothing is downloaded to produce it. An API key is
reported as set or not set, never printed.
`;

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = path.join(SKILL_DIR, "node_modules", "playwright-core");

export async function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printHelpAndExit(HELP, 0);
    return;
  }
  const install = !flags.check;
  const missing = [];

  if (!nodeIsRecent()) missing.push(`Node 22+ (this is ${process.versions.node})`);
  if (!hasPlaywright() && (!install || !installPlaywright())) missing.push("playwright-core");
  let cache;
  try {
    const limits = diskThresholds(process.env);
    cache = browserCacheStatus(process.env, limits.cacheBytes);
    const reelDir = typeof flags.dir === "string" ? flags.dir : undefined;
    for (const line of diskLines(cache, workStatus(reelDir, limits.workBytes))) console.log(line);
  } catch (e) {
    fail(e.message);
    return;
  }
  if (hasPlaywright() && !(await hasChromium())) {
    if (install && cache.low) missing.push(chromiumMissingHint(cache, "no room to install it"));
    else if (!install || !installChromium()) missing.push(chromiumMissingHint(cache, install ? "the install failed" : "not installed"));
  }
  for (const tool of ["ffmpeg", "ffprobe"]) if (!onPath(tool)) missing.push(`${tool} on PATH (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg)`);
  if (hasPlaywright() && (await hasChromium())) for (const line of await renderingLines(process.env)) console.log(line);

  for (const line of sttReport(process.env)) console.log(line);
  if (flags["stt-models"] && install && !installSttModels(process.env)) missing.push("STT models (download failed or SVA_STT_PYTHON not set)");

  if (missing.length) {
    fail(`not ready:\n  - ${missing.join("\n  - ")}`);
    return;
  }
  console.log(`ready: ${SKILL_DIR}`);
}

const CHROMIUM_NEED_BYTES = 800 * 1024 ** 2; // a Chromium download plus its unpacked copy
const WORKDIR_WARN_BYTES = 5 * 1024 ** 3; // renders write PNG frames and mp4 files

/**
 * The two free-disk thresholds in bytes: SVA_MIN_CACHE_GB (blocks the Chromium
 * install below it) and SVA_MIN_WORK_GB (warns below it); defaults 0.8 and 5.
 * @param {Record<string,string|undefined>} env
 * @returns {{cacheBytes: number, workBytes: number}}
 */
export function diskThresholds(env) {
  const read = (name, fallback) => {
    if (env[name] === undefined || env[name] === "") return fallback;
    const gbValue = Number(env[name]);
    if (!Number.isFinite(gbValue) || gbValue < 0) throw new Error(`${name} takes a number of GB, 0 or more (got "${env[name]}")`);
    return gbValue * 1024 ** 3;
  };
  return { cacheBytes: read("SVA_MIN_CACHE_GB", CHROMIUM_NEED_BYTES), workBytes: read("SVA_MIN_WORK_GB", WORKDIR_WARN_BYTES) };
}

/**
 * Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH when set,
 * else the per-OS default cache folder.
 * @param {Record<string,string|undefined>} env
 * @param {string} [platform]
 * @param {string} [home]
 */
export function playwrightCacheDir(env, platform = process.platform, home = os.homedir()) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return path.resolve(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
}

/** Free bytes on the volume holding `p` (its nearest existing parent); null when unreadable. */
export function freeBytes(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** {dir, exists, free, low}: the Playwright cache folder, whether it exists, free bytes, and whether that is too little for a Chromium install. */
function browserCacheStatus(env, needBytes) {
  const dir = playwrightCacheDir(env);
  const free = freeBytes(dir);
  return { dir, exists: fs.existsSync(dir), free, needBytes, low: free !== null && free < needBytes };
}

/**
 * Free disk where renders write: <reel>/out with --dir <reel>, else the current
 * folder (`measured: "cwd"`, which diskLines says out loud).
 * @param {string|undefined} reelDir
 * @param {number} warnBytes
 */
export function workStatus(reelDir, warnBytes) {
  const dir = reelDir ? path.join(path.resolve(reelDir), "out") : process.cwd();
  const free = freeBytes(dir);
  return { dir, free, warnBytes, measured: reelDir ? "reel" : "cwd", low: free !== null && free < warnBytes };
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/**
 * Lines about the Playwright cache folder and free disk (information; a low
 * cache volume blocks the Chromium install, a low working volume only warns).
 * @param {{dir: string, exists: boolean, free: number|null, low: boolean, needBytes?: number}} cache
 * @param {{dir: string, free: number|null, low: boolean, warnBytes?: number, measured?: "reel"|"cwd"}} work
 */
export function diskLines(cache, work) {
  const lines = [`Playwright browser cache: ${cache.dir} (${cache.exists ? "exists" : "does not exist yet"}), ${cache.free === null ? "free space unknown" : `${gb(cache.free)} free`}`];
  if (cache.low) lines.push(`  warning: under ${gb(cache.needBytes ?? CHROMIUM_NEED_BYTES)} free there — the Chromium install fails with ENOSPC. Free space, set PLAYWRIGHT_BROWSERS_PATH to a roomier folder, or lower SVA_MIN_CACHE_GB.`);
  const label = work.measured === "reel" ? "render folder" : "working folder";
  lines.push(`${label} ${work.dir}: ${work.free === null ? "free space unknown" : `${gb(work.free)} free`}`);
  if (work.measured === "cwd") lines.push("  measured the current folder; renders write to <reel>/out — pass --dir <reel> to measure that volume.");
  if (work.low) lines.push(`  warning: under ${gb(work.warnBytes ?? WORKDIR_WARN_BYTES)} free — renders write PNG frames and mp4 files and stop with ENOSPC when the disk fills (threshold: SVA_MIN_WORK_GB).`);
  return lines;
}

/** The "not ready" entry for a missing Chromium, with what to do about the cache. */
export function chromiumMissingHint(cache, why) {
  const gone = cache.exists ? "" : ` The cache folder ${cache.dir} is missing (a cleaned or moved cache deletes the browser).`;
  return `Chromium for Playwright (${why}).${gone} Run: node ${path.join(SKILL_DIR, "scripts", "setup.mjs")}${cache.low ? " after freeing disk space" : ""}`;
}

/**
 * Lines on whether rendering uses a real GPU or a software renderer
 * (SwiftShader), read from a blank page opened with the render launch options.
 * Information only; a probe failure is reported, never thrown.
 * @param {Record<string,string|undefined>} env
 */
export async function renderingLines(env) {
  let r;
  try {
    r = await gpuReport(env);
  } catch (e) {
    return [`rendering: could not probe WebGL (${String(e.message).split("\n")[0]})`];
  }
  const what = !r.webgl ? "no WebGL" : r.software ? `software renderer (${r.renderer})` : `real GPU (${r.renderer})`;
  const lines = [`rendering: ${what}; SVA_GPU=${r.mode}${r.args.length ? `, flags ${r.args.join(" ")}` : ""}`];
  if (r.software) lines.push("  3D reels render slowly on a software renderer. For a real GPU set SVA_GPU=gpu (extra flags: SVA_CHROME_ARGS=\"...\") and run setup.mjs --check again; on a Linux server the NVIDIA driver must be installed and visible to Chromium.");
  return lines;
}

const MLX_INSTALL_ROUTE = "on Apple silicon macOS, in a venv: `python3 -m venv <dir>` then `<dir>/bin/pip install mlx-whisper` (Python 3.11 is a verified version; use a Python version the mlx wheels list for your machine), then SVA_STT_PYTHON=<dir>/bin/python and `setup.mjs --stt-models`";

function importsMlxWhisper(python) {
  return spawnSync(python, ["-c", "import mlx_whisper"], { stdio: "ignore" }).status === 0;
}

/**
 * The speech-to-text engines, as lines for `setup`: which one can run and which
 * models are on disk. Information only — nothing is installed or downloaded, and
 * an API key is reported as set or not, never printed.
 * @param {Record<string,string|undefined>} env
 * @param {(python:string)=>boolean} [probe] whether `python` imports mlx_whisper (tests replace it)
 * @returns {string[]}
 */
export function sttReport(env, probe = importsMlxWhisper) {
  const python = env.SVA_STT_PYTHON;
  const mlx = !python
    ? "not ready: SVA_STT_PYTHON is not set (a Python with mlx-whisper installed)"
    : probe(python) ? "ready (SVA_STT_PYTHON imports mlx_whisper)" : "not ready: SVA_STT_PYTHON cannot import mlx_whisper";
  const models = Object.keys(MLX_MODEL_REPOS).map((m) => `${m} ${mlxModelCached(m, env) ? "downloaded" : "not downloaded"}`);
  return [
    "speech-to-text engines (optional; the voice check is skipped when none is ready):",
    `  mlx-whisper: ${mlx}`,
    ...(mlx.startsWith("ready") ? [] : [`  mlx-whisper install route: ${MLX_INSTALL_ROUTE}`]),
    `  mlx-whisper models: ${models.join(", ")}`,
    `  groq: ${env.GROQ_API_KEY ? "key set (used only with SVA_STT_ENGINE=groq)" : "no key (GROQ_API_KEY is not set)"}`,
  ];
}

/** Downloads the mlx-whisper models with SVA_STT_PYTHON. True when every model arrived. */
function installSttModels(env) {
  if (!env.SVA_STT_PYTHON) return false;
  console.log("downloading mlx-whisper models (several hundred MB to a few GB) …");
  const code = "import sys; from huggingface_hub import snapshot_download as d; [d(r) for r in sys.argv[1:]]";
  const childEnv = { ...env };
  delete childEnv.HF_HUB_OFFLINE;
  return spawnSync(env.SVA_STT_PYTHON, ["-c", code, ...Object.values(MLX_MODEL_REPOS)], { stdio: "inherit", env: childEnv }).status === 0;
}

function nodeIsRecent() {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

function hasPlaywright() {
  return fs.existsSync(path.join(PW_DIR, "package.json"));
}

function installPlaywright() {
  console.log("installing playwright-core …");
  return run("npm", ["ci", "--omit=dev", "--prefix", SKILL_DIR]) && hasPlaywright();
}

async function hasChromium() {
  const { chromium } = await import(pathToFileURL(path.join(PW_DIR, "index.mjs")).href);
  if (fs.existsSync(chromium.executablePath())) return true;
  // Headless runs use the separate headless shell build, which executablePath() does not name.
  try {
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch {
    return false;
  }
}

function installChromium() {
  console.log("installing Chromium for Playwright …");
  return run(process.execPath, [path.join(PW_DIR, "cli.js"), "install", "chromium"]);
}

function onPath(tool) {
  return spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
