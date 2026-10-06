#!/usr/bin/env node
// Bakes an LDraw-format model (MPD / LDR) into JSON a page loads (references/assembly.md "Reading a model file").
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { writeJson } from "./lib/reeldir.mjs";
import { bakeModel } from "./lib/ldraw-bake.mjs";

const HELP = `usage: ldraw-bake.mjs <model.mpd|model.ldr> --lib <parts-folder> --out <dir> [--until <n>] [--classes <json>] [--detail]

Reads a model in the LDraw text format and writes <dir>/build.json and <dir>/parts.json.
The model's own tree gives the step order: a sub-model's steps run first, then its parent's step where it joins.

--lib <dir>      the parts library the user supplies: the folder that holds parts/ and p/ (and LDConfig.ldr for the
                 colour table), or a flat folder of part files. A part that is not there stops the run and is named.
--out <dir>      where build.json and parts.json go (a reel's data/ folder)
--until <n>      bake only the first n steps of the model that is built (sub-models they join are baked whole)
--classes <json> {"<part id>": "stud" | "axis" | "hole"} for parts whose title does not say how they join
--detail         also print, for each crossing path, where along it the surfaces cross

build.json   tree, order (model, step, via), per model the steps with each item's matrix, colour, box, join class and
             insertion direction (join.from: where the part comes from; LDraw's -Y is up), travel and seat length,
             and pathCheck: per item the triangle pairs that cross on the way in (a number is a fact for you to judge)
parts.json   per part, triangles and edge lines by colour key as base64 Float32 (9 and 6 numbers per triangle and
             line), local box, title; colours used, with values from LDConfig.ldr
Exit 0 when the files were written; a missing library file, a model that contains itself or an unreadable file stops.
`;

function summary(r) {
  const out = [`build model: ${r.build.buildModel}; ${r.report.models} model(s), ${r.report.parts} unique parts`, ...r.build.tree];
  for (const [key, m] of Object.entries(r.build.models)) {
    for (const s of m.steps) {
      for (const it of s.items) {
        const what = it.kind === "part" ? it.title.slice(0, 30) : `sub-model ${it.model}`;
        out.push(`${key} step ${s.n} ${it.uid.padEnd(16)} ${what.padEnd(30)} from ${JSON.stringify(it.join.from)} travel ${it.join.travel} seat ${it.join.seatLen} - ${it.join.reason}`);
      }
    }
  }
  return out;
}

function crossingLines(r, detail) {
  const out = [];
  for (const [key, m] of Object.entries(r.build.models)) {
    const crossed = m.pathCheck.filter((c) => c.hits > 0);
    out.push(`path check ${key}: ${m.pathCheck.length - crossed.length} of ${m.pathCheck.length} paths cross nothing`);
    for (const c of crossed) {
      out.push(`  ${c.uid}: ${c.hits} triangle pairs cross (first at ${c.firstHitAt.toFixed(2)} of the path)`);
      if (detail) out.push(...c.detail.map((d) => `      ${d}`));
    }
  }
  return out;
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 1 || typeof flags.lib !== "string" || typeof flags.out !== "string") return printHelpAndExit(HELP, 1);
  try {
    const file = abs(positional[0]);
    const until = flags.until === undefined ? null : Number(flags.until);
    if (until !== null && (!Number.isInteger(until) || until < 1)) throw new Error(`--until takes a whole number of steps >= 1 (got "${flags.until}")`);
    const classes = typeof flags.classes === "string" ? JSON.parse(fs.readFileSync(abs(flags.classes), "utf8")) : {};
    const r = bakeModel({ text: fs.readFileSync(file, "utf8"), name: path.basename(file), libraryDir: abs(flags.lib), until, classes });
    writeJson(path.join(abs(flags.out), "build.json"), r.build);
    writeJson(path.join(abs(flags.out), "parts.json"), r.partsData);
    process.stdout.write([...summary(r), ...crossingLines(r, !!flags.detail)].join("\n") + "\n");
    if (r.report.noColourTable) process.stdout.write("note: no LDConfig.ldr in the library folder; parts.json has no colour values\n");
    if (r.report.unknownColours.length) process.stdout.write(`note: colour codes with no table entry: ${r.report.unknownColours.join(", ")}\n`);
    process.stdout.write(`wrote ${path.join(abs(flags.out), "build.json")} and parts.json\n`);
  } catch (e) {
    return fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
