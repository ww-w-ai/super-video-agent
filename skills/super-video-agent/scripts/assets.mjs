#!/usr/bin/env node
// Asset library CLI (design.md §2.5): search a local library of recorded
// sound effects and reaction clips, and fetch the ones a plan.json cues
// into a reel folder for render.mjs to draw and mix.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson, ensureDir } from "./lib/reeldir.mjs";
import { openLibrary, locateLibraryDir, assetFilePath, getById, searchAssets } from "./lib/library.mjs";
import { collectPlanCues, defaultPlay } from "./lib/cues.mjs";
import { ffmpeg, ffprobe } from "./lib/ffmpeg.mjs";

const HELP = `usage: assets.mjs search <query> [--role sfx|reaction] [--limit N]
       assets.mjs fetch <reel-dir> [--allow-personal-scope]

search   Lists library assets whose description/tags match every word in
         <query> (case-insensitive), with duration and license.
fetch    Copies every asset cued in <reel-dir>/plan.json's lines[].cues
         into <reel-dir>/assets/lib/: audio as-is, video as JPEG frames at
         the plan's fps plus a wav of its own audio when it has one.
         Writes assets/lib/manifest.json and assets/lib/cues.json.
         Refuses a non-commercialSafe asset unless plan.meta.distribution
         is "personal" or --allow-personal-scope is passed; either way
         every fetched asset's license is printed.

Without a library (no SVA_ASSET_LIB and no <skill>/library/), both
commands print "no library found at <path>" and exit 0.
`;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const [cmd, ...rest] = positional;
  try {
    if (cmd === "search") {
      await runSearch(rest, flags);
    } else if (cmd === "fetch") {
      await runFetch(rest, flags);
    } else {
      fail(`unknown command "${cmd}", expected "search" or "fetch"`);
    }
  } catch (e) {
    fail(e.message);
  }
}

async function runSearch(rest, flags) {
  const query = rest.join(" ");
  const library = openLibrary();
  if (!library) {
    process.stdout.write(`no library found at ${locateLibraryDir()}\n`);
    return;
  }
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const results = searchAssets(library, query, { role: flags.role, limit });
  if (results.length === 0) {
    process.stdout.write("no matches\n");
    return;
  }
  for (const a of results) {
    process.stdout.write(
      `${a.id}  [${a.role}]  ${a.durationSec.toFixed(2)}s  ` +
        `license:${a.license.kind}(commercialSafe=${a.license.commercialSafe})  ${a.description}\n`
    );
  }
}

async function runFetch(rest, flags) {
  if (!rest[0]) {
    fail("fetch requires a <reel-dir>");
    return;
  }
  const result = await fetchAssets({
    dir: abs(rest[0]),
    allowPersonalScope: !!flags["allow-personal-scope"],
    log: (line) => process.stdout.write(line + "\n"),
  });
  if (result.fetched > 0) {
    process.stdout.write(`fetched ${result.fetched} asset(s) into ${result.libDir}\n`);
  }
}

/**
 * `assets.mjs fetch`'s logic, separated from the CLI so callers (tests)
 * get a rejected Promise instead of a process.exit on failure. `log` is
 * called once per line the CLI would print (license lines, "no library
 * found", "no cues"); it never throws or exits.
 * @returns {Promise<{fetched:number, libDir?:string, manifestPath?:string, cuesPath?:string}>}
 */
export async function fetchAssets({ dir, allowPersonalScope = false, log = () => {} }) {
  const paths = reelPaths(dir);
  const plan = readJson(paths.planJson);
  const cues = collectPlanCues(plan);
  if (cues.length === 0) {
    log("no cues in plan.json — nothing to fetch");
    return { fetched: 0 };
  }

  const library = openLibrary();
  if (!library) {
    log(`no library found at ${locateLibraryDir()}`);
    return { fetched: 0 };
  }

  const distribution = (plan.meta && plan.meta.distribution) || "public";
  const allowed = allowPersonalScope || distribution === "personal";

  // Resolve every cued asset up front (fail fast, with the offending id)
  // and print each one's license before doing any copying.
  const byId = new Map();
  for (const cue of cues) {
    if (byId.has(cue.asset)) continue;
    const asset = getById(library, cue.asset);
    if (!asset) {
      throw new Error(`unknown asset id "${cue.asset}" (cued in line "${cue.lineId}")`);
    }
    byId.set(cue.asset, asset);
  }

  const forbidden = [];
  for (const asset of byId.values()) {
    log(`${asset.id}: license ${asset.license.kind} (commercialSafe=${asset.license.commercialSafe})`);
    if (asset.license.commercialSafe === false && !allowed) forbidden.push(asset.id);
  }
  if (forbidden.length) {
    throw new Error(
      `refusing to fetch non-commercialSafe asset(s) without --allow-personal-scope ` +
        `or meta.distribution "personal": ${forbidden.join(", ")}`
    );
  }

  const libDir = path.join(paths.assetsDir, "lib");
  ensureDir(libDir);
  const fps = (plan.meta && plan.meta.fps) || 30;

  const manifestAssets = {};
  for (const asset of byId.values()) {
    manifestAssets[asset.id] = await fetchOne({ library, asset, libDir, fps });
  }
  const manifestPath = path.join(libDir, "manifest.json");
  writeJson(manifestPath, { version: 1, assets: manifestAssets });

  const normalizedCues = cues.map((cue) => ({
    lineId: cue.lineId,
    asset: cue.asset,
    at: cue.at,
    offsetMs: cue.offsetMs || 0,
    gainDb: cue.gainDb == null ? 0 : cue.gainDb,
    maxSec: cue.maxSec,
    play: cue.play || defaultPlay(byId.get(cue.asset).role),
  }));
  const cuesPath = path.join(libDir, "cues.json");
  writeJson(cuesPath, { version: 1, cues: normalizedCues });

  return { fetched: byId.size, libDir, manifestPath, cuesPath };
}

function frameFileName(index) {
  return `frame-${String(index).padStart(5, "0")}.jpg`;
}

async function fetchOne({ library, asset, libDir, fps }) {
  const srcPath = assetFilePath(library, asset);
  if (asset.kind === "audio") {
    const ext = path.extname(asset.path) || ".wav";
    const destName = `${asset.id}${ext}`;
    fs.copyFileSync(srcPath, path.join(libDir, destName));
    return {
      kind: "audio",
      role: asset.role,
      license: asset.license,
      durationSec: asset.durationSec,
      file: `assets/lib/${destName}`,
    };
  }

  // video: JPEG frames at the plan fps, keeping aspect, capped at 1080 wide.
  const frameDir = path.join(libDir, asset.id);
  ensureDir(frameDir);
  await ffmpeg([
    "-y",
    "-i",
    srcPath,
    "-vf",
    `fps=${fps},scale='min(1080,iw)':-2:flags=lanczos`,
    "-start_number",
    "0",
    "-q:v",
    "2",
    path.join(frameDir, "frame-%05d.jpg"),
  ]);
  const frameFiles = fs.readdirSync(frameDir).filter((f) => f.endsWith(".jpg")).sort();
  const { width, height } = await probeImageSize(path.join(frameDir, frameFiles[0]));

  let audioFile;
  if (asset.hasAudio) {
    const audioName = `${asset.id}-audio.wav`;
    await ffmpeg(["-y", "-i", srcPath, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(libDir, audioName)]);
    audioFile = `assets/lib/${audioName}`;
  }

  return {
    kind: "video",
    role: asset.role,
    license: asset.license,
    durationSec: asset.durationSec,
    fps,
    width,
    height,
    frameCount: frameFiles.length,
    frameDir: `assets/lib/${asset.id}`,
    audio: audioFile,
  };
}

async function probeImageSize(framePath) {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    framePath,
  ]);
  const [width, height] = stdout.toString().trim().split("x").map(Number);
  return { width, height };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
