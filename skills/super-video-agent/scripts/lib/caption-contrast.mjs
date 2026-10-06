// Caption contrast, read from pixels already drawn: for sampled frames, the
// colour of the caption's drawn pixels against the picture behind its text
// box, as a WCAG contrast ratio. Both directions fall out of the same number
// (light text on a bright picture, dark text on a dark one). No screenshots:
// the caption layer's PNG (alpha) and the picture frame are decoded to raw
// pixels. A grade is a judgement — reported per line and time, never a stop.
import path from "node:path";
import fs from "node:fs";
import { ffmpeg } from "./ffmpeg.mjs";
import { checkedNothingNext } from "./checked-nothing.mjs";

export const CONTRAST_LOW = 3;
export const CONTRAST_MARGINAL = 4.5;
const SOLID_ALPHA = 200;
const SOFT_ALPHA = 64;
const CLEAR_ALPHA = 16;
const WORST_SHARE = 0.1;
const LIGHT_LUM = 0.18; // relative luminance of a mid grey: above it a colour reads as light
const TONE_BUCKETS = 16;
const SAMPLE_POSITIONS = [0.2, 0.5, 0.8];

const toLinear = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** WCAG relative luminance of an 8-bit sRGB colour (0 black .. 1 white). */
export function relLuminance(r, g, b) {
  return 0.2126 * toLinear[r] + 0.7152 * toLinear[g] + 0.0722 * toLinear[b];
}

/** WCAG contrast ratio of two relative luminances (1 .. 21). */
export function contrastRatio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** "low" under 3:1, "marginal" under 4.5:1, else "ok". */
export function gradeContrast(ratio) {
  if (ratio < CONTRAST_LOW) return "low";
  return ratio < CONTRAST_MARGINAL ? "marginal" : "ok";
}

/** "light on light", "dark on dark", "light on dark" or "dark on light". */
export function describeDirection(textLum, bgLum) {
  return `${textLum > LIGHT_LUM ? "light" : "dark"} on ${bgLum > LIGHT_LUM ? "light" : "dark"}`;
}

const CELL = 16; // px; drawn pixels are grouped on this grid to find separate texts
const REGION_GAP_SHARE = 0.04; // texts closer than this share of the frame height are one region (word and line gaps)

/** Alpha at or above which a pixel is text: solid when the layer has any, else soft. */
function textThreshold(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= SOLID_ALPHA) return SOLID_ALPHA;
  return SOFT_ALPHA;
}

/** Union-find over a flat array. */
function makeUnion(n) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  return { find, union: (a, b) => { parent[find(a)] = find(b); } };
}

/**
 * Separate texts of one layer frame (the caption, each corner note): text pixels are marked on a coarse grid
 * and cells within a line-gap of each other join. Returns regions with their tight boxes and a cell -> region map.
 */
function segmentRegions(rgba, width, height, threshold) {
  const cw = Math.ceil(width / CELL);
  const ch = Math.ceil(height / CELL);
  const marked = new Uint8Array(cw * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3] >= threshold) marked[Math.floor(y / CELL) * cw + Math.floor(x / CELL)] = 1;
  }
  const gap = Math.max(1, Math.ceil((height * REGION_GAP_SHARE) / CELL));
  const { find, union } = makeUnion(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      if (!marked[cy * cw + cx]) continue;
      for (let dy = 0; dy <= gap && cy + dy < ch; dy++) {
        for (let dx = dy === 0 ? 1 : -gap; dx <= gap; dx++) {
          const nx = cx + dx;
          if (nx >= 0 && nx < cw && marked[(cy + dy) * cw + nx]) union(cy * cw + cx, (cy + dy) * cw + nx);
        }
      }
    }
  }
  const ids = new Map();
  const cellRegion = new Int32Array(cw * ch).fill(-1);
  for (let c = 0; c < marked.length; c++) {
    if (!marked[c]) continue;
    const root = find(c);
    if (!ids.has(root)) ids.set(root, ids.size);
    cellRegion[c] = ids.get(root);
  }
  const boxes = Array.from({ length: ids.size }, () => [width, height, -1, -1]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < threshold) continue;
      const b = boxes[cellRegion[Math.floor(y / CELL) * cw + Math.floor(x / CELL)]];
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x + 1 > b[2]) b[2] = x + 1;
      if (y + 1 > b[3]) b[3] = y + 1;
    }
  }
  return { regions: boxes.map((box) => ({ box })), cellRegion, cw };
}

/** "caption" when the text sits around the middle of the frame, else "note" (corner notes hug a side). */
function regionKind(box, width) {
  const centre = (box[0] + box[2]) / 2;
  return Math.abs(centre - width / 2) <= width * 0.12 ? "caption" : "note";
}

/** The text's tones: its most common luminance bands (an outlined caption has two). `own(x, y)` limits it to one region. */
function textTones(rgba, width, box, threshold, own = () => true) {
  const bands = Array.from({ length: TONE_BUCKETS }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let y = box[1]; y < box[3]; y++) {
    for (let x = box[0]; x < box[2]; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < threshold || !own(x, y)) continue;
      const lum = relLuminance(rgba[i], rgba[i + 1], rgba[i + 2]);
      const band = bands[Math.min(TONE_BUCKETS - 1, Math.floor(Math.sqrt(lum) * TONE_BUCKETS))];
      band.n++;
      band.r += rgba[i];
      band.g += rgba[i + 1];
      band.b += rgba[i + 2];
      total++;
    }
  }
  return bands
    .filter((b) => b.n / total >= 0.2)
    .map((b) => {
      const color = [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)];
      return { color, lum: relLuminance(color[0], color[1], color[2]), share: b.n / total };
    })
    .sort((a, b) => b.share - a.share);
}

/** Whether a text pixel lies within 2 px of (x, y): the anti-aliased edge of a letter, not background. */
function nearText(rgba, width, height, x, y, threshold) {
  for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
    for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) if (rgba[(yy * width + xx) * 4 + 3] >= threshold) return true;
  }
  return false;
}

/**
 * Luminance histogram (256 bands) of what the viewer sees behind the text: inside the text box grown by a
 * quarter of its height (so a solid block of letters still has picture beside it). Clear pixels show the
 * picture; a semi-opaque pixel that is not a letter's edge (a note's panel, a shadow) is composited over the
 * picture, because that is the colour the text actually sits on. Text pixels (any region's) are left out.
 */
function backgroundHistogram(rgba, rgb, width, height, box, threshold) {
  const hist = new Float64Array(256);
  let n = 0;
  const pad = Math.max(4, Math.round((box[3] - box[1]) * 0.25));
  const x0 = Math.max(0, box[0] - pad);
  const x1 = Math.min(width, box[2] + pad);
  const y0 = Math.max(0, box[1] - pad);
  const y1 = Math.min(height, box[3] + pad);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a >= threshold || (a >= CLEAR_ALPHA && nearText(rgba, width, height, x, y, threshold))) continue;
      const j = (y * width + x) * 3;
      const w = a >= CLEAR_ALPHA ? a / 255 : 0;
      const r = Math.round(rgb[j] * (1 - w) + rgba[i] * w);
      const g = Math.round(rgb[j + 1] * (1 - w) + rgba[i + 1] * w);
      const b = Math.round(rgb[j + 2] * (1 - w) + rgba[i + 2] * w);
      hist[Math.round(Math.sqrt(relLuminance(r, g, b)) * 255)]++;
      n++;
    }
  }
  return { hist, n };
}

const bandLum = (band) => (band / 255) ** 2;

/** Luminance at the given share of the picture's pixels, darkest first. */
function histogramQuantile({ hist, n }, share) {
  let seen = 0;
  for (let b = 0; b < 256; b++) {
    seen += hist[b];
    if (seen >= n * share) return bandLum(b);
  }
  return 1;
}

/** The ratio that WORST_SHARE of the background pixels fall at or below, against one text luminance. */
function worstRatio({ hist, n }, textLum) {
  const ratios = [];
  for (let b = 0; b < 256; b++) if (hist[b]) ratios.push([contrastRatio(textLum, bandLum(b)), hist[b]]);
  ratios.sort((x, y) => x[0] - y[0]);
  let seen = 0;
  for (const [ratio, count] of ratios) {
    seen += count;
    if (seen >= n * WORST_SHARE) return ratio;
  }
  return ratios.length ? ratios[ratios.length - 1][0] : 21;
}

/** One text region measured on its own: its tones against the picture (with any panel) behind its box. */
function analyzeRegion({ caption, picture, width, height, threshold, box, own }) {
  const kind = regionKind(box, width);
  const tones = textTones(caption, width, box, threshold, own);
  const bg = backgroundHistogram(caption, picture, width, height, box, threshold);
  if (!tones.length || !bg.n) return { kind, box, tones, bgMedianLum: null, ratio: null, worstRatio: null, grade: "unmeasured", direction: null };
  const bgMedianLum = histogramQuantile(bg, 0.5);
  const best = tones.map((t) => ({ t, ratio: contrastRatio(t.lum, bgMedianLum) })).sort((a, b) => b.ratio - a.ratio)[0];
  const worst = Math.max(...tones.map((t) => worstRatio(bg, t.lum)));
  return {
    kind, box, tones, bgMedianLum, ratio: best.ratio, worstRatio: worst,
    grade: gradeContrast(best.ratio), direction: describeDirection(best.t.lum, bgMedianLum),
  };
}

/**
 * Contrast of one caption frame against the picture behind it. The caption and each corner note are separate
 * regions, measured one by one: a note's panel and its corner are not part of the caption's background.
 * @param {{caption: Uint8Array, picture: Uint8Array, width: number, height: number}} f caption = RGBA, picture = RGB, same size
 * @returns {null | {regions: object[], box:number[], tones:object[], bgMedianLum:number, ratio:number, worstRatio:number, grade:string, direction:string, kind:string}}
 *   null when the caption layer draws nothing here. Each region has {kind: "caption"|"note", box, tones, bgMedianLum,
 *   ratio, worstRatio, grade, direction}; `ratio` uses the median background and the text tone that reads best (an outlined
 *   caption has a fill and an outline tone); `worstRatio` the poorest tenth of the background. The top-level fields repeat
 *   the poorest region (lowest ratio), so a reader that looks at one row still sees the worst case.
 */
export function analyzeCaptionFrame({ caption, picture, width, height }) {
  const threshold = textThreshold(caption);
  const { regions, cellRegion, cw } = segmentRegions(caption, width, height, threshold);
  if (!regions.length) return null;
  const measured = regions.map((r, id) => analyzeRegion({
    caption, picture, width, height, threshold, box: r.box,
    own: (x, y) => cellRegion[Math.floor(y / CELL) * cw + Math.floor(x / CELL)] === id,
  }));
  const rank = (r) => (Number.isFinite(r.ratio) ? r.ratio : Infinity);
  const poorest = [...measured].sort((a, b) => rank(a) - rank(b))[0];
  return { ...poorest, regions: measured };
}

/** Up to three times inside each line (a line under 0.3 s: its middle), with their frames. */
export function sampleTimesForLines(lines, fps) {
  const out = [];
  for (const line of lines) {
    const dur = line.end - line.start;
    const positions = dur < 0.3 ? [0.5] : SAMPLE_POSITIONS;
    const seen = new Set();
    for (const p of positions) {
      const frame = Math.floor((line.start + dur * p) * fps);
      if (seen.has(frame)) continue;
      seen.add(frame);
      out.push({ lineId: line.id, t: frame / fps, frame });
    }
  }
  return out;
}

async function readRaw(args, input) {
  const { stdout } = await ffmpeg(args, input ? { input } : {});
  return stdout;
}

/** A caption PNG as raw RGBA at width x height. */
export function readCaptionPixels(pngPath, width, height) {
  return readRaw(["-i", pngPath, "-vf", `format=rgba,scale=${width}:${height}:flags=neighbor`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
}

/** A PNG held in memory (a captured canvas) as raw RGB at width x height. */
export function readPngPixels(png, width, height) {
  return readRaw(["-i", "pipe:0", "-vf", `scale=${width}:${height}:flags=neighbor`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], png);
}

const DIFF_TOLERANCE = 12; // summed channel difference at or below it is the same pixel (encoder or dither noise)

/**
 * The caption as an RGBA layer, from one frame drawn with the caption and the same instant drawn without it
 * (both RGB, same size). A pixel that differs is caption, opaque, in the colour it was drawn; the rest is clear.
 */
export function layerFromDifference(withCaption, without) {
  const n = withCaption.length / 3;
  const layer = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const j = p * 3;
    const d = Math.abs(withCaption[j] - without[j]) + Math.abs(withCaption[j + 1] - without[j + 1]) + Math.abs(withCaption[j + 2] - without[j + 2]);
    if (d <= DIFF_TOLERANCE) continue;
    layer.set([withCaption[j], withCaption[j + 1], withCaption[j + 2], 255], p * 4);
  }
  return layer;
}

/** One picture frame at second `t` as raw RGB at width x height. */
export function readPictureFrame(pictureMp4, t, width, height) {
  return readRaw(["-ss", String(t), "-i", pictureMp4, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}

/**
 * Measures every sampled caption frame of a language against its picture.
 * @param {{captionsDir: string, pictureMp4: string, lines: {id:string,start:number,end:number}[], fps: number, width: number, height: number, frameFile: (frame:number)=>string}} o
 * @returns {Promise<object[]>} one row per sample: {lineId, t, ...analysis} or {lineId, t, grade: "no-caption"}
 */
export async function measureCaptionContrast({ captionsDir, pictureMp4, lines, fps, width, height, frameFile }) {
  const rows = [];
  for (const s of sampleTimesForLines(lines, fps)) {
    const file = path.join(captionsDir, frameFile(s.frame));
    if (!fs.existsSync(file)) {
      rows.push({ lineId: s.lineId, t: s.t, grade: "no-caption" });
      continue;
    }
    const caption = await readCaptionPixels(file, width, height);
    const picture = await readPictureFrame(pictureMp4, s.t, width, height);
    const found = analyzeCaptionFrame({ caption, picture, width, height });
    rows.push({ lineId: s.lineId, t: s.t, ...(found || { grade: "no-caption" }) });
  }
  return rows;
}

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The rows as text: flagged rows one by one, then a count. Facts and grades; whether it matters is the reader's call. */
export function formatContrastReport(rows) {
  const measured = rows.filter((r) => Number.isFinite(r.ratio));
  if (!measured.length) return "caption contrast: checked nothing — no sampled frame has a drawn caption over a measurable picture. " + checkedNothingNext("a rendered segment that draws a caption (segments reused from the cache are not drawn again)") + "\n";
  const flagged = measured.filter((r) => r.grade !== "ok");
  const out = [`caption contrast (WCAG ratio, each text vs the picture behind its own box; low < ${CONTRAST_LOW}, marginal < ${CONTRAST_MARGINAL}): ${measured.length} frames measured, ${flagged.length} flagged`];
  for (const r of flagged) {
    for (const g of (r.regions || [r]).filter((x) => Number.isFinite(x.ratio) && x.grade !== "ok")) {
      out.push(
        `  ${r.lineId} t=${r.t.toFixed(2)}s ${g.grade.toUpperCase()} ${g.ratio.toFixed(2)}:1 (${g.kind || "caption"}, ${g.direction}; text ${hex(g.tones[0].color)}, ` +
          `picture median luminance ${g.bgMedianLum.toFixed(2)}, poorest tenth ${g.worstRatio.toFixed(2)}:1)`
      );
    }
  }
  return out.join("\n") + "\n";
}
