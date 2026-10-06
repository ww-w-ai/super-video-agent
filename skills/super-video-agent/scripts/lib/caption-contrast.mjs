// Caption contrast, read from pixels already drawn: for sampled frames, the
// colour of the caption's drawn pixels against the picture behind its text
// box, as a WCAG contrast ratio. Both directions fall out of the same number
// (light text on a bright picture, dark text on a dark one). No screenshots:
// the caption layer's PNG (alpha) and the picture frame are decoded to raw
// pixels. A grade is a judgement — reported per line and time, never a stop.
import path from "node:path";
import fs from "node:fs";
import { ffmpeg } from "./ffmpeg.mjs";

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

/** The drawn pixels' bounding box and which of them are solid text. */
function drawnPixels(rgba, width, height) {
  let solidCount = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= SOLID_ALPHA) solidCount++;
  const threshold = solidCount ? SOLID_ALPHA : SOFT_ALPHA;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { box: [x0, y0, x1 + 1, y1 + 1], threshold };
}

/** The text's tones: its most common luminance bands (an outlined caption has two). */
function textTones(rgba, width, box, threshold) {
  const bands = Array.from({ length: TONE_BUCKETS }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let y = box[1]; y < box[3]; y++) {
    for (let x = box[0]; x < box[2]; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < threshold) continue;
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

/**
 * Luminance histogram (256 bands) of the picture around and between the text:
 * inside the text box grown by a quarter of its height (so a solid block of
 * letters still has picture beside it), wherever the caption leaves it visible.
 */
function backgroundHistogram(rgba, rgb, width, height, box) {
  const hist = new Float64Array(256);
  let n = 0;
  const pad = Math.max(4, Math.round((box[3] - box[1]) * 0.25));
  const x0 = Math.max(0, box[0] - pad);
  const x1 = Math.min(width, box[2] + pad);
  const y0 = Math.max(0, box[1] - pad);
  const y1 = Math.min(height, box[3] + pad);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= CLEAR_ALPHA) continue;
      const j = (y * width + x) * 3;
      hist[Math.round(Math.sqrt(relLuminance(rgb[j], rgb[j + 1], rgb[j + 2])) * 255)]++;
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

/**
 * Contrast of one caption frame against the picture behind it.
 * @param {{caption: Uint8Array, picture: Uint8Array, width: number, height: number}} f caption = RGBA, picture = RGB, same size
 * @returns {null | {box:number[], tones:object[], bgMedianLum:number, ratio:number, worstRatio:number, grade:string, direction:string}}
 *   null when the caption layer draws nothing here. `ratio` uses the median background and the text tone that
 *   reads best (an outlined caption has a fill and an outline tone); `worstRatio` the poorest tenth of the background.
 */
export function analyzeCaptionFrame({ caption, picture, width, height }) {
  const drawn = drawnPixels(caption, width, height);
  if (!drawn) return null;
  const tones = textTones(caption, width, drawn.box, drawn.threshold);
  const bg = backgroundHistogram(caption, picture, width, height, drawn.box);
  if (!tones.length || !bg.n) return { box: drawn.box, tones, bgMedianLum: null, ratio: null, worstRatio: null, grade: "unmeasured", direction: null };
  const bgMedianLum = histogramQuantile(bg, 0.5);
  const best = tones.map((t) => ({ t, ratio: contrastRatio(t.lum, bgMedianLum) })).sort((a, b) => b.ratio - a.ratio)[0];
  const worst = Math.max(...tones.map((t) => worstRatio(bg, t.lum)));
  return {
    box: drawn.box,
    tones,
    bgMedianLum,
    ratio: best.ratio,
    worstRatio: worst,
    grade: gradeContrast(best.ratio),
    direction: describeDirection(best.t.lum, bgMedianLum),
  };
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
  if (!measured.length) return "caption contrast: checked nothing — no sampled frame has a drawn caption over a measurable picture\n";
  const flagged = measured.filter((r) => r.grade !== "ok");
  const out = [`caption contrast (WCAG ratio, text vs the picture behind its box; low < ${CONTRAST_LOW}, marginal < ${CONTRAST_MARGINAL}): ${measured.length} frames measured, ${flagged.length} flagged`];
  for (const r of flagged) {
    out.push(
      `  ${r.lineId} t=${r.t.toFixed(2)}s ${r.grade.toUpperCase()} ${r.ratio.toFixed(2)}:1 (${r.direction}; text ${hex(r.tones[0].color)}, ` +
        `picture median luminance ${r.bgMedianLum.toFixed(2)}, poorest tenth ${r.worstRatio.toFixed(2)}:1)`
    );
  }
  return out.join("\n") + "\n";
}
