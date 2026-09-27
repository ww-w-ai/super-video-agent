#!/usr/bin/env node
// Validate a reel's plan.json against scripts/plan.schema.json.
// Exit non-zero with the failing path(s) if invalid.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, reelPaths } from "./lib/reeldir.mjs";
import { validate } from "./lib/schema-check.mjs";

const HELP = `usage: validate-plan.mjs <reel-dir>

Validates <reel-dir>/plan.json against scripts/plan.schema.json.
Exits 0 and prints "ok" if valid; exits 1 and prints each failing
JSON path if not.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readJson(path.join(here, "plan.schema.json"));

  let plan;
  try {
    plan = readJson(paths.planJson);
  } catch (e) {
    fail(e.message);
    return;
  }

  const { valid, errors } = validate(plan, schema);
  if (valid) errors.push(...cueWordErrors(plan));
  if (errors.length) {
    process.stderr.write("plan.json is invalid:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("ok\n");
}

/**
 * A cue at "word:<w>" lands on the first word of the line's `text` that
 * contains <w> (reel-engine.js cueTime). One that matches no word falls back
 * to the line start at render time; catch it here, before the voice is made.
 */
export function cueWordErrors(plan) {
  const errors = [];
  (plan.lines || []).forEach((line, i) => {
    const words = String(line.text || "").split(/\s+/);
    (line.cues || []).forEach((cue, j) => {
      if (typeof cue.at !== "string" || !cue.at.startsWith("word:")) return;
      const w = cue.at.slice(5);
      if (!words.some((x) => x.includes(w))) {
        errors.push(`lines[${i}].cues[${j}].at: "${cue.at}" matches no word in line "${line.id}" text`);
      }
    });
  });
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
