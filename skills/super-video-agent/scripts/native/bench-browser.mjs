// Browser-path fps baseline on the SAME reel + same frames the native path
// measured, for an apples-to-apples comparison: seek(t) + canvas.toDataURL per
// frame (exactly what render.mjs's captureFrame does), warm-up skipped so it is
// pure per-frame draw+capture like the native loop.
//
// usage: bench-browser.mjs <reel-dir> <fromSec> <toSec>
import path from "node:path";
import { serveDir } from "../lib/server.mjs";
import { openReel, captureFrame } from "../lib/browser.mjs";
import { pictureUrl } from "../render.mjs";

const reelDir = process.argv[2];
const fromSec = Number(process.argv[3] || 80);
const toSec = Number(process.argv[4] || 100);

const server = await serveDir(reelDir);
try {
  const url = pictureUrl(server.url, true); // ?captions=0, picture (no lang)
  const session = await openReel(url, { width: 1920, height: 1080, warm: false });
  const fps = session.meta.fps;
  const f0 = Math.round(fromSec * fps);
  const f1 = Math.round(toSec * fps);
  // one untimed capture to settle first paint, then time the span
  await captureFrame(session.page, f0 / fps);
  const t0 = performance.now();
  for (let f = f0; f < f1; f++) await captureFrame(session.page, f / fps);
  const el = (performance.now() - t0) / 1000;
  const n = f1 - f0;
  console.log(`browser draw+capture: ${n} frames [${f0},${f1}) ${session.meta.width}x${session.meta.height}@${fps}fps -> ${(n / el).toFixed(1)} fps (${el.toFixed(1)}s)`);
  await session.close();
} finally {
  await server.close();
}
