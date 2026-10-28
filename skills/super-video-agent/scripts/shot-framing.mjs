#!/usr/bin/env node
// Shot framing check (references/assembly.md "Whole subjects stay whole in frame"): a subject that must be seen whole is
// inside every frame that shows it, with a margin. Exit 1 when any shot crops it.
import fs from "node:fs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { checkFraming } from "./lib/shot-framing.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: shot-framing.mjs <shots.json> [--margin 0.05] [--json <out.json>]

shots.json: {"shots": [{"t": <seconds or label>, "camera": {"eye":[x,y,z], "target":[x,y,z], "up":[0,-1,0], "fov":40,
"aspect":1.778}, "subjects": [{"name": "statue", "box": [x0,y0,z0,x1,y1,z1], "points": [[x,y,z], ...],
"allowBottom": false}]}]}  (or a bare list of shots). Cameras as the LDraw order gate reads them (LDraw frame, -Y up).

Every subject's points (its box corners plus the named points: head, hands) must project inside the frame, at least
--margin of the frame (default 0.05 = 5 %) from every edge. allowBottom lets only the bottom edge cut (a pedestal's foot).
Sample a moving camera densely (every 0.1 s, or every frame of a hold and its moves). Exit 0 all framed, 1 a crop, 2 bad input.
`;

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1) return printHelpAndExit(HELP, 2);
  try {
    const spec = JSON.parse(fs.readFileSync(abs(positional[0]), "utf8"));
    const shots = Array.isArray(spec) ? spec : spec.shots;
    if (!Array.isArray(shots)) throw new Error("shots.json needs a list of shots or {shots: [...]}");
    const margin = flags.margin === undefined ? 0.05 : Number(flags.margin);
    if (!(margin >= 0 && margin < 0.5)) throw new Error("--margin takes a share of the frame in [0, 0.5)");
    const r = checkFraming(shots, { margin });
    const out = [`framing: ${r.checked} subject-shots checked, ${r.fails.length} crop(s) (margin ${margin})`];
    for (const f of r.fails.slice(0, 30)) out.push(`  CROP t ${f.t} ${f.name}: ${f.out.map((o) => `point ${o.i} ${o.side} (${o.x}, ${o.y})`).join("; ")}`);
    process.stdout.write(out.join("\n") + "\n");
    if (typeof flags.json === "string") fs.writeFileSync(abs(flags.json), JSON.stringify(r, null, 1));
    process.exitCode = r.fails.length ? 1 : 0;
  } catch (e) {
    return fail(e.message, 2);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
