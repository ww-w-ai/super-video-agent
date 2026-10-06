#!/usr/bin/env node
// Machine-wide GPU utilization, so a render waits for GPU work from OTHER sessions and programs too,
// not only for our own lock. Facts only: when no probe works it says so and the caller uses the lock alone.
import { spawnSync } from "node:child_process";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";

const HELP = `usage: gpu-probe.mjs [--threshold <percent>] [--wait] [--max-wait <sec>] [--json]

Reads how busy the GPU is right now, across the whole machine:
  macOS   ioreg -r -d 1 -c IOAccelerator     "Device Utilization %"  (no sudo)
  NVIDIA  nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits
With several GPUs the busiest one counts. Prints the source and the percentage.
If neither probe works it prints "no gpu probe" and why, and exits 3 (lock-only fallback).

--threshold <percent>  exit 2 when utilization is above it (default env SVA_GPU_BUSY_PCT, else 50)
--wait                 poll every 10 s until utilization is at or below the threshold
--max-wait <sec>       with --wait: stop waiting after this long and exit 2 (default: no limit)
--json                 print the probe result as JSON

Exit: 0 at or below threshold (or no threshold exceeded), 2 busy, 3 no probe.
`;

export const DEFAULT_BUSY_PCT = 50;

/** Run one command; never throws. */
export function runCommand(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });
  if (r.error) return { ok: false, reason: `${cmd}: ${r.error.code || r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `${cmd} exited ${r.status}` };
  return { ok: true, stdout: r.stdout || "" };
}

/** Largest "Device Utilization %" in `ioreg -r -d 1 -c IOAccelerator` output (one per accelerator). */
export function parseIoreg(text) {
  const values = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  return values.length ? Math.max(...values) : null;
}

/** Largest percentage in `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits` output. */
export function parseNvidiaSmi(text) {
  const values = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+(\.\d+)?$/.test(l)).map(Number);
  return values.length ? Math.max(...values) : null;
}

const PROBES = {
  ioreg: { cmd: "ioreg", args: ["-r", "-d", "1", "-c", "IOAccelerator"], parse: parseIoreg },
  "nvidia-smi": { cmd: "nvidia-smi", args: ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], parse: parseNvidiaSmi },
};

/** Probe order: the platform's own tool first, the other one as a fallback. */
export function probeOrder(platform = process.platform) {
  return platform === "darwin" ? ["ioreg", "nvidia-smi"] : ["nvidia-smi", "ioreg"];
}

/**
 * First working probe wins. Returns {ok:true, source, utilization} or {ok:false, reasons:[...]}.
 * `run(cmd, args)` is injectable for tests.
 */
export function probeGpu({ run = runCommand, platform = process.platform } = {}) {
  const reasons = [];
  for (const name of probeOrder(platform)) {
    const p = PROBES[name];
    const out = run(p.cmd, p.args);
    if (!out.ok) {
      reasons.push(out.reason);
      continue;
    }
    const utilization = p.parse(out.stdout);
    if (utilization !== null) return { ok: true, source: name, utilization };
    reasons.push(`${name}: no utilization figure in its output`);
  }
  return { ok: false, reasons };
}

export function busyThreshold(env = process.env) {
  const n = Number(env.SVA_GPU_BUSY_PCT);
  return Number.isFinite(n) && env.SVA_GPU_BUSY_PCT !== undefined && env.SVA_GPU_BUSY_PCT !== "" ? n : DEFAULT_BUSY_PCT;
}

export const DEFAULT_IDLE_SAMPLES = 3;

/** How many consecutive samples at or below the threshold count as idle (env SVA_GPU_IDLE_SAMPLES, default 3, at least 1). */
export function idleSamples(env = process.env) {
  const n = Number(env.SVA_GPU_IDLE_SAMPLES);
  return Number.isInteger(n) && n >= 1 && env.SVA_GPU_IDLE_SAMPLES !== "" ? n : DEFAULT_IDLE_SAMPLES;
}

/**
 * Wait while the machine's GPU is above `threshold`. Resolves {status, waitedMs, probe}:
 *   "idle"     at or below the threshold (waitedMs is 0 when it never had to wait)
 *   "no-probe" no probe works — the caller falls back to its lock alone
 *   "timeout"  still busy after maxWaitMs; the caller decides (a lock holder goes on and reports it)
 * `onWait(probe, waitedMs)` is called once per poll while waiting.
 */
export async function waitForIdleGpu({ threshold, probe = probeGpu, sleep = defaultSleep, pollMs = 10000, maxWaitMs = Infinity, onWait, now = Date.now } = {}) {
  const t0 = now();
  for (;;) {
    const p = probe();
    if (!p.ok) return { status: "no-probe", waitedMs: now() - t0, probe: p };
    if (p.utilization <= threshold) return { status: "idle", waitedMs: now() - t0, probe: p };
    const waited = now() - t0;
    if (waited >= maxWaitMs) return { status: "timeout", waitedMs: waited, probe: p };
    if (onWait) onWait(p, waited);
    await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - waited)));
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function describeProbe(p) {
  return p.ok ? `${p.source}: GPU utilization ${p.utilization}%` : `no gpu probe (${p.reasons.join("; ")}) — lock only`;
}

export async function main(argv, deps = {}) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  const threshold = flags.threshold === undefined ? busyThreshold() : Number(flags.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    process.stderr.write(`error: --threshold takes a percentage 0-100 (got "${flags.threshold}")\n`);
    process.exit(1);
  }
  const maxSec = flags["max-wait"] === undefined ? Infinity : Number(flags["max-wait"]);
  if (Number.isNaN(maxSec)) {
    process.stderr.write(`error: --max-wait takes seconds (got "${flags["max-wait"]}")\n`);
    process.exit(1);
  }
  const probe = deps.probe || probeGpu;
  const res = flags.wait
    ? await waitForIdleGpu({ threshold, probe, maxWaitMs: maxSec * 1000, pollMs: deps.pollMs, sleep: deps.sleep, onWait: (p, ms) => process.stderr.write(`waiting: ${describeProbe(p)} > ${threshold}% (${Math.round(ms / 1000)} s)\n`) })
    : summarise(probe(), threshold);
  if (flags.json) process.stdout.write(JSON.stringify({ threshold, ...res }) + "\n");
  else process.stdout.write(describeProbe(res.probe) + (res.status === "idle" ? "" : ` [${res.status}]`) + "\n");
  process.exit(res.status === "idle" ? 0 : res.status === "no-probe" ? 3 : 2);
}

function summarise(p, threshold) {
  if (!p.ok) return { status: "no-probe", probe: p };
  return { status: p.utilization <= threshold ? "idle" : "busy", probe: p };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
