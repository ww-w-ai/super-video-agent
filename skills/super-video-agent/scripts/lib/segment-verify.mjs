// Content check of a cached segment against the page: a probe hash only says the page draws what it drew
// when the hash was recorded, not that the frames in the segment mp4 are those frames. This decodes a
// few frames of the mp4 and compares them with the page's capture of the same frame, in greyscale at a
// small size (encoder noise stays under the per-pixel step; a different picture does not).
import { ffmpeg } from "./ffmpeg.mjs";
import { changedFraction } from "./frame-diff.mjs";

/** Share of pixels that may differ (by the frame-diff step) before the copied frame counts as another picture. */
export const COPY_MISMATCH_FRACTION = 0.03;
const COMPARE_WIDTH = 160;

/** Greyscale comparison size for a picture of `width` x `height`. */
export function compareSize(width, height) {
  const w = Math.min(COMPARE_WIDTH, width);
  return { w, h: Math.max(2, Math.round((w * height) / width / 2) * 2) };
}

/** Greyscale raw pixels of an encoded image (PNG/JPEG bytes), scaled to w x h. */
export async function grayFromImage(bytes, { w, h }) {
  const { stdout } = await ffmpeg(["-i", "pipe:0", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { input: bytes });
  return stdout;
}

/** Greyscale raw pixels of frame `index` (0-based, decode order) of `mp4`, scaled to w x h. */
export async function grayFromVideoFrame(mp4, index, { w, h }) {
  const { stdout } = await ffmpeg(["-i", mp4, "-map", "0:v:0", "-vf", `select=eq(n\\,${index}),scale=${w}:${h}:flags=area,format=gray`, "-fps_mode", "passthrough", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return stdout;
}

/**
 * Compares frames of a clip with images of what the page draws there.
 * @param {{mp4: string, items: {index: number, image: Buffer}[], width: number, height: number, maxFraction?: number}} args
 *   `index` is the frame's place in the clip; `image` the page's capture of the frame that should sit there
 * @returns {Promise<{index: number, fraction: number}[]>} the frames that differ; empty when the clip holds what the page draws
 */
export async function clipVersusPage({ mp4, items, width, height, maxFraction = COPY_MISMATCH_FRACTION }) {
  const size = compareSize(width, height);
  const bad = [];
  for (const { index, image } of items) {
    const [clip, page] = [await grayFromVideoFrame(mp4, index, size), await grayFromImage(image, size)];
    const fraction = changedFraction(clip, page);
    if (clip.length !== page.length || fraction > maxFraction) bad.push({ index, fraction: Number(fraction.toFixed(4)) });
  }
  return bad;
}
