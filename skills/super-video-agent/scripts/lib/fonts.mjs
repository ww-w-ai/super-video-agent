// Locates system fonts to copy into a scaffolded reel (design.md §2.3
// new-reel.mjs). Never hot-links fonts — everything found here gets copied
// into the reel's assets/fonts/ so @font-face can use relative URLs.
import fs from "node:fs";
import path from "node:path";

const FONT_DIRS = ["/Library/Fonts", path.join(process.env.HOME || "", "Library", "Fonts")];

function listFontFiles() {
  const files = [];
  for (const dir of FONT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(otf|ttf|ttc)$/i.test(f)) files.push(path.join(dir, f));
    }
  }
  return files;
}

/** Pretendard files we want, in priority order (Regular + Bold minimum). */
export function findPretendard() {
  const files = listFontFiles();
  const byName = (needle) =>
    files.find((f) => path.basename(f).toLowerCase() === needle.toLowerCase());
  const regular = byName("Pretendard-Regular.otf") || files.find((f) => /pretendard-regular/i.test(f));
  const bold = byName("Pretendard-Bold.otf") || files.find((f) => /pretendard-bold/i.test(f));
  return { regular, bold };
}

/**
 * Search for an installed Korean handwriting-style font by filename
 * heuristic (Pen/Brush/hand — design.md §2.3). Returns the file path or
 * null if none is installed on this machine.
 */
export function findHandwritingFont() {
  const files = listFontFiles();
  const re = /(pen|brush|hand)/i;
  return files.find((f) => re.test(path.basename(f))) || null;
}
