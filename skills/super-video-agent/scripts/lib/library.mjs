// Asset library (design.md §2.5): a folder of catalog.json + files, kept
// outside the repo (git-ignored) because most sound effects and reaction
// clips carry third-party rights. Locating and reading it never throws for
// the common "no library on this machine" case — every caller (assets.mjs,
// verify.mjs) treats a missing library as "everything works as before".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The library's place under the user's home folder when SVA_ASSET_LIB is not set (every OS). */
export const DEFAULT_LIBRARY_SUBDIR = path.join(".super-video-agent", "library");

/**
 * Where the asset library is: `SVA_ASSET_LIB` when the user set it, else
 * `<home>/.super-video-agent/library`. Only locates; never creates it.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [home]
 */
export function locateLibraryDir(env = process.env, home = os.homedir()) {
  if (env.SVA_ASSET_LIB) return path.resolve(env.SVA_ASSET_LIB);
  return path.join(home, DEFAULT_LIBRARY_SUBDIR);
}

/** Valid role/kind pairs: sound effects and clips, then 3D models, owner image refs, code-built models. */
const ROLE_KINDS = {
  sfx: ["audio", "video"],
  reaction: ["audio", "video"],
  character: ["model", "code"],
  prop: ["model", "code"],
  set: ["model", "code"],
  "character-ref": ["image"],
};

/** Kinds `assets.mjs model` handles (everything that is not a timed cue clip). */
export const MODEL_KINDS = ["model", "image", "code"];

export function isModelAsset(asset) {
  return !!asset && MODEL_KINDS.includes(asset.kind);
}

function isValidAsset(a) {
  return (
    a &&
    typeof a.id === "string" &&
    a.id.length > 0 &&
    Object.prototype.hasOwnProperty.call(ROLE_KINDS, a.role) &&
    ROLE_KINDS[a.role].includes(a.kind) &&
    typeof a.path === "string" &&
    a.path.length > 0 &&
    a.license &&
    typeof a.license.kind === "string" &&
    typeof a.license.commercialSafe === "boolean"
  );
}

/**
 * Load and validate `<dir>/catalog.json`. Returns null when the folder or
 * its catalog is absent (no library there). Entries that fail basic shape
 * validation are dropped rather than failing the whole library.
 * @returns {{dir:string, version:number, assets:object[]}|null}
 */
export function loadLibrary(dir) {
  const catalogPath = path.join(dir, "catalog.json");
  if (!fs.existsSync(catalogPath)) return null;
  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const assets = Array.isArray(raw.assets) ? raw.assets.filter(isValidAsset) : [];
  return { dir, version: raw.version, assets };
}

/**
 * Locate (env override or default) and load the library in one step.
 * @returns {{dir:string, version:number, assets:object[]}|null}
 */
export function openLibrary(env = process.env) {
  const dir = locateLibraryDir(env);
  if (!fs.existsSync(dir)) return null;
  return loadLibrary(dir);
}

/**
 * Throws unless `file` stays inside the library folder. A catalogue is data a
 * user or a downloaded pack wrote, so neither a `..` path nor a symlink may
 * steer a copy to a file outside it. Compares real paths when the file exists.
 * @param {{dir:string}} library
 * @param {string} file absolute path
 * @param {string} label what to name in the error (an asset id or a file name)
 */
export function assertInsideLibrary(library, file, label) {
  const root = fs.realpathSync(library.dir);
  const target = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const lexicalRoot = path.resolve(library.dir);
  const inside = (r, t) => t.startsWith(r + path.sep);
  const ok = fs.existsSync(file) ? inside(root, target) : inside(lexicalRoot, target) || inside(root, target);
  if (!ok) throw new Error(`asset "${label}" resolves outside the library folder: ${file}`);
}

/** Absolute path to a library asset's file on disk; throws if the catalogue path leaves the library. */
export function assetFilePath(library, asset) {
  const file = path.join(library.dir, asset.path);
  assertInsideLibrary(library, file, asset.id);
  return file;
}

export function getById(library, id) {
  return library.assets.find((a) => a.id === id);
}

function haystack(asset) {
  const tags = Array.isArray(asset.tags) ? asset.tags.join(" ") : "";
  // NFC both sides: labels copied from macOS file names are often NFD.
  return `${asset.description || ""} ${tags}`.normalize("NFC").toLowerCase();
}

/**
 * Keyword search over an asset's description and tags (case-insensitive),
 * with how many of the query's words each hit matched. Assets matching
 * every word come first, then assets matching some of them, more words
 * first; within each, by total word-occurrence count, ties keeping catalog
 * order. An asset matching no word is left out.
 * @returns {{asset: object, matched: number, words: number, score: number}[]}
 */
export function searchAssetsRanked(library, query, opts = {}) {
  const tokens = String(query || "")
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const role = opts.role;
  const limit = opts.limit;

  const scored = [];
  for (const asset of library.assets) {
    if (role && asset.role !== role) continue;
    const text = haystack(asset);
    let score = 0;
    let matched = 0;
    for (const tok of tokens) {
      const count = countOccurrences(text, tok);
      if (count > 0) matched++;
      score += count;
    }
    if (tokens.length === 0 || matched > 0) scored.push({ asset, matched, words: tokens.length, score });
  }

  scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
  return typeof limit === "number" ? scored.slice(0, limit) : scored;
}

/**
 * The assets of searchAssetsRanked() in rank order; with `opts.all` true,
 * only those matching every word.
 * @returns {object[]}
 */
export function searchAssets(library, query, opts = {}) {
  const ranked = searchAssetsRanked(library, query, { role: opts.role });
  const kept = opts.all ? ranked.filter((r) => r.matched === r.words) : ranked;
  const results = kept.map((r) => r.asset);
  return typeof opts.limit === "number" ? results.slice(0, opts.limit) : results;
}

function countOccurrences(haystackStr, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystackStr.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}
