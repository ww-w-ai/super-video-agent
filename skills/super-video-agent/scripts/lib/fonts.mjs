// Locates installed fonts to copy into a scaffolded reel (design.md §2.3
// new-reel.mjs). Never hot-links fonts — everything found here gets copied
// into the reel's assets/fonts/ so @font-face can use relative URLs.
//
// Searched in order: $SVA_FONT_DIR (one folder, or several joined with the
// path delimiter), then the per-user and system font folders of macOS, Linux
// and Windows. Linux installs fonts in family subfolders
// (~/.local/share/fonts/Pretendard/, /usr/share/fonts/truetype/nanum/), so
// each folder is walked a few levels deep. Searching only the macOS folders
// left assets/fonts/ empty on Linux while reel.html still pointed at
// Pretendard, and the page silently drew in a fallback face.
import fs from "node:fs";
import path from "node:path";

const MAX_DEPTH = 4;
const FONT_EXT = /\.(otf|ttf|ttc)$/i;

/** The folders searched for fonts, most specific first. */
export function fontDirs(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || "";
  const dirs = [];
  if (env.SVA_FONT_DIR) dirs.push(...env.SVA_FONT_DIR.split(path.delimiter).filter(Boolean));
  if (platform === "darwin") {
    dirs.push(path.join(home, "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts");
  } else if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
    dirs.push(path.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Fonts"));
  } else {
    const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    dirs.push(path.join(dataHome, "fonts"), path.join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts");
  }
  return dirs.filter((d, i) => d && dirs.indexOf(d) === i);
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
    if (e.isFile() && FONT_EXT.test(e.name)) {
      out.push(p);
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) walk(p, depth + 1, out);
  }
}

function listFontFiles(dirs) {
  const files = [];
  for (const dir of dirs) walk(dir, 0, files);
  return files;
}

/**
 * Pretendard files we want (Regular + Bold minimum).
 * @param {{dirs?: string[]}} [opts] folders to search (default fontDirs())
 * @returns {{regular: string|undefined, bold: string|undefined, searched: string[]}}
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
 * the Linux system folders are searched. Returns the file path or null if
 * none is installed on this machine.
 * @param {{dirs?: string[]}} [opts]
 */
export function findHandwritingFont({ dirs = fontDirs() } = {}) {
  const files = listFontFiles(dirs);
  const re = /(Pen|Brush|Hand)|(^|[-_ ])(pen|brush|hand)/;
  return files.find((f) => re.test(path.basename(f))) || null;
}

/** The copy-paste remedy printed when Pretendard is not installed. */
export function pretendardRemedy(fontsDir, searched) {
  return [
    `WARNING: Pretendard not found — ${fontsDir} has no Pretendard-Regular.otf / Pretendard-Bold.otf,`,
    `but reel.html's @font-face points there, so the page would draw in a fallback face.`,
    `Searched: ${searched.join(", ")}`,
    `Fix (either):`,
    `  1. Copy Pretendard-Regular.otf and Pretendard-Bold.otf (and the licence) into ${fontsDir}.`,
    `  2. Install Pretendard (SIL OFL 1.1, https://github.com/orioncactus/pretendard/releases), or set`,
    `     SVA_FONT_DIR to the folder holding the .otf files, and re-run new-reel.mjs — only before`,
    `     editing reel.html: a re-run rewrites it.`,
  ].join("\n");
}
