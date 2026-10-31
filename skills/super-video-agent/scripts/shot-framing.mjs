#!/usr/bin/env node
// Shot framing check (references/3d.md "Hero and viewing shots"): a subject that must be seen whole is inside every frame
// that shows it, with a margin, and with --center a featured subject sits at the frame's horizontal centre. Exit 1 on a
// crop or an off-centre subject.
import fs from "node:fs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { checkFraming } from "./lib/shot-framing.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: shot-framing.mjs <shots.json> [--margin 0.05] [--center <share>] [--json <out.json>]

shots.json: {"shots": [{"t": <seconds or label>, "camera": {"eye":[x,y,z], "target":[x,y,z], "up":[0,-1,0], "fov":40,
"aspect":1.778}, "subjects": [{"name": "statue", "box": [x0,y0,z0,x1,y1,z1], "points": [[x,y,z], ...],
"allowBottom": false, "center": 0.05}]}]}  (or a bare list of shots). Cameras as the LDraw order gate reads them (LDraw
frame, -Y up).

Every subject's points (its box corners plus the named points: head, hands) must project inside the frame, at least
--margin of the frame (default 0.05 = 5 %) from every edge. allowBottom lets only the bottom edge cut (a pedestal's foot).
--center <share> (or "center" on a subject, which wins; null turns it off for that subject): the subject's projected box
centre must be within that share of the frame width of the centre (featured subjects in a vertical Short: 0.05).
Sample a moving camera densely (every 0.1 s, or every frame of a hold and its moves). Exit 0 all framed, 1 a crop or an
off-centre subject, 2 bad input.
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
    const center = flags.center === undefined ? null : Number(flags.center);
    if (center !== null && !(center >= 0 && center < 0.5)) throw new Error("--center takes a share of the frame width in [0, 0.5)");
    const r = checkFraming(shots, { margin, center });
    const out = [`framing: ${r.checked} subject-shots checked, ${r.fails.length} fail(s) (margin ${margin}${center !== null ? `, centre ±${center}` : ""})`];
    for (const f of r.fails.slice(0, 30)) {
      if (f.out.length) out.push(`  CROP t ${f.t} ${f.name}: ${f.out.map((o) => `point ${o.i} ${o.side} (${o.x}, ${o.y})`).join("; ")}`);
      if (f.offCentre) out.push(`  OFF-CENTRE t ${f.t} ${f.name}: box centre ${f.offset > 0 ? "+" : ""}${f.offset} of the frame width (${f.offset > 0 ? "right" : "left"} of centre)`);
    }
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
