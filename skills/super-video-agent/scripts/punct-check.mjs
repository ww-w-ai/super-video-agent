#!/usr/bin/env node
// Punctuation and script check for every language of a film: the base plan (plan.json meta.lang) and each
// dub/<code>/plan.json, read from the film itself, never from a fixed list. Rules: lib/punct-rules.mjs.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import { checkText } from "./lib/punct-rules.mjs";
import { checkedNothingNext } from "./lib/checked-nothing.mjs";

const HELP = `usage: punct-check.mjs <reel-dir> [--lang <code>[,<code>...]] [--out <json>]

Reads the caption text of the base plan (plan.json, language meta.lang) and of every dub/<code>/plan.json
and checks each line against that language's row of the table in references/pipeline.md
"Punctuation and script table" (rules in scripts/lib/punct-rules.mjs). The languages come from the film.
--lang  only these codes.
Each finding is "<lang> <line id>: <rule> [wrong|check]: ...text... - detail".
  wrong  a form that cannot be right for the language (a full-width mark in Latin text, a half-width mark
         straight after a CJK character, an inverted mark outside Spanish): exit 1, so that step stops.
  check  usually a slip but can be meant (another script's letter, a space before a mark, a straight
         quote): reported for the language's editor session to judge. Exit 0.
A language with no table row, or a film with no text, prints "checked nothing" and what to do.
Writes <reel-dir>/out/punct-check.json.
`;

/** [{lang, lines}] from the base plan and each dub/<code>/plan.json (the folder name when the plan names no lang). */
export function languagePlans(dir) {
  const paths = reelPaths(dir);
  const out = [];
  if (fs.existsSync(paths.planJson)) {
    const base = readJson(paths.planJson);
    out.push({ lang: (base.meta && base.meta.lang) || "base", lines: base.lines || [] });
  }
  const dubRoot = path.join(dir, "dub");
  for (const code of fs.existsSync(dubRoot) ? fs.readdirSync(dubRoot).sort() : []) {
    const p = path.join(dubRoot, code, "plan.json");
    if (!fs.existsSync(p)) continue;
    const plan = readJson(p);
    out.push({ lang: (plan.meta && plan.meta.lang) || code, lines: plan.lines || [] });
  }
  return out;
}

/** Findings and the languages that could not be checked. */
export function checkLanguages(plans) {
  const findings = [];
  const noRow = [];
  let checkedLines = 0;
  for (const { lang, lines } of plans) {
    const texts = lines.filter((l) => typeof l.text === "string" && l.text.trim());
    const probe = checkText(lang, "");
    if (probe === null) {
      noRow.push(lang);
      continue;
    }
    for (const l of texts) {
      checkedLines++;
      for (const f of checkText(lang, l.text)) findings.push({ lang, lineId: l.id, ...f });
    }
  }
  return { findings, noRow, checkedLines };
}

/** The report as text: findings one by one, then what was not checked. */
export function formatPunctReport({ findings, noRow, checkedLines }) {
  const out = [];
  for (const f of findings) out.push(`${f.lang} ${f.lineId}: ${f.rule} [${f.severity}]: ...${f.excerpt}... - ${f.detail}`);
  for (const lang of noRow) out.push(`${lang}: checked nothing (no row in the punctuation table). ${checkedNothingNext(`a row for ${lang} in scripts/lib/punct-rules.mjs and in references/pipeline.md`)}`);
  if (!checkedLines && !noRow.length) out.push(`punctuation and script: checked nothing (no caption text found). ${checkedNothingNext("plan.json lines with text, or dub/<code>/plan.json")}`);
  else if (checkedLines) out.push(`punctuation and script: ${checkedLines} lines checked, ${findings.filter((f) => f.severity === "wrong").length} wrong, ${findings.filter((f) => f.severity === "check").length} to check`);
  return out.join("\n") + "\n";
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const dir = abs(positional[0]);
  let plans;
  try {
    plans = languagePlans(dir);
  } catch (e) {
    return fail(e.message);
  }
  if (typeof flags.lang === "string") {
    const want = new Set(flags.lang.split(",").map((s) => s.trim().toLowerCase()));
    plans = plans.filter((p) => want.has(p.lang.toLowerCase()));
  }
  const result = checkLanguages(plans);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(reelPaths(dir).outDir, "punct-check.json");
  writeJson(outPath, result);
  process.stdout.write(formatPunctReport(result));
  process.stdout.write(`wrote ${outPath}\n`);
  if (result.findings.some((f) => f.severity === "wrong")) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
