#!/usr/bin/env node
// Probe an optional local renderer before authoring a new 3D film.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli.mjs";

const PROBE = fileURLToPath(new URL("./blender/probe.py", import.meta.url));
const HELP = `usage: probe-blender.mjs [--timeout-ms 60000]
Prints JSON: engine=blender only after an EEVEE frame renders; otherwise engine=threejs.
Checks SVA_BLENDER_BIN (an absolute executable path), PATH, and standard app locations.
Never installs Blender. An explicit SVA_BLENDER_BIN is the only candidate when set.
Exit 0 means a routing decision, not necessarily Blender success. Invalid arguments exit 1.
`;

/** Resolve installed candidates without searching the reel or invoking a shell. */
export function blenderCandidates({ env = process.env, platform = process.platform, home = os.homedir(), list = fs.readdirSync } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (env.SVA_BLENDER_BIN) return [env.SVA_BLENDER_BIN];
  const name = platform === "win32" ? "blender.exe" : "blender";
  const candidates = (env.PATH || "").split(platform === "win32" ? ";" : ":")
    .filter(dir => p.isAbsolute(dir)).map(dir => p.join(dir, name));
  if (platform === "darwin") {
    candidates.push("/Applications/Blender.app/Contents/MacOS/Blender", p.join(home, "Applications/Blender.app/Contents/MacOS/Blender"));
  }
  if (platform === "win32") {
    const root = p.join(env.ProgramFiles || "C:\\Program Files", "Blender Foundation");
    try {
      for (const entry of list(root).filter(n => /^Blender [\d.]+$/.test(n)).sort().reverse()) {
        candidates.push(p.join(root, entry, "blender.exe"));
      }
    } catch { /* The optional app directory may not exist. */ }
  }
  return [...new Set(candidates)];
}

/** Select from observable probe results. Absence and runtime failure keep the existing engine. */
export function selectEngine(candidates, probe) {
  const attempts = [];
  for (const executable of candidates) {
    const result = probe(executable);
    attempts.push({ executable, ...result });
    if (result.ok) return { engine: "blender", executable, renderEngine: result.renderEngine, attempts };
  }
  return { engine: "threejs", reason: attempts.length ? "Blender probe failed" : "Blender not found", attempts };
}

/** Require an actual PNG, not just a successful process or a log message. */
export function isProbePng(bytes) {
  return bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR"
    && bytes.readUInt32BE(16) === 32 && bytes.readUInt32BE(20) === 32;
}

/** Run in an owned temporary directory and always remove that directory afterwards. */
export function probeBlender(executable, { timeoutMs = 60000, run = spawnSync } = {}) {
  if (!path.isAbsolute(executable)) return { ok: false, reason: "Executable must be an absolute path" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-blender-probe-"));
  try {
    const output = path.join(dir, "probe.png");
    const result = run(executable, ["--background", "--factory-startup", "--disable-autoexec",
      "--python-exit-code", "1", "--python", PROBE, "--", output],
    { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, shell: false });
    if (result.error || result.status !== 0) {
      return { ok: false, reason: result.error?.code || `exit ${result.status}, signal ${result.signal || "none"}` };
    }
    const marker = (result.stdout || "").split(/\r?\n/).find(line => line.startsWith("SVA_BLENDER_OK "));
    if (!marker || !fs.existsSync(output) || !isProbePng(fs.readFileSync(output))) {
      return { ok: false, reason: "Render proof missing or invalid" };
    }
    const proof = JSON.parse(marker.slice("SVA_BLENDER_OK ".length));
    if (typeof proof.version !== "string" || !["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"].includes(proof.renderEngine)) {
      return { ok: false, reason: "Invalid render metadata" };
    }
    return { ok: true, version: proof.version, renderEngine: proof.renderEngine };
  } catch (error) {
    return { ok: false, reason: error.code || error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Print a decision that both skill hosts can consume before choosing a scene backend. */
export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) { process.stdout.write(HELP); return; }
  const timeoutMs = flags["timeout-ms"] === undefined ? 60000 : Number(flags["timeout-ms"]);
  if (positional.length || Object.keys(flags).some(k => k !== "timeout-ms")
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || typeof flags["timeout-ms"] === "boolean") {
    throw new Error(HELP);
  }
  const candidates = blenderCandidates().filter(p => process.env.SVA_BLENDER_BIN || fs.existsSync(p));
  const decision = selectEngine(candidates, executable => probeBlender(executable, { timeoutMs }));
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
