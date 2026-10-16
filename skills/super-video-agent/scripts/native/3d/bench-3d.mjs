// Measure native 3D render throughput (fps) and save frames at several timestamps
// for SSIM vs the browser reference. Renders a continuous span in one scene.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReel3D } from "../reel-host-3d.mjs";

process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e && e.stack ? e.stack : e); process.exit(1); });

const here = path.dirname(fileURLToPath(import.meta.url));
const reelDir = process.argv[2] || "/Users/taehyoungkim/Documents/DEV/ww-w-ai/codereel-workspace/samples/day04-foldable-iphone/reel";
const startT = Number(process.argv[3] ?? 0.5);
const nFrames = Number(process.argv[4] ?? 60);

const h = await loadReel3D(reelDir);
const fps = h.fps;
console.log(`loaded ${h.width}x${h.height}@${fps}, duration ${h.duration.toFixed(1)}s`);

const outDir = path.join(here, "..", "out", "bench3d");
fs.mkdirSync(outDir, { recursive: true });

await h.seek(startT); // warm
const saveAt = new Set([0, Math.floor(nFrames / 2), nFrames - 1]);
const t0 = Date.now();
for (let i = 0; i < nFrames; i++) {
  const t = startT + i / fps;
  await h.seek(t);
  if (saveAt.has(i)) fs.writeFileSync(path.join(outDir, `t_${t.toFixed(3)}.png`), h.capturePng());
}
const dt = (Date.now() - t0) / 1000;
console.log(`rendered ${nFrames} frames in ${dt.toFixed(2)}s -> ${(nFrames / dt).toFixed(1)} fps (render+composite+png-encode)`);
console.log(`saved frames at t=${[...saveAt].map((i) => (startT + i / fps).toFixed(3)).join(", ")}s to ${outDir}`);
process.exit(0);
