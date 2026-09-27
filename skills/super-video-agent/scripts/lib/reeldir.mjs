// Path + JSON helpers for a reel directory (reels/<slug>/ per design.md §2).
import fs from "node:fs";
import path from "node:path";

export function reelPaths(dir) {
  const root = path.resolve(dir);
  return {
    root,
    planJson: path.join(root, "plan.json"),
    reelHtml: path.join(root, "reel.html"),
    voiceDir: path.join(root, "voice"),
    narrationWav: path.join(root, "voice", "narration.wav"),
    timingsJson: path.join(root, "voice", "timings.json"),
    assetsDir: path.join(root, "assets"),
    outDir: path.join(root, "out"),
  };
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${filePath}: ${e.message}`);
  }
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function loadPlan(dir) {
  const p = reelPaths(dir);
  return readJson(p.planJson);
}

export function loadTimings(dir) {
  const p = reelPaths(dir);
  return readJson(p.timingsJson);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
