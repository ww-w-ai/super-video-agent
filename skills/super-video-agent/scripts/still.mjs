#!/usr/bin/env node
// Render one frame at full resolution (design.md §2.3), or tile PNG files
// into one contact sheet (--sheet).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, probeVideoInfo } from "./lib/ffmpeg.mjs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths } from "./lib/reeldir.mjs";
import { serveDir, serveOverrides } from "./lib/server.mjs";
import { openReel, captureFrame, stubSeconds, warmShotsOf, glIssues, glReportLines } from "./lib/browser.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { pictureUrl } from "./render.mjs";
import { isMain } from "./lib/is-main.mjs";

const DEFAULT_SHEET_CELL = 540;

const HELP = `usage: still.mjs <reel-dir> --at <t|shotId>[,<t|shotId>...] [--out <png> | --out-dir <dir>] [--stub <sec>] [--no-captions] [--dub <code>] [--no-warm]
       still.mjs --sheet <out.png> <a.png> <b.png> ... [--cols N] [--cell <px>]

Renders frames of <reel-dir>/reel.html at time \`t\` (seconds) or at a
shot's readAt (pass the shot id) and writes each as a PNG. Several --at
values share one browser session.
Default output is <reel-dir>/out/still-<at>.png per value (still-<at>-nocap.png
with --no-captions). --out applies only when a single --at value is given.
--out-dir <dir> writes the per-value files into <dir> instead of <reel-dir>/out.
Only the shots the --at values fall in are warmed up (two throwaway seeks each);
--no-warm skips even that.
If the page logs a WebGL error (GL_INVALID_*, lost context) the frames are wrong:
the files are still written, the error is printed and the exit code is 1. Other
WebGL warnings are printed and do not change the exit code.
If the page throws or logs any other error while loading or drawing (a scene may
not have registered, a frame may be partial), the error is printed, no further
still is written and the exit code is 1.

--stub <sec>  for a reel with no voice/timings.json (a picture-only probe):
              the page is served one silent line of <sec> seconds with id
              "stub". Nothing is written to voice/.
--no-captions loads the page with ?captions=0, as render.mjs --no-captions
              does, so the still matches out/picture.mp4 (the picture with
              no caption layer).
--dub <code>  previews a language's caption layer (?layer=captions&dub=<code>: its
              captions, labels and corner notes from dub/<code>/plan.json) laid over
              the picture at that second (out/picture-<code>.mp4, else out/picture.mp4;
              flat grey when there is none). Before the language is dubbed
              (no dub/<code>/timings.placed.json) the base language's clock is used
              with that plan's text; nothing is written into the reel. Writes
              still-<at>-dub-<code>.png. Not with --no-captions or --stub.
--sheet <out.png> <png...>
              tiles the given PNG files into one contact sheet, each labelled
              with its file name, in the given order. No reel page is opened.
              --cols N sets the column count (default: up to 4).
              --cell <px> sets each tile's width (default ${DEFAULT_SHEET_CELL}, enough to
              read captions on a 16:9 frame); the height follows the frames'
              aspect.
              Never writes over one of its inputs, or over an existing file
              that is not a sheet of the same size.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printHelpAndExit(HELP, 0);
    return;
  }
  if (flags.sheet !== undefined) {
    await sheetMain(flags, positional);
    return;
  }
  if (positional.length === 0 || flags.at == null) {
    printHelpAndExit(HELP, 1);
    return;
  }
  const dir = abs(positional[0]);
  const paths = reelPaths(dir);
  if (!fs.existsSync(paths.reelHtml)) {
    fail(`no reel.html in ${dir} — run new-reel.mjs first`);
    return;
  }

  const ats = String(flags.at).split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.out && ats.length > 1) {
    fail("--out takes a single --at value; drop --out to write still-<at>.png per value");
    return;
  }

  let stubSec;
  try {
    stubSec = stubSeconds(flags.stub, paths.timingsJson, fs.existsSync);
  } catch (e) {
    fail(e.message);
    return;
  }

  if (flags.out && flags["out-dir"]) {
    fail("--out names one file and --out-dir a folder for several; use one");
    return;
  }
  if (flags["out-dir"] !== undefined && typeof flags["out-dir"] !== "string") {
    fail("--out-dir takes a folder, e.g. --out-dir /tmp/stills");
    return;
  }
  const outDir = flags["out-dir"] ? abs(flags["out-dir"]) : paths.outDir;
  const noCaptions = !!flags["no-captions"];
  let dubCode = null;
  try {
    dubCode = dubFlag(flags, { noCaptions, stub: stubSec });
  } catch (e) {
    fail(e.message);
    return;
  }
  const server = await serveDir(dir);
  let layerServer = null;
  let session;
  try {
    let url = pictureUrl(server.url, noCaptions);
    if (dubCode) {
      layerServer = await serveDubLayer(server, dir, dubCode);
      url = `${layerServer.url}?layer=captions&dub=${encodeURIComponent(dubCode)}`;
    }
    // Warm-up is two throwaway seeks per shot; only the shots this run captures need it.
    session = await openReel(url, { stubSec, warm: false });
    if (dubCode && !(session.meta.layers || []).includes("captions")) {
      throw new Error('reel.html does not declare "captions" in __reel.layers, so it has no per-language caption layer to preview');
    }
    const targets = ats.map((at) => ({ at, t: resolveAt(at, session.meta.shots) }));
    if (!flags["no-warm"]) await warmShotsOf(session, shotsAt(session.meta.shots, targets.map((x) => x.t)));
    stopOnPageErrors(session);
    for (const { at, t } of targets) {
      const png = await captureFrame(session.page, t);
      stopOnPageErrors(session);
      const outPath = flags.out ? abs(flags.out) : path.join(outDir, stillFileName(at, noCaptions, dubCode));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, dubCode ? await compositeOverPicture({ layerPng: png, paths, dubCode, t, size: session.meta }) : png);
      process.stdout.write(`wrote ${outPath} (t=${t.toFixed(3)}s)\n`);
    }
    reportGl(session);
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    if (layerServer) await layerServer.close();
    await server.close();
  }
}

/** The --dub language code, or null; throws when it cannot combine with the other flags. */
function dubFlag(flags, { noCaptions, stub }) {
  if (flags.dub === undefined) return null;
  if (typeof flags.dub !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(flags.dub)) {
    throw new Error(`--dub takes a language code such as en or zh-Hans (got "${flags.dub}")`);
  }
  if (noCaptions) throw new Error("--dub previews a language's caption layer; --no-captions removes captions. Use one");
  if (stub) throw new Error("--dub needs the film's own voice/timings.json; drop --stub");
  return flags.dub;
}

/**
 * The timings a not-yet-dubbed language shows in the preview: the base
 * clock's lines (same ids, starts, ends) carrying that language's plan text.
 * Word times are left out, so the page spreads a line's words by character
 * count. `missing` lists base line ids the language's plan has no text for
 * (those lines keep their base text).
 * @param {{duration: number, lines: object[]}} baseTimings
 * @param {{lines: {id: string, text?: string}[]}} dubPlan
 */
export function previewDubTimings(baseTimings, dubPlan) {
  const byId = new Map((dubPlan.lines || []).map((l) => [l.id, l]));
  const missing = [];
  const lines = baseTimings.lines.map((l) => {
    const own = byId.get(l.id);
    if (!own || typeof own.text !== "string") missing.push(l.id);
    const { words, ...rest } = l;
    return { ...rest, text: own && typeof own.text === "string" ? own.text : l.text };
  });
  return { timings: { ...baseTimings, lines }, missing };
}

/**
 * A server for the page that answers dub/<code>/timings.placed.json from
 * previewDubTimings when the language has not been dubbed yet (nothing is
 * written into the reel); everything else comes from `origin`. With the real
 * placed timings on disk, `origin` is used as is.
 */
async function serveDubLayer(origin, dir, code) {
  const placed = path.join(dir, "dub", code, "timings.placed.json");
  if (fs.existsSync(placed)) return { url: origin.url, close: async () => {} };
  const planPath = path.join(dir, "dub", code, "plan.json");
  const baseTimingsPath = path.join(dir, "voice", "timings.json");
  if (!fs.existsSync(planPath)) throw new Error(`no ${planPath} — create dub/${code}/plan.json (this reel's line ids, in ${code}) first`);
  if (!fs.existsSync(baseTimingsPath)) throw new Error(`no ${baseTimingsPath} — the preview needs the base clock; run voice.mjs first`);
  const { timings, missing } = previewDubTimings(JSON.parse(fs.readFileSync(baseTimingsPath, "utf8")), JSON.parse(fs.readFileSync(planPath, "utf8")));
  process.stdout.write(
    `note: dub/${code}/timings.placed.json does not exist yet; previewing on the base language's clock with ${code}'s plan text ` +
      `(word times are spread by character count)${missing.length ? `; no ${code} text for ${missing.join(", ")} (base text shown)` : ""}\n`
  );
  return serveOverrides(origin, { [`/dub/${code}/timings.placed.json`]: JSON.stringify(timings) });
}

/**
 * The caption layer's PNG over the picture at second `t` (out/picture-<code>.mp4,
 * else out/picture.mp4) so a language's captions can be read in place; over flat
 * grey when no picture exists yet.
 */
async function compositeOverPicture({ layerPng, paths, dubCode, t, size }) {
  const candidates = [path.join(paths.outDir, `picture-${dubCode}.mp4`), path.join(paths.outDir, "picture.mp4")];
  const picture = candidates.find((p) => fs.existsSync(p));
  const layerPath = path.join(os.tmpdir(), `sva-still-layer-${Date.now()}-${process.hrtime.bigint() / 1000n}-${process.pid}.png`);
  fs.writeFileSync(layerPath, layerPng);
  try {
    const under = picture
      ? ["-ss", String(t), "-i", picture]
      : ["-f", "lavfi", "-i", `color=c=0x808080:s=${size.width}x${size.height}`];
    const { stdout } = await ffmpeg([...under, "-i", layerPath, "-filter_complex", `[0:v]scale=${size.width}:${size.height}[b];[b][1:v]overlay`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
    return stdout;
  } finally {
    fs.rmSync(layerPath, { force: true });
  }
}

/**
 * Reads `--sheet <out.png> <png...> [--cols N] [--cell <px>]` into
 * {outPath, inputs, cols, cellWidth}. Throws on a missing output path, no
 * inputs, or a bad --cols / --cell.
 * @param {Record<string, string|boolean>} flags
 * @param {string[]} positional
 */
export function parseSheetArgs(flags, positional) {
  if (typeof flags.sheet !== "string") {
    throw new Error("--sheet takes the output PNG path first: --sheet <out.png> <a.png> <b.png> ...");
  }
  if (positional.length === 0) {
    throw new Error("--sheet needs at least one input PNG after the output path");
  }
  const cols = flags.cols === undefined ? undefined : positiveInt("--cols", flags.cols);
  const cellWidth = flags.cell === undefined ? DEFAULT_SHEET_CELL : positiveInt("--cell", flags.cell);
  return { outPath: abs(flags.sheet), inputs: positional.map(abs), cols, cellWidth };
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} takes a positive whole number (got "${value}")`);
  return n;
}

async function sheetMain(flags, positional) {
  let args;
  try {
    args = parseSheetArgs(flags, positional);
    const missing = args.inputs.filter((p) => !fs.existsSync(p));
    if (missing.length) throw new Error(`input PNG not found: ${missing.join(", ")}`);
    if (args.inputs.includes(args.outPath)) {
      throw new Error(`--sheet output ${args.outPath} is also an input; the first path after --sheet is the output: --sheet <out.png> <a.png> <b.png> ...`);
    }
  } catch (e) {
    fail(e.message);
    return;
  }
  try {
    const frames = args.inputs.map((p) => ({ png: fs.readFileSync(p), label: path.basename(p) }));
    const sheet = await buildContactSheet(frames, { cols: args.cols, cellWidth: args.cellWidth });
    await refuseForeignOutput(args.outPath, pngSize(sheet));
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, sheet);
    process.stdout.write(`wrote ${args.outPath} (${frames.length} PNGs)\n`);
  } catch (e) {
    fail(e.message);
  }
}

/**
 * Throws when `outPath` exists and is not an earlier sheet of this layout
 * (same width and height as `size`); a file that cannot be read as an image
 * is refused too. A missing `outPath` passes.
 * @param {string} outPath
 * @param {{width: number, height: number}} size the new sheet's size
 */
async function refuseForeignOutput(outPath, size) {
  if (!fs.existsSync(outPath)) return;
  const nothing = `nothing written. The first path after --sheet is the output — name a new file, or delete ${outPath} to replace it`;
  let existing;
  try {
    existing = await probeVideoInfo(outPath);
    // ffprobe on a non-image prints nothing, which reads as 0x0.
    if (!(existing.width > 0 && existing.height > 0)) throw new Error("no image size");
  } catch {
    throw new Error(`--sheet output ${outPath} already exists and cannot be read as an image; ${nothing}`);
  }
  if (existing.width === size.width && existing.height === size.height) return;
  throw new Error(
    `--sheet output ${outPath} already exists and is not a sheet of this layout (${existing.width}x${existing.height}; this sheet is ${size.width}x${size.height}); ${nothing}`
  );
}

/** Width and height from a PNG buffer's IHDR chunk. */
function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Ids of the shots that cover the times `ts` (start <= t < end; the last
 * shot also covers its end). A time in no shot warms nothing.
 * @param {{id: string, start: number, end: number}[]} shots
 * @param {number[]} ts
 */
export function shotsAt(shots, ts) {
  const last = shots.length - 1;
  const ids = new Set();
  for (const t of ts) {
    const i = shots.findIndex((s, k) => t >= s.start && (t < s.end || (k === last && t <= s.end)));
    if (i !== -1) ids.add(shots[i].id);
  }
  return [...ids];
}

/**
 * The page's own errors (uncaught exceptions, console errors), leaving out the
 * WebGL messages reportGl() handles. session.gl is keyed by glKey(text), so the
 * raw text is normalized the same way before the lookup.
 * @param {{errors: string[], gl: Map<string, object>}} session
 */
export function pageErrorsOf(session) {
  return session.errors.filter((t) => !session.gl.has(glKey(t)));
}

// The key lib/browser.mjs noteGlMessage() files a WebGL message under: hex ids and long numbers vary per run.
function glKey(text) {
  return text.replace(/0x[0-9a-f]+/gi, "0x…").replace(/\d{3,}/g, "N");
}

// A page that threw while loading or drawing may have skipped scenes or drawn a
// partial frame: no still is written from here on (files already written stay).
function stopOnPageErrors(session) {
  const errors = pageErrorsOf(session);
  if (!errors.length) return;
  reportGl(session);
  throw new Error(`the page reported error(s) while loading or drawing; stills from here on are not written:\n  ${errors.join("\n  ")}`);
}

// WebGL messages the page logged: a GL error means the frames just written are wrong (exit 1);
// other GL warnings are reported for the reviewer.
function reportGl(session) {
  const issues = glIssues(session);
  for (const l of glReportLines(issues)) process.stderr.write(`${l}\n`);
  if (issues.definite.length) {
    process.stderr.write("DIAGNOSIS: the page logged a WebGL error while drawing — the frame above is wrong (a failed draw leaves it blank or partial).\n");
    process.exitCode = 1;
  }
}

function resolveAt(at, shots) {
  const asNumber = Number(at);
  if (Number.isFinite(asNumber)) return asNumber;
  const shot = shots.find((s) => s.id === at);
  if (!shot) throw new Error(`no shot with id "${at}" and not a valid number`);
  return shot.readAt;
}

/**
 * Default still file name for one --at value; a picture-only still gets
 * "-nocap" and a language's caption-layer preview "-dub-<code>" so neither
 * overwrites the captioned base still.
 * @param {string} at
 * @param {boolean} noCaptions
 * @param {string|null} [dubCode]
 */
export function stillFileName(at, noCaptions, dubCode = null) {
  return `still-${sanitize(at)}${noCaptions ? "-nocap" : ""}${dubCode ? `-dub-${sanitize(dubCode)}` : ""}.png`;
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
