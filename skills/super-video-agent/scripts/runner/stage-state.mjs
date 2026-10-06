// What the runner remembers between starts: which stages finished, with the hash of the file that
// proved it. Also the done-file check, script snapshots and the one-line-per-event status log.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CLOCK_SLACK_MS = 2000; // file systems round mtimes; a done-file written in the stage's first second still counts

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Is the stage's done-file proof of THIS run? Checks, in order: it exists and is not empty (or minBytes),
 * it was written after the stage started (an old output must not count — pass startedAtMs = null to skip
 * this when re-checking a recorded stage by hash), and its content passes verify.{json, contains, matches}.
 */
export function verifyDone(stage, startedAtMs) {
  let st;
  try {
    st = fs.statSync(stage.done);
  } catch {
    return { ok: false, reason: `done-file missing: ${stage.done}` };
  }
  const v = stage.verify || {};
  if (!st.isFile() || st.size < (v.minBytes ?? 1)) return { ok: false, reason: `done-file empty or not a file: ${stage.done}` };
  if (startedAtMs !== null && st.mtimeMs < startedAtMs - CLOCK_SLACK_MS) {
    return { ok: false, reason: `done-file is older than this run (an earlier output): ${stage.done}` };
  }
  return verifyContent(fs.readFileSync(stage.done, "utf8"), v);
}

export function verifyContent(text, v) {
  if (v.json) {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: "done-file is not valid JSON" };
    }
  }
  if (v.contains !== undefined && !text.includes(v.contains)) return { ok: false, reason: `done-file does not contain "${v.contains}"` };
  if (v.matches !== undefined && !new RegExp(v.matches).test(text)) return { ok: false, reason: `done-file does not match /${v.matches}/` };
  return { ok: true };
}

/** state.json under <dir>/.runner, written whole through a temp file so a crash never leaves half a file. */
export function openStateStore(dir) {
  const file = path.join(dir, ".runner", "state.json");
  let data = { stages: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.stages ||= {};
  } catch {
    /* first run */
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    file,
    get: (name) => data.stages[name],
    set(name, rec) {
      data.stages[name] = rec;
      save();
    },
    drop(name) {
      delete data.stages[name];
      save();
    },
  };
}

/** Every stage that waits on any of `names`, directly or not (the names themselves excluded). */
export function dependentsOf(stages, names) {
  const waiters = new Map(stages.map((s) => [s.name, []]));
  for (const s of stages) for (const n of s.needs) waiters.get(n).push(s.name);
  const seen = new Set();
  const stack = [...names];
  while (stack.length) {
    for (const d of waiters.get(stack.pop()) || []) {
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return [...seen];
}

/**
 * A stage ran again, so what came after it is out of date: forget the records and move each stale
 * done-file aside (renamed, never deleted) so a session cannot mistake it for its own finished work.
 * Returns the names invalidated.
 */
export function invalidate(store, byName, names, stamp) {
  const out = [];
  for (const n of names) {
    const done = byName.get(n).done;
    const had = store.get(n);
    store.drop(n);
    const hadFile = fs.existsSync(done);
    if (hadFile) fs.renameSync(done, `${done}.invalid-${stamp}`);
    if (had || hadFile) out.push(n);
  }
  return out;
}

/** bash reads a script while running it, so editing the file mid-run changes what runs. The runner runs a copy. */
export function snapshotScript(script, dir, stamp) {
  const snapDir = path.join(dir, ".runner", "snapshots");
  fs.mkdirSync(snapDir, { recursive: true });
  const copy = path.join(snapDir, `${stamp}-${path.basename(script)}`);
  fs.copyFileSync(script, copy);
  return copy;
}

/** Unique and sortable: microsecond-resolution clock plus pid. */
export function uniqueStamp() {
  return `${process.hrtime.bigint()}-${process.pid}`;
}

/** "MM-DD HH:MM text" appended to <dir>/status.txt: the line anyone checking in the morning reads first. */
export function openStatusLog(dir) {
  const file = path.join(dir, "status.txt");
  return (text) => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    fs.appendFileSync(file, `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${text}\n`);
  };
}
