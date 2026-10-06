#!/usr/bin/env node
// Example unattended runner: the script owns order, waiting, retries and the log; each `claude -p`
// session does one piece of judgment work and leaves one file. Copy it and the plan next to your film
// and shape both to it. Start it detached from any session:  nohup node run.mjs plan.json > run.out 2>&1 &
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";
import { spawnGroup, runLocked, installExitKill, readSlot, releaseDeadSlot, defaultLockDir, assertSafeLockDir } from "./lock.mjs";
import { busyThreshold } from "./gpu-probe.mjs";
import { validatePlan } from "./plan.mjs";
import { verifyDone, sha256File, openStateStore, openStatusLog, dependentsOf, invalidate, snapshotScript, uniqueStamp } from "./stage-state.mjs";
import { reportFor, formatReport } from "./cost-report.mjs";

const HELP = `usage: run.mjs <plan.json> [--check] [--redo <stage,stage>]

Runs the stages of a film in dependency order, unattended. Plan file (all paths absolute):
  {
    "dir": "/abs/film",                       state, logs, results and status.txt live here
    "claude": "claude", "claudeArgs": [],     the command for session stages and its extra flags
    "maxParallel": 3,
    "lock": { "dir": null, "gpu": true, "threshold": 50, "gpuWaitMaxSec": 5400, "gpuIdleSamples": 3, "pollMs": 5000 },
    "stages": [
      { "name": "voice-xx", "kind": "session", "prompt": "/abs/prompts/voice-xx.txt",
        "done": "/abs/film/reel/dub/xx/voice/timings.json", "owns": ["/abs/film/reel/dub/xx"],
        "verify": { "json": true }, "maxResumes": 3 },
      { "name": "dub-xx", "kind": "job", "cmd": ["node", "/abs/skill/scripts/dub.mjs", "/abs/film/reel", "--lang", "xx"],
        "needs": ["voice-xx"], "done": "/abs/film/reel/out/final-xx.mp4", "heavy": true, "maxAttempts": 2 }
    ]
  }
  kind session   one \`claude -p --output-format json\` run per stage, resumed by its session id (up to maxResumes)
                 while the done-file is missing. The prompt file is sent with the done-file's ABSOLUTE path appended.
  kind job       a command (or "script": "/abs/x.sh", run from a snapshot copy so editing the original is safe).
                 "heavy" (default for jobs) runs under the render slot: one at a time, in fair order, and only while
                 the machine's GPU is not busy with other work (see lock.mjs). Retried up to maxAttempts.
  done           the proof the stage finished. It counts only if it exists, is non-empty, was written after the stage
                 started (an old output does not count), and passes verify { json, contains, matches, minBytes }.
  needs / owns   a stage starts when everything it needs is done. Stages that can run together must not own the
                 same file or folder (the done-file counts as owned); the plan is refused otherwise.
A failed stage stops after its cap; stages that need it are skipped, the others go on. Finishing a stage again
(rerun or --redo) forgets the stages after it and renames their done-files to <name>.invalid-<stamp>.
At the end the cost and time of every session is printed (cost-report.mjs) and saved to <dir>/cost-report.txt.

--check          validate the plan (names, absolute paths, order, file ownership) and exit
--redo a,b       forget those stages and everything after them, then run
Exit 0 when every stage is done, 1 otherwise.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeContext(plan) {
  const byName = new Map(plan.stages.map((s) => [s.name, s]));
  for (const d of ["logs", "results"]) fs.mkdirSync(path.join(plan.dir, d), { recursive: true });
  const lockDir = plan.lock.dir || defaultLockDir();
  assertSafeLockDir(lockDir, { create: true });
  return { plan, byName, store: openStateStore(plan.dir), log: openStatusLog(plan.dir), lockDir };
}

/** Fresh-run bookkeeping: what comes after this stage is out of date from now on. */
function invalidateAfter(ctx, stage) {
  const stale = invalidate(ctx.store, ctx.byName, dependentsOf(ctx.plan.stages, [stage.name]), uniqueStamp());
  if (stale.length) ctx.log(`invalidated after ${stage.name}: ${stale.join(", ")}`);
}

/** Runs one stage to done or failed. A stage already recorded as done with an unchanged done-file is skipped. */
async function executeStage(ctx, stage) {
  const rec = ctx.store.get(stage.name);
  if (rec?.status === "done" && fs.existsSync(stage.done) && sha256File(stage.done) === rec.doneSha && verifyDone(stage, null).ok) {
    ctx.log(`skip: ${stage.name}`);
    return { ok: true };
  }
  invalidateAfter(ctx, stage);
  const startedAtMs = Date.now();
  ctx.store.set(stage.name, { status: "running", startedAt: new Date(startedAtMs).toISOString() });
  ctx.log(`start: ${stage.name}`);
  const res = stage.kind === "session" ? await runSession(ctx, stage, startedAtMs) : await runJob(ctx, stage, startedAtMs);
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(startedAtMs).toISOString();
  if (res.ok) ctx.store.set(stage.name, { status: "done", startedAt, finishedAt, attempts: res.attempts, doneSha: sha256File(stage.done) });
  else ctx.store.set(stage.name, { status: "failed", startedAt, finishedAt, attempts: res.attempts, reason: res.reason });
  ctx.log(`finished: ${stage.name} (${res.ok ? "ok" : `FAILED: ${res.reason}`})`);
  return res;
}

// --- session stages --------------------------------------------------------------------------------

function sessionFooter(stage) {
  return `\n\nDone-file (absolute path): ${stage.done}\nWrite it last, only when this job is finished. Run every job in the foreground.\n`;
}

/** One `claude -p` call; its stdout (the JSON result) goes to results/<stage>.<n>.json. Resolves the exit code. */
function claudeCall(ctx, stage, n, extraArgs, input) {
  const { plan } = ctx;
  const out = fs.openSync(path.join(plan.dir, "results", `${stage.name}.${n}.json`), "w");
  const err = fs.openSync(path.join(plan.dir, "logs", `${stage.name}.${n}.err`), "w");
  return new Promise((resolve) => {
    const child = spawnGroup(plan.claude, ["-p", ...extraArgs, "--output-format", "json", ...plan.claudeArgs], { cwd: plan.dir, stdio: ["pipe", out, err] });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }).finally(() => {
    fs.closeSync(out);
    fs.closeSync(err);
  });
}

function sessionIdOf(ctx, stage, n) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ctx.plan.dir, "results", `${stage.name}.${n}.json`), "utf8"));
    return r.session_id || null;
  } catch {
    return null;
  }
}

/** A heavy job may still hold the slot; resuming a session now would only race it. */
async function waitSlotFree(ctx, stage) {
  let said = false;
  for (;;) {
    releaseDeadSlot(ctx.lockDir);
    if (!readSlot(ctx.lockDir).held) return;
    if (!said) ctx.log(`${stage.name}: a render holds the slot, waiting before resume`);
    said = true;
    await sleep(ctx.plan.lock.pollMs);
  }
}

async function runSession(ctx, stage, startedAtMs) {
  const prompt = fs.readFileSync(stage.prompt, "utf8") + sessionFooter(stage);
  await claudeCall(ctx, stage, 0, [], prompt);
  for (let n = 0; ; n++) {
    const v = verifyDone(stage, startedAtMs);
    if (v.ok) return { ok: true, attempts: n + 1 };
    if (n >= stage.maxResumes) return { ok: false, attempts: n + 1, reason: `${v.reason}; gave up after ${n} resume(s)` };
    const sid = sessionIdOf(ctx, stage, n);
    if (!sid) return { ok: false, attempts: n + 1, reason: `${v.reason}; no session_id in results/${stage.name}.${n}.json to resume` };
    await waitSlotFree(ctx, stage);
    ctx.log(`${stage.name}: ${v.reason}, resume ${n + 1}`);
    const note = `Continue the job. The done-file ${stage.done} is still missing or invalid (${v.reason}). Run every job in the foreground and write the done-file last.`;
    await claudeCall(ctx, stage, n + 1, ["--resume", sid], note);
  }
}

// --- job stages ------------------------------------------------------------------------------------

function jobCommand(ctx, stage) {
  if (!stage.script) return stage.cmd;
  return ["bash", snapshotScript(stage.script, ctx.plan.dir, uniqueStamp()), ...(stage.args || [])];
}

function lockOptions(ctx, stage) {
  const l = ctx.plan.lock;
  return {
    dir: ctx.lockDir, priority: stage.priority, label: stage.name, output: stage.done, pollMs: l.pollMs,
    gpu: l.gpu === false ? false : { threshold: l.threshold ?? busyThreshold(), maxWaitMs: (l.gpuWaitMaxSec ?? 5400) * 1000, idleSamples: l.gpuIdleSamples },
    onEvent: (type, text) => ctx.log(`${stage.name}: ${text}`),
  };
}

async function runJob(ctx, stage, startedAtMs) {
  const [cmd, ...args] = jobCommand(ctx, stage);
  let reason = "";
  for (let n = 1; n <= stage.maxAttempts; n++) {
    const logFd = fs.openSync(path.join(ctx.plan.dir, "logs", `${stage.name}.${n}.log`), "w");
    const spawnOptions = { cwd: ctx.plan.dir, stdio: ["ignore", logFd, logFd] };
    try {
      const code = stage.heavy
        ? await runLocked(cmd, args, { ...lockOptions(ctx, stage), spawnOptions })
        : await new Promise((resolve) => {
          const c = spawnGroup(cmd, args, spawnOptions);
          c.once("error", () => resolve(127));
          c.once("close", (k) => resolve(k ?? 1));
        });
      const v = verifyDone(stage, startedAtMs);
      if (code === 0 && v.ok) return { ok: true, attempts: n };
      reason = code === 0 ? v.reason : `exit ${code}`;
    } finally {
      fs.closeSync(logFd);
    }
    ctx.log(`${stage.name}: attempt ${n} failed (${reason})`);
  }
  return { ok: false, attempts: stage.maxAttempts, reason: `${reason}; gave up after ${stage.maxAttempts} attempt(s)` };
}

// --- scheduling ------------------------------------------------------------------------------------

/** Starts stages as their needs finish, at most maxParallel at a time. Returns name → {ok, reason?, blocked?}. */
async function schedule(ctx) {
  const outcome = new Map();
  const pending = new Map(ctx.plan.stages.map((s) => [s.name, s]));
  const running = new Map();
  while (pending.size || running.size) {
    blockUnreachable(ctx, pending, outcome);
    for (const [name, stage] of pending) {
      if (running.size >= ctx.plan.maxParallel) break;
      if (!stage.needs.every((n) => outcome.get(n)?.ok)) continue;
      pending.delete(name);
      running.set(name, executeStage(ctx, stage).catch((e) => {
        ctx.log(`finished: ${name} (FAILED: ${e.message})`);
        return { ok: false, reason: e.message };
      }).then((res) => {
        outcome.set(name, res);
        running.delete(name);
      }));
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size) break; // nothing runnable and nothing running: cannot happen after blockUnreachable
  }
  return outcome;
}

/** A stage whose need failed or was skipped never runs; say so once and let the rest go on. */
function blockUnreachable(ctx, pending, outcome) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, stage] of pending) {
      const bad = stage.needs.find((n) => outcome.has(n) && !outcome.get(n).ok);
      if (!bad) continue;
      pending.delete(name);
      outcome.set(name, { ok: false, blocked: true, reason: `needs ${bad}, which did not finish` });
      ctx.log(`skipped: ${name} (needs ${bad}, which did not finish)`);
      changed = true;
    }
  }
}

function redo(ctx, names) {
  const unknown = names.filter((n) => !ctx.byName.has(n));
  if (unknown.length) throw new Error(`--redo: no such stage: ${unknown.join(", ")}`);
  const gone = invalidate(ctx.store, ctx.byName, [...names, ...dependentsOf(ctx.plan.stages, names)], uniqueStamp());
  ctx.log(`redo: forgot ${gone.join(", ") || "nothing recorded"}`);
}

export function outcomeLines(outcome) {
  const lines = [];
  const bad = [...outcome].filter(([, o]) => !o.ok);
  lines.push(`stages: ${outcome.size - bad.length} done, ${bad.length} not done`);
  for (const [name, o] of bad) lines.push(`  ${o.blocked ? "SKIPPED" : "FAILED"} ${name}: ${o.reason}`);
  return lines;
}

/** Runs the whole plan; resolves {ok, outcome, report}. The cost report is also printed and saved. */
export async function runPlan(rawPlan, { redo: redoNames = [], print = (s) => process.stdout.write(s) } = {}) {
  const plan = validatePlan(rawPlan);
  const ctx = makeContext(plan);
  ctx.log("run started");
  if (redoNames.length) redo(ctx, redoNames);
  const outcome = await schedule(ctx);
  ctx.log("ended");
  const report = outcomeLines(outcome).join("\n") + "\n" + formatReport(reportFor(plan.dir));
  fs.writeFileSync(path.join(plan.dir, "cost-report.txt"), report);
  print(report);
  return { ok: [...outcome.values()].every((o) => o.ok), outcome, report };
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) return printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(positional[0]), "utf8"));
    if (flags.check) {
      const plan = validatePlan(raw);
      process.stdout.write(`plan ok: ${plan.stages.length} stages\n`);
      return;
    }
    installExitKill();
    const redoNames = typeof flags.redo === "string" ? flags.redo.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const res = await runPlan(raw, { redo: redoNames });
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
