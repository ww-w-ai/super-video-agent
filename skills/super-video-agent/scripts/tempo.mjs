#!/usr/bin/env node
// Speed factor that fits a timeline to a target length (references/assembly.md "Fit to a target
// length"). Reports the plain factor, the factor with a per-stage floor, and each stage's factor;
// writes a fitted timeline only when asked. Whether to apply it is the model's call.
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { readJson, writeJson } from "./lib/reeldir.mjs";
import { fitTempo, tempoLines, fittedTimeline, stagesOfTimeline, TEMPO_RANGE } from "./lib/tempo.mjs";

const HELP = `usage: tempo.mjs --target <sec> (--timeline <timeline.json> | --timings <voice/timings.json>) [--floor <sec>] [--out <timeline.json>] [--report <json>]

tempo = natural / target (above 1 = faster); each stage's length becomes natural / tempo.
--timeline  {steps|stages:[{id,start,end}], duration}; natural length = duration (else the last end)
--timings   a timings file: each line is a stage, natural length = its duration
--floor     the shortest a stage may run, in seconds (a stage already shorter stays as it is): stages that
            reach it stay there and the others take the rest, so the applied tempo can differ from the plain one
--out       write the fitted timeline (new start/end per stage, duration = target, the applied tempo) where the
            page reads it; needs --timeline
--report    write the numbers as JSON
Prints the factors and notes a tempo outside ${TEMPO_RANGE[0]}-${TEMPO_RANGE[1]} or a target the floors make unreachable.
Reports only: nothing is changed unless --out is given. Exit 1 only for bad input.
`;

function positiveNumber(flags, name) {
  const v = Number(flags[name]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} takes a number above 0, got "${flags[name]}"`);
  return v;
}

/** Reads the input file and returns what fitTempo needs, plus the source object for --out. */
export function loadInput(flags) {
  const file = typeof flags.timeline === "string" ? flags.timeline : flags.timings;
  if (typeof file !== "string") throw new Error("give --timeline or --timings");
  const obj = readJson(abs(file));
  const stages = stagesOfTimeline(obj);
  if (!stages.length) throw new Error(`${path.basename(file)} has no steps, stages or lines`);
  const natural = Number.isFinite(obj.duration) ? obj.duration : stages[stages.length - 1].end;
  return { obj, stages, natural, isTimeline: typeof flags.timeline === "string" };
}

export function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (flags.target === undefined) return printHelpAndExit(HELP, 1);
  try {
    const target = positiveNumber(flags, "target");
    const floorSec = flags.floor === undefined ? 0 : Number(flags.floor);
    if (!Number.isFinite(floorSec) || floorSec < 0) throw new Error(`--floor takes seconds, 0 or more, got "${flags.floor}"`);
    const input = loadInput(flags);
    const r = fitTempo({ stages: input.stages, natural: input.natural, target, floorSec });
    process.stdout.write(tempoLines(r).join("\n") + "\n");
    if (typeof flags.report === "string") writeJson(abs(flags.report), r);
    if (typeof flags.out === "string") {
      if (!input.isTimeline) throw new Error("--out writes a timeline: give --timeline, not --timings");
      writeJson(abs(flags.out), fittedTimeline(input.obj, r));
      process.stdout.write(`wrote ${abs(flags.out)}\n`);
    }
  } catch (e) {
    fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
