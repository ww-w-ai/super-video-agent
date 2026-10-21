// run.mjs: a dropped API connection does not end the run. Every session stage gets its own --session-id on the
// first call; a call that fails with a network message is retried with --resume after a backoff, outside maxResumes.
// `claude` is a node script: <done>.drops holds how many calls still fail with a message from <done>.msg.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPlan } from "../scripts/runner/run.mjs";
import { isNetworkError } from "../scripts/runner/network-errors.mjs";

const FAKE_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const done = /Done-file \\(absolute path\\): (.+)/.exec(input)?.[1] || /done-file (\\S+) is still/.exec(input)[1];
  fs.appendFileSync(done + ".args", JSON.stringify(args) + "\\n");
  let drops = 0;
  try { drops = Number(fs.readFileSync(done + ".drops", "utf8")); } catch {}
  if (drops > 0) {
    fs.writeFileSync(done + ".drops", String(drops - 1));
    const msg = fs.readFileSync(done + ".msg", "utf8");
    console.error(msg);
    console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: msg }));
    process.exit(1);
  }
  fs.writeFileSync(done, "{}");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 10, num_turns: 1, session_id: args[args.indexOf("--resume") + 1] || args[args.indexOf("--session-id") + 1] }));
});
`;

function film() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-net-")));
  const claude = path.join(dir, "fake-claude.js");
  fs.writeFileSync(claude, `#!${process.execPath}\n${FAKE_CLAUDE}`);
  fs.chmodSync(claude, 0o755);
  fs.mkdirSync(path.join(dir, "prompts"));
  return { dir, claude, done: (n) => path.join(dir, `${n}.done`) };
}

function stage(f, name, { drops = 0, msg = "API Error: Can't reach the API server (ENOTFOUND)", ...extra } = {}) {
  const prompt = path.join(f.dir, "prompts", `${name}.txt`);
  fs.writeFileSync(prompt, `Do the ${name} job.\n`);
  if (drops) {
    fs.writeFileSync(`${f.done(name)}.drops`, String(drops));
    fs.writeFileSync(`${f.done(name)}.msg`, msg);
  }
  return { name, kind: "session", prompt, done: f.done(name), ...extra };
}

const planOf = (f, stages, extra = {}) => ({
  dir: f.dir, claude: f.claude, networkBackoffSec: [0.01], lock: { dir: path.join(f.dir, ".lock"), gpu: false, pollMs: 10 }, stages, ...extra,
});
const quiet = { print: () => {} };
const callsOf = (f, name) => fs.readFileSync(`${f.done(name)}.args`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const statusOf = (f) => fs.readFileSync(path.join(f.dir, "status.txt"), "utf8");

test("network errors: the list matches the measured messages and nothing else", () => {
  for (const m of [
    "API Error: Can't reach the API server (ENOTFOUND)",
    "API Error: Unable to connect to API: SSL certificate hostname mismatch",
    "read ECONNRESET",
    "request failed: socket hang up",
  ]) assert.equal(isNetworkError(m), true, m);
  for (const m of ["", "rate limit reached", "Prompt is too long", undefined]) assert.equal(isNetworkError(m), false, String(m));
});

test("runner: the first call carries --session-id, and a first-call network drop is retried with --resume of that id", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [stage(f, "voice", { drops: 2 })]), quiet);
  assert.equal(r.ok, true);
  const [first, second, third] = callsOf(f, "voice");
  const sid = flagValue(first, "--session-id");
  assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(!first.includes("--resume"));
  for (const args of [second, third]) {
    assert.equal(flagValue(args, "--resume"), sid);
    assert.ok(!args.includes("--session-id"));
  }
  const lines = statusOf(f).split("\n").filter((l) => /network error/.test(l));
  assert.equal(lines.length, 2);
});

test("runner: network retries do not use maxResumes (maxResumes 0 still survives drops)", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [stage(f, "voice", { drops: 3, msg: "Unable to connect to API: SSL certificate hostname mismatch", maxResumes: 0 })]), quiet);
  assert.equal(r.ok, true);
  assert.equal(callsOf(f, "voice").length, 4);
});

test("runner: network retries stop at maxNetworkRetries and the stage fails", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [stage(f, "voice", { drops: 50, maxResumes: 0 })], { maxNetworkRetries: 2 }), quiet);
  assert.equal(r.ok, false);
  assert.equal(callsOf(f, "voice").length, 3);
  assert.match(r.outcome.get("voice").reason, /network/);
});

test("runner: a failure that is not a network message keeps the old path (a resume, no backoff retry)", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [stage(f, "voice", { drops: 1, msg: "Prompt is too long" })], { maxNetworkRetries: 5 }), quiet);
  assert.equal(r.ok, true);
  const calls = callsOf(f, "voice");
  assert.equal(calls.length, 2);
  assert.equal(flagValue(calls[1], "--resume"), flagValue(calls[0], "--session-id"));
  assert.ok(!/network error/.test(statusOf(f)));
});

test("runner: a later stage still runs after an earlier stage rode out a drop", async () => {
  const f = film();
  const second = stage(f, "dub", { needs: ["voice"] });
  const r = await runPlan(planOf(f, [stage(f, "voice", { drops: 1 }), second]), quiet);
  assert.equal(r.ok, true);
});
