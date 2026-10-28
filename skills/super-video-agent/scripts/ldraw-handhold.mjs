#!/usr/bin/env node
// Checks that every item in a minifig hand is gripped on a 3.18 mm bar (references/assembly.md "Minifig hands hold bars only").
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { handhold } from "./lib/ldraw-handhold.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: ldraw-handhold.mjs <model.mpd|model.ldr> --lib <parts-folder> [--moving <moving.json>] [--json <out.json>]

A minifig hand (3820, and a hand inside a composite arm) is a C-clip for a 3.18 mm bar (8 LDU). For every part whose
geometry enters a hand's clip it reports PASS when one of the part's bars lies on the clip axis (<= 8 deg, <= 1.2 LDU
off-centre) and fills at least half the 11 LDU grip, and FAIL otherwise (a stud, brick body, plate edge, tile, camera
body, or a bar at the wrong angle). Bars come from the part's own cylinder primitives of radius 4 LDU (holes marked
BFC INVERTNEXT and stud primitives are not bars).

--lib <dir>       the parts library (the folder with parts/ and p/)
--moving <file>   optional animation data: any object with "steps" (step numbers of the main model) and a "pivot",
                  and "groups" {name: [steps]}. FAIL when an entry moves a held item without its hand or the hand
                  without the item, when its pivot is not on the arm's shoulder axis or at the torso, or when an entry
                  named rod / camera / tool / held / item / paddle / oar / binoculars / prop moves parts no hand grips.
--json <file>     also write the result as JSON

CHECK lines (not failures): a held item whose own up (its part frame's -Y) points more than 120 deg from up, e.g. a
camera held upside down. Turn it about the grip or take the bar's other end, keep its front where the figure looks,
and look at a close-up sheet next to a photo of a real minifig before anyone else sees it.

Reads the library directly (no bake), so it is fast on very large models. Exit 0 when nothing fails, 1 when an item fails.
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1 || typeof flags.lib !== "string") return printHelpAndExit(HELP, 1);
  try {
    const model = abs(positional[0]);
    const r = handhold(model, { lib: abs(flags.lib), moving: typeof flags.moving === "string" ? abs(flags.moving) : null });
    const out = [`handhold ${path.basename(model)}: ${r.ok ? "OK" : `${r.problems.length} failing`}${r.checks.length ? `, ${r.checks.length} to look at` : ""}`, r.info, ...r.problems.map((p) => `- ${p}`), ...r.checks.map((p) => `- ${p}`), ...r.passes.map((p) => `- ${p}`)];
    process.stdout.write(out.join("\n") + "\n");
    if (typeof flags.json === "string") fs.writeFileSync(abs(flags.json), JSON.stringify(r, null, 1));
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) {
    return fail(e.message);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
