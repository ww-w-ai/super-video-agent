#!/usr/bin/env node
// Page-state checks: text boxes that overlap, glyphs drawn by a fallback font, and one-frame
// flicker. Source review first (flicker only: show/hide windows in the reel's code), then a state
// scan of every frame confirms in the rendered timeline. Facts only; exit 0 whatever it finds.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, stubSeconds } from "./lib/browser.mjs";
import { installTextProbe, collectFrameStates, glyphCoverage } from "./lib/page-probe.mjs";
import { textOverlapSpans, glyphFallbacks, findFlicker, visibleKeys, formatStateChecks, namedFamilies } from "./lib/state-checks.mjs";
import { gatherSources, visibilitySourceReview, formatSourceFindings } from "./lib/source-review.mjs";

const HELP = `usage: state-checks.mjs <reel-dir> [--only overlap,glyphs,flicker] [--step <frames>] [--fps <n>]
                        [--source-only] [--no-source] [--out <json>] [--stub <sec>]

Three checks over the page's state at every frame (default every frame; --step N samples every Nth):
  overlap  text boxes that overlap other text boxes, per pair: the spans and the shared px²
  glyphs   characters of every on-screen string that the font in use does not have, so a fallback
           font drew them (a script missing from the chosen font); generic-only families are listed
           as not checked
  flicker  an element visible for a single sampled frame with neither neighbour showing it: drawn
           texts, plus any layer the page lists through the optional hook window.__reel.visibleAt(t)
           -> [{id: "<name>", opacity?: 0..1}]
The state comes from wrapping the canvas 2D text calls while the page seeks, so any reel works with
no change; nothing is read from pixels.

Flicker is reviewed in the source first: show/hide windows in reel.html / src/*.js under 2 frames,
one-frame gaps or overlaps between neighbouring windows, conditions on two clocks, boundaries rounded
inside the test, and fades of 0 or 1 frame, each with file:line. --fps overrides the fps used there
(default plan.json meta.fps, else the page's). --source-only stops after that source review;
--no-source skips it.
Writes <reel-dir>/out/state-checks.json. Exit 0 whatever it finds.
`;

const CHECKS = ["overlap", "glyphs", "flicker"];

function planFps(paths, flags) {
  if (flags.fps !== undefined) {
    const n = Number(flags.fps);
    if (!Number.isFinite(n) || n <= 0) fail(`--fps takes a number > 0 (got "${flags.fps}")`);
    return n;
  }
  try {
    const plan = readJson(paths.planJson);
    if (plan.meta && Number.isFinite(plan.meta.fps)) return plan.meta.fps;
  } catch { /* no plan: fall through */ }
  const html = fs.existsSync(paths.reelHtml) ? fs.readFileSync(paths.reelHtml, "utf8") : "";
  const m = /\bfps\s*[:=]\s*(\d+)/.exec(html);
  return m ? Number(m[1]) : 30;
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) return printHelpAndExit(HELP, 0);
  if (positional.length === 0) return printHelpAndExit(HELP, 1);
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) return fail(`no reel.html in ${dir} — run new-reel.mjs first`);
  const only = typeof flags.only === "string" ? flags.only.split(",").filter(Boolean) : CHECKS;
  const bad = only.find((c) => !CHECKS.includes(c));
  if (bad) return fail(`--only takes ${CHECKS.join(", ")} (got "${bad}")`);
  const step = flags.step === undefined ? 1 : Number(flags.step);
  if (!Number.isInteger(step) || step < 1) return fail(`--step takes a whole number of frames ≥ 1 (got "${flags.step}")`);
  const outPath = typeof flags.out === "string" ? abs(flags.out) : path.join(paths.outDir, "state-checks.json");
  const result = { reel: paths.reelHtml, checks: only };

  if (!flags["no-source"] && only.includes("flicker")) {
    const fps = planFps(paths, flags);
    result.sourceFlicker = visibilitySourceReview(gatherSources(dir), fps);
    process.stdout.write(formatSourceFindings(result.sourceFlicker, `flicker source review (${fps} fps)`));
  }
  if (flags["source-only"]) {
    writeJson(outPath, result);
    process.stdout.write(`wrote ${outPath}\n`);
    return;
  }

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
    const { fps, duration } = session.meta;
    await installTextProbe(session.page);
    const { frames, hook } = await collectFrameStates(session.page, { fps, duration, step });
    const report = { sampledFrames: frames.length, step, fps, duration };
    if (only.includes("overlap")) report.overlaps = textOverlapSpans(frames, { fps, step });
    if (only.includes("glyphs")) {
      const pairs = new Map();
      for (const f of frames) for (const t of f.texts) {
        const fam = namedFamilies(t.font).join(", ");
        if (fam) for (const ch of new Set(Array.from(t.text))) pairs.set(`${fam}\u0000${ch}`, [fam, ch]);
      }
      const list = [...pairs.values()];
      const answers = list.length ? await glyphCoverage(session.page, list) : [];
      const table = new Map(list.map(([fam, ch], i) => [`${fam}\u0000${ch}`, answers[i]]));
      report.glyphs = glyphFallbacks(frames, (fam, ch) => table.get(`${fam}\u0000${ch}`) ?? true, { fps });
    }
    if (only.includes("flicker")) {
      report.flicker = findFlicker(frames.map((f) => ({ frame: f.frame, keys: visibleKeys(f) })), { fps });
      report.flickerHook = hook;
    }
    Object.assign(result, { state: report });
    process.stdout.write(formatStateChecks({ overlaps: report.overlaps, glyphs: report.glyphs, flicker: report.flicker,
      sampledFrames: frames.length, hooks: hook }));
    writeJson(outPath, result);
    process.stdout.write(`wrote ${outPath}\n`);
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
