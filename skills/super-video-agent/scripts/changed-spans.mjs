#!/usr/bin/env node
// Finds the spans of a film that changed between an old and a new timeline.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { writeJson } from "./lib/reeldir.mjs";
import { diffTimelines, spanFlag, edlFromRuns } from "./lib/timeline-diff.mjs";

const HELP = `usage: changed-spans.mjs <old-timeline.json> <new-timeline.json> [--fps <n>] [--out <report.json>]
                         [--edl-out <edl.json> --old-film <mp4> --new-film <mp4>[,<mp4>...] [--reel <dir>]]

Diffs two timelines and reports which frames of the new film must be drawn and which can be copied from
the old film. A timeline is voice/timings.json ({duration, fps?, lines:[{id, start, end, text, words?}]}) or a dump
of the page's shots ({duration, fps?, shots:[{id, start, end, hash?}]}). Keep the old file before voice.mjs or
the page changes. Each item owns the frames from its start to the next item's start; it is kept when the other
timeline has the same id with the same text, hash, word times and owned length, even if it moved.
Prints
  new     <from>-<to> s  <ids>  changed|added        frames to draw
  keep    new frames [a,b) = old frames [c,d)  shift N   frames to copy
  removed ids that only the old timeline has
  --span  <from>-<to>,...   the value for render.mjs --span; use it when none of the kept frames moved
                            ("0 of them moved"); when some moved, build the film with --assemble instead
Exit 0 whatever it finds; the report is facts, the decision to render or copy is yours.

--fps <n>        frames per second (default: the new timeline's "fps"; stops when neither gives one)
--out <json>     also write the report (runs, removed, frames, span)
--edl-out <json> write an --assemble EDL: keep runs from --old-film at their old frames, new runs from
                 --new-film: an mp4 whose frame n is the new film's frame n, or draft clips under out/drafts/
                 (render.mjs --only <id> --handle <sec>; several separated by commas). A draft's sidecar
                 <name>.json says which film frame its first frame is (frameStart), so a new run [a,b) becomes
                 clip frames [a-frameStart, b-frameStart). A new run that no clip holds stops the step.
--reel <dir>     make the EDL's src paths relative to the reel dir (as --assemble reads them)
`;

function readTimeline(file) {
  try {
    return JSON.parse(fs.readFileSync(abs(file), "utf8"));
  } catch (e) {
    throw new Error(`cannot read timeline ${file}: ${e.message}`);
  }
}

function runLine(r, fps) {
  const secs = `${(r.newFrom / fps).toFixed(3)}-${(r.newTo / fps).toFixed(3)} s`;
  if (r.kind === "new") return `new     ${secs}  ${r.ids.join(",")}  ${r.reason}  (${r.newTo - r.newFrom} frames)\n`;
  return `keep    new frames [${r.newFrom},${r.newTo}) = old frames [${r.oldFrom},${r.oldTo})  shift ${r.newFrom - r.oldFrom}  ${r.ids.join(",")}\n`;
}

function relativeTo(reel, file) {
  return reel ? path.relative(abs(reel), abs(file)) : file;
}

/**
 * The new film's clips from --new-film (one mp4, or several separated by commas). A draft has a sidecar
 * <name>.json (render.mjs --only --handle) that says which frame of the new film its first frame is; a clip
 * with no sidecar is taken as the new film itself (its frame n is the new film's frame n).
 */
function newClipsFrom(spec, reel) {
  return spec.split(",").filter(Boolean).map((file) => {
    const side = abs(file).replace(/\.mp4$/i, "") + ".json";
    const src = relativeTo(reel, file);
    if (!fs.existsSync(side)) return { src, frameStart: 0, frameEnd: Infinity };
    const j = readTimeline(side);
    if (!Number.isInteger(j.frameStart) || !Number.isInteger(j.frameEnd)) throw new Error(`${side} has no integer frameStart and frameEnd`);
    return { src, frameStart: j.frameStart, frameEnd: j.frameEnd };
  });
}

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length !== 2) return printHelpAndExit(HELP, 1);
  try {
    const [oldDoc, newDoc] = positional.map(readTimeline);
    const fps = flags.fps !== undefined ? Number(flags.fps) : newDoc.fps;
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("no frame rate: pass --fps <n> (the new timeline has no numeric \"fps\")");
    const diff = diffTimelines(oldDoc, newDoc, fps);
    const span = spanFlag(diff.runs, fps);
    process.stdout.write(diff.runs.map((r) => runLine(r, fps)).join(""));
    if (diff.removed.length) process.stdout.write(`removed ${diff.removed.join(",")}\n`);
    process.stdout.write(`frames: ${diff.frames.new} to draw, ${diff.frames.kept} to copy (${diff.frames.shifted} of them moved)\n`);
    process.stdout.write(span ? `--span ${span}\n` : "no changed frames\n");
    if (typeof flags.out === "string") writeJson(abs(flags.out), { fps, ...diff, span });
    if (flags["edl-out"] !== undefined) {
      if (typeof flags["edl-out"] !== "string" || typeof flags["old-film"] !== "string" || typeof flags["new-film"] !== "string") {
        throw new Error("--edl-out <json> needs --old-film <mp4> and --new-film <mp4>");
      }
      const edl = edlFromRuns(diff.runs, { oldFilm: relativeTo(flags.reel, flags["old-film"]), newClips: newClipsFrom(flags["new-film"], flags.reel) });
      writeJson(abs(flags["edl-out"]), edl);
      process.stdout.write(`wrote ${abs(flags["edl-out"])} (${edl.entries.length} entries)\n`);
    }
  } catch (e) {
    return fail(e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
