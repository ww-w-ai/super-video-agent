#!/usr/bin/env node
// Page-state checks: text boxes that overlap, glyphs drawn by a fallback font, and one-frame
// flicker. Source review first (flicker only: show/hide windows in the reel's code), then a state
// scan of every frame confirms in the rendered timeline. Facts only; exit 0 whatever it finds, except a glyph a language's font lacks (exit 1).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, stubSeconds } from "./lib/browser.mjs";
import { installTextProbe, collectFrameStates, glyphCoverage } from "./lib/page-probe.mjs";
import { textOverlapSpans, glyphFallbacks, findFlicker, visibleKeys, formatStateChecks, namedFamilies, checkedNothingReasons,
  regionCovers, fontForLang, langGlyphPairs, langGlyphReport, glyphMaskCoverage } from "./lib/state-checks.mjs";
import { gatherSources, visibilitySourceReview, formatSourceFindings } from "./lib/source-review.mjs";

const HELP = `usage: state-checks.mjs <reel-dir> [--only overlap,glyphs,flicker,covers,langglyphs] [--step <frames>] [--fps <n>]
                        [--source-only] [--no-source] [--out <json>] [--stub <sec>] [--outline-em <n>]

Five checks. The first three read the page's state at every frame (default every frame; --step N samples every Nth):
  overlap  text boxes that overlap other text boxes, per pair: the spans and the shared px²
  glyphs   characters of every on-screen string that the font in use does not have, so a fallback
           font drew them (a script missing from the chosen font); generic-only families are listed
           as not checked
  flicker  an element visible for a single sampled frame with neither neighbour showing it: drawn
           texts, plus any layer the page lists through the optional hook window.__reel.visibleAt(t)
           -> [{id: "<name>", opacity?: 0..1}]
The state comes from wrapping the canvas 2D text calls while the page seeks, so any reel works with
no change; nothing is read from pixels.
  covers      a label or always-on overlay that covers key content. Only regions the page declares are
              checked: window.__reel.regions = [{id, kind: "key"|"label"|"overlay", box: [x0,y0,x1,y1] (canvas
              px), outline?: px, from?: s, to?: s}] (no from/to = the whole film), or a function returning it.
              Reported with the shared px² and times; a judgement for the reviewer, never a failure.
  langglyphs  every character of every language's captions (plan.json + each dub/<code>/plan.json) against
              the font that language uses (window.__reel.captionFonts = {"<lang>": "<font-family list>",
              "*": "..."}, else plan style.fonts[<lang>|caption|body|default]). A missing glyph is definitely
              wrong for that language: listed with code points and line ids, and this step exits 1.
              --outline-em <n>: the captions are drawn with an outline n times the font size wide; glyph
              shapes are compared after growing them by half of it.
A check that looked at nothing says "checked nothing" with the reason, never "none". Intended
slow-motion spans are declared with window.__reel.holds = [{from, to}] and read by review.mjs.

Flicker is reviewed in the source first: show/hide windows in reel.html / src/*.js under 2 frames,
one-frame gaps or overlaps between neighbouring windows, conditions on two clocks, boundaries rounded
inside the test, and fades of 0 or 1 frame, each with file:line. --fps overrides the fps used there
(default plan.json meta.fps, else the page's). --source-only stops after that source review;
--no-source skips it.
Writes <reel-dir>/out/state-checks.json. Exit 0 whatever it finds, except langglyphs (exit 1 on a missing glyph).
`;

const CHECKS = ["overlap", "glyphs", "flicker", "covers", "langglyphs"];
const FRAME_CHECKS = ["overlap", "glyphs", "flicker"];

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
  report.covers = report.regionsDeclared ? regionCovers(regions, { duration }) : [];
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
    if (frameChecks.length) {
      await installTextProbe(session.page);
      ({ frames, hook } = await collectFrameStates(session.page, { fps, duration, step }));
    }
    report.sampledFrames = frames.length;
    if (frameChecks.length) report.nothing = checkedNothingReasons({ frames, checks: frameChecks, hasLayerHook: hook });
    if (only.includes("covers")) await reportCovers(session.page, report, duration);
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
    if (report.covers && !report.regionsDeclared) report.nothing = [...(report.nothing || []), { check: "label over key content", reason: "the page declares no regions (window.__reel.regions)" }];
    process.stdout.write(formatStateChecks({ overlaps: report.overlaps, glyphs: report.glyphs, flicker: report.flicker,
      sampledFrames: frames.length, hooks: hook, nothing: report.nothing, covers: report.covers, langGlyphs: report.langGlyphs }));
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
