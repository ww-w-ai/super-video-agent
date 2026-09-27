// Asset library (design.md §2.5): a folder of catalog.json + files, kept
// outside the repo (git-ignored) because most sound effects and reaction
// clips carry third-party rights. Locating and reading it never throws for
// the common "no library on this machine" case — every caller (assets.mjs,
// verify.mjs) treats a missing library as "everything works as before".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, "..", "..");

/** `SVA_ASSET_LIB` if set, else `<skill>/library` next to scripts/. */
export function locateLibraryDir(env = process.env) {
  if (env.SVA_ASSET_LIB) return path.resolve(env.SVA_ASSET_LIB);
  return path.join(REPO_ROOT, "library");
}

function isValidAsset(a) {
  return (
    a &&
    typeof a.id === "string" &&
    a.id.length > 0 &&
    (a.role === "sfx" || a.role === "reaction") &&
    (a.kind === "audio" || a.kind === "video") &&
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

/** Absolute path to a library asset's file on disk. */
export function assetFilePath(library, asset) {
  return path.join(library.dir, asset.path);
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
 * Keyword search: every whitespace-separated token in `query` must appear
 * (case-insensitive) somewhere in an asset's description or tags. Matches
 * are ranked by total token-occurrence count, ties keeping catalog order.
 * @returns {object[]}
 */
export function searchAssets(library, query, opts = {}) {
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
    if (tokens.length === 0) {
      scored.push({ asset, score: 0 });
      continue;
    }
    let score = 0;
    let missed = false;
    for (const tok of tokens) {
      const count = countOccurrences(text, tok);
      if (count === 0) {
        missed = true;
        break;
      }
      score += count;
    }
    if (!missed) scored.push({ asset, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.map((s) => s.asset);
  return typeof limit === "number" ? results.slice(0, limit) : results;
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
