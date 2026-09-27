#!/usr/bin/env node
// Install what the skill needs into its own folder, then check the tools it cannot install.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, printHelpAndExit, fail } from "./lib/cli.mjs";

const HELP = `usage: setup.mjs [--check]

Makes this skill folder ready to run:
  1. Node 22 or newer
  2. playwright-core in <skill>/node_modules (npm ci from package-lock.json)
  3. Playwright's Chromium
  4. ffmpeg and ffprobe on PATH (checked only; install them yourself)

--check   report what is missing without installing anything.
Exits 0 when everything is ready, 1 otherwise.
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

  if (missing.length) {
    fail(`not ready:\n  - ${missing.join("\n  - ")}`);
    return;
  }
  console.log(`ready: ${SKILL_DIR}`);
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
