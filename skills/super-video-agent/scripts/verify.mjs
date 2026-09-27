#!/usr/bin/env node
// Static contract scan + determinism probe (design.md §2.1, §2.3, §2.4).
// Exits non-zero with a DIAGNOSIS line on failure.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson } from "./lib/reeldir.mjs";
import { scanReelHtml } from "./lib/static-scan.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame } from "./lib/browser.mjs";
import { sha256, buildProbeTimes, deterministicShuffle } from "./lib/determinism.mjs";
import { collectPlanCues, cueKey } from "./lib/cues.mjs";

const HELP = `usage: verify.mjs <reel-dir>

Runs two checks against <reel-dir>/reel.html:
  1. Static scan of the scene script for banned nondeterministic/network
     tokens (Math.random, Date, performance.now, requestAnimationFrame,
     timers, fetch beyond the one allowed timings.json loader).
  2. Determinism probe: seeks >=12 times (shot boundaries, boil bucket
     edges, spread samples) in order and shuffled order, hashes each
     captured PNG, and requires identical hashes at every probe time.

Also warns (does not fail) when plan.json's line cues (design.md §2.5)
don't match assets/lib/cues.json, i.e. \`assets.mjs fetch\` hasn't run since
the cues last changed.

Exits 0 on pass. Exits 1 with a DIAGNOSIS line on the first failure found.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }

  const staticResult = scanReelHtml(paths.reelHtml);
  if (!staticResult.sceneFound) {
    process.stderr.write(
      "DIAGNOSIS: reel.html is missing /* SCENE:BEGIN */ ... /* SCENE:END */ markers — static scan could not isolate scene code.\n"
    );
    process.exitCode = 1;
    return;
  }
  if (!staticResult.ok) {
    for (const v of staticResult.violations) {
      process.stderr.write(
        `DIAGNOSIS: banned token "${v.name}" found ${v.count} time(s) in scene code (limit ${v.limit}). Scene code must be a pure function of t — no randomness outside rng(key), no wall-clock, no network beyond the timings.json loader.\n`
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("static scan: ok\n");

  warnOnCueDrift(dir, paths);

  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(server.url, {});
    if (session.errors.length) {
      process.stderr.write(
        `DIAGNOSIS: page threw ${session.errors.length} error(s) while loading:\n  ${session.errors.join("\n  ")}\n`
      );
      process.exitCode = 1;
      return;
    }
    const { shots, duration } = session.meta;
    if (!shots || shots.length === 0) {
      process.stderr.write("DIAGNOSIS: window.__reel.shots is empty — timings.json produced no lines.\n");
      process.exitCode = 1;
      return;
    }

    const probeTimes = buildProbeTimes(shots, duration, 8);
    if (probeTimes.length < 12) {
      process.stderr.write(
        `DIAGNOSIS: only ${probeTimes.length} probe times available (need >=12) — reel duration too short for a meaningful probe.\n`
      );
      process.exitCode = 1;
      return;
    }

    const inOrderHashes = new Map();
    for (const t of probeTimes) {
      const png = await captureFrame(session.page, t);
      inOrderHashes.set(t, sha256(png));
    }

    const shuffled = deterministicShuffle(probeTimes);
    const mismatches = [];
    for (const t of shuffled) {
      const png = await captureFrame(session.page, t);
      const h = sha256(png);
      if (h !== inOrderHashes.get(t)) mismatches.push(t);
    }

    if (mismatches.length > 0) {
      process.stderr.write(
        `DIAGNOSIS: seek(t) is not independent of seek history — pixel hash mismatch at t=${mismatches
          .map((t) => t.toFixed(3))
          .join(", ")}s between in-order and shuffled seek order. Check for state carried between seek() calls (module-level mutable variables not keyed on t).\n`
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `determinism probe: ok (${probeTimes.length} times, in-order vs shuffled hashes identical)\n`
    );
  } catch (e) {
    process.stderr.write(`DIAGNOSIS: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
    await server.close();
  }
}

/**
 * Warns (never fails) when plan.json's line cues (design.md §2.5) don't
 * match what assets/lib/cues.json has fetched — e.g. a cue was added,
 * removed or retargeted since the last `assets.mjs fetch`.
 */
function warnOnCueDrift(dir, paths) {
  let plan;
  try {
    plan = readJson(paths.planJson);
  } catch {
    return; // validate-plan.mjs owns reporting a missing/invalid plan.json
  }
  const planCues = collectPlanCues(plan);
  if (planCues.length === 0) return;

  const cuesJsonPath = path.join(paths.assetsDir, "lib", "cues.json");
  let fetched;
  try {
    fetched = readJson(cuesJsonPath).cues || [];
  } catch {
    process.stderr.write(
      `warning: plan.json has ${planCues.length} cue(s) but no assets/lib/cues.json — run assets.mjs fetch\n`
    );
    return;
  }

  const planKeys = new Set(planCues.map(cueKey));
  const fetchedKeys = new Set(fetched.map(cueKey));
  const same = planKeys.size === fetchedKeys.size && [...planKeys].every((k) => fetchedKeys.has(k));
  if (!same) {
    process.stderr.write(
      "warning: plan.json cues differ from assets/lib/cues.json — run assets.mjs fetch\n"
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
