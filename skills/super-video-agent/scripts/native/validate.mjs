// Validate the native render against the browser's out/picture.mp4.
//
// For each sampled frame index N: render it natively (seek(N/fps) -> PNG) and
// extract the same frame from out/picture.mp4, then compute SSIM between the
// two with ffmpeg. Reports per-frame and overall SSIM. Only a measured match
// counts — no green fps stands in for a wrong-looking frame.
//
// usage: validate.mjs <reel-dir> [--samples N] [--from SEC] [--to SEC] [--out DIR]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReel } from "./reel-host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const reelDir = process.argv[2];
if (!reelDir || reelDir.startsWith("--")) throw new Error("usage: validate.mjs <reel-dir> [--samples N] [--from SEC] [--to SEC] [--out DIR]");
const samples = Number(arg("--samples", "40"));
const fromSec = arg("--from", null);
const toSec = arg("--to", null);
const outDir = arg("--out", path.join(here, "out", "validate"));

const refMp4 = path.join(reelDir, "out", "picture.mp4");
if (!fs.existsSync(refMp4)) throw new Error(`no reference at ${refMp4}`);
fs.mkdirSync(outDir, { recursive: true });

// Reference frame count (packets) and the native clock.
function ffprobeFrames(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

/** Extract frame index N from `file` to `pngPath` (input seek for speed, exact PTS for CFR). */
function extractRefFrame(file, n, fps, pngPath) {
  const t = (n + 0.0) / fps;
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-ss", t.toFixed(6), "-i", file, "-frames:v", "1", "-pix_fmt", "rgb24", pngPath],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg extract frame ${n}: ${r.stderr}`);
}

/** SSIM "All" between two images (ffmpeg ssim filter). */
function ssim(a, b) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", a, "-i", b, "-lavfi", "ssim=stats_file=-", "-f", "null", "-"], { encoding: "utf8" });
  // ssim prints "... All:0.987654 (18.2)" to stderr; stats_file=- writes per-frame to stdout.
  const txt = (r.stderr || "") + (r.stdout || "");
  const m = txt.match(/All:([0-9.]+)/);
  return m ? Number(m[1]) : NaN;
}

const h = await loadReel(reelDir);
const refFrames = ffprobeFrames(refMp4);
const nativeFrames = Math.round(h.duration * h.fps);
console.log(`native clock: ${h.width}x${h.height} ${h.fps}fps dur=${h.duration.toFixed(3)} frames=${nativeFrames}; reference picture.mp4 frames=${refFrames}`);

const lo = fromSec != null ? Math.round(Number(fromSec) * h.fps) : 1;
const hi = toSec != null ? Math.round(Number(toSec) * h.fps) : Math.min(nativeFrames, refFrames) - 1;
const span = hi - lo;
const idxs = [];
for (let k = 0; k < samples; k++) idxs.push(lo + Math.round((span * k) / (samples - 1)));

const rows = [];
for (const n of idxs) {
  await h.seek(n / h.fps);
  const nativePng = path.join(outDir, `n-${n}.png`);
  fs.writeFileSync(nativePng, h.capture("png"));
  const refPng = path.join(outDir, `r-${n}.png`);
  extractRefFrame(refMp4, n, h.fps, refPng);
  const s = ssim(nativePng, refPng);
  rows.push({ n, t: n / h.fps, ssim: s });
  console.log(`frame ${String(n).padStart(6)} t=${(n / h.fps).toFixed(2).padStart(7)}s  SSIM=${s.toFixed(5)}`);
}
h.dispose();

const vals = rows.map((r) => r.ssim).filter((v) => Number.isFinite(v));
const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
const sorted = [...vals].sort((a, b) => a - b);
const worst = rows.filter((r) => Number.isFinite(r.ssim)).sort((a, b) => a.ssim - b.ssim).slice(0, 8);
console.log(`\nSSIM over ${vals.length} frames: mean=${mean.toFixed(5)} min=${sorted[0].toFixed(5)} p10=${sorted[Math.floor(vals.length * 0.1)].toFixed(5)} median=${sorted[Math.floor(vals.length / 2)].toFixed(5)}`);
console.log("worst frames:", worst.map((r) => `${r.n}@${r.t.toFixed(1)}s=${r.ssim.toFixed(4)}`).join(", "));
fs.writeFileSync(path.join(outDir, "ssim.json"), JSON.stringify({ reelDir, mean, rows }, null, 2));
console.log("rows written to", path.join(outDir, "ssim.json"));
