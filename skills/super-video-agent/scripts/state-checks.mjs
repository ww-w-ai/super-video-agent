#!/usr/bin/env node
// Page-state checks: text boxes that overlap, glyphs drawn by a fallback font, and one-frame
// flicker. Source review first (flicker only: show/hide windows in the reel's code), then a state
// scan of every frame confirms in the rendered timeline. Facts only; exit 0 whatever it finds, except
// langglyphs: a character a language's loaded font lacks exits 1 (see the exit contract in HELP).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, stubSeconds, glIssues, glReportLines } from "./lib/browser.mjs";
import { parseTimeRange } from "./lib/determinism.mjs";
import { installTextProbe, collectFrameStates, glyphCoverage } from "./lib/page-probe.mjs";
import { textOverlapSpans, glyphFallbacks, findFlicker, visibleKeys, formatStateChecks, namedFamilies, checkedNothingReasons,
  regionCovers, regionScope, coverNothingReason, reserveScope, reserveIntrusions, fontForLang, langGlyphPairs, langGlyphReport, glyphMaskCoverage } from "./lib/state-checks.mjs";
import { gatherSources, visibilitySourceReview, formatSourceFindings } from "./lib/source-review.mjs";

const HELP = `usage: state-checks.mjs <reel-dir> [--only overlap,glyphs,flicker,covers,reserve,langglyphs] [--step <frames>] [--fps <n>]
                        [--range <t0>-<t1>] [--source-only] [--no-source] [--out <json>] [--stub <sec>] [--outline-em <n>]

--range <t0>-<t1> reads the frame checks (overlap, glyphs, flicker, reserve) only between t0 and t1 seconds
(e.g. --range 42-61.5); the other checks are unchanged. Progress goes to stderr about every 10 s
("frames 1200/4800 (25%, 31 s)"). WebGL console warnings and errors the page logged are printed
to stderr; they do not change the exit code here.

Six checks. overlap, glyphs, flicker and reserve read the page's state at every frame (default every frame; --step N samples every Nth):
  overlap  text boxes that overlap other text boxes, per pair: the spans and the shared px²
  glyphs   characters of every on-screen string that the font in use does not have, so a fallback
           font drew them (a script missing from the chosen font); generic-only families are listed
           as not checked
  flicker  an element visible for a single sampled frame with neither neighbour showing it: drawn
           texts, plus any layer the page lists through the optional hook window.__reel.visibleAt(t)
           -> [{id: "<name>", opacity?: 0..1}]
The state comes from wrapping the canvas 2D text calls while the page seeks, so any reel works with
no change; nothing is read from pixels.
  covers      a label, an always-on overlay or a reserved corner that covers key content. Only regions the page
              declares are checked: window.__reel.regions = [{id, kind: "key"|"label"|"overlay"|"reserve", box: [x0,y0,x1,y1] (canvas
              px), outline?: px, from?: s, to?: s}] (no from/to = the whole film), or a function returning it.
              Reported with the shared px² and times; a judgement for the reviewer, never a failure.
  reserve     picture text drawn inside a corner box the film keeps clear for a persistent label or logo. Only
              regions of kind "reserve" are checked (window.__reel.regions, from plan.json meta.corners through
              Reel.cornerRegions): each text whose box shares area with an active reserve box is listed with its
              times; the label's own text (region "text") is not an intruder. A declared key region that overlaps
              a reserve box is reported by covers. Silent when the film declares no reserve, unless named in --only.
  langglyphs  every character of every language's captions (plan.json + each dub/<code>/plan.json) against
              the font that language uses (window.__reel.captionFonts = {"<lang>": "<font-family list>",
              "*": "..."}, else plan style.fonts[<lang>|caption|body|default]). A missing glyph is definitely
              wrong for that language: listed with code points and line ids, and this step exits 1.
              --outline-em <n>: the captions are drawn with an outline n times the font size wide; glyph
              shapes are compared after growing them by half of it.
A check that looked at nothing says "checked nothing" with the reason, never "none"; covers says
"checked N key regions against M label/overlay regions, 0 covered" when it looked and found nothing.
Intended slow-motion spans are declared with window.__reel.holds = [{from, to}] and read by review.mjs.

Exit contract (the default --only set runs all six checks):
  exit 1  only when langglyphs finds a character that a language's font does not have. That is
          definitely wrong for that language (it would draw in a fallback font), so it stops this step.
          Missing = the character, drawn as "<font>, <generic>", looks exactly like plain monospace, serif or
          sans-serif (what the browser draws when the font lacks it).
          If the font was declared (@font-face / FontFace) but none of its faces loaded, or the font is not
          installed or draws the letters "H" and "a" exactly like a generic family (so a glyph cannot be told
          from a fallback), langglyphs prints "not checked: font not loaded" and does not exit 1.
  exit 1  also for unusable arguments or an unreadable reel (nothing was checked).
  exit 0  every other finding: overlap, glyphs, flicker, covers, "checked nothing". These are
          judgements or facts for the reviewer; none stops the run. Use --only overlap,glyphs,flicker,covers
          to run without the one check that can exit 1.

Flicker is reviewed in the source first: show/hide windows in reel.html / src/*.js under 2 frames,
one-frame gaps or overlaps between neighbouring windows, conditions on two clocks, boundaries rounded
inside the test, and fades of 0 or 1 frame, each with file:line. --fps overrides the fps used there
(default plan.json meta.fps, else the page's). --source-only stops after that source review;
--no-source skips it.
Writes <reel-dir>/out/state-checks.json.
`;

const CHECKS = ["overlap", "glyphs", "flicker", "covers", "reserve", "langglyphs"];
const FRAME_CHECKS = ["overlap", "glyphs", "flicker", "reserve"];

/**
 * A progress callback for collectFrameStates: a line on stderr (stdout stays the
 * findings) about every 10 s and at the end, e.g. "frames 1200/4800 (25%, 31 s)".
 * @param {() => number} [now] ms clock (tests replace it)
 * @param {(line: string) => void} [write]
 */
export function progressPrinter(now = Date.now, write = (l) => process.stderr.write(l)) {
  const started = now();
  let lastPrinted = started;
  return (done, total) => {
    const t = now();
    if (done !== total && t - lastPrinted < 10000) return;
    lastPrinted = t;
    write(`frames ${done}/${total} (${Math.round((done / total) * 100)}%, ${Math.round((t - started) / 1000)} s)\n`);
  };
}

/** window.__reel.regions (an array, or a function returning one), or []. */
async function pageDeclared(page, name) {
  return page.evaluate(async (n) => {
    const v = window.__reel && window.__reel[n];
    const r = typeof v === "function" ? await v() : v;
    return r === undefined || r === null ? null : r;
  }, name);
}

async function reportCovers(page, report, duration) {
  const regions = await pageDeclared(page, "regions");
  report.regionsDeclared = Array.isArray(regions) && regions.length > 0;
  report.coverScope = regionScope(report.regionsDeclared ? regions : []);
  report.covers = report.regionsDeclared ? regionCovers(regions, { duration }) : [];
  const reason = coverNothingReason(report.coverScope);
  if (reason) report.nothing = [...(report.nothing || []), { check: "label over key content", reason }];
}

/** Reserved corners: picture text inside one of them. Without a declared reserve it says so only when asked for by name. */
async function reportReserve(page, report, frames, { fps, duration, asked }) {
  const regions = (await pageDeclared(page, "regions")) || [];
  report.reserveCorners = reserveScope(regions);
  report.reserve = report.reserveCorners ? reserveIntrusions(frames, regions, { fps, duration }) : [];
  if (!report.reserveCorners && asked) report.nothing = [...(report.nothing || []), { check: "reserved corners", reason: 'the page declares no region of kind "reserve" (window.__reel.regions)' }];
}

/** The base plan (plan.json meta.lang) and every dub/<code>/plan.json: [{lang, lines, fonts}]. */
function languagePlans(dir, paths) {
  const out = [];
  const base = fs.existsSync(paths.planJson) ? readJson(paths.planJson) : null;
  if (base) out.push({ lang: (base.meta && base.meta.lang) || "base", lines: base.lines || [], fonts: base.style && base.style.fonts });
  const dubRoot = path.join(dir, "dub");
  const codes = fs.existsSync(dubRoot) ? fs.readdirSync(dubRoot).sort() : [];
  for (const code of codes) {
    const p = path.join(dubRoot, code, "plan.json");
    if (!fs.existsSync(p)) continue;
    const plan = readJson(p);
    out.push({ lang: (plan.meta && plan.meta.lang) || code, lines: plan.lines || [], fonts: (plan.style && plan.style.fonts) || (base && base.style && base.style.fonts) });
  }
  return out;
}

async function reportLangGlyphs(page, report, { dir, paths, outlineEm }) {
  const langs = languagePlans(dir, paths);
  const em = outlineEm === undefined ? 0 : Number(outlineEm);
  if (!Number.isFinite(em) || em < 0) throw new Error(`--outline-em takes a number >= 0 (got "${outlineEm}")`);
  const pageFonts = (await pageDeclared(page, "captionFonts")) || {};
  const fontOf = (lang) => fontForLang(lang, pageFonts, (langs.find((l) => l.lang === lang) || {}).fonts);
  const plan = langGlyphPairs(langs, fontOf);
  const covered = plan.pairs.length ? await glyphMaskCoverage(page, plan.pairs, { outlineEm: em }) : [];
  report.langGlyphs = langGlyphReport(plan, covered, langs);
  if (!langs.length) report.nothing = [...(report.nothing || []), { check: "language glyphs", reason: "no plan.json to read caption text from" }];
}

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
  let range = null;
  try {
    if (flags.range !== undefined) range = parseTimeRange(flags.range);
  } catch (e) {
    return fail(e.message);
  }
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
    const report = { step, fps, duration };
    const frameChecks = only.filter((c) => FRAME_CHECKS.includes(c));
    let frames = [], hook = false;
    if (range) report.range = range;
    if (frameChecks.length) {
      await installTextProbe(session.page);
      ({ frames, hook } = await collectFrameStates(session.page, { fps, duration, step, range, onProgress: progressPrinter() }));
    }
    for (const l of glReportLines(glIssues(session))) process.stderr.write(`${l}\n`);
    report.sampledFrames = frames.length;
    if (frameChecks.length) report.nothing = checkedNothingReasons({ frames, checks: frameChecks, hasLayerHook: hook });
    if (only.includes("covers")) await reportCovers(session.page, report, duration);
    if (only.includes("reserve")) await reportReserve(session.page, report, frames, { fps, duration, asked: typeof flags.only === "string" });
    if (only.includes("langglyphs")) await reportLangGlyphs(session.page, report, { dir, paths, outlineEm: flags["outline-em"] });
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
      sampledFrames: frames.length, hooks: hook, nothing: report.nothing, covers: report.covers, coverScope: report.coverScope,
      langGlyphs: report.langGlyphs, reserve: report.reserve, reserveCorners: report.reserveCorners }));
    writeJson(outPath, result);
    process.stdout.write(`wrote ${outPath}\n`);
    // A character a language's font lacks is definitely wrong for that language: this step exits non-zero.
    if (report.langGlyphs && report.langGlyphs.definitelyWrong) process.exitCode = 1;
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
