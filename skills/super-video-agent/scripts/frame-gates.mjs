#!/usr/bin/env node
// Frame-to-frame stability gates for 3D step-build films (references/3d.md "Stable frame in step builds"; EV-73, EV-74).
// Runs on JSON the film's page probe wrote (per output frame: base plate screen position, camera vector); no media is read.
import fs from "node:fs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { plateStill, roadFlicker } from "./lib/frame-gates.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: frame-gates.mjs plate <track.json> [--still 2] [--move 45] [--turn 270] [--span i0,i1] [--json <out>]
       frame-gates.mjs road  <track.json> --means <means.json> [--limit 0.5] [--span i0,i1] [--json <out>]

track.json: {"fps": 30, "frames": [{"px": 540, "py": 960, "vis": true, "cam": [x, y, z, azimuth, elevation, ...], "fa": 0}, ...]}
  one record per output frame, from the page's own camera (the plate's projected centre). cam[3], cam[4] are the view angles in
  degrees; a change of either (or of "fa", a flip angle) marks a planned turn.
plate: the plate moves <= --still px per frame outside planned turns, <= --move px per frame inside them, and the camera turns
  <= --turn deg/s. A peak over 90 deg/s (the Shorts target) is printed as a warning.
road:  means.json = per frame [r, g, b] mean of the ground pixels (null where unmeasured), measured on the final video. In a
  static camera the colour changes <= --limit (default 0.5 of 255) between consecutive frames (D1) and from the average of its
  neighbours (D2, outside planned turns).
Exit 0 pass, 1 a violation, 2 bad input.
`;

const span = (s) => (typeof s === "string" ? s.split(",").map(Number) : undefined);

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  const [mode, file] = positional;
  if (!["plate", "road"].includes(mode) || !file) return printHelpAndExit(HELP, 2);
  try {
    const track = JSON.parse(fs.readFileSync(abs(file), "utf8"));
    if (!Array.isArray(track.frames) || !(track.fps > 0)) throw new Error("track.json needs fps and frames[]");
    let r;
    if (mode === "plate") {
      r = plateStill(track.frames, track.fps, { stillPx: flags.still === undefined ? undefined : Number(flags.still), movePx: flags.move === undefined ? undefined : Number(flags.move), turnDegS: flags.turn === undefined ? undefined : Number(flags.turn), span: span(flags.span) });
      process.stdout.write(`plate-still: ${r.pass ? "PASS" : "FAIL"} still ${r.frames.still} frames max ${r.max.stillPx} px (limit ${r.limits.stillPx}); planned ${r.frames.planned} frames max ${r.max.movePx} px; turn max ${r.max.turnDegPerS} deg/s (limit ${r.limits.turnDegPerS}); violations ${r.violations}\n`);
      if (r.warnTurn) process.stdout.write(`warning: camera turn peaks at ${r.warnTurn} deg/s (target for Shorts <= 90)\n`);
    } else {
      if (typeof flags.means !== "string") throw new Error("road needs --means <means.json>");
      const means = JSON.parse(fs.readFileSync(abs(flags.means), "utf8"));
      r = roadFlicker(means, track.frames, { limit: flags.limit === undefined ? undefined : Number(flags.limit), span: span(flags.span) });
      process.stdout.write(`road-flicker: ${r.pass ? "PASS" : "FAIL"} D1 ${r.D1.pairs} pairs max ${r.D1.max}/255; D2 ${r.D2.frames} frames max ${r.D2.max}/255; limit ${r.limit}; violations ${r.violations}\n`);
    }
    if (r.first.length) process.stdout.write(JSON.stringify(r.first) + "\n");
    if (typeof flags.json === "string") fs.writeFileSync(abs(flags.json), JSON.stringify(r, null, 1));
    process.exitCode = r.pass ? 0 : 1;
  } catch (e) {
    return fail(e.message, 2);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
