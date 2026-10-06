#!/usr/bin/env node
// Render slot: one heavy job at a time on this machine, waiting in fair order, and only while the
// machine's GPU is not busy with someone else's work. Plain files, so any process (and any session)
// can read the state. Works on macOS and Linux with no dependency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";
import { probeGpu, busyThreshold, idleSamples, describeProbe } from "./gpu-probe.mjs";

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
  --gpu-idle-samples <n>  the GPU must read at or below the threshold this many polls in a row (default env
                          SVA_GPU_IDLE_SAMPLES, else 3), so a quiet moment between two bursts does not count
  --gpu-wait-max <sec>    stop waiting for the GPU after this long and go on, saying so (default 5400)
  --no-gpu                wait for the slot only, never probe the GPU
  --poll <sec>            how often to look again (default 5)

The slot is a folder created with mkdir (one process wins) and holds the owner's pid and its start time (a pid
now running a process with another start time counts as dead, so a recycled pid never keeps the slot). A slot
whose owner has died is released by the next process that looks, and the dead owner's leftover child process
group is stopped only when the owner record names your uid, the group id is above 1 and the group leader still
has the start time recorded for it (otherwise the kill is skipped and the reason is printed). The command runs in its own process group; when this wrapper exits, is interrupted or is
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

/**
 * When the process started, as text that is stable for that process: `ps -o lstart=` (macOS, Linux),
 * else field 22 of /proc/<pid>/stat. null when it cannot be read (no such pid, no ps).
 */
export function procStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return (ownStartTime ??= readStartTime(pid)); // never changes; saves a ps on every poll
  const hit = startCache.get(pid);
  if (hit && Date.now() - hit.at < START_CACHE_MS) return hit.value;
  const value = readStartTime(pid);
  startCache.set(pid, { value, at: Date.now() });
  return value;
}

let ownStartTime;
const startCache = new Map(); // one poll asks about the same pid several times; a pid is not recycled within a second
const START_CACHE_MS = 1000;

function readStartTime(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000 });
  const text = r.status === 0 ? (r.stdout || "").trim().replace(/\s+/g, " ") : "";
  if (text) return text;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "(comm)": state is field 3
    return fields[19] ? `proc:${fields[19]}` : null;
  } catch {
    return null;
  }
}

/** First letter of the process state (`ps -o stat=`, else /proc/<pid>/stat): "Z" is a zombie. null when unreadable. */
export function procState(pid) {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000 });
  const text = r.status === 0 ? (r.stdout || "").trim() : "";
  if (text) return text[0];
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Whether the process is there. A zombie (killed, not yet reaped by its parent) still answers kill(pid, 0) and
 * keeps its start time, but it can never release anything, so it counts as dead. With `startTime` (recorded when
 * the owner or ticket was written), a pid that now belongs to a process with a different start time is a recycled
 * pid, so dead. A start time that cannot be read now leaves the kill(pid, 0) answer standing.
 */
export function pidAlive(pid, startTime = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
  if (pid !== process.pid && procState(pid) === "Z") return false;
  if (!startTime) return true;
  const now = procStartTime(pid);
  return now === null || now === startTime;
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
    out.push({ ...t, id: n.slice(0, -5), alive: pidAlive(t.pid, t.startTime) });
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
  return { held: true, owner, ownerAlive: pidAlive(owner.pid, owner.startTime) };
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

/** Why a recorded child group must not be signalled, or null when its leader is the process we recorded. */
function groupLeaderMismatch({ childPgid, childStart }) {
  if (!childStart) return "the record has no start time for the group leader, so it cannot be told from an unrelated process that reused the id";
  const now = procStartTime(childPgid);
  // A gone leader is fine: a group id is not reused while members remain, and an empty group makes the kill a no-op.
  if (now === null) return pidAlive(childPgid) ? "the group leader's start time cannot be read" : null;
  return now === childStart ? null : `pid ${childPgid} started at "${now}" but the record says "${childStart}" (the id was reused)`;
}

/** SIGKILL the child group a dead owner left behind, only when the record is ours and its leader is the recorded process. */
export function stopLeftoverGroup(owner, emit = () => {}) {
  if (!trustedOwner(owner) || !safePgid(owner.childPgid)) return false;
  const why = groupLeaderMismatch(owner);
  if (why) {
    emit("skip-group-kill", `not stopping process group ${owner.childPgid}: ${why}`);
    return false;
  }
  return killGroup(owner.childPgid, "SIGKILL");
}

/**
 * Release the slot when its owner is dead. The slot is renamed away first, so of several
 * processes that notice at once exactly one removes it. Returns the dead owner's record or null.
 * `seam.beforeRename` / `seam.afterRename` run around the rename (tests only: they stand in for other processes).
 */
export function releaseDeadSlot(dir, emit = () => {}, seam = {}) {
  const p = paths(dir);
  const s = readSlot(dir);
  if (!s.held || s.ownerAlive) return null;
  seam.beforeRename?.();
  const grave = `${p.slot}.dead-${nowUs()}-${process.pid}`;
  try {
    fs.renameSync(p.slot, grave);
  } catch {
    return null;
  }
  seam.afterRename?.();
  const dead = readJson(path.join(grave, "owner.json"));
  if (dead && s.owner && dead.pid !== s.owner.pid) {
    putBackDisplaced(p, grave, dead, emit);
    return null;
  }
  stopLeftoverGroup(dead, emit);
  fs.rmSync(grave, { recursive: true, force: true });
  return dead || { pid: null };
}

/**
 * We renamed away a fresh owner's slot, not the dead one's: put it back. When another waiter has already taken
 * the free slot the rename fails; the displaced owner's record is then gone, and that owner finds out through
 * its handle's holds() (checked before it runs the command and after it records its group) and queues again.
 */
function putBackDisplaced(p, grave, displaced, emit) {
  try {
    fs.renameSync(grave, p.slot);
  } catch {
    fs.rmSync(grave, { recursive: true, force: true });
    emit("displaced-owner", `slot of pid ${displaced.pid} was taken by another waiter before it could be put back; that process will queue again`);
  }
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
 * opts: dir, priority, label, output, pid (default this process), pollMs, maxWaitMs (default: no limit), sleep,
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
  const maxWaitMs = opts.maxWaitMs ?? Infinity; // default waits as long as it takes; tests bound it
  const emit = opts.onEvent || (() => {});
  const t0 = Date.now();
  const ticket = writeTicket(p, { pid, startTime: procStartTime(pid), priority: opts.priority || 0, label: opts.label || "", output: opts.output || null, createdUs: nowUs(), createdMs: Date.now() });
  const gate = makeGpuGate(opts.gpu, emit);
  try {
    for (;;) {
      const dead = releaseDeadSlot(dir, emit);
      if (dead) emit("released-dead-owner", `released slot of dead owner pid ${dead.pid}`);
      const head = waitingOrder(readTickets(dir))[0];
      const ourTurn = Boolean(head) && head.id === ticket.id && !readSlot(dir).held;
      if (ourTurn && (await gate())) {
        if (tryMkdirSlot(p, pid, opts.label, opts.output)) break;
      } else if (!ourTurn) gate.reset(); // idle samples must be consecutive polls of our own turn
      if (Date.now() - t0 > maxWaitMs) throw new Error(`could not get the render slot within ${Math.round(maxWaitMs / 1000)} s`);
      await sleep(pollMs);
    }
  } catch (e) {
    fs.rmSync(ticket.file, { force: true });
    throw e;
  }
  fs.rmSync(ticket.file, { force: true });
  return makeHandle(p, pid, Date.now() - t0, gate.summary());
}

/**
 * Returns an async () => boolean ("GPU is free for us now"), with `summary()` of what it saw and `reset()`.
 * Free means `idleSamples` samples in a row at or below the threshold (cfg.idleSamples, env SVA_GPU_IDLE_SAMPLES,
 * default 3): one quiet reading between two bursts of someone else's work does not count.
 */
function makeGpuGate(cfg, emit) {
  if (cfg === false) return Object.assign(async () => true, { summary: () => ({ status: "off" }), reset() {} });
  const threshold = cfg?.threshold ?? busyThreshold();
  const needIdle = cfg?.idleSamples ?? idleSamples();
  const probe = cfg?.probe || probeGpu;
  const maxWaitMs = (cfg?.maxWaitMs ?? 5400 * 1000);
  let busySince = null;
  let idleRun = 0;
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
      idleRun++;
      if (idleRun >= needIdle) {
        busySince = null;
        return true;
      }
      status = "waited";
      emit("gpu-settling", `${describeProbe(p)} <= ${threshold}%, sample ${idleRun} of ${needIdle} in a row`);
      return false;
    }
    idleRun = 0;
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
  return Object.assign(gate, { summary: () => ({ status, threshold, idleSamples: needIdle }), reset: () => { idleRun = 0; } });
}

function tryMkdirSlot(p, pid, label, output) {
  try {
    fs.mkdirSync(p.slot);
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  fs.writeFileSync(p.owner, JSON.stringify({ pid, startTime: procStartTime(pid), label: label || "", output: output || null, uid: myUid(), since: Date.now(), childPgid: null, childStart: null }));
  return true;
}

function makeHandle(p, pid, waitedMs, gpu) {
  let released = false;
  return {
    waitedMs,
    gpu,
    /** Whether the slot on disk still names this process (false when a releaser displaced it and another waiter took the slot). */
    holds() {
      const o = readJson(p.owner);
      return Boolean(o) && o.pid === pid;
    },
    /** Records the child's group and its leader's start time; false when the slot no longer names this process. */
    setChildGroup(pgid) {
      const o = readJson(p.owner);
      if (!o || o.pid !== pid) return false;
      fs.writeFileSync(p.owner, JSON.stringify({ ...o, childPgid: pgid, childStart: procStartTime(pgid) }));
      return true;
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
  for (;;) {
    const handle = await acquireSlot(opts);
    const result = await runHeld(handle, cmd, args, opts);
    if (result !== SLOT_LOST) return result;
    (opts.onEvent || (() => {}))("requeued", "the slot was taken from this process by a releaser's mistaken rename; queueing again");
  }
}

const SLOT_LOST = Symbol("slot lost");

/** Runs the command while holding the slot; SLOT_LOST when the slot stopped naming this process before or just after the spawn. */
async function runHeld(handle, cmd, args, opts) {
  const releaseOnExit = () => handle.release(); // the wrapper may be terminated: free the slot on the way out
  process.once("exit", releaseOnExit);
  let pgid = null;
  try {
    if (!handle.holds()) return SLOT_LOST;
    const child = spawnGroup(cmd, args, opts.spawnOptions || { stdio: "inherit" });
    pgid = child.pid;
    const closed = new Promise((resolve) => {
      child.once("error", () => resolve(127));
      child.once("close", (code, sig) => resolve(code ?? 128 + (os.constants.signals[sig] || 0)));
    });
    if (!handle.setChildGroup(pgid)) {
      killGroup(pgid, "SIGKILL");
      await closed;
      return SLOT_LOST;
    }
    return await closed;
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
  const gpu = flags["no-gpu"] ? false : { threshold: num("gpu-threshold", busyThreshold()), maxWaitMs: num("gpu-wait-max", 5400) * 1000, idleSamples: num("gpu-idle-samples", idleSamples()) };
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
