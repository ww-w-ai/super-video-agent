#!/usr/bin/env node
// Static contract scan + determinism probe (design.md §2.1, §2.3, §2.4).
// Exits non-zero with a DIAGNOSIS line on failure.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson } from "./lib/reeldir.mjs";
import { scanReelHtml, boilCallSiteReport, pictureTextReport } from "./lib/static-scan.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, seekTo, pixelDiff, stubSeconds, warmShotsOf, glIssues, glReportLines, readEngineFactLines, driftReportLines, parallaxReportLines } from "./lib/browser.mjs";
import { sha256, buildProbeTimes, deterministicShuffle, parseTimeRange } from "./lib/determinism.mjs";
import { collectPlanCues, cueKey } from "./lib/cues.mjs";
import { checkedNothingNext } from "./lib/checked-nothing.mjs";

const HELP = `usage: verify.mjs <reel-dir> [--stub <sec>] [--no-cue-check] [--range <t0>-<t1> | --only <shotIds> | --world <key>]

Runs three checks against <reel-dir>/reel.html:
  1. Static scan of the scene script (the SCENE block and every script under
     <reel-dir>/src) for banned nondeterministic/network tokens (Math.random,
     Date, performance.now, requestAnimationFrame, timers, fetch beyond the
     one allowed timings.json loader). When there is no code to scan it prints
     "checked nothing", not "ok".
  2. Determinism probe: seeks >=12 times (shot boundaries, boil bucket
     edges, spread samples) in order and shuffled order, hashes each
     captured PNG, and requires identical hashes at every probe time.
  3. Cold probe: a second page, opened without the per-shot warm-up, seeks
     each probe time once in order; every hash must equal the warm one.
     This catches a frame that differs the first time its scene is sought
     (e.g. a texture built lazily on first seek).

A WebGL error the page logs while drawing (GL_INVALID_*, lost context) means the
frames are wrong: verify prints it and fails. Other WebGL warnings are printed
and do not fail. A page may declare window.__reel.preload (a promise, or a
function returning one, e.g. ImageBitmaps decoded after ready); every page
verify opens, the cold one included, waits for it before the first seek.

On a mismatch it names the prior seek time that changes the frame (found
by bisecting the seek history, each test in a fresh page) and the bounding
box of the pixel difference.

--stub <sec>  for a reel with no voice/timings.json: the page is served one
              silent line of <sec> seconds. Nothing is written to voice/.

--range <t0>-<t1>
              probe only between t0 and t1 seconds (e.g. --range 42-61.5).
              Only the shots that overlap the range are warmed, in this page
              and in every fresh page the diagnosis opens, so a page that
              builds its scenes on first seek builds only those.
--only <ids>  probe only the named shots (comma separated ids from window.__reel.shots,
              e.g. --only s3,s4). Exactly those shots are warmed and probed; an
              unknown id fails and lists the page's ids. A full verify of a long
              film can take minutes: --range / --only / --world narrow it.
--world <key> probe only where the page's window.__reel.segments lists
              {from, to, key} entries with this key (a film that builds one
              3D world per key and exposes its segment list). Fails when the
              page lists no such entry.

Also prints an info line counting boil() call sites in the scene code and
how many pass a \`moving\` option — a fact report, not a gate.

Also warns (does not fail) when plan.json's line cues (design.md §2.5)
don't match assets/lib/cues.json, i.e. \`assets.mjs fetch\` hasn't run since
the cues last changed. --no-cue-check turns that warning off (for a session
that cannot run assets.mjs).

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
  let scope;
  try {
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
    scope = parseScopeFlags(flags);
  } catch (e) {
    fail(e.message);
    return;
  }

  if (!staticChecks(paths)) {
    process.exitCode = 1;
    return;
  }
  warnOnCueDrift(dir, paths, { skip: flags["no-cue-check"] === true });

  const server = await serveDir(dir);
  try {
    const ok = await determinismChecks({ url: server.url, opts: { stubSec } }, scope);
    if (!ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`DIAGNOSIS: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    await server.close();
  }
}

function staticChecks(paths) {
  for (const text of pictureTextReport(paths.reelHtml)) {
    process.stdout.write(`picture text ${text.kind}: ${text.file}:${text.line}: fillText(${text.expression}) — prefer Reel.pictureText(key, defaultText) from the first build; advisory only\n`);
  }
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
  process.stdout.write(staticScanLine(staticResult));
  const boilReport = boilCallSiteReport(paths.reelHtml);
  process.stdout.write(`boil: ${boilReport.callSites} call site(s), ${boilReport.withMoving} pass moving\n`);
  return true;
}

/**
 * The line for a passing scan: what was scanned, or "checked nothing" when
 * the scene block is empty and src/ has no scripts (a pass over no code).
 * Bundled libraries the scan left out are named on a second line.
 * @param {{scannedChars: number, srcFiles: number, skippedLibraries?: string[]}} result
 */
export function staticScanLine(result) {
  const skipped = result.skippedLibraries && result.skippedLibraries.length
    ? `static scan: skipped bundled libraries under src/: ${result.skippedLibraries.join(", ")}\n`
    : "";
  if (result.scannedChars === 0) {
    return "static scan: checked nothing (no code between the SCENE markers and no scripts under src/). " + checkedNothingNext("scene code between the SCENE markers or scripts under src/") + "\n" + skipped;
  }
  return `static scan: ok (scene block${result.srcFiles ? ` + ${result.srcFiles} script(s) under src/` : ""})\n` + skipped;
}

/** Writes the page's WebGL console messages; true when one is a GL error (the frames are wrong). */
function reportGl(session, where) {
  const issues = glIssues(session);
  for (const l of glReportLines(issues)) process.stderr.write(`${l} (${where})\n`);
  if (!issues.definite.length) return false;
  process.stderr.write(`DIAGNOSIS: the page logged a WebGL error while drawing (${where}) — a failed draw leaves frames blank or partial, so the hashes above compare wrong frames.\n`);
  return true;
}

/**
 * Warm in-order pass, shuffled pass, then the cold pass. Returns false
 * after writing DIAGNOSIS lines on the first failing check.
 * @param {{url: string, opts: object}} target page URL + openReel options;
 *   with a scope, opts.warmShots is set to the scope's shots for every page
 *   the diagnosis opens later.
 * @param {{range?: {from:number,to:number}, world?: string}|null} [scope]
 */
async function determinismChecks(target, scope = null) {
  const session = await openReel(target.url, { ...target.opts, warm: false });
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
    const { windows, scoped } = await resolveScope(session, scope);
    if (windows) {
      target.opts.warmShots = scoped.map((s) => s.id);
      process.stdout.write(`scope: ${windows.map((w) => `${w.from}-${w.to}s`).join(", ")} (${scoped.length} of ${shots.length} shots)\n`);
    }
    await warmShotsOf(session, scoped.map((s) => s.id));
    const probeTimes = buildProbeTimes(scoped, duration, 8, windows);
    if (probeTimes.length < 12) {
      process.stderr.write(
        `DIAGNOSIS: only ${probeTimes.length} probe times available (need >=12) — reel duration too short for a meaningful probe.\n`
      );
      return false;
    }
    warm = await warmPasses(session, probeTimes);
    if (reportGl(session, "warm page")) return false;
    for (const l of await readEngineFactLines(session.page)) process.stdout.write(`${l}\n`);
    for (const l of driftReportLines(session.meta.drift)) process.stdout.write(`${l}\n`);
    for (const l of parallaxReportLines(session.meta.parallax)) process.stdout.write(`${l}\n`);
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
  if (cold.glError) return false;
  if (cold.mismatches.length > 0) {
    await reportMismatches({
      kind: "cold",
      what: "a page opened without warm-up draws a different frame on its first seek",
      mismatches: cold.mismatches,
      diagnose: (m) => diagnoseCold(target, m, warm.inOrder),
    });
    return false;
  }
  process.stdout.write(`cold probe: ok (${warm.probeTimes.length} times, fresh page without warm-up matches warm hashes)\n`);
  return true;
}

/**
 * Reads --range <t0>-<t1> or --world <key>; null when neither is given.
 * @returns {{range?: {from:number,to:number}, world?: string}|null}
 */
export function parseScopeFlags(flags) {
  const given = ["range", "world", "only"].filter((k) => flags[k] !== undefined);
  if (given.length > 1) throw new Error(`--${given.join(" and --")} each narrow the probe; use one`);
  if (flags.world !== undefined) {
    if (typeof flags.world !== "string" || flags.world === "") throw new Error("--world takes a key from window.__reel.segments, e.g. --world park");
    return { world: flags.world };
  }
  if (flags.only !== undefined) {
    const ids = typeof flags.only === "string" ? flags.only.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!ids.length) throw new Error("--only takes shot ids, e.g. --only s3,s4 (ids are in window.__reel.shots)");
    return { only: [...new Set(ids)] };
  }
  if (flags.range === undefined) return null;
  return { range: parseTimeRange(flags.range) };
}

/**
 * The time windows a scope names and the shots it covers; windows null for the
 * whole film. --only keeps exactly the named shots (a neighbour that merely
 * touches a boundary is not warmed). Throws on an unknown shot id.
 */
async function resolveScope(session, scope) {
  const { shots } = session.meta;
  if (scope && scope.only) {
    const scoped = onlyShots(shots, scope.only);
    return { windows: scoped.map((s) => ({ from: s.start, to: s.end })), scoped };
  }
  const windows = await scopeWindows(session.page, scope);
  return { windows, scoped: windows ? shotsInWindows(shots, windows) : shots };
}

/**
 * The shots whose ids are named, in timeline order. Throws listing the ids
 * the page has when one is unknown.
 * @param {{id: string}[]} shots
 * @param {string[]} ids
 */
export function onlyShots(shots, ids) {
  const have = new Set(shots.map((s) => s.id));
  const unknown = ids.filter((id) => !have.has(id));
  if (unknown.length) throw new Error(`--only: no shot with id ${unknown.join(", ")} (shots: ${shots.map((s) => s.id).join(", ")})`);
  const want = new Set(ids);
  return shots.filter((s) => want.has(s.id));
}

/** The time windows a range or world scope names; null for the whole film. Throws when --world matches nothing. */
async function scopeWindows(page, scope) {
  if (!scope) return null;
  if (scope.range) return [scope.range];
  const segs = await page.evaluate(() => {
    const s = window.__reel.segments;
    return Array.isArray(s) ? s.map((x) => ({ from: x.from, to: x.to, key: x.key })) : null;
  });
  return worldWindows(segs, scope.world);
}

/**
 * The windows of `segments` ({from, to, key}) whose key is `world`, in order.
 * @param {{from:number,to:number,key:string|null}[]|null} segments
 * @param {string} world
 */
export function worldWindows(segments, world) {
  if (!segments) throw new Error("--world needs the page to list window.__reel.segments as [{from, to, key}]; this page lists none (use --range)");
  const out = segments.filter((s) => s.key === world).map((s) => ({ from: s.from, to: s.to }));
  if (!out.length) {
    const keys = [...new Set(segments.map((s) => s.key).filter(Boolean))];
    throw new Error(`--world ${world}: no entry in window.__reel.segments has that key (keys: ${keys.join(", ") || "none"})`);
  }
  return out;
}

/** Shots that overlap any of the windows. */
export function shotsInWindows(shots, windows) {
  return shots.filter((s) => windows.some((w) => s.start <= w.to && s.end >= w.from));
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
    return { mismatches, glError: reportGl(session, "cold page") };
  } finally {
    await session.close();
  }
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
export function warnOnCueDrift(dir, paths, { skip = false } = {}) {
  if (skip) return;
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
