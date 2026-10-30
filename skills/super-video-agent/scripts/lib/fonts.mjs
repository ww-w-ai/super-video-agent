// Locates system fonts to copy into a scaffolded reel (design.md §2.3
// new-reel.mjs). Never hot-links fonts — everything found here gets copied
// into the reel's assets/fonts/ so @font-face can use relative URLs.
//
// Linux installs fonts in family subfolders (~/.local/share/fonts/Pretendard/,
// /usr/share/fonts/truetype/nanum/), so each folder is walked a few levels
// deep; a single-level listing misses them and the reel silently falls back
// to another face.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DEPTH = 4;
const FONT_EXT = /\.(otf|ttf|ttc)$/i;

/**
 * Font folders to search: $SVA_FONT_DIR first (one folder, or several joined
 * by path.delimiter), then the system and per-user folders of this OS.
 */
export function fontDirs(platform = process.platform, home = os.homedir(), env = process.env) {
  const override = (env.SVA_FONT_DIR || "").split(path.delimiter).filter(Boolean);
  return [...override, ...osFontDirs(platform, home, env)];
}

function osFontDirs(platform, home, env) {
  if (platform === "darwin") return ["/Library/Fonts", path.join(home, "Library", "Fonts")];
  if (platform === "win32") {
    const win = env.WINDIR || env.SystemRoot || "C:\\Windows";
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(win, "Fonts"), path.join(local, "Microsoft", "Windows", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local", "share", "fonts"), path.join(home, ".fonts")];
}

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (FONT_EXT.test(e.name) && !e.isDirectory()) {
      out.push(p);
    } else if (depth < MAX_DEPTH && isDirectory(e, p)) {
      walk(p, depth + 1, out);
    }
  }
}

// Distro font packages often symlink family folders, so follow symlinks.
function isDirectory(entry, p) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFontFiles(dirs) {
  const files = [];
  for (const dir of dirs) walk(dir, 0, files);
  return files;
}

/**
 * Pretendard files we want, in priority order (Regular + Bold minimum).
 * `searched` lists the folders looked in, for the not-found warning.
 */
export function findPretendard({ dirs = fontDirs() } = {}) {
  const files = listFontFiles(dirs);
  const byName = (needle) =>
    files.find((f) => path.basename(f).toLowerCase() === needle.toLowerCase());
  const regular = byName("Pretendard-Regular.otf") || files.find((f) => /pretendard-regular/i.test(path.basename(f)));
  const bold = byName("Pretendard-Bold.otf") || files.find((f) => /pretendard-bold/i.test(path.basename(f)));
  return { regular, bold, searched: dirs };
}

/**
 * Search for an installed Korean handwriting-style font by filename
 * heuristic (Pen/Brush/Hand — design.md §2.3). The word must start with a
 * capital or follow a separator, so "NanumPen.ttf" and "nanum-brush.ttf"
 * match but "OpenSans" or "NotoSansSoraSompeng" do not — those turn up once
 * the Linux system folders are searched deeply. Returns the file path or
 * null if none is installed on this machine.
 */
export function findHandwritingFont({ dirs = fontDirs() } = {}) {
  const files = listFontFiles(dirs);
  const re = /(Pen|Brush|Hand)|(^|[-_ ])(pen|brush|hand)/;
  return files.find((f) => re.test(path.basename(f))) || null;
}

/** Warning printed when Pretendard is missing from the scaffolded reel. */
export function pretendardRemedy(fontsDir, searched) {
  return [
    `WARNING: Pretendard not found — ${fontsDir} has no Pretendard-Regular.otf / Pretendard-Bold.otf,`,
    `but reel.html's @font-face points there, so the page would draw in a fallback face.`,
    `Searched: ${searched.join(", ")}`,
    `Fix (either):`,
    `  1. Copy Pretendard-Regular.otf and Pretendard-Bold.otf into ${fontsDir}.`,
    `  2. Install Pretendard, or set SVA_FONT_DIR to the folder holding the .otf files, and re-run`,
    `     new-reel.mjs — only before editing reel.html: a re-run rewrites it.`,
  ].join("\n");
}
