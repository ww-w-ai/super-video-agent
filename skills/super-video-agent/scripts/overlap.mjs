#!/usr/bin/env node
// Reports where parts poke through a cover (references/3d.md "Covers and soft bodies: nothing
// pokes through"). Facts only: it never fails a reel for an overlap.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, seekTo, stubSeconds } from "./lib/browser.mjs";
import { checkHookResult, overlapSpans, formatSpans } from "./lib/overlap.mjs";

const HELP = `usage: overlap.mjs <reel-dir> [--step <frames>] [--out <json>] [--stub <sec>]

Seeks <reel-dir>/reel.html frame by frame and calls the page hook
window.__reel.overlap(t) after each seek. The hook returns
  [{ pair: "<cover>/<part>", count: <vertices on the wrong side> }, ...]
for that frame; other fields are ignored. Prints, per pair, the spans of frames where count > 0, and writes them as
JSON (default <reel-dir>/out/overlap.json). Exit 0 whatever it finds.
A page with no overlap hook is reported as such, also with exit 0.

--step <frames>  sample every Nth frame (default 1)
--stub <sec>     for a reel with no voice/timings.json (see still.mjs)
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) return fail(`no reel.html in ${dir} — run new-reel.mjs first`);
  const step = flags.step === undefined ? 1 : Number(flags.step);
  if (!Number.isInteger(step) || step < 1) return fail(`--step takes a whole number of frames ≥ 1 (got "${flags.step}")`);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "overlap.json");
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
    const hasHook = await session.page.evaluate(() => typeof window.__reel.overlap === "function");
    if (!hasHook) {
      process.stdout.write("no window.__reel.overlap hook in this page — nothing checked\n");
      return;
    }
    const { fps, duration } = session.meta;
    const samples = await sample(session.page, fps, duration, step);
    const pairs = overlapSpans(samples, { fps, step });
    writeJson(outPath, { reel: paths.reelHtml, fps, duration, step, sampledFrames: samples.length, pairs });
    process.stdout.write(`sampled ${samples.length} frames (every ${step}) of ${duration.toFixed(3)} s\n`);
    process.stdout.write(formatSpans(pairs));
    process.stdout.write(`wrote ${outPath}\n`);
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

async function sample(page, fps, duration, step) {
  const last = Math.max(0, Math.ceil(duration * fps - 1e-9) - 1);
  const samples = [];
  for (let frame = 0; frame <= last; frame += step) {
    const t = frame / fps;
    await seekTo(page, t);
    const value = await page.evaluate(async (time) => {
      const r = window.__reel.overlap(time);
      return r && typeof r.then === "function" ? await r : r;
    }, t);
    samples.push({ frame, t, pairs: checkHookResult(value, t).map(({ pair, count }) => ({ pair, count })) });
  }
  return samples;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
