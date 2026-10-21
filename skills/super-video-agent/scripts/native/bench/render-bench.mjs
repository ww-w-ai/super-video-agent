// Native 2D render bench on the pod: render a real reel through skia (CPU raster),
// then encode the SAME real frames CPU (libx264/265) vs NVENC (h264/hevc). Reports
// render fps and encode fps for each, so the GPU/NVENC win is measured on real content.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { loadReel } from "./reel-host.mjs";

const reelDir = "/root/kadap/MyDisk/rea-render";
const FR = "/root/kadap/MyDisk/renderframes";
const LOG = "/root/kadap/MyDisk/renderbench.log";
const N = Number(process.env.N || 150);
const log = (s) => { fs.appendFileSync(LOG, s + "\n"); };
fs.writeFileSync(LOG, "");

const t0 = Date.now();
const h = await loadReel(reelDir);
log(`loaded ${h.width}x${h.height}@${h.fps} dur=${Number(h.duration).toFixed(1)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

fs.mkdirSync(FR, { recursive: true });
const n = Math.min(N, Math.round(h.duration * h.fps));
const s = Date.now();
for (let i = 0; i < n; i++) {
  await h.seek(i / h.fps);
  fs.writeFileSync(`${FR}/${String(i + 1).padStart(5, "0")}.png`, h.canvas.toBufferSync("png"));
}
const rdt = (Date.now() - s) / 1000;
log(`RENDER skia-CPU-raster+png: ${n} frames ${rdt.toFixed(2)}s -> ${(n / rdt).toFixed(1)} fps`);

function enc(name, args) {
  const cmd = `cat ${FR}/*.png | ffmpeg -y -v error -f image2pipe -framerate ${h.fps} -i - ${args} /root/kadap/MyDisk/renc_${name}.mp4`;
  const es = Date.now();
  try { execSync(cmd, { shell: "/bin/bash" }); } catch (e) { log(`${name}: ENC_FAIL ${e.message}`); return; }
  const dt = (Date.now() - es) / 1000;
  const sz = fs.existsSync(`/root/kadap/MyDisk/renc_${name}.mp4`) ? fs.statSync(`/root/kadap/MyDisk/renc_${name}.mp4`).size : 0;
  log(`ENCODE ${name}: ${dt.toFixed(2)}s -> ${(n / dt).toFixed(1)} fps  size=${sz}`);
}
enc("cpu_h264", "-c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p");
enc("nvenc_h264", "-c:v h264_nvenc -preset p5 -cq 18 -pix_fmt yuv420p");
enc("cpu_hevc", "-c:v libx265 -crf 20 -preset medium -pix_fmt yuv420p -tag:v hvc1");
enc("nvenc_hevc", "-c:v hevc_nvenc -preset p5 -cq 20 -pix_fmt yuv420p -tag:v hvc1");
log("DONE");
process.exit(0);
