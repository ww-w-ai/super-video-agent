// Smoke: load a real 3D reel through the native WebGPU host, build worlds, seek a
// few timestamps, save stage PNGs. Surfaces runtime errors before full validation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReel3D } from "../reel-host-3d.mjs";

process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION:\n", e && e.stack ? e.stack : e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:\n", e && e.stack ? e.stack : e); process.exit(1); });

const here = path.dirname(fileURLToPath(import.meta.url));
const reelDir = process.argv[2] || "/Users/taehyoungkim/Documents/DEV/ww-w-ai/codereel-workspace/samples/day04-foldable-iphone/reel";
const times = (process.argv[3] || "0.5").split(",").map(Number);

console.log("loading reel:", reelDir);
const t0 = Date.now();
const h = await loadReel3D(reelDir);
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${h.width}x${h.height}@${h.fps}, duration ${h.duration}s`);

const outDir = path.join(here, "..", "out", "smoke3d");
fs.mkdirSync(outDir, { recursive: true });
for (const t of times) {
  const s = Date.now();
  await h.seek(t);
  const png = h.capturePng();
  const out = path.join(outDir, `f_${String(t).replace(".", "_")}.png`);
  fs.writeFileSync(out, png);
  console.log(`seek ${t}s -> ${out} (${((Date.now() - s) / 1000).toFixed(2)}s, ${png.length} bytes)`);
}
process.exit(0);
