// Caption contrast for a voice-first film's own render (render.mjs with captions on). The picture and the
// caption are drawn into one canvas, so for the few frames sampled per line the page draws the same instant
// once more with captions off (window.Reel.setCaptionsOn(false)); the pixels that differ are the caption.
// The numeric WCAG ratio then comes from lib/caption-contrast.mjs, the same as dub.mjs. No screenshots.
// A graded result is reported, never a stop: any failure here is printed and the render goes on.
import { sampleTimesForLines, analyzeCaptionFrame, readPngPixels, layerFromDifference, formatContrastReport } from "./caption-contrast.mjs";
import { seekTo } from "./browser.mjs";
import { writeJson } from "./reeldir.mjs";

/**
 * @param {{id:string,start:number,end:number}[]} lines the film's timed lines (voice/timings.json)
 * @param {number} fps
 * @returns {Map<number, {lineId:string}>} frame -> sample; up to three frames inside each line
 */
export function planContrastSamples(lines, fps) {
  const frames = new Map();
  for (const s of sampleTimesForLines(lines || [], fps)) frames.set(s.frame, { lineId: s.lineId });
  return frames;
}

/** A collector the segment encoder fills while it draws frames. */
export function createContrastCollector({ lines, fps, width, height }) {
  return { frames: planContrastSamples(lines, fps), rows: [], width, height, fps, unsupported: false };
}

/** Draws the page's current instant `t` without captions, returning its PNG (null when the engine cannot hide them). */
async function captureWithoutCaptions(page, t, capture) {
  const hidden = await page.evaluate(() => {
    if (!window.Reel || typeof window.Reel.setCaptionsOn !== "function") return false;
    window.Reel.setCaptionsOn(false);
    return true;
  });
  if (!hidden) return null;
  try {
    await seekTo(page, t);
    return await capture(page);
  } finally {
    await page.evaluate(() => window.Reel.setCaptionsOn(true));
  }
}

/**
 * Measures one frame the encoder just drew. `withPng` is that frame (caption included).
 * Pushes a row onto collector.rows; never throws.
 */
export async function measureDrawnFrame(collector, { page, frame, withPng, capture }) {
  const sample = collector.frames.get(frame);
  if (!sample || collector.unsupported) return;
  const t = frame / collector.fps;
  try {
    const withoutPng = await captureWithoutCaptions(page, t, capture);
    if (!withoutPng) {
      collector.unsupported = true;
      return;
    }
    const { width, height } = collector;
    const [withPx, withoutPx] = await Promise.all([readPngPixels(withPng, width, height), readPngPixels(withoutPng, width, height)]);
    const found = analyzeCaptionFrame({ caption: layerFromDifference(withPx, withoutPx), picture: withoutPx, width, height });
    collector.rows.push({ lineId: sample.lineId, t, ...(found || { grade: "no-caption" }) });
  } catch (e) {
    collector.rows.push({ lineId: sample.lineId, t, grade: "unmeasured", error: String(e.message || e).split("\n")[0] });
  }
}

/**
 * Prints the measured rows (flagged ones one by one, then a count) and saves them to `outPath`.
 * Facts and grades: whether a low ratio matters is the reader's call, so this never stops the render.
 */
export function reportRenderContrast(collector, outPath) {
  if (collector.unsupported) {
    process.stdout.write("caption contrast: not measured (this page's engine has no Reel.setCaptionsOn; update the film to the current engine, then rerun only this check)\n");
    return;
  }
  try {
    writeJson(outPath, { rows: collector.rows });
  } catch (e) {
    process.stdout.write(`caption contrast: rows not saved (${String(e.message).split("\n")[0]})\n`);
  }
  process.stdout.write(formatContrastReport(collector.rows));
}
