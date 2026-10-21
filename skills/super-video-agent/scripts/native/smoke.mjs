// Smoke test: load a reel, print meta, write a few sample frames as PNG.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReel } from "./reel-host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const reelDir = process.argv[2];
if (!reelDir) throw new Error("usage: smoke.mjs <reel-dir> [t1 t2 ...]");
const times = process.argv.slice(3).map(Number);

const h = await loadReel(reelDir);
console.log("meta:", JSON.stringify({ width: h.width, height: h.height, fps: h.fps, duration: h.duration, shots: h.meta.shots.length, layers: h.meta.layers }));

const outDir = path.join(here, "out", "smoke");
fs.mkdirSync(outDir, { recursive: true });
const ts = times.length ? times : [0, h.duration / 2, h.duration - 0.1];
for (const t of ts) {
  await h.seek(t);
  const png = h.capture("png");
  const f = path.join(outDir, `t-${t.toFixed(2)}.png`);
  fs.writeFileSync(f, png);
  console.log("wrote", f, png.length, "bytes");
}
h.dispose();
console.log("ok");
