// Builds a contact-sheet PNG (thumbnail grid with timestamp labels) from
// already-captured shot frame PNGs, drawn in a throwaway Chromium page so
// we get real canvas text rendering without depending on ffmpeg's
// (possibly freetype-less) drawtext filter.
//
// Frames are sent to the page and drawn one at a time (one page.evaluate
// per frame, downscaled straight into its cell): a full-size shot PNG is
// ~1080x1920 (~3MB), and passing 30+ of them as base64 data URLs in a
// single page.evaluate hangs Chromium. Streaming keeps page memory
// bounded regardless of how many frames there are.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pwEntry = path.join(here, "..", "..", "node_modules", "playwright-core", "index.mjs");

let chromiumMod = null;
async function getChromium() {
  if (!chromiumMod) chromiumMod = (await import(pwEntry)).chromium;
  return chromiumMod;
}

/**
 * @param {{png: Buffer, label: string}[]} frames
 * @param {{cellWidth?: number, cols?: number}} [opts]
 * @returns {Promise<Buffer>} contact sheet PNG bytes
 */
export async function buildContactSheet(frames, opts = {}) {
  const cellWidth = opts.cellWidth || 220;
  const cols = opts.cols || Math.min(4, frames.length) || 1;
  const rows = Math.ceil(frames.length / cols);
  const labelH = 28;

  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><canvas id='sheet'></canvas>");

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const dataUrl = "data:image/png;base64," + f.png.toString("base64");
      await page.evaluate(
        async ({ dataUrl, label, i, cellWidth, cols, rows, labelH, isFirst }) => {
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = dataUrl;
          });
          const canvas = document.getElementById("sheet");
          const ctx = canvas.getContext("2d");
          if (isFirst) {
            const cellHeight =
              Math.round(cellWidth * ((img.naturalHeight / img.naturalWidth) || 16 / 9)) + labelH;
            canvas.width = cols * cellWidth;
            canvas.height = rows * cellHeight;
            canvas.dataset.cellHeight = String(cellHeight);
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          const cellHeight = Number(canvas.dataset.cellHeight);
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = col * cellWidth;
          const y = row * cellHeight;
          const imgH = cellHeight - labelH;
          ctx.drawImage(img, x, y, cellWidth, imgH);
          ctx.strokeStyle = "#ccc";
          ctx.strokeRect(x, y, cellWidth, imgH);
          ctx.fillStyle = "#111";
          ctx.font = "14px sans-serif";
          ctx.textBaseline = "top";
          ctx.fillText(label, x + 6, y + imgH + 4);
        },
        { dataUrl, label: f.label, i, cellWidth, cols, rows, labelH, isFirst: i === 0 }
      );
    }

    const outDataUrl = await page.evaluate(() =>
      document.getElementById("sheet").toDataURL("image/png")
    );
    return Buffer.from(outDataUrl.slice(outDataUrl.indexOf(",") + 1), "base64");
  } finally {
    await browser.close();
  }
}
