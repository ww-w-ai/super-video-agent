#!/usr/bin/env node
// Character blink check, from code and state, not frames: a blink too fast to see in a screenshot
// still shows in the eye drive. Source review first (the reel's code), then the per-frame page hook
// window.__reel.blink(t) confirms in the rendered timeline; --glb reads a clip's own keyframes.
// Reports only; exit 0 whatever it finds.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, seekTo, stubSeconds } from "./lib/browser.mjs";
import { analyzeAll, formatBlinks, MIN_BLINK_SEC, MIN_INTERVAL_SEC, FLUTTER_COUNT, FLUTTER_WINDOW_SEC } from "./lib/blink.mjs";
import { gatherSources, blinkSourceReview, formatSourceFindings } from "./lib/source-review.mjs";
import { readGltf, morphTracks, BLINK_MORPH } from "./lib/glb-clip-tracks.mjs";

const HELP = `usage: blink-check.mjs <reel-dir> [--glb <file>] [--morph <regex>] [--step <frames>] [--no-source] [--source-only] [--out <json>] [--stub <sec>]

Reports each character's blinks: count, start-to-start intervals, start-to-end durations, and flags
  fast-blink     closes and opens in under ${Math.round(MIN_BLINK_SEC * 1000)} ms (human blink ~100–400 ms)
  close-blinks   starts under ${MIN_INTERVAL_SEC} s after the previous (people blink about every 2–10 s)
  flutter        ${FLUTTER_COUNT} blinks within ${FLUTTER_WINDOW_SEC} s
A blink is closure (0 open .. 1 closed) above 0.1 that peaks at 0.5 or more.

1. Source review, first: reel.html / src/*.js are read for blink intervals, durations, per-minute
   rates, keyframe arrays, \`t % period\` loops and random or timer drives, each with file:line.
2. Page hook, second: if the page defines window.__reel.blink(t) it is called after each seek and
   must return [{character: "<name>", closed: 0..1}] (the eyelid morph influence or bone value, 1 =
   shut; one entry per character, or per eye as "<name>.L"). See references/3d.md.
3. --glb <file>: the clip's own keyframes. Every weights channel whose morph name matches --morph
   (default ${BLINK_MORPH}) becomes a series per clip, node and morph.

--step <frames>  sample the hook every Nth frame (default 1; a sample is 1/fps s, so a blink under
                 2 samples long cannot be measured: use 1)
Writes <reel-dir>/out/blink-check.json.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  const step = flags.step === undefined ? 1 : Number(flags.step);
  if (!Number.isInteger(step) || step < 1) return fail(`--step takes a whole number of frames ≥ 1 (got "${flags.step}")`);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "blink-check.json");
  const result = { reel: paths.reelHtml };

  if (!flags["no-source"] && fs.existsSync(paths.reelHtml)) {
    result.source = blinkSourceReview(gatherSources(dir));
    process.stdout.write(formatSourceFindings(result.source, "blink source review"));
  }
  if (flags["source-only"]) {
    writeJson(outPath, result);
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }

  if (typeof flags.glb === "string") {
    let re = BLINK_MORPH;
    if (typeof flags.morph === "string") {
      try { re = new RegExp(flags.morph, "i"); } catch (e) { return fail(`--morph is not a regex: ${e.message}`); }
    }
    try {
      const file = abs(flags.glb);
      const tracks = morphTracks(readGltf(fs.readFileSync(file), path.dirname(file)), re);
      const byName = Object.fromEntries(tracks.map((t) => [`${t.clip}/${t.node}.${t.morph}`, t.series]));
      result.clip = analyzeAll(byName);
      process.stdout.write(tracks.length ? "clip keyframes:\n" : `clip keyframes: no weights channel with a morph matching ${re}\n`);
      process.stdout.write(formatBlinks(result.clip));
    } catch (e) {
      return fail(`${flags.glb}: ${e.message}`);
    }
  }

  if (fs.existsSync(paths.reelHtml)) {
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
      const hasHook = await session.page.evaluate(() => typeof window.__reel.blink === "function");
      if (!hasHook) {
        process.stdout.write("no window.__reel.blink hook in this page — page state not checked\n");
      } else {
        const { fps, duration } = session.meta;
        const series = await sample(session.page, fps, duration, step);
        result.state = { fps, step, characters: analyzeAll(series) };
        process.stdout.write(`page hook, ${duration.toFixed(3)} s sampled every ${step} frame${step > 1 ? "s" : ""} at ${fps} fps:\n`);
        process.stdout.write(formatBlinks(result.state.characters));
      }
    } catch (e) {
      return fail(e.message);
    } finally {
      if (session) await session.close();
      await server.close();
    }
  }
  writeJson(outPath, result);
  process.stdout.write(`wrote ${outPath}\n`);
}

async function sample(page, fps, duration, step) {
  const last = Math.max(0, Math.ceil(duration * fps - 1e-9) - 1);
  const series = {};
  for (let frame = 0; frame <= last; frame += step) {
    const t = frame / fps;
    await seekTo(page, t);
    const value = await page.evaluate(async (time) => {
      const r = window.__reel.blink(time);
      return r && typeof r.then === "function" ? await r : r;
    }, t);
    const where = `window.__reel.blink(${t.toFixed(3)})`;
    if (!Array.isArray(value)) throw new Error(`${where} returned ${typeof value}, not an array of {character, closed}`);
    const frameMax = {};
    value.forEach((e, i) => {
      if (!e || typeof e.character !== "string" || !e.character) throw new Error(`${where}[${i}] has no "character" string`);
      if (!Number.isFinite(e.closed)) throw new Error(`${where}[${i}] ("${e.character}") has no numeric "closed" (0 open .. 1 closed)`);
      frameMax[e.character] = Math.max(frameMax[e.character] ?? -Infinity, e.closed);
    });
    for (const [name, v] of Object.entries(frameMax)) (series[name] ||= []).push({ t, v });
  }
  return series;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
