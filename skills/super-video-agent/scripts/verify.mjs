#!/usr/bin/env node
// Static contract scan + determinism probe (design.md §2.1, §2.3, §2.4).
// Exits non-zero with a DIAGNOSIS line on failure.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson } from "./lib/reeldir.mjs";
import { scanReelHtml, boilCallSiteReport } from "./lib/static-scan.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, seekTo, pixelDiff, stubSeconds } from "./lib/browser.mjs";
import { sha256, buildProbeTimes, deterministicShuffle } from "./lib/determinism.mjs";
import { collectPlanCues, cueKey } from "./lib/cues.mjs";

const HELP = `usage: verify.mjs <reel-dir> [--stub <sec>]

Runs three checks against <reel-dir>/reel.html:
  1. Static scan of the scene script for banned nondeterministic/network
     tokens (Math.random, Date, performance.now, requestAnimationFrame,
     timers, fetch beyond the one allowed timings.json loader).
  2. Determinism probe: seeks >=12 times (shot boundaries, boil bucket
     edges, spread samples) in order and shuffled order, hashes each
     captured PNG, and requires identical hashes at every probe time.
  3. Cold probe: a second page, opened without the per-shot warm-up, seeks
     each probe time once in order; every hash must equal the warm one.
     This catches a frame that differs the first time its scene is sought
     (e.g. a texture built lazily on first seek).

On a mismatch it names the prior seek time that changes the frame (found
by bisecting the seek history, each test in a fresh page) and the bounding
box of the pixel difference.

--stub <sec>  for a reel with no voice/timings.json: the page is served one
              silent line of <sec> seconds. Nothing is written to voice/.

Also prints an info line counting boil() call sites in the scene code and
how many pass a \`moving\` option — a fact report, not a gate.

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
  let stubSec;
  try {
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
  } catch (e) {
    fail(e.message);
    return;
  }

  if (!staticChecks(paths)) {
    process.exitCode = 1;
    return;
  }
  warnOnCueDrift(dir, paths);

  const server = await serveDir(dir);
  try {
    const ok = await determinismChecks({ url: server.url, opts: { stubSec } });
    if (!ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`DIAGNOSIS: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    await server.close();
  }
}

function staticChecks(paths) {
  const staticResult = scanReelHtml(paths.reelHtml);
  if (!staticResult.sceneFound) {
    process.stderr.write(
      "DIAGNOSIS: reel.html is missing /* SCENE:BEGIN */ ... /* SCENE:END */ markers — static scan could not isolate scene code.\n"
    );
    return false;
  }
  if (!staticResult.ok) {
    for (const v of staticResult.violations) {
      process.stderr.write(
        `DIAGNOSIS: banned token "${v.name}" found ${v.count} time(s) in scene code (limit ${v.limit}). Scene code must be a pure function of t — no randomness outside rng(key), no wall-clock, no network beyond the timings.json loader.\n`
      );
    }
    return false;
  }
  process.stdout.write("static scan: ok\n");
  const boilReport = boilCallSiteReport(paths.reelHtml);
  process.stdout.write(`boil: ${boilReport.callSites} call site(s), ${boilReport.withMoving} pass moving\n`);
  return true;
}

/**
 * Warm in-order pass, shuffled pass, then the cold pass. Returns false
 * after writing DIAGNOSIS lines on the first failing check.
 * @param {{url: string, opts: object}} target page URL + openReel options
 */
async function determinismChecks(target) {
  const session = await openReel(target.url, target.opts);
  let warm;
  try {
    if (session.errors.length) {
      process.stderr.write(
        `DIAGNOSIS: page threw ${session.errors.length} error(s) while loading:\n  ${session.errors.join("\n  ")}\n`
      );
      return false;
    }
    const { shots, duration } = session.meta;
    if (!shots || shots.length === 0) {
      process.stderr.write("DIAGNOSIS: window.__reel.shots is empty — timings.json produced no lines (a picture-only probe can pass --stub <sec>).\n");
      return false;
    }
    const probeTimes = buildProbeTimes(shots, duration, 8);
    if (probeTimes.length < 12) {
      process.stderr.write(
        `DIAGNOSIS: only ${probeTimes.length} probe times available (need >=12) — reel duration too short for a meaningful probe.\n`
      );
      return false;
    }
    warm = await warmPasses(session, probeTimes);
  } finally {
    await session.close();
  }

  if (warm.mismatches.length > 0) {
    await reportMismatches({
      kind: "warm",
      what: "seek(t) is not independent of seek history — pixel hash mismatch between in-order and shuffled seek order",
      mismatches: warm.mismatches,
      diagnose: (m) => diagnoseWarm(target, m, warm.inOrder),
    });
    return false;
  }
  process.stdout.write(`determinism probe: ok (${warm.probeTimes.length} times, in-order vs shuffled hashes identical)\n`);

  const cold = await coldPass(target, warm);
  if (cold.length > 0) {
    await reportMismatches({
      kind: "cold",
      what: "a page opened without warm-up draws a different frame on its first seek",
      mismatches: cold,
      diagnose: (m) => diagnoseCold(target, m, warm.inOrder),
    });
    return false;
  }
  process.stdout.write(`cold probe: ok (${warm.probeTimes.length} times, fresh page without warm-up matches warm hashes)\n`);
  return true;
}

/**
 * In-order then shuffled capture of every probe time in one warm page.
 * A mismatch carries its seek history: every seek between the in-order
 * capture of t and the shuffled capture of t, plus the warm-up before.
 */
async function warmPasses(session, probeTimes) {
  const inOrder = new Map();
  for (const t of probeTimes) {
    const png = await captureFrame(session.page, t);
    inOrder.set(t, { hash: sha256(png), png });
  }
  const shuffled = deterministicShuffle(probeTimes);
  const mismatches = [];
  for (let i = 0; i < shuffled.length; i++) {
    const t = shuffled[i];
    const png = await captureFrame(session.page, t);
    if (sha256(png) === inOrder.get(t).hash) continue;
    const history = probeTimes.filter((x) => x > t).concat(shuffled.slice(0, i));
    mismatches.push({ t, history, diff: await pixelDiff(session.page, inOrder.get(t).png) });
  }
  return { probeTimes, inOrder, mismatches, warmUp: session.warmUp };
}

/** One fresh page, no warm-up, each probe time once in order. */
async function coldPass(target, warm) {
  const session = await openReel(target.url, { ...target.opts, warm: false });
  const mismatches = [];
  try {
    for (const t of warm.probeTimes) {
      const png = await captureFrame(session.page, t);
      const ref = warm.inOrder.get(t);
      if (sha256(png) === ref.hash) continue;
      const before = warm.probeTimes.filter((x) => x < t);
      mismatches.push({ t, history: warm.warmUp.concat(before, [t]), diff: await pixelDiff(session.page, ref.png) });
    }
  } finally {
    await session.close();
  }
  return mismatches;
}

/**
 * Writes the summary line, then diagnoses the first mismatch only (each
 * bisect step opens a fresh page, so diagnosing all of them would multiply
 * the cost).
 */
async function reportMismatches({ kind, what, mismatches, diagnose }) {
  process.stderr.write(
    `DIAGNOSIS: ${what} at t=${mismatches.map((m) => m.t.toFixed(3)).join(", ")}s. Check for state carried between seek() calls (module-level mutable variables not keyed on t, caches built on first use).\n`
  );
  const first = mismatches[0];
  process.stderr.write(`DIAGNOSIS: t=${first.t.toFixed(3)}s pixel difference: ${describeDiff(first.diff)}\n`);
  const result = await diagnose(first);
  process.stderr.write(`DIAGNOSIS: ${describeOffender(kind, first.t, result)}\n`);
}

// Warm mismatch: in a fresh warmed page, does seeking S before t change
// t's frame away from its in-order frame?
function diagnoseWarm(target, mismatch, inOrder) {
  const ref = inOrder.get(mismatch.t).hash;
  return bisectOffender(uniqueTimes(mismatch.history), async (subset) => {
    const hash = await hashAfterSeeks(target, target.opts, subset, mismatch.t);
    return hash !== ref;
  });
}

// Cold mismatch: in a fresh page without warm-up, does seeking S before t
// turn t's cold frame into the warm frame?
function diagnoseCold(target, mismatch, inOrder) {
  const ref = inOrder.get(mismatch.t).hash;
  return bisectOffender(uniqueTimes(mismatch.history), async (subset) => {
    const hash = await hashAfterSeeks(target, { ...target.opts, warm: false }, subset, mismatch.t);
    return hash === ref;
  });
}

async function hashAfterSeeks(target, opts, seeks, t) {
  const session = await openReel(target.url, opts);
  try {
    for (const s of seeks) await seekTo(session.page, s);
    return sha256(await captureFrame(session.page, t));
  } finally {
    await session.close();
  }
}

/**
 * Finds the single seek time in `history` that changes the frame, by
 * halving: `changesFrame(subset)` seeks `subset` in order (fresh state)
 * then t, and says whether the frame changed. The first half is tried
 * before the second.
 * @param {number[]} history seek times, in the order they were sought
 * @param {(subset: number[]) => Promise<boolean>} changesFrame
 * @returns {Promise<{offender: number|null, subset: number[]|null, reproduced: boolean, tests: number}>}
 *   reproduced=false: the whole history does not change the frame.
 *   offender=null with a subset: seeks from both halves are needed together.
 */
export async function bisectOffender(history, changesFrame) {
  let tests = 0;
  const probe = async (subset) => {
    tests++;
    return changesFrame(subset);
  };
  if (history.length === 0 || !(await probe(history))) {
    return { offender: null, subset: null, reproduced: false, tests };
  }
  let candidates = history;
  while (candidates.length > 1) {
    const mid = Math.ceil(candidates.length / 2);
    const first = candidates.slice(0, mid);
    const second = candidates.slice(mid);
    if (await probe(first)) candidates = first;
    else if (await probe(second)) candidates = second;
    else return { offender: null, subset: candidates, reproduced: true, tests };
  }
  return { offender: candidates[0], subset: candidates, reproduced: true, tests };
}

/** Seek times without repeats, first occurrence kept, order kept. */
export function uniqueTimes(times) {
  const seen = new Set();
  const out = [];
  for (const t of times) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** One line for a pixelDiff() result. */
export function describeDiff(diff) {
  if (!diff || !diff.box) return "no pixel differs (the PNG bytes differ only)";
  const [x0, y0, x1, y1] = diff.box;
  return `${diff.changed} px differ, max channel delta ${diff.maxDelta}, box x ${x0}–${x1}, y ${y0}–${y1} (${x1 - x0 + 1}×${y1 - y0 + 1})`;
}

/** One line naming the offending prior seek for a bisectOffender() result. */
export function describeOffender(kind, t, result) {
  const tt = `t=${t.toFixed(3)}s`;
  if (!result.reproduced) {
    return `${kind}: replaying the seek history in a fresh page did not reproduce the change at ${tt}; the difference may depend on timing, not on seek order.`;
  }
  if (result.offender === null) {
    return `${kind}: no single prior seek changes ${tt}; these seeks together do: ${result.subset.map((x) => x.toFixed(3)).join(", ")}s.`;
  }
  const o = result.offender;
  const self = Math.abs(o - t) < 1e-9 ? " (an earlier seek of the same time)" : "";
  if (kind === "cold") {
    return `cold: seeking t=${o.toFixed(3)}s${self} first is what turns ${tt} into its warm frame — the first seek there draws something the later ones do not (lazy build, cache, first-use state).`;
  }
  return `warm: seeking t=${o.toFixed(3)}s${self} before ${tt} changes the frame — state from that seek carries over.`;
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
