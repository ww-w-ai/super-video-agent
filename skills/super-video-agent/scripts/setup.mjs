#!/usr/bin/env node
// Install what the skill needs into its own folder, then check the tools it cannot install.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, printHelpAndExit, fail } from "./lib/cli.mjs";
import { mlxModelCached, MLX_MODEL_REPOS } from "./lib/stt-engine.mjs";

const HELP = `usage: setup.mjs [--check] [--stt-models]

Makes this skill folder ready to run:
  1. Node 22 or newer
  2. playwright-core in <skill>/node_modules (npm ci from package-lock.json)
  3. Playwright's Chromium
  4. ffmpeg and ffprobe on PATH (checked only; install them yourself)

--check        report what is missing without installing anything.
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
  if (hasPlaywright() && !(await hasChromium()) && (!install || !installChromium())) missing.push("Chromium for Playwright");
  for (const tool of ["ffmpeg", "ffprobe"]) if (!onPath(tool)) missing.push(`${tool} on PATH (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg)`);

  for (const line of sttReport(process.env)) console.log(line);
  if (flags["stt-models"] && install && !installSttModels(process.env)) missing.push("STT models (download failed or SVA_STT_PYTHON not set)");

  if (missing.length) {
    fail(`not ready:\n  - ${missing.join("\n  - ")}`);
    return;
  }
  console.log(`ready: ${SKILL_DIR}`);
}

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
  return fs.existsSync(chromium.executablePath());
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
