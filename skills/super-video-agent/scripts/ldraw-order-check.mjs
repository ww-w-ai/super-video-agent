#!/usr/bin/env node
// Required gate for any LDraw build film (references/assembly.md "Required before any render of an LDraw build"):
// every landing joins what is already placed, no arrival path passes through a placed part, nothing is pushed in under
// a part already above it. Exit 1 on any violation; render.mjs and verify.mjs refuse a reel whose order has no passing stamp.
import fs from "node:fs";
import { parseArgs, printHelpAndExit, abs } from "./lib/cli.mjs";
import { checkOrderFiles, stampPathFor, writeStamp } from "./lib/ldraw-order-check.mjs";
import { isMain } from "./lib/is-main.mjs";

const HELP = `usage: ldraw-order-check.mjs <build.json | model.mpd | model.ldr> --lib <parts-folder>
         [--order <order.json>] [--groups <groups.json>] --cameras <cameras.json> [--min-visible <0-1>] [--internal <regex>]
         [--max-hidden <pct>] [--structure-only] [--strict]
         [--ground auto|none|<y>] [--classes <json>] [--loose <regex>] [--ignore <regex>] [--ignore-tail <n>]
         [--travel <ldu>] [--json <report.json>] [--stamp <file> | --no-stamp] [--list <n>]

Checks a build order before anything is rendered. Input: a bake's build.json (ldraw-bake.mjs output, or a planner's
rewrite of it: the build model's step order is the landing order, each item's join.from / travel / seatLen is its
arrival), or an MPD/LDR (the file's own step order, arrival direction found from its joins), optionally re-ordered by
--order (a simple order file, references/assembly.md "The order file").

Per landing:
  SUPPORT   it joins a part placed earlier or the ground: a stud seated in an underside (from the parts' stud
            primitives and the receiving part's own walls), axle/pin in a hole, clip/bar, hinge, wheel, minifig joint.
            A sub-assembly (a sub-model item, an --order step with several ids, a --groups range) is checked as its own
            build first (its first part is free), then lands as one piece that must join the model.
  CROSSING  the arrival sweep, from <travel> away along the arrival direction down to <seatLen> away (the joint
            closing, not sampled), crosses no triangle of a placed part.
  ORDER     a part arriving from above has no placed part above it in its column (arriving from below: none below).
  DIRECTION the arrival is how a joint it seats on is made: a stud joint along the stud axis from the open side
            (SNOT and bracket faces included), an axle/pin in a hole or a wheel/drum/rim on an axle along the axle axis
            (either end, never across it), a clip square to its bar; hinge, minifig and loose joints set no direction.
            A part with several joints passes when it matches any one it seats on (its path must still be clear).
            "from": "auto" picks the first clear joint direction.
  HINGES    (EV-30) hinge plates/bricks/tiles, finger and click hinges and turntables join on their pin line (a pin
            circle of each half on one line, at any angle about it); a ball joint on its ball centre (at any angle).
            Stud joints are judged in each part's own frame, so plates built on a swung half join it. The partner of
            such a joint is not swept for CROSSING (knuckles interlock by design). A hinged half either arrives at its
            angle, or uses "arrive": "swing": it arrives at the hinge's rest pose (square to its partner; "from",
            default above) and swings on the pin, every 3 degrees checked against all placed parts but the partner.
            "swingFrom": <deg> sets the start angle (right-hand about the pin axis with its largest component positive).
  VISIBILITY (required) the landing is seen from the camera of its moment, with everything placed before it in the way:
            sample points on the part's own triangles are cast to the eye; it counts as seen when at least --min-visible
            (default 0.1) of them are in frame and unblocked. Any hidden landing, any landing with no camera, or no
            --cameras at all fails. A part matching --internal (internal by design) that lands hidden in a shot marked
            "opening": true is listed as excepted, not failed.
  STABILITY (EV-40, advisory: listed; fails only with --strict) the landing rests with its centre of mass over what holds it against gravity: the seated studs below
            it (and, for a part arriving from below, the part it hangs under), each standing for its stud cell, or the
            table. A part on one stud at its far end, or a bridge with one end held, fails when it would rest once the
            parts under it are placed (an order fault: land it later; listed, a FAIL only with --strict); one that overhangs even in the finished model is
            a designed cantilever, listed (not failed) for the film report. Parts held only sideways (side studs, axles,
            hinges, clips) are judged by their joint, not here.
  FIGURE    (EV-41, advisory: listed; fails only with --strict) a minifig lands in three whole placements: hips + legs, torso + arms + hands (+ what it holds), head
            + hair/hat. A landing with an arm or hand but no torso, a leg but no hips, or hair/hat but no head is listed
            (checked on --ignore landings too; not on the --ignore-tail). Fold a figure's runs into --groups units.
  PRECISION (EV-42, listed) placement rotations that are not rotations any more (written with too few decimals): tilted
            parts then sit inside their neighbours and read as false CROSSING. Write matrices with 6 decimals.

--lib <dir>        the LDraw parts library (holds parts/ and p/)
--order <file>      [{"id": "<uid>"|<index>, "from": [x,y,z]|"above"|"below"|"+x"|"-z"|"auto", "travel": <ldu>|"auto",
                    "seatLen": 8, "ids": [...], "build": [...], "arrive": "slide"|"swing", "swingFrom": <deg>,
                    "ignore": false}, ...]
--groups <file>     sub-assembly ranges {"units":[{"k0","k1","kind","name","from"?,"swingFrom"?}]} (k1 exclusive; a staged
                    planner's stage.json works as is); kind "panel"/"swing" swings in: on a hinge pin the swing is
                    checked, without one its path is listed as unchecked
--cameras <file>    the film's camera track, in the build model's LDraw frame (k = main landing index):
                    {"cameras":[{"k0","k1" | "t0","t1", "eye":[x,y,z],"target":[x,y,z],"up":[0,-1,0],"fov":40,"aspect":1.778,
                    "opening"?:true}], "landingTimes"?:[sec per landing], "perLanding"?:[camera per landing]}
--strict            STABILITY and FIGURE faults fail the check (default: listed only)
--structure-only    planning run without cameras: VISIBILITY is skipped; exit 0 when the rest passes, but its stamp
                    opens no render/verify gate
--ground <y>        the table height (default auto = the lowest part bottom); none = nothing stands on a table
--classes <json>    file {"<part id>": ["axis"|"hole"|"clip"|"wheel"|"minifig"|"loose"]} where the title does not say
--loose <regex>     parts whose title or id matches are held by any box overlap or touch (hinged or odd parts)
--ignore <regex>    landings whose parts all match (uid, part id or title) are not checked (counted as ignored; the stamp records it)
--ignore-tail <n>   the last n landings are not checked (assembled minifigs added at the end)
--travel <ldu>      judge every arrival with this travel instead of the file's
--json <file>       the full report
--stamp <file>      where the stamp goes (default: order-check.json beside the order file, or beside the input);
                    render.mjs and verify.mjs read it. --no-stamp writes none.
--list <n>          violations printed per kind (default 20)

Exit 0: every check passed. Exit 1: violations (listed). Exit 2: bad input.
`;

const regex = (v, name) => {
  if (v === undefined) return null;
  if (typeof v !== "string") throw new Error(`--${name} takes a regular expression`);
  return new RegExp(v, "i");
};

function lines(report, n) {
  const c = report.counts;
  const out = [`build model ${report.buildModel}: ${c.parts} parts, ${c.landings} landings, ground y ${report.groundY ?? "none"}, ${report.ms} ms`];
  out.push(`SUPPORT ${c.support}  CROSSING ${c.crossing}  ORDER ${c.order}  DIRECTION ${c.direction}  STABILITY ${c.stability}${report.strict ? "" : " (advisory)"}  FIGURE ${c.figure}${report.strict ? "" : " (advisory)"}  UNPLACED ${c.unplaced}${report.visibility ? (report.visibility.missingCameras ? "  VISIBILITY no cameras" : `  HIDDEN ${c.hidden} (${report.visibility.pct}%)  NO-CAMERA ${c.noCamera}  excepted ${c.excepted}`) : "  (structure only)"}  unchecked ${c.unchecked}  ignored ${c.ignored}`);
  const v = report.violations;
  for (const s of v.support.slice(0, n)) out.push(`  SUPPORT  ${s.scope} #${s.index} ${s.label} (${s.title}${s.parts > 1 ? `, ${s.parts} parts` : ""}): joins nothing placed before it`);
  for (const s of v.crossing.slice(0, n))
    out.push(s.from === "swing"
      ? `  CROSSING ${s.scope} #${s.index} ${s.label} swing from ${s.swingFrom} deg: ${s.hits.map((h) => `${h.member} through ${h.with} (${h.how})`).join("; ")}`
      : `  CROSSING ${s.scope} #${s.index} ${s.label} from ${JSON.stringify(s.from)} travel ${s.travel}: ${s.hits.map((h) => `${h.member} through ${h.with} at ${h.at} LDU`).join("; ")}`);
  if (report.swings && report.swings.length) out.push(`  swings on a pin checked: ${report.swings.length} (e.g. #${report.swings[0].index} ${report.swings[0].label} on ${report.swings[0].kind} with ${report.swings[0].with}, from ${report.swings[0].swingFrom} deg)`);
  for (const s of v.order.slice(0, n)) out.push(`  ORDER    ${s.scope} #${s.index} ${s.label}: arrives from ${s.above ? "above" : "below"} but ${s.count} placed part(s) ${s.above ? "above" : "below"} it, e.g. ${s.blockers[0].blocker}`);
  const fmt = (a) => `[${a.map((x) => Math.round(x * 100) / 100).join(",")}]`;
  const rule = { exact: "from", axis: "along ±", perp: "square to bar" };
  for (const s of v.direction.slice(0, n)) out.push(`  DIRECTION ${s.scope} #${s.index} ${s.label} from ${fmt(s.from)}: its joints need ${s.need.map((j) => `${j.kind} with ${j.with} ${rule[j.rule]} ${fmt(j.axis)}`).join("; ")}`);
  for (const s of v.stability.slice(0, n)) out.push(`  STABILITY ${s.scope} #${s.index} ${s.label} (${s.title}): centre ${fmt(s.com)} outside its holding studs x/z ${fmt(s.contactBox)}; it ${s.finished}: land it after them`);
  for (const s of v.figure.slice(0, n)) out.push(`  FIGURE   ${s.scope} #${s.index} ${s.label} (${s.title}): lands without its ${s.missing}; a minifig lands as hips+legs, torso+arms+hands, head+hair (one unit each)`);
  for (const u of v.unplaced.slice(0, n)) out.push(`  UNPLACED ${u}`);
  for (const k of ["support", "crossing", "order", "direction", "stability", "figure", "unplaced"]) if (v[k].length > n) out.push(`  ... ${v[k].length - n} more ${k}`);
  if (report.cantilevers && report.cantilevers.length) {
    out.push(`  cantilevers (designed overhangs, they look hung on one side whatever the order; list them in the film report for the owner, or give each a support from below): ${report.cantilevers.length}`);
    for (const s of report.cantilevers.slice(0, Math.min(n, 10))) out.push(`    #${s.index} ${s.label} (${s.title}) centre ${fmt(s.com)} vs studs ${fmt(s.contactBox)}`);
  }
  if (report.precision && report.precision.count) out.push(`  precision: ${report.precision.count} placement(s) whose rotation is off by more than ${report.precision.tolerance} (e.g. ${report.precision.first[0].uid}, ${report.precision.first[0].error}): rounded matrices make tilted parts overlap their neighbours (false CROSSING); write them with 6 decimals`);
  const vis = report.visibility;
  if (vis && vis.missingCameras) out.push("  VISIBILITY required: pass --cameras <the film's camera track> (per landing, or k/t ranges); --structure-only is for planning and opens no gate");
  if (vis) {
    for (const h of vis.hidden.slice(0, n)) out.push(`  HIDDEN   #${h.index} ${h.label}: ${Math.round(h.fraction * 100)}% of its surface seen${h.blockers.length ? `, behind ${h.blockers.join(", ")}` : h.inFrame ? "" : ", out of frame"}`);
    for (const h of vis.noCamera.slice(0, n)) out.push(`  NO-CAMERA #${h.index} ${h.label}`);
    for (const h of vis.excepted.slice(0, n)) out.push(`  excepted #${h.index} ${h.label} (${h.reason})`);
  }
  out.push(report.pass ? "PASS" : "FAIL: fix the order (references/assembly.md \"Required before any render of an LDraw build\": bottom-up per column, back to front, sub-assemblies built on their own, turn the model for underside parts)");
  return out;
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1 || typeof flags.lib !== "string") return printHelpAndExit(HELP, 2);
  let result;
  try {
    const str = (k) => (typeof flags[k] === "string" ? abs(flags[k]) : null);
    const ground = flags.ground === undefined ? "auto" : String(flags.ground);
    if (ground !== "auto" && ground !== "none" && !Number.isFinite(Number(ground))) throw new Error(`--ground takes auto, none or a number (got ${ground})`);
    const travel = flags.travel === undefined ? null : Number(flags.travel);
    if (travel !== null && !(travel > 0)) throw new Error("--travel takes a positive number of LDU");
    const tail = flags["ignore-tail"] === undefined ? 0 : Number(flags["ignore-tail"]);
    if (!Number.isInteger(tail) || tail < 0) throw new Error("--ignore-tail takes a whole number");
    const maxHidden = flags["max-hidden"] === undefined ? 0 : Number(flags["max-hidden"]);
    if (!Number.isFinite(maxHidden) || maxHidden < 0) throw new Error("--max-hidden takes a percentage");
    const minVisible = flags["min-visible"] === undefined ? 0.1 : Number(flags["min-visible"]);
    if (!(minVisible > 0 && minVisible <= 1)) throw new Error("--min-visible takes a fraction in (0, 1]");
    const args = {
      input: abs(positional[0]), libraryDir: abs(flags.lib), order: str("order"), groups: str("groups"), cameras: str("cameras"),
      ground, travel, ignoreTail: tail, maxHidden, minVisible, internal: regex(flags.internal, "internal"), structureOnly: !!flags["structure-only"], strict: !!flags.strict, loose: regex(flags.loose, "loose"), ignore: regex(flags.ignore, "ignore"),
      classes: typeof flags.classes === "string" ? JSON.parse(fs.readFileSync(abs(flags.classes), "utf8")) : {},
    };
    result = checkOrderFiles(args);
    if (typeof flags.json === "string") fs.writeFileSync(abs(flags.json), JSON.stringify({ ...result.report, inputs: result.inputs }, null, 2) + "\n");
    if (!flags["no-stamp"]) {
      const file = typeof flags.stamp === "string" ? abs(flags.stamp) : stampPathFor(args);
      writeStamp(file, result);
      result.stampFile = file;
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  const n = flags.list === undefined ? 20 : Math.max(0, Number(flags.list) || 0);
  process.stdout.write(lines(result.report, n).join("\n") + "\n");
  if (result.stampFile) process.stdout.write(`stamp: ${result.stampFile} (${result.report.pass ? (result.report.structureOnly ? "pass, structure only: opens no gate" : "pass") : "FAIL"})\n`);
  process.exitCode = result.report.pass ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
