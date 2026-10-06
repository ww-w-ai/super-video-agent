// scripts/runner/: GPU probe, render slot lock, stale-queue lister/remover, cost report, stage runner.
// Fakes: ioreg / nvidia-smi are small scripts on a private PATH; `claude` is a node script that
// reads the prompt and writes (or does not write) the done-file. No real GPU, no real session.
import { test as rawTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseIoreg, parseNvidiaSmi, probeGpu, probeOrder, waitForIdleGpu, busyThreshold,
} from "../scripts/runner/gpu-probe.mjs";
import {
  acquireSlot, readSlot, readTickets, releaseDeadSlot, waitingOrder, killGroup, pidAlive,
  defaultLockDir, assertSafeLockDir, safePgid, trustedOwner, procStartTime, procState,
} from "../scripts/runner/lock.mjs";
import { listEntries, removeEntries } from "../scripts/runner/queue.mjs";
import { rowOfFile, aggregate, formatReport, reportFor } from "../scripts/runner/cost-report.mjs";
import { validatePlan } from "../scripts/runner/plan.mjs";
import { runPlan } from "../scripts/runner/run.mjs";

// Every test gets a time limit, and every process a test spawns is killed (whole group) when the test ends,
// so a failed assertion never leaves a live child behind.
const spawned = new Set();
const track = (child) => {
  spawned.add(child);
  return child;
};
const killTracked = () => {
  for (const c of spawned) {
    for (const target of [-c.pid, c.pid]) {
      try { process.kill(target, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  spawned.clear();
};
const test = (name, fn) => rawTest(name, { timeout: 180000 }, async (t) => {
  t.after(killTracked);
  return fn(t);
});

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "runner");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a13-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await sleep(15);
  }
};
const exeScript = (file, body) => {
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
  fs.chmodSync(file, 0o755);
};
const shScript = (file, body) => {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

// ---- gpu probe ----------------------------------------------------------------------------------

const IOREG = `+-o AGXAcceleratorG14X  <class IOAccelerator>
    {
      "PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=30}
    }
+-o Another  <class IOAccelerator>
    {
      "PerformanceStatistics" = {"Device Utilization %"=81}
    }`;

test("ioreg and nvidia-smi output: the busiest device counts, no figure gives null", () => {
  assert.equal(parseIoreg(IOREG), 81);
  assert.equal(parseIoreg("nothing here"), null);
  assert.equal(parseNvidiaSmi("12\n 95 \n"), 95);
  assert.equal(parseNvidiaSmi("[N/A]\n"), null);
});

test("probe order follows the platform and falls back to the other tool", () => {
  assert.deepEqual(probeOrder("darwin"), ["ioreg", "nvidia-smi"]);
  assert.deepEqual(probeOrder("linux"), ["nvidia-smi", "ioreg"]);
  const seen = [];
  const run = (cmd) => {
    seen.push(cmd);
    return cmd === "nvidia-smi" ? { ok: true, stdout: "44\n" } : { ok: false, reason: "ioreg: ENOENT" };
  };
  assert.deepEqual(probeGpu({ run, platform: "darwin" }), { ok: true, source: "nvidia-smi", utilization: 44 });
  assert.deepEqual(seen, ["ioreg", "nvidia-smi"]);
  const none = probeGpu({ run: () => ({ ok: false, reason: "x: ENOENT" }), platform: "linux" });
  assert.equal(none.ok, false);
  assert.equal(none.reasons.length, 2);
});

test("busyThreshold reads SVA_GPU_BUSY_PCT, default 50", () => {
  assert.equal(busyThreshold({}), 50);
  assert.equal(busyThreshold({ SVA_GPU_BUSY_PCT: "30" }), 30);
  assert.equal(busyThreshold({ SVA_GPU_BUSY_PCT: "" }), 50);
});

test("waitForIdleGpu waits while busy, reports no-probe and timeout", async () => {
  const seq = [90, 80, 20];
  const polls = [];
  const idle = await waitForIdleGpu({
    threshold: 50, sleep: async () => {}, onWait: (p) => polls.push(p.utilization),
    probe: () => ({ ok: true, source: "ioreg", utilization: seq.shift() }),
  });
  assert.equal(idle.status, "idle");
  assert.deepEqual(polls, [90, 80]);
  const np = await waitForIdleGpu({ threshold: 50, probe: () => ({ ok: false, reasons: ["no tool"] }) });
  assert.equal(np.status, "no-probe");
  let t = 0;
  const to = await waitForIdleGpu({
    threshold: 50, maxWaitMs: 1000, sleep: async () => { t += 600; }, now: () => t,
    probe: () => ({ ok: true, source: "ioreg", utilization: 99 }),
  });
  assert.equal(to.status, "timeout");
});

function probeCli(binDir, args = []) {
  const r = spawnSync(process.execPath, [path.join(RUNNER, "gpu-probe.mjs"), ...args], { encoding: "utf8", env: { PATH: binDir } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("gpu-probe CLI with a fake ioreg: exit 0 idle, 2 busy, 3 when no probe works", () => {
  const bin = tmp();
  const none = probeCli(bin, ["--json"]);
  assert.equal(none.code, 3);
  assert.match(none.out, /"status":"no-probe"/);
  shScript(path.join(bin, "ioreg"), `echo '"PerformanceStatistics" = {"Device Utilization %"=12}'`);
  const idle = probeCli(bin, ["--threshold", "50"]);
  assert.equal(idle.code, 0);
  assert.match(idle.out, /ioreg: GPU utilization 12%/);
  shScript(path.join(bin, "ioreg"), `echo '"PerformanceStatistics" = {"Device Utilization %"=88}'`);
  const busy = probeCli(bin, ["--threshold", "50"]);
  assert.equal(busy.code, 2);
  assert.match(busy.out, /\[busy\]/);
});

test("gpu-probe CLI with a fake nvidia-smi", () => {
  const bin = tmp();
  shScript(path.join(bin, "nvidia-smi"), "printf '5\\n71\\n'");
  const r = probeCli(bin, ["--threshold", "80"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /nvidia-smi: GPU utilization 71%/);
});

// ---- lock ---------------------------------------------------------------------------------------

const fastOpts = (dir, extra = {}) => ({ dir, pollMs: 10, gpu: false, maxWaitMs: 30000, ...extra });

test("one holder at a time; release frees the slot for the next", async () => {
  const dir = tmp();
  const a = await acquireSlot(fastOpts(dir, { label: "a" }));
  assert.equal(readSlot(dir).owner.label, "a");
  let gotB = false;
  const pb = acquireSlot(fastOpts(dir, { label: "b" })).then((h) => { gotB = true; return h; });
  await sleep(80);
  assert.equal(gotB, false);
  a.release();
  const b = await pb;
  assert.equal(readSlot(dir).owner.label, "b");
  b.release();
  assert.equal(readSlot(dir).held, false);
});

test("waiting is fair: higher priority first, equal priority in arrival order", async () => {
  const dir = tmp();
  const holder = await acquireSlot(fastOpts(dir));
  const order = [];
  const wait = (label, priority) => acquireSlot(fastOpts(dir, { label, priority })).then((h) => { order.push(label); h.release(); });
  const ps = [wait("low1", 0)];
  await sleep(20);
  ps.push(wait("low2", 0));
  await sleep(20);
  ps.push(wait("urgent", 5));
  await sleep(50);
  holder.release();
  await Promise.all(ps);
  assert.deepEqual(order, ["urgent", "low1", "low2"]);
});

test("a dead owner's slot is released by the next process, and its leftover child group is stopped", async () => {
  const dir = tmp();
  const leftover = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }));
  const dead = deadPid();
  fs.mkdirSync(path.join(dir, "slot"), { recursive: true });
  fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ pid: dead, uid: process.getuid(), label: "gone", since: Date.now(), childPgid: leftover.pid, childStart: procStartTime(leftover.pid) }));
  assert.equal(readSlot(dir).ownerAlive, false);
  const h = await acquireSlot(fastOpts(dir, { label: "next" }));
  assert.equal(readSlot(dir).owner.label, "next");
  await until(() => !pidAlive(leftover.pid));
  h.release();
});

test("a zombie (killed, not reaped by its parent) reads as dead, and a bounded wait gives up instead of hanging", async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "zombie.pid");
  // The parent spawns a child that exits at once, then blocks its event loop so it cannot reap the child.
  const parentSrc = `const c = require("child_process").spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); require("fs").writeFileSync(process.argv[1], String(c.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40000);`;
  track(spawn(process.execPath, ["-e", parentSrc, pidFile], { stdio: "ignore" }));
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
  const zombie = Number(fs.readFileSync(pidFile, "utf8"));
  await until(() => procState(zombie) === "Z");
  assert.doesNotThrow(() => process.kill(zombie, 0), "kill(pid, 0) alone still says it is there");
  assert.equal(pidAlive(zombie, procStartTime(zombie)), false);
  assert.equal(pidAlive(zombie), false);
  fs.mkdirSync(path.join(dir, "slot"));
  fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ pid: zombie, startTime: procStartTime(zombie), uid: process.getuid(), label: "zombie", since: Date.now() }));
  assert.equal(readSlot(dir).ownerAlive, false);
  const h = await acquireSlot(fastOpts(dir, { label: "next" }));
  assert.equal(readSlot(dir).owner.label, "next");
  h.release();
  const holder = await acquireSlot(fastOpts(dir));
  await assert.rejects(() => acquireSlot(fastOpts(dir, { maxWaitMs: 100 })), /could not get the render slot/);
  assert.equal(readTickets(dir).length, 0, "the giving-up waiter leaves no ticket");
  holder.release();
});

test("releaseDeadSlot leaves a live owner alone", async () => {
  const dir = tmp();
  const h = await acquireSlot(fastOpts(dir));
  assert.equal(releaseDeadSlot(dir), null);
  assert.equal(readSlot(dir).held, true);
  h.release();
});

test("tickets of dead processes are skipped in the order but never deleted by the lock", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "queue"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue", "1-1.json"), JSON.stringify({ pid: deadPid(), priority: 9, createdUs: 1, createdMs: 1, label: "ghost" }));
  const h = await acquireSlot(fastOpts(dir, { label: "real" }));
  assert.equal(readSlot(dir).owner.label, "real");
  assert.equal(readTickets(dir).length, 1);
  assert.equal(waitingOrder(readTickets(dir)).length, 0);
  h.release();
});

test("a busy machine GPU keeps the slot free and the first ticket first: nobody overtakes", async () => {
  const dir = tmp();
  let util = 90;
  const gpu = { threshold: 50, maxWaitMs: 60000, probe: () => ({ ok: true, source: "ioreg", utilization: util }) };
  const events = [];
  const got = [];
  const go = (label) => acquireSlot(fastOpts(dir, { label, gpu, onEvent: (t) => events.push(t) })).then((h) => { got.push(label); h.release(); });
  const p1 = go("first");
  await sleep(20);
  const p2 = go("second");
  await sleep(120);
  assert.deepEqual(got, []);
  assert.equal(readSlot(dir).held, false);
  assert.ok(events.includes("gpu-busy"));
  util = 10;
  await Promise.all([p1, p2]);
  assert.deepEqual(got, ["first", "second"]);
});

test("no GPU probe: says so once and the lock alone decides", async () => {
  const dir = tmp();
  const events = [];
  const gpu = { threshold: 50, probe: () => ({ ok: false, reasons: ["no tool"] }) };
  const h = await acquireSlot(fastOpts(dir, { gpu, onEvent: (t, text) => events.push([t, text]) }));
  assert.equal(events.filter(([t]) => t === "no-gpu-probe").length, 1);
  assert.match(events[0][1], /lock only/);
  h.release();
});

test("GPU still busy after the wait limit: goes on and reports it", async () => {
  const dir = tmp();
  const events = [];
  const gpu = { threshold: 50, maxWaitMs: 40, probe: () => ({ ok: true, source: "ioreg", utilization: 99 }) };
  const h = await acquireSlot(fastOpts(dir, { gpu, onEvent: (t) => events.push(t) }));
  assert.ok(events.includes("gpu-timeout"));
  assert.equal(h.gpu.status, "timeout");
  h.release();
});

test("lock.mjs run: the command's exit code comes back, and killing the wrapper stops the command and frees the slot", async () => {
  const dir = tmp();
  const lock = path.join(RUNNER, "lock.mjs");
  const ok = spawnSync(process.execPath, [lock, "run", "--dir", dir, "--no-gpu", "--poll", "0.01", "--", process.execPath, "-e", "process.exit(7)"], { encoding: "utf8" });
  assert.equal(ok.status, 7);
  const pidFile = path.join(dir, "child.pid");
  const child = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)";
  const wrapper = track(spawn(process.execPath, [lock, "run", "--dir", dir, "--no-gpu", "--poll", "0.01", "--", process.execPath, "-e", child, pidFile], { stdio: "ignore" }));
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(readSlot(dir).owner.childPgid, childPid);
  wrapper.kill("SIGTERM");
  await until(() => !pidAlive(childPid));
  await until(() => !pidAlive(wrapper.pid));
  assert.equal(readSlot(dir).held, false);
});

test("a SIGKILLed wrapper leaves a slot that reads as dead; the next waiter takes it and stops the orphaned command", async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "child.pid");
  const child = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)";
  const wrapper = track(spawn(process.execPath, [path.join(RUNNER, "lock.mjs"), "run", "--dir", dir, "--no-gpu", "--", process.execPath, "-e", child, pidFile], { stdio: "ignore" }));
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"));
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  wrapper.kill("SIGKILL");
  await until(() => !pidAlive(wrapper.pid));
  assert.equal(readSlot(dir).ownerAlive, false);
  const h = await acquireSlot(fastOpts(dir));
  await until(() => !pidAlive(childPid));
  h.release();
});

test("lock.mjs status and --help", () => {
  const dir = tmp();
  const lock = path.join(RUNNER, "lock.mjs");
  const st = spawnSync(process.execPath, [lock, "status", "--dir", dir], { encoding: "utf8" });
  assert.match(st.stdout, /slot: free/);
  const help = spawnSync(process.execPath, [lock, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage:/);
});

// ---- lock dir and kill safety ---------------------------------------------------------------------

test("default lock dir is per user: env override, then XDG_RUNTIME_DIR, then ~/.cache, never a shared temp dir", () => {
  assert.equal(defaultLockDir({ SVA_RENDER_LOCK: "/x/lock" }), "/x/lock");
  assert.equal(defaultLockDir({ XDG_RUNTIME_DIR: "/run/user/1" }), "/run/user/1/super-video-agent/render-lock");
  assert.equal(defaultLockDir({}), path.join(os.homedir(), ".cache", "super-video-agent", "render-lock"));
});

test("a missing lock dir is created with mode 700", async () => {
  const dir = path.join(tmp(), "a", "lock");
  const h = await acquireSlot(fastOpts(dir));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  h.release();
});

test("unsafe lock dir: a symlink, group/other permission bits, or a file is refused", async () => {
  const real = tmp();
  const link = path.join(tmp(), "link");
  fs.symlinkSync(real, link);
  await assert.rejects(() => acquireSlot(fastOpts(link)), /unsafe lock dir.*not a real directory/);
  assert.throws(() => assertSafeLockDir(link), /unsafe lock dir/);
  const open = tmp();
  fs.chmodSync(open, 0o770);
  await assert.rejects(() => acquireSlot(fastOpts(open)), /unsafe lock dir.*mode 770/);
  assert.throws(() => listEntries({ dir: open }), /unsafe lock dir/);
  assert.throws(() => removeEntries({ dir: open, ids: ["slot"] }), /unsafe lock dir/);
  const file = path.join(tmp(), "f");
  fs.writeFileSync(file, "");
  assert.throws(() => assertSafeLockDir(file), /unsafe lock dir/);
  assert.doesNotThrow(() => assertSafeLockDir(path.join(tmp(), "missing")));
});

test("killGroup refuses 0, 1, negatives and non-integers (checked with signal 0, which would report success if it went through)", () => {
  for (const bad of [0, 1, -1, -1234, 1.5, NaN, "5", null, undefined]) assert.equal(killGroup(bad, 0), false, String(bad));
  assert.equal(safePgid(2), true);
  assert.equal(safePgid(1), false);
});

test("an owner record of another uid, or with no uid, never steers a kill", async () => {
  for (const uid of [process.getuid() + 1, undefined]) {
    const dir = tmp();
    const bystander = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }));
    fs.mkdirSync(path.join(dir, "slot"));
    fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ pid: deadPid(), uid, label: "planted", since: Date.now() - 5000, childPgid: bystander.pid }));
    assert.equal(trustedOwner(readSlot(dir).owner), false);
    const h = await acquireSlot(fastOpts(dir)); // the dead slot itself is still released ...
    assert.equal(readSlot(dir).owner.label, "", "released and re-taken");
    await sleep(60);
    assert.equal(pidAlive(bystander.pid), true, "... but the planted pgid was not signalled");
    h.release();
    fs.mkdirSync(path.join(dir, "slot"));
    fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ pid: deadPid(), uid, label: "planted", since: Date.now(), childPgid: bystander.pid }));
    removeEntries({ dir, ids: ["slot"] }); // queue.mjs path
    await sleep(60);
    assert.equal(pidAlive(bystander.pid), true);
    killGroup(bystander.pid, "SIGKILL");
  }
});

// ---- stale queue --------------------------------------------------------------------------------

function seedQueue(dir) {
  fs.mkdirSync(path.join(dir, "queue"), { recursive: true });
  const out = path.join(dir, "made.mp4");
  const ticket = (id, t) => fs.writeFileSync(path.join(dir, "queue", `${id}.json`), JSON.stringify({ priority: 0, createdUs: 1, ...t }));
  const before = Date.now() - 1000;
  fs.writeFileSync(out, "video");
  ticket("1-dead-done", { pid: deadPid(), createdMs: before, label: "scene-1", output: out });
  ticket("2-dead-nofile", { pid: deadPid(), createdMs: before, label: "scene-2", output: path.join(dir, "absent.mp4") });
  ticket("3-alive", { pid: process.pid, createdMs: Date.now(), label: "scene-3" });
  return out;
}

test("list reports facts and marks candidates; it removes nothing", () => {
  const dir = tmp();
  seedQueue(dir);
  const entries = listEntries({ dir });
  const by = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.deepEqual(by["1-dead-done"].reasons, ["owner-dead", "output-present"]);
  assert.equal(by["1-dead-done"].outputPresent, true);
  assert.deepEqual(by["2-dead-nofile"].reasons, ["owner-dead"]);
  assert.equal(by["2-dead-nofile"].outputPresent, false);
  assert.equal(by["3-alive"].candidate, false);
  assert.equal(by["3-alive"].pidAlive, true);
  const cli = spawnSync(process.execPath, [path.join(RUNNER, "queue.mjs"), "list", "--dir", dir], { encoding: "utf8" });
  assert.match(cli.stdout, /Nothing has been removed/);
  assert.equal(fs.readdirSync(path.join(dir, "queue")).length, 3);
});

test("an old but live entry is a candidate only through the age rule", () => {
  const dir = tmp();
  seedQueue(dir);
  const old = listEntries({ dir, now: Date.now() + 48 * 3600 * 1000 }).find((e) => e.id === "3-alive");
  assert.deepEqual(old.reasons, ["older-than-24h"]);
  const off = listEntries({ dir, olderThanH: 0, now: Date.now() + 48 * 3600 * 1000 }).find((e) => e.id === "3-alive");
  assert.equal(off.candidate, false);
});

test("remove takes exactly the confirmed ids; unknown id or live pid stops it before anything goes", () => {
  const dir = tmp();
  seedQueue(dir);
  assert.throws(() => removeEntries({ dir, ids: ["1-dead-done", "nope"] }), /no such queue entry: nope/);
  assert.throws(() => removeEntries({ dir, ids: ["2-dead-nofile", "3-alive"] }), /still alive/);
  assert.equal(fs.readdirSync(path.join(dir, "queue")).length, 3);
  removeEntries({ dir, ids: ["1-dead-done"] });
  assert.deepEqual(fs.readdirSync(path.join(dir, "queue")).sort(), ["2-dead-nofile.json", "3-alive.json"]);
  removeEntries({ dir, ids: ["3-alive"], force: true });
  assert.equal(fs.readdirSync(path.join(dir, "queue")).length, 1);
});

test("a dead owner's slot is a removable entry and its child group goes with it", async () => {
  const dir = tmp();
  const leftover = track(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }));
  fs.mkdirSync(path.join(dir, "slot"), { recursive: true });
  fs.writeFileSync(path.join(dir, "slot", "owner.json"), JSON.stringify({ pid: deadPid(), uid: process.getuid(), label: "gone", since: Date.now() - 5000, childPgid: leftover.pid, childStart: procStartTime(leftover.pid) }));
  const slot =listEntries({ dir }).find((e) => e.kind === "slot");
  assert.deepEqual(slot.reasons, ["owner-dead"]);
  removeEntries({ dir, ids: ["slot"] });
  assert.equal(readSlot(dir).held, false);
  await until(() => !pidAlive(leftover.pid));
  killGroup(leftover.pid, "SIGKILL");
});

// ---- cost report --------------------------------------------------------------------------------

const result = (o = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, duration_ms: 60000, num_turns: 4, session_id: "s1", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, ...o });

test("a result file becomes a row: cost, time, turns, tokens, flags", () => {
  const ok = rowOfFile("/x/results/voice-ja.0.json", result());
  assert.deepEqual([ok.stage, ok.attempt, ok.cost, ok.durationMs, ok.turns, ok.inTokens, ok.outTokens, ok.flags], ["voice-ja", 0, 0.5, 60000, 4, 1000, 50, []]);
  assert.deepEqual(rowOfFile("/x/a.0.json", result({ is_error: true, subtype: "error_max_turns" })).flags, ["is_error", "error_max_turns"]);
  assert.deepEqual(rowOfFile("/x/a.0.json", "not json").flags, ["unreadable"]);
  assert.deepEqual(rowOfFile("/x/a.0.json", result({ total_cost_usd: undefined })).flags, ["no-cost-field"]);
  assert.equal(rowOfFile("/x/result-old.json", result()).stage, "old");
  assert.equal(rowOfFile("/x/a.0.json", JSON.stringify([{ type: "system" }, JSON.parse(result({ total_cost_usd: 2 }))])).cost, 2);
});

test("resumes add to their stage; flags name the resume; the report totals and lists flagged stages", () => {
  const rows = [
    rowOfFile("/r/a.0.json", result({ is_error: true })),
    rowOfFile("/r/a.1.json", result({ total_cost_usd: 0.25 })),
    rowOfFile("/r/b.0.json", result()),
  ];
  const agg = aggregate(rows, { a: 90000 });
  assert.equal(agg.stages[0].sessions, 2);
  assert.equal(agg.stages[0].cost, 0.75);
  assert.deepEqual(agg.stages[0].flags, ["is_error"]);
  assert.equal(agg.total.cost, 1.25);
  assert.deepEqual(agg.flagged, ["a"]);
  const text = formatReport(agg);
  assert.match(text, /a \| 2 \| 0\.75 \| 2\.0 min \| 1\.5 min/);
  assert.match(text, /total \| 3 \| 1\.25/);
  assert.match(text, /flagged: a/);
});

test("reportFor on a folder with no results says so", () => {
  assert.match(formatReport(reportFor(tmp())), /no result files found/);
});

// ---- plan ---------------------------------------------------------------------------------------

const session = (name, extra = {}) => ({ name, kind: "session", prompt: `/p/${name}.txt`, done: `/film/${name}.done`, ...extra });
const basePlan = (stages) => ({ dir: "/film", stages });

test("plan: relative done-file, unknown need, cycle and bad names are all reported together", () => {
  assert.throws(() => validatePlan(basePlan([session("a", { done: "reel/a.done" })])), /"done" must be an absolute path/);
  assert.throws(() => validatePlan(basePlan([session("a", { needs: ["zzz"] })])), /unknown stage "zzz"/);
  assert.throws(() => validatePlan(basePlan([session("a", { needs: ["b"] }), session("b", { needs: ["a"] })])), /cycle among: a, b/);
  assert.throws(() => validatePlan(basePlan([session("bad name")])), /stage name must match/);
  assert.throws(() => validatePlan({ dir: "film", stages: [] }), /"dir" must be an absolute path[\s\S]*at least one stage/);
});

test("plan: stages that can run together may not own the same file or folder; ordered ones may", () => {
  const clash = basePlan([session("a", { owns: ["/film/dub"] }), session("b", { owns: ["/film/dub/ja"] })]);
  assert.throws(() => validatePlan(clash), /"a" and "b" can run at the same time/);
  const sameDone = basePlan([session("a"), session("b", { done: "/film/a.done" })]);
  assert.throws(() => validatePlan(sameDone), /own \/film\/a\.done/);
  const ordered = basePlan([session("a", { owns: ["/film/dub"] }), session("b", { owns: ["/film/dub/ja"], needs: ["a"] })]);
  assert.equal(validatePlan(ordered).stages.length, 2);
  const siblings = basePlan([session("a", { owns: ["/film/dub-c"] }), session("b", { owns: ["/film/dub"] }), session("c", { owns: ["/film/dub/x"] })]);
  assert.throws(() => validatePlan(siblings), /"b" and "c"/); // "/film/dub-c" sorts between "/film/dub" and "/film/dub/x"
});

// ---- runner -------------------------------------------------------------------------------------

// Fake `claude -p`: the first prompt carries FAKE_WRITE_ON_CALL=<n>; the done-file appears on call n.
const FAKE_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const done = (/Done-file \\(absolute path\\): (.+)/.exec(input) || /done-file (\\S+) is still/.exec(input))[1];
  const stateFile = done + ".fake";
  let st = { calls: 0, writeOn: 1, resumes: 0 };
  if (fs.existsSync(stateFile)) st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  else {
    st.writeOn = Number((/FAKE_WRITE_ON_CALL=(\\d+)/.exec(input) || [0, 1])[1]);
    fs.writeFileSync(done + ".prompt", input);
  }
  st.calls += 1;
  if (args.includes("--resume")) st.resumes += 1;
  if (st.calls >= st.writeOn) fs.writeFileSync(done, JSON.stringify({ ok: true, call: st.calls }));
  fs.writeFileSync(stateFile, JSON.stringify(st));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, duration_ms: 1000, num_turns: 2, session_id: "sid-" + require("path").basename(done), usage: { input_tokens: 10, output_tokens: 5 } }));
});
`;

function film() {
  const dir = fs.realpathSync(tmp());
  const claude = path.join(dir, "fake-claude.js");
  exeScript(claude, FAKE_CLAUDE);
  fs.mkdirSync(path.join(dir, "prompts"));
  return { dir, claude, done: (n) => path.join(dir, `${n}.done`), calls: (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.done.fake`), "utf8")) };
}

function sessionStage(f, name, writeOn, extra = {}) {
  const prompt = path.join(f.dir, "prompts", `${name}.txt`);
  fs.writeFileSync(prompt, `Do the ${name} job.\nFAKE_WRITE_ON_CALL=${writeOn}\n`);
  return { name, kind: "session", prompt, done: f.done(name), ...extra };
}

function jobStage(f, name, extra = {}) {
  const log = path.join(f.dir, "jobs.log");
  const code = `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} "+Date.now()+"\\n");setTimeout(()=>{fs.writeFileSync(${JSON.stringify(f.done(name))},"{}");fs.appendFileSync(${JSON.stringify(log)},"end ${name} "+Date.now()+"\\n")},150)`;
  return { name, kind: "job", cmd: [process.execPath, "-e", code], done: f.done(name), ...extra };
}

const planOf = (f, stages, extra = {}) => ({ dir: f.dir, claude: f.claude, lock: { dir: path.join(f.dir, ".lock"), gpu: false, pollMs: 10 }, stages, ...extra });
const quiet = { print: () => {} };

test("runner: the prompt carries the done-file as an absolute path; the same path is what gets checked", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [sessionStage(f, "voice", 1)]), quiet);
  assert.equal(r.ok, true);
  const prompt = fs.readFileSync(`${f.done("voice")}.prompt`, "utf8");
  assert.ok(prompt.includes(`Done-file (absolute path): ${f.done("voice")}`));
  assert.ok(path.isAbsolute(f.done("voice")));
});

test("runner: a missing done-file resumes the session by id, then the cost report counts both sessions", async () => {
  const f = film();
  const printed = [];
  const r = await runPlan(planOf(f, [sessionStage(f, "voice", 2)]), { print: (s) => printed.push(s) });
  assert.equal(r.ok, true);
  assert.equal(f.calls("voice").resumes, 1);
  assert.ok(fs.existsSync(path.join(f.dir, "results", "voice.0.json")) && fs.existsSync(path.join(f.dir, "results", "voice.1.json")));
  assert.match(printed.join(""), /voice \| 2 \| 1\.00/);
  assert.match(printed.join(""), /total \| 2 \| 1\.00/);
  const status = fs.readFileSync(path.join(f.dir, "status.txt"), "utf8");
  assert.match(status, /start: voice/);
  assert.match(status, /voice: done-file missing.*resume 1/);
  assert.match(status, /finished: voice \(ok\)/);
  assert.equal(fs.readFileSync(path.join(f.dir, "cost-report.txt"), "utf8"), printed.join(""));
});

test("runner: after the resume cap the stage stops, what needs it is skipped, the rest goes on", async () => {
  const f = film();
  const stages = [
    sessionStage(f, "bad", 99, { maxResumes: 1 }),
    jobStage(f, "after-bad", { needs: ["bad"] }),
    sessionStage(f, "other", 1),
  ];
  const r = await runPlan(planOf(f, stages), quiet);
  assert.equal(r.ok, false);
  assert.equal(f.calls("bad").calls, 2);
  assert.match(r.outcome.get("bad").reason, /gave up after 1 resume/);
  assert.equal(r.outcome.get("after-bad").blocked, true);
  assert.equal(r.outcome.get("other").ok, true);
  assert.equal(fs.existsSync(f.done("after-bad")), false);
  assert.match(r.report, /FAILED bad/);
  assert.match(r.report, /SKIPPED after-bad/);
});

test("runner: an old output does not count as done", async () => {
  const f = film();
  const stage = sessionStage(f, "voice", 99, { maxResumes: 0 });
  fs.writeFileSync(stage.done, "{}");
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(stage.done, hourAgo, hourAgo);
  const r = await runPlan(planOf(f, [stage]), quiet);
  assert.equal(r.ok, false);
  assert.match(r.outcome.get("voice").reason, /older than this run/);
});

test("runner: done-file content is checked (json / contains) before the stage counts as done", async () => {
  const f = film();
  const stage = sessionStage(f, "review", 1, { maxResumes: 0, verify: { contains: "verdict: ok" } });
  const r = await runPlan(planOf(f, [stage]), quiet);
  assert.equal(r.ok, false);
  assert.match(r.outcome.get("review").reason, /does not contain "verdict: ok"/);
});

test("runner: a second start skips finished stages; redo reruns one and forgets what came after it", async () => {
  const f = film();
  const stages = () => [sessionStage(f, "a", 1), jobStage(f, "b", { needs: ["a"] }), jobStage(f, "c", { needs: ["b"] })];
  const starts = () => fs.readFileSync(path.join(f.dir, "jobs.log"), "utf8").split("\n").filter((l) => l.startsWith("start")).map((l) => l.split(" ")[1]);
  assert.equal((await runPlan(planOf(f, stages()), quiet)).ok, true);
  assert.deepEqual(starts(), ["b", "c"]);
  assert.equal((await runPlan(planOf(f, stages()), quiet)).ok, true);
  assert.deepEqual(starts(), ["b", "c"]); // nothing ran again
  assert.equal(f.calls("a").calls, 1);
  const r = await runPlan(planOf(f, stages()), { ...quiet, redo: ["a"] });
  assert.equal(r.ok, true);
  assert.equal(f.calls("a").calls, 2); // a's done-file was renamed aside, so the session ran again and wrote a new one
  assert.deepEqual(starts(), ["b", "c", "b", "c"]);
  const invalid = fs.readdirSync(f.dir).filter((n) => n.includes(".invalid-"));
  assert.ok(invalid.some((n) => n.startsWith("b.done")) && invalid.some((n) => n.startsWith("c.done")));
});

test("runner: a job that exits 0 without its done-file is retried up to the cap, then fails", async () => {
  const f = film();
  const stage = { name: "silent", kind: "job", cmd: [process.execPath, "-e", "0"], done: f.done("silent"), maxAttempts: 2 };
  const r = await runPlan(planOf(f, [stage]), quiet);
  assert.equal(r.ok, false);
  assert.match(r.outcome.get("silent").reason, /done-file missing.*gave up after 2 attempt/);
  assert.equal(fs.existsSync(path.join(f.dir, "logs", "silent.2.log")), true);
});

test("runner: a script runs from a snapshot copy, so editing the original mid-run changes nothing", async () => {
  const f = film();
  const script = path.join(f.dir, "step.sh");
  const marker = path.join(f.dir, "ran-from.txt");
  fs.writeFileSync(script, `echo "$0" > ${marker}\nsleep 0.2\necho '{}' > ${f.done("sh")}\n`);
  const run = runPlan(planOf(f, [{ name: "sh", kind: "job", script, done: f.done("sh"), heavy: false }]), quiet);
  await until(() => fs.existsSync(marker));
  fs.writeFileSync(script, "exit 9\n"); // bash would read this mid-run if it ran the original
  const r = await run;
  assert.equal(r.ok, true);
  const from = fs.readFileSync(marker, "utf8").trim();
  assert.notEqual(from, script);
  assert.ok(from.includes(`${path.sep}.runner${path.sep}snapshots${path.sep}`));
});

test("runner: heavy jobs run one at a time even with room for several", async () => {
  const f = film();
  const stages = ["h1", "h2", "h3"].map((n) => jobStage(f, n));
  const r = await runPlan(planOf(f, stages, { maxParallel: 3 }), quiet);
  assert.equal(r.ok, true);
  const events = fs.readFileSync(path.join(f.dir, "jobs.log"), "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual(events, ["start", "end", "start", "end", "start", "end"]);
});

test("runner: a plan with a relative done-file is refused before anything runs", async () => {
  const f = film();
  const bad = sessionStage(f, "x", 1, { done: "x.done" });
  await assert.rejects(() => runPlan(planOf(f, [bad]), quiet), /"done" must be an absolute path/);
  assert.equal(fs.existsSync(path.join(f.dir, "status.txt")), false);
});

test("every runner script prints usage with --help and exits 0", () => {
  for (const s of ["gpu-probe", "lock", "queue", "cost-report", "run"]) {
    const r = spawnSync(process.execPath, [path.join(RUNNER, `${s}.mjs`), "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, s);
    assert.match(r.stdout, /usage:/, s);
  }
});
