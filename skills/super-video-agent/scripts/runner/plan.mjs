// Stage plan for run.mjs: shape checks, dependency order, and file ownership between stages that can
// run at the same time. Every problem is collected and thrown together, so one run of the check lists them all.
import path from "node:path";

const NAME = /^[A-Za-z0-9_-]+$/;

/** Throws one Error listing every problem, or returns the plan with defaults filled in. */
export function validatePlan(plan) {
  const problems = [];
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  if (!isAbs(plan?.dir)) problems.push(`"dir" must be an absolute path (got ${JSON.stringify(plan?.dir)})`);
  if (!stages.length) problems.push('"stages" must list at least one stage');
  const names = new Set();
  for (const s of stages) checkStage(s, names, problems);
  for (const s of stages) for (const n of s.needs || []) if (!names.has(n)) problems.push(`stage "${s.name}" needs unknown stage "${n}"`);
  if (!problems.length) {
    const order = topoOrder(stages);
    if (order.cycle) problems.push(`dependency cycle among: ${order.cycle.join(", ")}`);
    else problems.push(...ownershipProblems(stages));
  }
  if (problems.length) throw new Error(`invalid plan:\n- ${problems.join("\n- ")}`);
  return normalise(plan);
}

const isAbs = (p) => typeof p === "string" && path.isAbsolute(p);

function checkStage(s, names, problems) {
  const where = `stage "${s?.name}"`;
  if (!s || typeof s.name !== "string" || !NAME.test(s.name)) return problems.push(`stage name must match ${NAME} (got ${JSON.stringify(s?.name)})`);
  if (names.has(s.name)) problems.push(`${where}: name used twice`);
  names.add(s.name);
  // The done-file is checked by the runner and written into the session's prompt: both must see the same absolute path.
  if (!isAbs(s.done)) problems.push(`${where}: "done" must be an absolute path (a relative one resolves differently for the runner and the session)`);
  if (s.kind === "session") {
    if (!isAbs(s.prompt)) problems.push(`${where}: "prompt" must be an absolute path to the prompt file`);
  } else if (s.kind === "job") {
    if (!s.script && !(Array.isArray(s.cmd) && s.cmd.length)) problems.push(`${where}: a job needs "cmd" (array) or "script"`);
    if (s.script && !isAbs(s.script)) problems.push(`${where}: "script" must be an absolute path`);
  } else problems.push(`${where}: "kind" must be "session" or "job"`);
  for (const o of s.owns || []) if (!isAbs(o)) problems.push(`${where}: "owns" entry must be absolute (got ${JSON.stringify(o)})`);
}

/** Kahn's algorithm. Returns {order} or {cycle:[names left]}. */
export function topoOrder(stages) {
  const left = new Map(stages.map((s) => [s.name, new Set(s.needs || [])]));
  const dependents = new Map(stages.map((s) => [s.name, []]));
  for (const s of stages) for (const n of s.needs || []) dependents.get(n)?.push(s.name);
  const ready = [...left].filter(([, n]) => n.size === 0).map(([k]) => k);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const d of dependents.get(n)) {
      const need = left.get(d);
      need.delete(n);
      if (need.size === 0) ready.push(d);
    }
  }
  const placed = new Set(order);
  return order.length === stages.length ? { order } : { cycle: stages.map((s) => s.name).filter((n) => !placed.has(n)) };
}

/** name → Set of every stage it waits on, directly or not. */
export function ancestorsOf(stages) {
  const byName = new Map(stages.map((s) => [s.name, s]));
  const memo = new Map();
  const visit = (n) => {
    if (memo.has(n)) return memo.get(n);
    const set = new Set();
    for (const d of byName.get(n).needs || []) {
      set.add(d);
      for (const a of visit(d)) set.add(a);
    }
    memo.set(n, set);
    return set;
  };
  for (const s of stages) visit(s.name);
  return memo;
}

/**
 * Two stages that can run at the same time must not write the same file or folder (or one inside the other).
 * Paths are sorted so every path meets only its prefixes: no all-pairs scan.
 */
function ownershipProblems(stages) {
  const anc = ancestorsOf(stages);
  const entries = [];
  for (const s of stages) for (const o of [s.done, ...(s.owns || [])]) entries.push({ p: path.resolve(o), stage: s.name });
  // "\0" sorts before every filename character, so a folder's children follow it directly ("/a/b-c" does not split "/a/b" from "/a/b/x")
  const key = (e) => e.p.split(path.sep).join("\0");
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const problems = [];
  const open = []; // chain of entries whose path is a prefix of the current one
  for (const e of entries) {
    while (open.length && !(e.p === open.at(-1).p || e.p.startsWith(open.at(-1).p + path.sep))) open.pop();
    for (const o of open) {
      if (o.stage === e.stage) continue;
      const ordered = anc.get(o.stage).has(e.stage) || anc.get(e.stage).has(o.stage);
      if (!ordered) problems.push(`stages "${o.stage}" and "${e.stage}" can run at the same time and both own ${o.p === e.p ? e.p : `${o.p} / ${e.p}`} — declare different "owns" or make one need the other`);
    }
    open.push(e);
  }
  return problems;
}

function normalise(plan) {
  return {
    ...plan,
    claude: plan.claude || "claude",
    claudeArgs: plan.claudeArgs || [],
    maxParallel: plan.maxParallel || 3,
    lock: { gpu: true, pollMs: 5000, ...(plan.lock || {}) },
    stages: plan.stages.map((s) => ({
      needs: [], owns: [], verify: {}, priority: 0, heavy: s.kind === "job",
      maxResumes: 3, maxAttempts: 2, ...s,
    })),
  };
}
