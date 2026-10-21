// run.mjs: per-stage --model / --effort on every claude call, and result files that survive a rerun.
// `claude` is a node script that records its argv per call and writes the done-file (on the first call, or
// only on a resume when FAKE_NEEDS_RESUME is in the prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePlan } from "../scripts/runner/plan.mjs";
import { runPlan, modelArgs } from "../scripts/runner/run.mjs";
import { reportFor, formatReport, stageOfFile } from "../scripts/runner/cost-report.mjs";

const FAKE_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const done = /Done-file \\(absolute path\\): (.+)/.exec(input)?.[1] || /done-file (\\S+) is still/.exec(input)[1];
  fs.appendFileSync(done + ".args", JSON.stringify(args) + "\\n");
  if (args.includes("--resume") || !input.includes("FAKE_NEEDS_RESUME")) fs.writeFileSync(done, "{}");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, duration_ms: 1000, num_turns: 2, session_id: "sid", usage: { input_tokens: 10, output_tokens: 5 } }));
});
`;

function film() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runner-flags-")));
  const claude = path.join(dir, "fake-claude.js");
  fs.writeFileSync(claude, `#!${process.execPath}\n${FAKE_CLAUDE}`);
  fs.chmodSync(claude, 0o755);
  fs.mkdirSync(path.join(dir, "prompts"));
  return { dir, claude, done: (n) => path.join(dir, `${n}.done`) };
}

function stage(f, name, extra = {}) {
  const prompt = path.join(f.dir, "prompts", `${name}.txt`);
  fs.writeFileSync(prompt, `Do the ${name} job.\n${extra.needsResume ? "FAKE_NEEDS_RESUME\n" : ""}`);
  const { needsResume, ...rest } = extra;
  return { name, kind: "session", prompt, done: f.done(name), ...rest };
}

const planOf = (f, stages, extra = {}) => ({ dir: f.dir, claude: f.claude, lock: { dir: path.join(f.dir, ".lock"), gpu: false, pollMs: 10 }, stages, ...extra });
const quiet = { print: () => {} };
const callsOf = (f, name) => fs.readFileSync(`${f.done(name)}.args`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test("runner: a stage's model and effort become --model / --effort on its first call and on the resume", async () => {
  const f = film();
  const r = await runPlan(planOf(f, [stage(f, "script", { model: "claude-opus-5-5", effort: "xhigh", needsResume: true })]), quiet);
  assert.equal(r.ok, true);
  const [first, resume] = callsOf(f, "script");
  assert.ok(resume.includes("--resume"));
  for (const args of [first, resume]) {
    assert.equal(flagValue(args, "--model"), "claude-opus-5-5");
    assert.equal(flagValue(args, "--effort"), "xhigh");
  }
});

test("runner: the plan's model and effort apply to stages without their own; a stage value overrides", async () => {
  const f = film();
  const stages = [stage(f, "review"), stage(f, "film", { model: "claude-opus-5-5", effort: "max" }), stage(f, "voice", { effort: "low" })];
  const r = await runPlan(planOf(f, stages, { model: "claude-haiku-5-5", effort: "medium", claudeArgs: ["--verbose"] }), quiet);
  assert.equal(r.ok, true);
  const [review] = callsOf(f, "review");
  const [film_] = callsOf(f, "film");
  const [voice] = callsOf(f, "voice");
  assert.deepEqual([flagValue(review, "--model"), flagValue(review, "--effort")], ["claude-haiku-5-5", "medium"]);
  assert.deepEqual([flagValue(film_, "--model"), flagValue(film_, "--effort")], ["claude-opus-5-5", "max"]);
  assert.deepEqual([flagValue(voice, "--model"), flagValue(voice, "--effort")], ["claude-haiku-5-5", "low"]);
  assert.ok(review.includes("--verbose"));
});

test("runner: no model or effort anywhere adds no flag", async () => {
  assert.deepEqual(modelArgs({}, {}), []);
  const f = film();
  await runPlan(planOf(f, [stage(f, "plain")]), quiet);
  const [args] = callsOf(f, "plain");
  assert.ok(!args.includes("--model") && !args.includes("--effort"));
});

test("plan --check: a non-string model and an effort outside low|medium|high|xhigh|max are refused, on a stage and on the plan", () => {
  const f = film();
  const ok = planOf(f, [stage(f, "a", { model: "m", effort: "xhigh" })], { model: "m2", effort: "low" });
  assert.equal(validatePlan(ok).stages.length, 1);
  assert.throws(() => validatePlan(planOf(f, [stage(f, "a", { effort: "extreme" })])), /stage "a": "effort" must be one of low\|medium\|high\|xhigh\|max/);
  assert.throws(() => validatePlan(planOf(f, [stage(f, "a", { model: 5 })])), /stage "a": "model" must be a non-empty string/);
  assert.throws(() => validatePlan(planOf(f, [stage(f, "a")], { effort: "turbo" })), /plan: "effort" must be one of/);
});

test("runner: two runs on the same plan keep both result files and the cost report sums them", async () => {
  const f = film();
  const plan = planOf(f, [stage(f, "voice")]);
  await runPlan(plan, quiet);
  const second = await runPlan(plan, { ...quiet, redo: ["voice"] });
  const results = fs.readdirSync(path.join(f.dir, "results"));
  assert.equal(results.length, 2);
  assert.equal(new Set(results).size, 2);
  assert.match(second.report, /voice \| 2 \| 1\.00/);
  assert.match(second.report, /total \| 2 \| 1\.00/);
});

test("cost report: files in the run-id, attempt-only and result-<stage> names are all summed per stage", () => {
  const f = film();
  const results = path.join(f.dir, "results");
  fs.mkdirSync(results);
  const body = (cost) => JSON.stringify({ type: "result", subtype: "success", total_cost_usd: cost, duration_ms: 1000, num_turns: 1, session_id: "s" });
  fs.writeFileSync(path.join(results, "voice.rk1a2b3.0.json"), body(1));
  fs.writeFileSync(path.join(results, "voice.rk1a2b3.1.json"), body(0.5));
  fs.writeFileSync(path.join(results, "voice.rk9z9z9.0.json"), body(2));
  fs.writeFileSync(path.join(results, "voice.0.json"), body(0.25));
  fs.writeFileSync(path.join(results, "result-voice.json"), body(0.125));
  const agg = reportFor(f.dir);
  assert.equal(agg.stages.length, 1);
  assert.equal(agg.stages[0].sessions, 5);
  assert.equal(agg.stages[0].cost, 3.875);
  assert.match(formatReport(agg), /voice \| 5 \| 3\.88/);
  assert.deepEqual(stageOfFile("/r/voice.rk1a2b3.1.json"), { stage: "voice", run: "rk1a2b3", attempt: 1 });
  assert.deepEqual(stageOfFile("/r/voice.2.json"), { stage: "voice", run: "", attempt: 2 });
});
