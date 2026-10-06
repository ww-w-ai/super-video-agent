#!/usr/bin/env node
// Render one frame at full resolution (design.md §2.3), or tile PNG files
// into one contact sheet (--sheet).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "./lib/ffmpeg.mjs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths } from "./lib/reeldir.mjs";
import { serveDir } from "./lib/server.mjs";
import { openReel, captureFrame, stubSeconds, warmShotsOf, glIssues, glReportLines } from "./lib/browser.mjs";
import { buildContactSheet } from "./lib/contact-sheet.mjs";
import { pictureUrl } from "./render.mjs";

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
    for (const { at, t } of targets) {
      const png = await captureFrame(session.page, t);
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
  return overrideServer(origin, { [`/dub/${code}/timings.placed.json`]: JSON.stringify(timings) });
}

/** A loopback server that returns `bodies[path]` (JSON) and forwards every other request to `origin`. */
function overrideServer(origin, bodies) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (bodies[pathname] !== undefined) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(bodies[pathname]);
        return;
      }
      try {
        const r = await fetch(origin.url.replace(/\/$/, "") + req.url);
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        res.writeHead(502);
        res.end(String(e.message));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
