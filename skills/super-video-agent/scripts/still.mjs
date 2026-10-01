#!/usr/bin/env node
// Render one frame at full resolution (design.md §2.3), or tile PNG files
// into one contact sheet (--sheet).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, stubSeconds } from "./lib/browser.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { pictureUrl } from "./render.mjs";

const DEFAULT_SHEET_CELL = 540;

const HELP = `usage: still.mjs <reel-dir> --at <t|shotId>[,<t|shotId>...] [--out <png>] [--stub <sec>] [--no-captions]
       still.mjs --sheet <out.png> <a.png> <b.png> ... [--cols N] [--cell <px>]

Renders frames of <reel-dir>/reel.html at time \`t\` (seconds) or at a
shot's readAt (pass the shot id) and writes each as a PNG. Several --at
values share one browser session.
Default output is <reel-dir>/out/still-<at>.png per value (still-<at>-nocap.png
with --no-captions). --out applies only when a single --at value is given.

--stub <sec>  for a reel with no voice/timings.json (a picture-only probe):
              the page is served one silent line of <sec> seconds with id
              "stub". Nothing is written to voice/.
--no-captions loads the page with ?captions=0, as render.mjs --no-captions
              does, so the still matches out/picture.mp4 (the picture with
              no caption layer).
--sheet <out.png> <png...>
              tiles the given PNG files into one contact sheet, each labelled
              with its file name, in the given order. No reel page is opened.
              --cols N sets the column count (default: up to 4).
              --cell <px> sets each tile's width (default ${DEFAULT_SHEET_CELL}, enough to
              read captions on a 16:9 frame); the height follows the frames'
              aspect.
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

  const noCaptions = !!flags["no-captions"];
  const server = await serveDir(dir);
  let session;
  try {
    session = await openReel(pictureUrl(server.url, noCaptions), { stubSec });
    for (const at of ats) {
      const t = resolveAt(at, session.meta.shots);
      const png = await captureFrame(session.page, t);
      const outPath = flags.out ? abs(flags.out) : path.join(paths.outDir, stillFileName(at, noCaptions));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, png);
      process.stdout.write(`wrote ${outPath} (t=${t.toFixed(3)}s)\n`);
    }
  } catch (e) {
    fail(e.message);
  } finally {
    if (session) await session.close();
    await server.close();
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
  } catch (e) {
    fail(e.message);
    return;
  }
  try {
    const frames = args.inputs.map((p) => ({ png: fs.readFileSync(p), label: path.basename(p) }));
    const sheet = await buildContactSheet(frames, { cols: args.cols, cellWidth: args.cellWidth });
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, sheet);
    process.stdout.write(`wrote ${args.outPath} (${frames.length} PNGs)\n`);
  } catch (e) {
    fail(e.message);
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
 * "-nocap" so it never overwrites the captioned one.
 * @param {string} at
 * @param {boolean} noCaptions
 */
export function stillFileName(at, noCaptions) {
  return `still-${sanitize(at)}${noCaptions ? "-nocap" : ""}.png`;
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
