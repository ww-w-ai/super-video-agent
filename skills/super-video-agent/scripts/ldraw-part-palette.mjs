#!/usr/bin/env node
// Part-palette share of a freely designed LDraw model (references/assembly.md "Sculpted subjects": the palette gate).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { paletteShare } from "./lib/ldraw-part-palette.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: ldraw-part-palette.mjs <model.ldr|.mpd> --lib <parts-folder> --palette <palette.json>
         [--min-specialty 0.25] [--region <submodel text>] [--json <out.json>]

Counts the parts of a model (MPD blocks and sibling .ldr files followed, with multiplicity):
  basic      plain rectangular bricks, plates and tiles (library title "Brick|Plate|Tile N x N [x H]")
  specialty  any part id on the palette (printed and composite variants of a palette part count too)
  other      everything else (candidates to add to the palette if they are curved or line-specific)
--palette   the project's curated palette {"groups":[{"key","title","parts":[{"id"}]}]} (all LEGO lines: curves, SNOT,
            line-specific shapes such as car panels, East-Asian roofs, creature parts)
--region    count only inside sub-models whose name contains this text (a statue's sub-model)
--min-specialty  the share that passes (default 0.25; statues and figures 0.5)

Mega builds only (any part from any line); a follow-along build keeps to its set. Exit 0 pass, 1 below the minimum, 2 bad input.
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1 || typeof flags.lib !== "string" || typeof flags.palette !== "string") return printHelpAndExit(HELP, 2);
  let r;
  try {
    const min = flags["min-specialty"] === undefined ? 0.25 : Number(flags["min-specialty"]);
    if (!(min >= 0 && min <= 1)) throw new Error("--min-specialty takes a share in [0, 1]");
    r = paletteShare({ model: abs(positional[0]), lib: abs(flags.lib), palette: abs(flags.palette), region: typeof flags.region === "string" ? flags.region : "", min });
  } catch (e) {
    return fail(e.message, 2);
  }
  const pct = (n) => (r.total ? ((100 * n) / r.total).toFixed(1) + "%" : "n/a");
  const out = [`model ${path.basename(positional[0])}${r.region ? `  region "${r.region}"` : ""}`];
  if (r.region && !r.total) out.push(`WARNING no parts in a sub-model whose name contains "${r.region}" (sub-models: ${r.submodels.slice(0, 20).join(", ")})`);
  out.push(`parts ${r.total}  basic ${r.basic} (${pct(r.basic)})  specialty ${r.specialty} (${pct(r.specialty)})  other ${r.other} (${pct(r.other)})`);
  for (const [g, n] of Object.entries(r.byGroup).sort((a, b) => b[1] - a[1])) out.push(`  ${g.padEnd(10)} ${String(n).padStart(6)} (${pct(n)})  ${r.groupTitles[g] || ""}`);
  out.push(`distinct specialty ids: ${r.distinctSpecialty.length}  ${r.distinctSpecialty.slice(0, 40).map(([i, n]) => `${i}x${n}`).join(" ")}`);
  if (r.topOther.length) out.push(`top other ids: ${r.topOther.map(([i, n]) => `${i}x${n}`).join(" ")}`);
  out.push(`${r.pass ? "PASS" : "FAIL"} specialty ${(r.share * 100).toFixed(1)}% vs minimum ${(r.min * 100).toFixed(0)}%`);
  process.stdout.write(out.join("\n") + "\n");
  if (typeof flags.json === "string") fs.writeFileSync(abs(flags.json), JSON.stringify(r, null, 1));
  process.exitCode = r.pass ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
