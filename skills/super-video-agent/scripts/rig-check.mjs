#!/usr/bin/env node
// Numeric joint check for a cut-out rig page (references/characters.md "Cut-out rig"). Facts only:
// it never fails a reel, because a joint left apart on purpose is a choice.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, stubSeconds } from "./lib/browser.mjs";

const HELP = `usage: rig-check.mjs <reel-dir> [--step <sec>] [--out <json>] [--stub <sec>]

Calls the page hook window.__reel.rigCheck(times) with times every --step seconds (default 0.1) from 0 to the
film's end. The hook returns what ReelRig.jointCheck returns:
  {joints:[{joint, maxGapPx, atT, over, angleOver, samples}], rows:[...], lines:[...], notes:[...]}
Prints one line per joint (the largest gap in px between the child's pivot and the parent's anchor, and how many
samples were over the tolerance) and writes the whole result as JSON (default <reel-dir>/out/rig-check.json).
The gap is an anchor offset: 0 px means the pose does not move a child off its parent's anchor, not that
the drawn parts overlap at the joint. A visible seam from parts that do not overlap is a drawing question;
look at a still of the pose (still.mjs --at <sec>).
Exit 0 whatever it finds. A page with no rigCheck hook is reported as such, also with exit 0.

--step <sec>  sampling step; --stub <sec> for a reel with no voice/timings.json (see still.mjs)
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) return fail(`no reel.html in ${dir} — run new-reel.mjs first`);
  const step = flags.step === undefined ? 0.1 : Number(flags.step);
  if (!Number.isFinite(step) || step <= 0) return fail(`--step takes seconds above 0 (got "${flags.step}")`);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "rig-check.json");
  let stubSec;
  try {
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
  } catch (e) {
    return fail(e.message);
  }
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, { stubSec, warm: false });
    if (!(await session.page.evaluate(() => typeof window.__reel.rigCheck === "function"))) {
      process.stdout.write("no window.__reel.rigCheck hook in this page — nothing checked\n");
      return;
    }
    const times = sampleTimes(session.meta.duration, step);
    const result = await session.page.evaluate((ts) => window.__reel.rigCheck(ts), times);
    writeJson(outPath, { reel: paths.reelHtml, step, ...result });
    process.stdout.write(`sampled ${times.length} times (every ${step} s) of ${session.meta.duration.toFixed(3)} s\n${(result.lines || []).join("\n")}\nwrote ${outPath}\n`);
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/** 0, step, 2*step, ... and the final instant. */
export function sampleTimes(duration, step) {
  const times = [];
  for (let i = 0; i * step < duration - 1e-9; i++) times.push(Math.round(i * step * 1e6) / 1e6);
  times.push(duration);
  return times;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
