#!/usr/bin/env node
// Compare a render with a reference photo, for shaping a 3D model against photos (references/photo-to-3d.md).
//   overlay:    ref | render | 50 % blend side by side, all at the reference's size, with guide lines at 1/4, 1/2, 3/4 height
//   centreline: a dashed vertical line on a front render, to judge left-right symmetry by eye
// Origin: ww-w-kids Sejong statue head (2026-10-27), EV-37. Reports only; writes one PNG.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";
import { isMain } from "./lib/is-main.mjs";
import { getChromium } from "./lib/playwright.mjs";

const HELP = `usage: mesh-overlay.mjs overlay <ref.png|jpg> <render.png> <out.png> [--alpha 0.5]
       mesh-overlay.mjs centreline <front.png> <out.png> [--x 0.5]

overlay     the reference, the render and the render blended over the reference
            (--alpha, default 0.5), side by side at the reference's size, with red
            guide lines at 1/4, 1/2 and 3/4 of the height. Render the model with the
            same framing as the photo first (an orthographic view in
            scripts/blender/render-mesh.py, name:az:el:O:cx:cy:width:height).
centreline  a dashed red vertical line at --x (fraction of the width, default
            0.5) on a front render whose camera is centred on the mirror plane.
            Light the render from the centre plane, or the lighting itself reads
            as asymmetry.
`;

const dataUri = (file) => {
  const ext = path.extname(file).toLowerCase();
  const type = ext === ".png" ? "png" : ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext === ".webp" ? "webp" : null;
  if (!type) throw new Error(`${file}: not a PNG, JPEG or WebP image`);
  return `data:image/${type};base64,` + fs.readFileSync(file).toString("base64");
};

/** Parse and check the arguments; returns {mode, inputs, out, value} or throws with a message. */
export function parseOverlayArgs(argv) {
  const { positional, flags } = parseArgs(argv);
  const [mode, ...rest] = positional;
  if (mode === "overlay") {
    if (rest.length !== 3) throw new Error("overlay needs <ref> <render> <out.png>");
    const alpha = flags.alpha === undefined ? 0.5 : Number(flags.alpha);
    if (!(alpha >= 0 && alpha <= 1)) throw new Error("--alpha must be between 0 and 1");
    return { mode, inputs: rest.slice(0, 2).map(abs), out: abs(rest[2]), value: alpha };
  }
  if (mode === "centreline" || mode === "centerline") {
    if (rest.length !== 2) throw new Error("centreline needs <front.png> <out.png>");
    const x = flags.x === undefined ? 0.5 : Number(flags.x);
    if (!(x > 0 && x < 1)) throw new Error("--x must be between 0 and 1");
    return { mode: "centreline", inputs: [abs(rest[0])], out: abs(rest[1]), value: x };
  }
  throw new Error(`unknown mode ${mode === undefined ? "(none)" : JSON.stringify(mode)}: use overlay or centreline`);
}

async function draw(job) {
  for (const f of job.inputs) if (!fs.existsSync(f)) throw new Error(`${f}: not found`);
  const uris = job.inputs.map(dataUri);
  const chromium = await getChromium();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = await page.evaluate(async ([mode, srcs, v]) => {
      const load = async (s) => { const im = new Image(); im.src = s; await im.decode(); return im; };
      const imgs = await Promise.all(srcs.map(load));
      const c = document.createElement("canvas");
      const g = c.getContext("2d");
      if (mode === "overlay") {
        const [A, R] = imgs; const w = A.width, h = A.height;
        c.width = w * 3 + 8; c.height = h;
        g.fillStyle = "#222"; g.fillRect(0, 0, c.width, h);
        g.drawImage(A, 0, 0, w, h); g.drawImage(R, w + 4, 0, w, h);
        g.drawImage(A, 2 * w + 8, 0, w, h); g.globalAlpha = v; g.drawImage(R, 2 * w + 8, 0, w, h); g.globalAlpha = 1;
        g.strokeStyle = "rgba(255,0,0,0.6)";
        for (let k = 0; k < 3; k++) {
          const x0 = k * (w + 4);
          for (const fy of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(x0, h * fy); g.lineTo(x0 + w, h * fy); g.stroke(); }
        }
      } else {
        const [im] = imgs; c.width = im.width; c.height = im.height;
        g.drawImage(im, 0, 0); g.strokeStyle = "rgba(255,40,40,0.9)"; g.lineWidth = 2; g.setLineDash([12, 6]);
        const x = Math.round(im.width * v) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, im.height); g.stroke();
      }
      return c.toDataURL("image/png");
    }, [job.mode, uris, job.value]);
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    fs.writeFileSync(job.out, Buffer.from(url.split(",")[1], "base64"));
  } finally {
    await browser.close();
  }
}

export async function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help || flags.h || argv.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  let job;
  try {
    job = parseOverlayArgs(argv);
    await draw(job);
  } catch (e) {
    fail(e.message);
    return;
  }
  console.log("wrote", job.out);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
