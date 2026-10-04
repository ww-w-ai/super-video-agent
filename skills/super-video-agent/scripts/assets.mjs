#!/usr/bin/env node
// Asset library CLI (design.md §2.5): search a local library of recorded
// sound effects, reaction clips and 3D models, fetch the clips a plan.json cues
// into a reel folder for render.mjs to draw and mix, and copy models in.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { reelPaths, readJson, writeJson, ensureDir } from "./lib/reeldir.mjs";
import { openLibrary, locateLibraryDir, assetFilePath, assertInsideLibrary, getById, searchAssets, isModelAsset } from "./lib/library.mjs";
import { collectPlanCues, defaultPlay } from "./lib/cues.mjs";
import { ffmpeg, ffprobe } from "./lib/ffmpeg.mjs";

const HELP = `usage: assets.mjs search <query> [--role sfx|reaction|character|prop|set|character-ref] [--limit N]
       assets.mjs fetch <reel-dir> [--allow-personal-scope]
       assets.mjs model <id> <reel-dir> [--allow-personal-scope]

search   Lists library assets whose description/tags match every word in
         <query> (case-insensitive): clips with duration, 3D models and
         images with rigged/clips, plus the license.
model    Copies a 3D model (character, prop, set) or a code-built model
         module into <reel-dir>/assets/models/<id>/, an owner image into
         <reel-dir>/assets/refs/<id>/, and prints its license. A glTF also
         brings its .bin and textures. Each asset has its own <id> folder,
         so two models that both export scene.gltf do not overwrite each
         other. Same license rule as fetch.
fetch    Copies every asset cued in <reel-dir>/plan.json's lines[].cues
         into <reel-dir>/assets/lib/: audio as-is, video as JPEG frames at
         the plan's fps plus a wav of its own audio when it has one.
         Writes assets/lib/manifest.json and assets/lib/cues.json.
         Refuses a non-commercialSafe asset unless plan.meta.distribution
         is "personal" or --allow-personal-scope is passed; either way
         every fetched asset's license is printed.

The library is not bundled with the skill (its files carry third-party
rights). Without one (no SVA_ASSET_LIB and no <skill>/library/), both
commands print "no library found at <path>", how to point SVA_ASSET_LIB
at a folder with catalog.json, and exit 0.
`;

/**
 * The line printed when no asset library is found at `dir`.
 * @param {string} dir where the library was looked for
 * @param {Record<string, string|undefined>} [env]
 */
export function noLibraryMessage(dir, env = process.env) {
  const where = env.SVA_ASSET_LIB ? "SVA_ASSET_LIB names no folder with catalog.json" : "the asset library is not bundled with the skill";
  return (
    `no library found at ${dir} — ${where}. To use one, set SVA_ASSET_LIB=<folder with catalog.json> ` +
    `(references/pipeline.md "Asset library"); without it, synthesized sounds still work.`
  );
}

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
    } else if (cmd === "model") {
      await runModel(rest, flags);
    } else {
      fail(`unknown command "${cmd}", expected "search", "fetch" or "model"`);
    }
  } catch (e) {
    fail(e.message);
  }
}

async function runSearch(rest, flags) {
  const query = rest.join(" ");
  const library = openLibrary();
  if (!library) {
    process.stdout.write(noLibraryMessage(locateLibraryDir()) + "\n");
    return;
  }
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const results = searchAssets(library, query, { role: flags.role, limit });
  if (results.length === 0) {
    process.stdout.write("no matches\n");
    return;
  }
  for (const a of results) process.stdout.write(searchLine(a) + "\n");
}

/** One `search` result line: clips show duration, models show rigged/clips. */
export function searchLine(a) {
  const lic = `license:${a.license.kind}(commercialSafe=${a.license.commercialSafe})`;
  if (isModelAsset(a)) {
    const clips = Array.isArray(a.clips) && a.clips.length ? a.clips.map((c) => c.name).join(",") : "none";
    const shape = a.kind === "model" ? `rigged=${!!a.rigged} clips=${clips}  ` : "";
    return `${a.id}  [${a.role}/${a.kind}]  ${shape}${lic}  ${a.description}`;
  }
  return `${a.id}  [${a.role}]  ${a.durationSec.toFixed(2)}s  ${lic}  ${a.description}`;
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

async function runModel(rest, flags) {
  if (!rest[0] || !rest[1]) {
    fail("model requires <id> and <reel-dir>");
    return;
  }
  await fetchModel({
    id: rest[0],
    dir: abs(rest[1]),
    allowPersonalScope: !!flags["allow-personal-scope"],
    log: (line) => process.stdout.write(line + "\n"),
  });
}

/** True when the reel's plan.json or --allow-personal-scope lets a non-commercialSafe asset through. */
function personalScopeAllowed(plan, allowPersonalScope) {
  const distribution = (plan.meta && plan.meta.distribution) || "public";
  return allowPersonalScope || distribution === "personal";
}

/**
 * Joins `rel` onto `base` and returns the result only if it stays under `base`.
 * A .gltf is third-party data, so its uris must not steer a read or a write
 * outside the asset's own folder or the reel's destination folder.
 * @param {string} base
 * @param {string} rel
 * @param {string} uri the original uri, for the error message
 */
function resolveInside(base, rel, uri) {
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`glTF uri "${uri}" points outside the asset folder`);
  }
  return full;
}

/**
 * Decodes one glTF uri into a safe relative path (forward slashes), or throws.
 * Rejects absolute paths, drive letters, url schemes, NUL and any `..` segment.
 */
function safeCompanionPath(uri) {
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`glTF uri "${uri}" is not valid URI encoding`);
  }
  const normalized = decoded.replace(/\\/g, "/");
  const bad =
    decoded.includes("\0") ||
    path.isAbsolute(decoded) ||
    normalized.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) ||
    normalized.split("/").includes("..");
  if (bad || normalized === "") throw new Error(`glTF uri "${uri}" is absolute or leaves the asset folder`);
  return normalized;
}

/** Files a .gltf pulls in by relative uri (its .bin and textures), as safe relative paths. */
function gltfCompanions(gltfPath) {
  const json = JSON.parse(fs.readFileSync(gltfPath, "utf8"));
  const uris = [...(json.buffers || []), ...(json.images || [])]
    .map((x) => x.uri)
    .filter((u) => typeof u === "string" && !u.startsWith("data:"));
  return [...new Set(uris.map(safeCompanionPath))];
}

/**
 * `assets.mjs model`'s logic: copy one model/image/code asset into the reel.
 * Models and code go to assets/models/<id>/, images to assets/refs/<id>/. Rejects
 * (instead of exiting) on an unknown id, a clip asset, a missing file, or a
 * non-commercialSafe asset without the personal-scope override.
 * @returns {Promise<{fetched:number, file?:string, files?:string[]}>}
 */
export async function fetchModel({ id, dir, allowPersonalScope = false, log = () => {} }) {
  const library = openLibrary();
  if (!library) {
    log(noLibraryMessage(locateLibraryDir()));
    return { fetched: 0 };
  }
  const asset = getById(library, id);
  if (!asset) throw new Error(`unknown asset id "${id}"`);
  if (!isModelAsset(asset)) {
    throw new Error(`asset "${id}" is a clip (kind ${asset.kind}), not a model; cue it in plan.json and use "assets.mjs fetch"`);
  }

  const paths = reelPaths(dir);
  const plan = fs.existsSync(paths.planJson) ? readJson(paths.planJson) : {};
  log(`${asset.id}: license ${asset.license.kind} (commercialSafe=${asset.license.commercialSafe})`);
  if (asset.license.note) log(`${asset.id}: ${asset.license.note}`);
  if (asset.license.commercialSafe === false && !personalScopeAllowed(plan, allowPersonalScope)) {
    throw new Error(
      `refusing to fetch non-commercialSafe asset without --allow-personal-scope ` +
        `or meta.distribution "personal": ${asset.id}`
    );
  }

  const srcPath = assetFilePath(library, asset);
  if (!fs.existsSync(srcPath)) throw new Error(`library file missing for "${id}": ${srcPath}`);
  const sub = asset.kind === "image" ? "refs" : "models";
  if (/[\\/]/.test(asset.id) || asset.id === "." || asset.id === "..") throw new Error(`asset id "${id}" is not a usable folder name`);
  const destDir = path.join(paths.assetsDir, sub, asset.id);
  ensureDir(destDir);

  const srcDir = path.dirname(srcPath);
  const extra = srcPath.endsWith(".gltf") ? gltfCompanions(srcPath) : [];
  if (extra.length) for (const f of fs.readdirSync(srcDir)) if (/^license.*\.txt$/i.test(f)) extra.push(f);
  const names = [path.basename(srcPath), ...extra];
  // Validate every source and destination before copying anything, so a bad uri leaves no partial copy.
  const copies = names.map((name) => {
    const from = resolveInside(srcDir, name, name);
    assertInsideLibrary(library, from, `${id}: ${name}`);
    return { from, to: resolveInside(destDir, name, name) };
  });
  for (const { from, to } of copies) {
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }

  const files = names.map((n) => `assets/${sub}/${asset.id}/${n}`);
  log(`fetched ${asset.id} into ${destDir} (${files.join(", ")})`);
  return { fetched: 1, file: files[0], files };
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
    log(noLibraryMessage(locateLibraryDir()));
    return { fetched: 0 };
  }

  const allowed = personalScopeAllowed(plan, allowPersonalScope);

  // Resolve every cued asset up front (fail fast, with the offending id)
  // and print each one's license before doing any copying.
  const byId = new Map();
  for (const cue of cues) {
    if (byId.has(cue.asset)) continue;
    const asset = getById(library, cue.asset);
    if (!asset) {
      throw new Error(`unknown asset id "${cue.asset}" (cued in line "${cue.lineId}")`);
    }
    if (isModelAsset(asset)) {
      throw new Error(`asset "${cue.asset}" is a ${asset.kind}, not a cue clip; use "assets.mjs model ${cue.asset} <reel-dir>"`);
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
