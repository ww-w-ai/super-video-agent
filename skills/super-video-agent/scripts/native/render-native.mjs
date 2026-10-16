// Render an SVA 2D reel natively (no browser) to an mp4, using the project's own
// encoder pipeline (scripts/lib/ffmpeg.mjs spawnImagePipeEncoder) so the output
// is a drop-in for render.mjs's out/picture.mp4 (same codec/crf/preset/gop). The
// only difference from the browser path is the draw surface: skia-canvas, not
// headless Chrome.
//
// usage: render-native.mjs <reel-dir> [--out FILE] [--from SEC] [--to SEC]
//        [--preview] [--captions]
//
// Writes to <this-dir>/out/<reel-name>-native[.span].mp4 by default. Never
// writes into the reel/sample dir.

import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReel } from "./reel-host.mjs";
import { spawnImagePipeEncoder } from "../lib/ffmpeg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(name);
}

const reelDir = process.argv[2];
if (!reelDir || reelDir.startsWith("--")) throw new Error("usage: render-native.mjs <reel-dir> [--out FILE] [--from SEC] [--to SEC] [--preview] [--captions]");
const preview = has("--preview");
const captions = has("--captions");
const fromSec = arg("--from", null);
const toSec = arg("--to", null);

const h = await loadReel(reelDir, { captions });
const fps = h.fps;
const totalFrames = Math.round(h.duration * fps);
const frameStart = fromSec != null ? Math.max(0, Math.round(Number(fromSec) * fps)) : 0;
const frameEnd = toSec != null ? Math.min(totalFrames, Math.round(Number(toSec) * fps)) : totalFrames;

const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const name = path.basename(path.resolve(reelDir, ".."));
const span = fromSec != null || toSec != null ? `.${frameStart}-${frameEnd}` : "";
const outFile = arg("--out", path.join(outDir, `${name}-native${span}${preview ? ".preview" : ""}.mp4`));

const crf = preview ? 28 : 18;
const preset = preview ? "veryfast" : "medium";
const { proc, done } = spawnImagePipeEncoder({ fps, outPath: outFile, crf, preset, width: h.width, height: h.height });
done.catch(() => {});

const t0 = performance.now();
let drawMs = 0;
for (let frame = frameStart; frame < frameEnd; frame++) {
  const ta = performance.now();
  await h.seek(frame / fps);
  const png = h.capture("png");
  drawMs += performance.now() - ta;
  if (!proc.stdin.write(png)) await once(proc.stdin, "drain");
  if ((frame - frameStart) % 300 === 0) process.stdout.write(`  frame ${frame}/${frameEnd}\r`);
}
proc.stdin.end();
await done;
h.dispose();

const elapsed = (performance.now() - t0) / 1000;
const n = frameEnd - frameStart;
console.log(`\nnative render: ${n} frames ${h.width}x${h.height} @${fps}fps -> ${outFile}`);
console.log(`draw-only: ${(n / (drawMs / 1000)).toFixed(1)} fps; draw+encode: ${(n / elapsed).toFixed(1)} fps; elapsed ${elapsed.toFixed(1)}s`);
