#!/usr/bin/env node
// One report from the per-stage result files of `claude -p --output-format json`: cost, time, turns,
// tokens and error flags per stage and in total. run.mjs prints it at the end of a run; the film's
// final report to the user includes it. Facts only: a file that cannot be read is listed, not guessed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit } from "../lib/cli.mjs";

const HELP = `usage: cost-report.mjs <film-dir> [--results <dir>] [--json]

Reads every <results>/<stage>.<attempt>.json (default <film-dir>/results; the older
result-<stage>.json name also works), one file per session or resume, and prints per stage:
  sessions (1 + resumes), cost in USD, session time, turns, input/output tokens, error flags
then the totals. Flags: is_error true, a subtype other than "success" (for example error_max_turns),
a file that is empty or not JSON, a result with no cost field.
Stage wall time (start to finish, waits included) is added when <film-dir>/.runner/state.json exists.
TTS usage: reads the optional <film-dir>/voice/tts-usage.jsonl, <film-dir>/dub/<code>/voice/tts-usage.jsonl (where voice.mjs writes it) and <film-dir>/dub/<code>/tts-usage.jsonl, one JSON
object per synthesis: {"provider": "...", "chars": 120, "seconds" or "audioSec": 8.4, "cost": 0.012} (cost may be missing). It prints
syntheses, characters, seconds and known cost per folder and provider, or "not logged" when no such file exists.
--json prints the same numbers as JSON.
`;

/** The result object of one file: the file is one JSON object, or an array of events whose last "result" entry counts. */
export function parseResult(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) v = [...v].reverse().find((e) => e && e.type === "result") || null;
  return v && typeof v === "object" ? v : null;
}

export function stageOfFile(file) {
  const base = path.basename(file, ".json");
  const m = /^(.+)\.(\d+)$/.exec(base);
  if (m) return { stage: m[1], attempt: Number(m[2]) };
  return { stage: base.replace(/^result-/, ""), attempt: 0 };
}

function numberOr(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** One row per file. */
export function rowOfFile(file, text) {
  const { stage, attempt } = stageOfFile(file);
  const r = parseResult(text);
  if (!r) return { stage, attempt, flags: ["unreadable"], cost: 0, durationMs: 0, turns: 0, inTokens: 0, outTokens: 0 };
  const flags = [];
  if (r.is_error) flags.push("is_error");
  if (r.subtype && r.subtype !== "success") flags.push(r.subtype);
  const cost = r.total_cost_usd ?? r.cost_usd;
  if (typeof cost !== "number") flags.push("no-cost-field");
  const u = r.usage || {};
  return {
    stage, attempt, flags, sessionId: r.session_id || null,
    cost: numberOr(cost), durationMs: numberOr(r.duration_ms), turns: numberOr(r.num_turns),
    inTokens: numberOr(u.input_tokens) + numberOr(u.cache_creation_input_tokens) + numberOr(u.cache_read_input_tokens),
    outTokens: numberOr(u.output_tokens),
  };
}

/** Per-stage totals, stages sorted by name. */
export function aggregate(rows, wallMsByStage = {}) {
  const by = new Map();
  for (const r of [...rows].sort((a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : a.attempt - b.attempt))) {
    const s = by.get(r.stage) || { stage: r.stage, sessions: 0, cost: 0, durationMs: 0, turns: 0, inTokens: 0, outTokens: 0, flags: [], wallMs: wallMsByStage[r.stage] ?? null };
    s.sessions += 1;
    for (const k of ["cost", "durationMs", "turns", "inTokens", "outTokens"]) s[k] += r[k];
    for (const f of r.flags) s.flags.push(r.attempt ? `${f}@resume${r.attempt}` : f);
    by.set(r.stage, s);
  }
  const stages = [...by.values()];
  const total = stages.reduce((t, s) => {
    for (const k of ["sessions", "cost", "durationMs", "turns", "inTokens", "outTokens"]) t[k] += s[k];
    return t;
  }, { sessions: 0, cost: 0, durationMs: 0, turns: 0, inTokens: 0, outTokens: 0 });
  return { stages, total, flagged: stages.filter((s) => s.flags.length).map((s) => s.stage) };
}

const fmtMin = (ms) => `${(ms / 60000).toFixed(1)} min`;
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatReport(agg) {
  const lines = ["Stage report (sessions run through claude -p)", "stage | sessions | cost USD | session time | wall time | turns | tokens in/out | flags"];
  for (const s of agg.stages) {
    lines.push(`${s.stage} | ${s.sessions} | ${s.cost.toFixed(2)} | ${fmtMin(s.durationMs)} | ${s.wallMs === null ? "-" : fmtMin(s.wallMs)} | ${s.turns} | ${fmtK(s.inTokens)}/${fmtK(s.outTokens)} | ${s.flags.join(", ") || "-"}`);
  }
  const t = agg.total;
  lines.push(`total | ${t.sessions} | ${t.cost.toFixed(2)} | ${fmtMin(t.durationMs)} | - | ${t.turns} | ${fmtK(t.inTokens)}/${fmtK(t.outTokens)} | ${agg.flagged.length ? `flagged: ${agg.flagged.join(", ")}` : "none flagged"}`);
  if (agg.stages.length === 0) lines.push("no result files found");
  lines.push("Cost is what claude -p reports per session; rendering, voice and other tools run outside a session and are not in it.");
  if (agg.tts) lines.push(...formatTts(agg.tts));
  return lines.join("\n") + "\n";
}

const TTS_LOG = "tts-usage.jsonl";

/** The folders a film's voice synthesis logs to: voice/ and, per language, dub/<code>/voice/ (where voice.mjs writes) and dub/<code>/. */
function ttsScopes(filmDir) {
  const scopes = [{ scope: "voice", dir: path.join(filmDir, "voice") }];
  try {
    for (const code of fs.readdirSync(path.join(filmDir, "dub")).sort()) {
      scopes.push({ scope: `dub/${code}/voice`, dir: path.join(filmDir, "dub", code, "voice") });
      scopes.push({ scope: `dub/${code}`, dir: path.join(filmDir, "dub", code) });
    }
  } catch {
    /* no dub folder */
  }
  return scopes;
}

/**
 * TTS usage from the optional `tts-usage.jsonl` files (one JSON object per synthesis: provider, chars, seconds,
 * cost when known). Returns {logged:false} when no film folder has the file; else per scope and provider the
 * synthesis count, characters, seconds, the cost that was known and how many syntheses had none, plus the count
 * of lines that were not JSON objects.
 */
export function ttsUsageFor(filmDir) {
  const rows = new Map();
  let unreadable = 0;
  let files = 0;
  for (const { scope, dir } of ttsScopes(filmDir)) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, TTS_LOG), "utf8");
    } catch {
      continue;
    }
    files++;
    for (const line of text.split("\n").filter((l) => l.trim())) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        e = null;
      }
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        unreadable++;
        continue;
      }
      const provider = typeof e.provider === "string" && e.provider ? e.provider : "unknown";
      const row = rows.get(`${scope}\u0000${provider}`) || { scope, provider, syntheses: 0, chars: 0, seconds: 0, cost: 0, noCost: 0 };
      row.syntheses += 1;
      row.chars += numberOr(e.chars);
      row.seconds += numberOr(e.seconds ?? e.audioSec);
      if (typeof e.cost === "number" && Number.isFinite(e.cost)) row.cost += e.cost;
      else row.noCost += 1;
      rows.set(`${scope}\u0000${provider}`, row);
    }
  }
  return { logged: files > 0, files, unreadable, rows: [...rows.values()] };
}

function formatTts(tts) {
  if (!tts.logged) return [`TTS usage: not logged (no ${TTS_LOG} in voice/ or dub/<code>/)`];
  const lines = ["TTS usage (from tts-usage.jsonl)", "scope | provider | syntheses | chars | seconds | cost USD (known)"];
  for (const r of tts.rows) lines.push(`${r.scope} | ${r.provider} | ${r.syntheses} | ${r.chars} | ${r.seconds.toFixed(1)} | ${r.cost.toFixed(4)}${r.noCost ? ` (+${r.noCost} without cost)` : ""}`);
  if (!tts.rows.length) lines.push("the file(s) hold no readable entry");
  if (tts.unreadable) lines.push(`${tts.unreadable} line(s) were not JSON objects and are not counted`);
  return lines;
}

function wallTimes(filmDir) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(filmDir, ".runner", "state.json"), "utf8"));
    const out = {};
    for (const [name, s] of Object.entries(st.stages || {})) {
      if (s.startedAt && s.finishedAt) out[name] = Date.parse(s.finishedAt) - Date.parse(s.startedAt);
    }
    return out;
  } catch {
    return {};
  }
}

/** Reads the result files of a film folder and returns the aggregate. */
export function reportFor(filmDir, resultsDir = path.join(filmDir, "results")) {
  let files = [];
  try {
    files = fs.readdirSync(resultsDir).filter((n) => n.endsWith(".json")).map((n) => path.join(resultsDir, n));
  } catch {
    /* no results folder yet: the report says so */
  }
  const rows = files.map((f) => rowOfFile(f, fs.readFileSync(f, "utf8")));
  return { ...aggregate(rows, wallTimes(filmDir)), tts: ttsUsageFor(filmDir) };
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) return printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
  const filmDir = path.resolve(positional[0]);
  const agg = reportFor(filmDir, typeof flags.results === "string" ? path.resolve(flags.results) : undefined);
  process.stdout.write(flags.json ? JSON.stringify(agg) + "\n" : formatReport(agg));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
