#!/usr/bin/env node
// Native 2D POC: skia-canvas -> raw RGBA -> ffmpeg stdin. No browser.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";

const here = path.dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30, N = 300;
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "native-2d.mp4");

export function drawFrame(ctx, t, i) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `hsl(${(210 + t * 20) % 360},70%,18%)`);
  g.addColorStop(1, `hsl(${(280 + t * 20) % 360},70%,30%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let k = 0; k < 12; k++) {
    const a = t * (0.6 + k * 0.11) + k;
    const x = W / 2 + Math.cos(a) * (200 + k * 55);
    const y = H / 2 + Math.sin(a * 1.3) * (120 + k * 30);
    const r = 40 + 25 * Math.sin(t * 2 + k) + k * 4;
    ctx.fillStyle = `hsla(${(k * 30 + t * 40) % 360},85%,60%,0.75)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 4;
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(W / 2, 160);
  ctx.scale(1 + 0.06 * Math.sin(t * 3), 1 + 0.06 * Math.sin(t * 3));
  ctx.fillStyle = "#fff";
  ctx.font = "bold 120px Helvetica";
  ctx.textAlign = "center";
  ctx.fillText("Super Video Agent", 0, 0);
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "48px Helvetica";
  ctx.textAlign = "left";
  ctx.fillText(`native 2D  frame ${i}  t=${t.toFixed(2)}s`, 60, H - 60);
}

const canvas = new Canvas(W, H);
const ctx = canvas.getContext("2d");
const ff = spawn("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${W}x${H}`, "-framerate", String(FPS), "-i", "-", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-y", outFile], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((res) => ff.on("close", res));

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  drawFrame(ctx, i / FPS, i);
  const buf = canvas.toBufferSync("raw");
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
}
ff.stdin.end();
await done;
const el = (performance.now() - t0) / 1000;
console.log(`2D-NATIVE fps=${(N / el).toFixed(1)} elapsed=${el.toFixed(2)}s lib=skia-canvas out=${outFile}`);
