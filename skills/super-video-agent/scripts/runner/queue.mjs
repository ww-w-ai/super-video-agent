#!/usr/bin/env node
// Stale render-queue entries, in two steps. `list` reports CANDIDATES with the facts; the model (or a
// person) judges each one; `remove --ids ...` then removes exactly the ones it confirms.
// This tool never removes anything by itself.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";
import { defaultLockDir, assertSafeLockDir, readTickets, readSlot, stopLeftoverGroup } from "./lock.mjs";

const HELP = `usage:
  queue.mjs list [--dir <lock-dir>] [--older-than <hours>] [--json]
  queue.mjs remove --ids <id,id,...> [--dir <lock-dir>] [--force]

The render queue is the lock folder used by lock.mjs (default env SVA_RENDER_LOCK, else the per-user
folder under $XDG_RUNTIME_DIR or ~/.cache; refused as "unsafe lock dir" unless it is yours alone, mode 700):
one slot (the job running) and tickets (the jobs waiting).

list    prints every entry with its facts and marks CANDIDATES for removal:
          id, kind (slot | ticket), label, pid, whether that pid is alive, age,
          the output file it declared and whether that file is already present (non-empty, written after the entry began)
        candidate reasons: owner-dead, output-present, older-than-<hours> (default 24; --older-than 0 turns it off)
        Facts only. A live owner is never a "safe" candidate; decide from the facts, then run remove.
remove  removes the entries named by --ids and nothing else. An id that does not exist stops the command
        (exit 1, nothing removed). An entry whose pid is still alive is refused unless --force.
        Removing the slot of a dead owner also stops that owner's leftover child process group, only when the
        owner record names your uid and the group id is above 1.
`;

/** Facts for one entry. `now` is injectable for tests. */
function entryFacts({ id, kind, pid, alive, label, output, createdMs }, now, olderThanH) {
  let outputPresent = null;
  if (output) {
    try {
      const st = fs.statSync(output);
      outputPresent = st.isFile() && st.size > 0 && st.mtimeMs >= createdMs;
    } catch {
      outputPresent = false;
    }
  }
  const ageSec = Math.max(0, Math.round((now - createdMs) / 1000));
  const reasons = [];
  if (!alive) reasons.push("owner-dead");
  if (outputPresent) reasons.push("output-present");
  if (olderThanH > 0 && ageSec > olderThanH * 3600) reasons.push(`older-than-${olderThanH}h`);
  return { id, kind, label: label || "", pid, pidAlive: alive, ageSec, output: output || null, outputPresent, candidate: reasons.length > 0, reasons };
}

export function listEntries({ dir = defaultLockDir(), olderThanH = 24, now = Date.now() } = {}) {
  assertSafeLockDir(dir);
  const entries = [];
  const slot = readSlot(dir);
  if (slot.held && slot.owner) {
    entries.push(entryFacts({ id: "slot", kind: "slot", pid: slot.owner.pid, alive: slot.ownerAlive, label: slot.owner.label, output: slot.owner.output, createdMs: slot.owner.since }, now, olderThanH));
  }
  for (const t of readTickets(dir)) {
    entries.push(entryFacts({ id: t.id, kind: "ticket", pid: t.pid, alive: t.alive, label: t.label, output: t.output, createdMs: t.createdMs }, now, olderThanH));
  }
  return entries;
}

/** Removes the named entries. Throws before removing anything when an id is unknown or an owner is alive without force. */
export function removeEntries({ dir = defaultLockDir(), ids, force = false }) {
  if (!ids.length) throw new Error("remove needs --ids");
  const known = new Map(listEntries({ dir, olderThanH: 0 }).map((e) => [e.id, e]));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`no such queue entry: ${unknown.join(", ")} (run list for the current ids)`);
  const alive = ids.filter((id) => known.get(id).pidAlive && !force);
  if (alive.length) throw new Error(`pid still alive for: ${alive.join(", ")} — pass --force only if you have checked the process is not doing the job`);
  for (const id of ids) removeOne(dir, id);
  return ids;
}

function removeOne(dir, id) {
  if (id === "slot") {
    const s = readSlot(dir);
    if (!s.ownerAlive) stopLeftoverGroup(s.owner, (type, text) => process.stderr.write(`queue: ${text}\n`));
    fs.rmSync(path.join(dir, "slot"), { recursive: true, force: true });
    return;
  }
  fs.rmSync(path.join(dir, "queue", `${id}.json`), { force: true });
}

export function formatList(entries) {
  if (!entries.length) return "queue is empty\n";
  const lines = [];
  const cands = entries.filter((e) => e.candidate);
  lines.push(`${entries.length} entries, ${cands.length} candidate(s) for removal. Nothing has been removed.`);
  for (const e of entries) {
    const o = e.output ? ` output ${e.output} ${e.outputPresent ? "PRESENT" : "absent"}` : " no output declared";
    lines.push(`${e.candidate ? "CANDIDATE" : "ok       "} ${e.id} [${e.kind}] pid ${e.pid} ${e.pidAlive ? "alive" : "DEAD"} age ${e.ageSec}s${o}${e.label ? ` "${e.label}"` : ""}${e.reasons.length ? ` — ${e.reasons.join(", ")}` : ""}`);
  }
  if (cands.length) lines.push("Confirm each one, then: queue.mjs remove --ids <id,id,...>");
  return lines.join("\n") + "\n";
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) return printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
  const dir = typeof flags.dir === "string" ? path.resolve(flags.dir) : defaultLockDir();
  try {
    if (positional[0] === "list") {
      const olderThanH = flags["older-than"] === undefined ? 24 : Number(flags["older-than"]);
      if (!Number.isFinite(olderThanH) || olderThanH < 0) throw new Error(`--older-than takes hours (got "${flags["older-than"]}")`);
      const entries = listEntries({ dir, olderThanH });
      process.stdout.write(flags.json ? JSON.stringify({ dir, entries }) + "\n" : formatList(entries));
    } else if (positional[0] === "remove") {
      const ids = typeof flags.ids === "string" ? flags.ids.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const removed = removeEntries({ dir, ids, force: Boolean(flags.force) });
      process.stdout.write(`removed ${removed.length}: ${removed.join(", ")}\n`);
    } else throw new Error(`unknown command "${positional[0]}" (list | remove)`);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
