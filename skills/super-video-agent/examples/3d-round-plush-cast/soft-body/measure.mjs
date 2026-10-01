#!/usr/bin/env node
// EXAMPLE: samples window.__wobbleDebug.measure(t) (see wobble.js) every frame of the first
// 3 s at 30 fps, without rendering, and prints tracked-point pixel offsets from rest, the
// lowest stack vertex vs the plate, and fork clearance above the cake. Stills cannot show
// motion; these per-frame numbers are what the jiggle was judged by.
// Uses the skill's scripts/lib/server.mjs and scripts/lib/browser.mjs read-only.
// usage: node measure.mjs <reel-dir> <skill-dir> [--csv <out.csv>]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [reelDir, skillDir] = process.argv.slice(2);
const csvIdx = process.argv.indexOf("--csv");
const csvPath = csvIdx > 0 ? process.argv[csvIdx + 1] : null;
const { serveDir } = await import(pathToFileURL(path.join(skillDir, "scripts/lib/server.mjs")).href);
const { openReel } = await import(pathToFileURL(path.join(skillDir, "scripts/lib/browser.mjs")).href);

const server = await serveDir(reelDir);
const session = await openReel(server.url, {});
try {
  const fps = 30;
  const n = Math.round(3 * fps);
  const rows = [];
  for (let f = 0; f <= n; f++) {
    const t = f / fps;
    rows.push(await session.page.evaluate((tt) => window.__wobbleDebug.measure(tt), t));
  }
  const keys = Object.keys(rows[0].px);
  const d = (r, k, a) => r.px[k][a] - r.restPx[k][a];
  const lines = ["t," + keys.map((k) => `${k}_dx,${k}_dy`).join(",") + ",minAbovePlate,forkClearance,tipToSurface"];
  for (const r of rows) {
    const cells = keys.map((k) => `${d(r, k, 0).toFixed(1)},${d(r, k, 1).toFixed(1)}`);
    lines.push(
      [r.t.toFixed(3), ...cells, r.minAbovePlate.toFixed(5), r.forkClearance == null ? "" : r.forkClearance.toFixed(4), r.tipToSurface == null ? "" : r.tipToSurface.toFixed(5)].join(",")
    );
  }
  if (csvPath) fs.writeFileSync(csvPath, lines.join("\n") + "\n");
  // summary
  const after = rows.filter((r) => r.t >= 0.6);
  const range = (k, axis) => {
    const v = after.map((r) => d(r, k, axis));
    return [Math.min(...v).toFixed(1), Math.max(...v).toFixed(1)];
  };
  for (const k of keys) console.log(`${k}: dx ${range(k, 0).join("..")} px, dy ${range(k, 1).join("..")} px`);
  console.log("min stack height above plate:", Math.min(...rows.map((r) => r.minAbovePlate)).toFixed(5));
  const fc = rows.filter((r) => r.forkClearance != null);
  if (fc.length) {
    const worst = fc.reduce((a, b) => (b.forkClearance < a.forkClearance ? b : a));
    console.log(`fork clearance min ${worst.forkClearance.toFixed(4)} at t=${worst.t.toFixed(3)}`);
  }
  const tip = rows.filter((r) => r.tipToSurface != null).map((r) => r.tipToSurface);
  console.log("tip-to-surface during contact:", tip.map((v) => v.toFixed(5)).join(" "));
  // zero crossings of the top's lateral offset after the tap
  const top = after.map((r) => d(r, "topRight", 0));
  let cross = 0;
  const peaks = [];
  for (let i = 1; i < top.length - 1; i++) {
    if (Math.sign(top[i]) !== Math.sign(top[i - 1]) && top[i] !== 0) cross++;
    if (Math.abs(top[i]) >= Math.abs(top[i - 1]) && Math.abs(top[i]) > Math.abs(top[i + 1])) peaks.push(`${after[i].t.toFixed(2)}s:${top[i].toFixed(1)}`);
  }
  console.log("topRight dx zero crossings:", cross, "peaks:", peaks.join(" "));
  if (session.errors.length) console.log("page errors:", session.errors.join(" | "));
} finally {
  await session.close();
  await server.close();
}
