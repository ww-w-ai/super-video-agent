#!/usr/bin/env node
// Render slot: one heavy job at a time on this machine, waiting in fair order, and only while the
// machine's GPU is not busy with someone else's work. Plain files, so any process (and any session)
// can read the state. Works on macOS and Linux with no dependency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";
import { probeGpu, busyThreshold, describeProbe } from "./gpu-probe.mjs";

const HELP = `usage:
  lock.mjs run [options] -- <command> [args...]    wait for the slot, run the command, release
  lock.mjs status [--dir <lock-dir>] [--json]      who holds the slot and who is waiting

options for run:
  --dir <lock-dir>        default env SVA_RENDER_LOCK, else $XDG_RUNTIME_DIR/super-video-agent/render-lock, else
                          ~/.cache/super-video-agent/render-lock (one slot per machine and user). The folder is created
                          with mode 700 and refused ("unsafe lock dir") unless it is a real directory, owned by you,
                          with no group or other permissions.
  --priority <n>          higher goes first (default 0); equal priority goes in arrival order
  --label <text>          shown in status
  --output <abs-path>     file this job will produce; lets queue.mjs tell a finished job from a stale one
  --gpu-threshold <pct>   also wait while the machine's GPU utilization is above this (default env SVA_GPU_BUSY_PCT, else 50)
  --gpu-wait-max <sec>    stop waiting for the GPU after this long and go on, saying so (default 5400)
  --no-gpu                wait for the slot only, never probe the GPU
  --poll <sec>            how often to look again (default 5)

The slot is a folder created with mkdir (one process wins) and holds the owner's pid. A slot whose owner
has died is released by the next process that looks, and the dead owner's leftover child process group is
stopped (only when the owner record names your uid and the group id is above 1). The command runs in its own process group; when this wrapper exits, is interrupted or is
terminated, the whole group is stopped (SIGTERM, then SIGKILL after 10 s).
Exit code is the command's. 75 means the wrapper could not get the slot.
`;

const STALE_SLOT_MS = 10000; // a slot with no owner file this old was abandoned between mkdir and write

/** One slot per machine and user: env override, else the user's runtime dir, else ~/.cache. Never a shared temp dir. */
export function defaultLockDir(env = process.env) {
  if (env.SVA_RENDER_LOCK) return path.resolve(env.SVA_RENDER_LOCK);
  const base = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "super-video-agent") : path.join(os.homedir(), ".cache", "super-video-agent");
  return path.join(base, "render-lock");
}

const myUid = () => (process.getuid ? process.getuid() : null);

/**
 * The lock dir decides which pids this tool may signal, so it must be ours alone: a real directory
 * (not a symlink), owned by this user, no group or other permission bits. Throws "unsafe lock dir".
 * With create, a missing dir is created with mode 0700; without it a missing dir is fine (nothing to read yet).
 */
export function assertSafeLockDir(dir, { create = false } = {}) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === "ENOENT" && !create) return;
    throw e;
  }
  const why = !st.isDirectory() ? "not a real directory (a symlink or a file)"
    : myUid() !== null && st.uid !== myUid() ? `owned by uid ${st.uid}, not ${myUid()}`
      : (st.mode & 0o077) !== 0 ? `mode ${(st.mode & 0o777).toString(8)} lets group or others in (use 700)` : null;
  if (why) throw new Error(`unsafe lock dir ${dir}: ${why}`);
}

/** A recorded child group may be signalled only when it is a real group (integer > 1). */
export const safePgid = (n) => Number.isInteger(n) && n > 1;

/** An owner record counts only when it names this user: a file someone else planted must not steer kill(). */
export const trustedOwner = (owner) => Boolean(owner) && myUid() !== null && owner.uid === myUid();

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const nowUs = () => Date.now() * 1000 + (seq++ % 1000);

function paths(dir) {
  return { dir, queue: path.join(dir, "queue"), slot: path.join(dir, "slot"), owner: path.join(dir, "slot", "owner.json") };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every ticket in the queue folder, with whether its pid is alive. Dead tickets are listed, never deleted here. */
export function readTickets(dir) {
  const p = paths(dir);
  let names = [];
  try {
    names = fs.readdirSync(p.queue).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const t = readJson(path.join(p.queue, n));
    if (!t || !Number.isInteger(t.pid)) continue;
    out.push({ ...t, id: n.slice(0, -5), alive: pidAlive(t.pid) });
  }
  return out;
}

/** Waiting order among live tickets: priority high first, then arrival. */
export function waitingOrder(tickets) {
  return tickets
    .filter((t) => t.alive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.createdUs - b.createdUs || (a.id < b.id ? -1 : 1));
}

/** The slot's holder: {held:false} or {held:true, owner, ownerAlive}. owner is null between mkdir and its first write. */
export function readSlot(dir) {
  const p = paths(dir);
  let st;
  try {
    st = fs.statSync(p.slot);
  } catch {
    return { held: false };
  }
  const owner = readJson(p.owner);
  if (!owner) return { held: true, owner: null, ownerAlive: Date.now() - st.mtimeMs < STALE_SLOT_MS };
  return { held: true, owner, ownerAlive: pidAlive(owner.pid) };
}

export function killGroup(pgid, signal) {
  if (!safePgid(pgid)) return false; // 0, 1, negatives and non-integers would hit our own group, init or everything
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the slot when its owner is dead. The slot is renamed away first, so of several
 * processes that notice at once exactly one removes it. Returns the dead owner's record or null.
 */
export function releaseDeadSlot(dir) {
  const p = paths(dir);
  const s = readSlot(dir);
  if (!s.held || s.ownerAlive) return null;
  const grave = `${p.slot}.dead-${nowUs()}-${process.pid}`;
  try {
    fs.renameSync(p.slot, grave);
  } catch {
    return null;
  }
  const dead = readJson(path.join(grave, "owner.json"));
  if (dead && s.owner && dead.pid !== s.owner.pid) {
    try {
      fs.renameSync(grave, p.slot); // we displaced a fresh owner, not the dead one: put it back
    } catch {
      /* the new owner's slot is gone; it re-creates on its own release check */
    }
    return null;
  }
  if (trustedOwner(dead)) killGroup(dead.childPgid, "SIGKILL");
  fs.rmSync(grave, { recursive: true, force: true });
  return dead || { pid: null };
}

function writeTicket(p, t) {
  fs.mkdirSync(p.queue, { recursive: true });
  const id = `${t.createdUs}-${t.pid}`;
  const file = path.join(p.queue, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t));
  fs.renameSync(tmp, file);
  return { id, file };
}

/**
 * Wait for the slot. Resolves a handle {release(), waitedMs, gpu} once this process holds it.
 * opts: dir, priority, label, output, pid (default this process), pollMs, sleep,
 *       gpu: false | {threshold, probe, maxWaitMs}, onEvent(type, text).
 * While the slot is free and this ticket is first, the GPU check runs; a busy GPU keeps the
 * ticket first and the slot free, so nobody overtakes. No GPU probe → the slot alone decides.
 */
export async function acquireSlot(opts = {}) {
  const dir = opts.dir || defaultLockDir();
  const p = paths(dir);
  assertSafeLockDir(dir, { create: true });
  const pid = opts.pid || process.pid;
  const sleep = opts.sleep || sleepMs;
  const pollMs = opts.pollMs ?? 5000;
  const emit = opts.onEvent || (() => {});
  const t0 = Date.now();
  const ticket = writeTicket(p, { pid, priority: opts.priority || 0, label: opts.label || "", output: opts.output || null, createdUs: nowUs(), createdMs: Date.now() });
  const gate = makeGpuGate(opts.gpu, emit);
  try {
    for (;;) {
      const dead = releaseDeadSlot(dir);
      if (dead) emit("released-dead-owner", `released slot of dead owner pid ${dead.pid}`);
      const head = waitingOrder(readTickets(dir))[0];
      if (head && head.id === ticket.id && !readSlot(dir).held && (await gate())) {
        if (tryMkdirSlot(p, pid, opts.label, opts.output)) break;
      }
      await sleep(pollMs);
    }
  } catch (e) {
    fs.rmSync(ticket.file, { force: true });
    throw e;
  }
  fs.rmSync(ticket.file, { force: true });
  return makeHandle(p, pid, Date.now() - t0, gate.summary());
}

/** Returns an async () => boolean ("GPU is free for us now"), with a `summary()` of what it saw. */
function makeGpuGate(cfg, emit) {
  if (cfg === false) return Object.assign(async () => true, { summary: () => ({ status: "off" }) });
  const threshold = cfg?.threshold ?? busyThreshold();
  const probe = cfg?.probe || probeGpu;
  const maxWaitMs = (cfg?.maxWaitMs ?? 5400 * 1000);
  let busySince = null;
  let status = "idle";
  let announcedNoProbe = false;
  const gate = async () => {
    const p = probe();
    if (!p.ok) {
      status = "no-probe";
      if (!announcedNoProbe) emit("no-gpu-probe", describeProbe(p));
      announcedNoProbe = true;
      return true;
    }
    if (p.utilization <= threshold) {
      busySince = null;
      return true;
    }
    busySince ??= Date.now();
    if (Date.now() - busySince >= maxWaitMs) {
      status = "timeout";
      emit("gpu-timeout", `${describeProbe(p)} still above ${threshold}% after ${Math.round(maxWaitMs / 1000)} s — going on`);
      return true;
    }
    emit("gpu-busy", `${describeProbe(p)} > ${threshold}%, waiting`);
    status = "waited";
    return false;
  };
  return Object.assign(gate, { summary: () => ({ status, threshold }) });
}

function tryMkdirSlot(p, pid, label, output) {
  try {
    fs.mkdirSync(p.slot);
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  fs.writeFileSync(p.owner, JSON.stringify({ pid, label: label || "", output: output || null, uid: myUid(), since: Date.now(), childPgid: null }));
  return true;
}

function makeHandle(p, pid, waitedMs, gpu) {
  let released = false;
  return {
    waitedMs,
    gpu,
    setChildGroup(pgid) {
      const o = readJson(p.owner);
      if (o && o.pid === pid) fs.writeFileSync(p.owner, JSON.stringify({ ...o, childPgid: pgid }));
    },
    release() {
      if (released) return;
      released = true;
      const o = readJson(p.owner);
      if (o && o.pid === pid) fs.rmSync(p.slot, { recursive: true, force: true });
    },
  };
}

// --- children: own process group each, all stopped when this process leaves -----------------------

const liveGroups = new Set();

/** spawn() into its own process group, remembered so exit and signals can stop it. */
export function spawnGroup(cmd, args, options = {}) {
  const child = spawn(cmd, args, { ...options, detached: true });
  if (child.pid) {
    liveGroups.add(child.pid);
    child.once("close", () => liveGroups.delete(child.pid));
  }
  return child;
}

export function stopAllGroups(signal = "SIGTERM") {
  for (const pgid of liveGroups) killGroup(pgid, signal);
}

let handlersInstalled = false;
/** Stop every spawned group when this process exits or is interrupted. Call once from a CLI entry point. */
export function installExitKill(graceMs = 10000) {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", () => stopAllGroups("SIGKILL"));
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => {
      stopAllGroups("SIGTERM");
      setTimeout(() => process.exit(code), graceMs).unref();
      const poll = setInterval(() => {
        if (liveGroups.size === 0) process.exit(code);
      }, 100);
      poll.unref();
    });
  }
}

/**
 * Wait for the slot, run `cmd args` in its own process group, release. Resolves the exit code
 * (128+signal when killed). `spawnOptions` pass to spawn (stdio, cwd, env).
 */
export async function runLocked(cmd, args, opts = {}) {
  const handle = await acquireSlot(opts);
  const releaseOnExit = () => handle.release(); // the wrapper may be terminated: free the slot on the way out
  process.once("exit", releaseOnExit);
  let pgid = null;
  try {
    const child = spawnGroup(cmd, args, opts.spawnOptions || { stdio: "inherit" });
    pgid = child.pid;
    handle.setChildGroup(pgid);
    return await new Promise((resolve) => {
      child.once("error", () => resolve(127));
      child.once("close", (code, sig) => resolve(code ?? 128 + (os.constants.signals[sig] || 0)));
    });
  } finally {
    if (pgid && killGroup(pgid, 0)) killGroup(pgid, "SIGTERM"); // the command ended; anything it left in its group goes too
    process.removeListener("exit", releaseOnExit);
    handle.release();
  }
}

// --- CLI -------------------------------------------------------------------------------------------

export function formatStatus(dir) {
  const slot = readSlot(dir);
  const lines = [`lock dir: ${dir}`];
  if (!slot.held) lines.push("slot: free");
  else if (!slot.owner) lines.push("slot: held (owner not written yet)");
  else lines.push(`slot: held by pid ${slot.owner.pid} ${slot.ownerAlive ? "(alive)" : "(DEAD — released by the next waiter)"} ${slot.owner.label || ""} since ${new Date(slot.owner.since).toISOString()}`.trim());
  const tickets = waitingOrder(readTickets(dir));
  lines.push(tickets.length ? "waiting, in order:" : "waiting: none");
  tickets.forEach((t, i) => lines.push(`  ${i + 1}. pid ${t.pid} priority ${t.priority} ${t.label || ""}`.trimEnd()));
  const dead = readTickets(dir).filter((t) => !t.alive).length;
  if (dead) lines.push(`${dead} ticket(s) of dead processes — list with queue.mjs`);
  return lines.join("\n");
}

function flagsToOpts(flags) {
  const num = (name, dflt) => {
    if (flags[name] === undefined) return dflt;
    const n = Number(flags[name]);
    if (!Number.isFinite(n)) throw new Error(`--${name} takes a number (got "${flags[name]}")`);
    return n;
  };
  const gpu = flags["no-gpu"] ? false : { threshold: num("gpu-threshold", busyThreshold()), maxWaitMs: num("gpu-wait-max", 5400) * 1000 };
  return {
    dir: typeof flags.dir === "string" ? path.resolve(flags.dir) : defaultLockDir(),
    priority: num("priority", 0),
    label: typeof flags.label === "string" ? flags.label : "",
    output: typeof flags.output === "string" ? path.resolve(flags.output) : null,
    pollMs: num("poll", 5) * 1000,
    gpu,
  };
}

export async function main(argv) {
  const sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep);
  const command = sep < 0 ? [] : argv.slice(sep + 1);
  const { positional, flags } = parseArgs(head);
  if (flags.help || flags.h || positional.length === 0) return printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
  try {
    if (positional[0] === "status") return printStatus(flags);
    if (positional[0] !== "run") throw new Error(`unknown command "${positional[0]}" (run | status)`);
    if (command.length === 0) throw new Error("run needs a command after --");
    installExitKill();
    const opts = { ...flagsToOpts(flags), onEvent: (type, text) => process.stderr.write(`render-lock: ${text}\n`) };
    process.exit(await runLocked(command[0], command.slice(1), opts));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(75);
  }
}

function printStatus(flags) {
  const dir = typeof flags.dir === "string" ? path.resolve(flags.dir) : defaultLockDir();
  assertSafeLockDir(dir);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ dir, slot: readSlot(dir), waiting: waitingOrder(readTickets(dir)), deadTickets: readTickets(dir).filter((t) => !t.alive) }) + "\n");
  } else process.stdout.write(formatStatus(dir) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
