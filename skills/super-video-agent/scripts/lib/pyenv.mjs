// Shared helpers for voice providers that shell out to a local Python venv
// (qwen3, melotts): resolving which python binary to use, running a batch
// script while streaming its stderr live (progress logs), and parsing its
// JSON-lines stdout contract ({id, wav, ...} — one JSON object per
// synthesized line).
import fs from "node:fs";
import { spawn } from "node:child_process";

/**
 * `process.env[envVar]` if set, else `autoDetectPath` if it exists on
 * disk, else null (caller raises a clear "no python found" error).
 */
export function resolvePythonPath(envVar, autoDetectPath) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (autoDetectPath && fs.existsSync(autoDetectPath)) return autoDetectPath;
  return null;
}

/**
 * Run `pythonPath args...`, forwarding its stderr live (batch scripts log
 * progress there) and resolving with the captured stdout once it exits 0.
 * `extraEnv` is merged on top of `process.env` (e.g. HF_HUB_OFFLINE=1).
 */
export function runPythonBatch(pythonPath, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (e) => reject(new Error(`${pythonPath} failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${pythonPath} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

/**
 * Parse a batch script's JSON-lines stdout (one `{"id":...}` object per
 * line, progress text on other lines ignored) into a Map keyed by `id`.
 */
export function parseJsonLinesById(stdout) {
  const byId = new Map();
  for (const rawLine of String(stdout).split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // not a result line
    }
    if (parsed && parsed.id != null) byId.set(parsed.id, parsed);
  }
  return byId;
}

// No machine-specific auto-detect path is shipped. Each engine is resolved
// from its own env var only (see the per-provider files); when unset,
// resolvePythonPath returns null and the caller reports "not configured".
