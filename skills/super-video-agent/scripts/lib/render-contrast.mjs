// Caption contrast for a voice-first film's own render (render.mjs with captions on). The engine tags its
// caption-layer draws, so for the few frames sampled per line the page seeks that instant once more with the
// text probe armed: each caption draw comes back with its colour and backing, and lib/text-contrast.mjs
// grades it (pair = text vs its own opaque box; picture = text vs the pixels under its box, read before the
// text was drawn). An engine that does not tag its draws falls back to the older measure: the same instant
// drawn with captions off, the pixels that differ taken as the caption. No screenshots either way.
// A graded result is reported, never a stop: any failure here is printed and the render goes on.
import { sampleTimesForLines, analyzeCaptionFrame, readPngPixels, layerFromDifference, formatContrastReport } from "./caption-contrast.mjs";
import { contrastFindings, formatContrastFindings } from "./text-contrast.mjs";
import { installTextProbe, probeSeek } from "./page-probe.mjs";
import { VISIBLE_ALPHA } from "./state-checks.mjs";
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
  return { frames: planContrastSamples(lines, fps), rows: [], states: [], mode: null, width, height, fps, unsupported: false };
}

/** "records" when the page's engine tags its caption draws (Reel.drawRoles), else "pixels". */
async function contrastMode(page) {
  return (await page.evaluate(() => !!(window.Reel && window.Reel.drawRoles))) ? "records" : "pixels";
}

/** The caption draws of instant `t`, from one armed probe seek. */
async function recordCaptionDraws(collector, { page, frame, t, lineId }) {
  await installTextProbe(page, { pixels: true, paused: true });
  const texts = await probeSeek(page, t);
  collector.states.push({ frame, t, lineId, texts: texts.filter((r) => r.role === "caption") });
}

/**
 * The caption draws at every contrast sample frame of an already open page (dub's caption layer), for
 * measureCaptionContrast({records}). One armed seek per sampled frame, no capture. Returns null when the
 * engine does not tag its draws or nothing was recorded, so the caller keeps the pixel path. A frame whose
 * seek drew no caption text is left out of the map: that frame is measured from pixels. Never throws.
 * @param {{page:object, lines:{id:string,start:number,end:number}[], fps:number, probe?:{install:Function, seek:Function}}} o
 *   probe: the page-probe functions, injectable for tests
 * @returns {Promise<Map<number, object[]>|null>}
 */
export async function captionRecordsAtSamples({ page, lines, fps, probe = { install: installTextProbe, seek: probeSeek } }) {
  try {
    if ((await contrastMode(page)) !== "records") return null;
    await probe.install(page, { paused: true });
    const records = new Map();
    for (const s of sampleTimesForLines(lines || [], fps)) {
      const drawn = (await probe.seek(page, s.t)).filter((r) => r.role === "caption");
      if (drawn.length) records.set(s.frame, drawn);
    }
    return records.size ? records : null;
  } catch {
    return null;
  }
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

/** The older measure for an engine without tagged draws: with/without-caption pixel difference. */
async function measureByDifference(collector, { page, t, lineId, withPng, capture }) {
  if (!withPng) withPng = await capture(page);
  const withoutPng = await captureWithoutCaptions(page, t, capture);
  if (!withoutPng) {
    collector.unsupported = true;
    return;
  }
  const { width, height } = collector;
  const [withPx, withoutPx] = await Promise.all([readPngPixels(withPng, width, height), readPngPixels(withoutPng, width, height)]);
  const found = analyzeCaptionFrame({ caption: layerFromDifference(withPx, withoutPx), picture: withoutPx, width, height });
  collector.rows.push({ lineId, t, ...(found || { grade: "no-caption" }) });
}

/**
 * Measures one frame the encoder just drew (a sampled frame only). `withPng` (that frame, or null when
 * the encoder took raw pixels: it is then captured again) and `capture` are used only by the fallback
 * for an engine that does not tag its caption draws. Never throws.
 */
export async function measureDrawnFrame(collector, { page, frame, withPng, capture }) {
  const sample = collector.frames.get(frame);
  if (!sample || collector.unsupported) return;
  const t = frame / collector.fps;
  try {
    if (!collector.mode) collector.mode = await contrastMode(page);
    if (collector.mode === "records") await recordCaptionDraws(collector, { page, frame, t, lineId: sample.lineId });
    else await measureByDifference(collector, { page, t, lineId: sample.lineId, withPng, capture });
  } catch (e) {
    collector.rows.push({ lineId: sample.lineId, t, grade: "unmeasured", error: String(e.message || e).split("\n")[0] });
  }
}

const save = (outPath, data) => {
  try {
    writeJson(outPath, data);
  } catch (e) {
    process.stdout.write(`caption contrast: rows not saved (${String(e.message).split("\n")[0]})\n`);
  }
};

/**
 * Prints the measured contrast (flagged findings one by one, then a count) and saves it to `outPath`.
 * Facts and grades: whether a low ratio matters is the reader's call, so this never stops the render.
 */
export function reportRenderContrast(collector, outPath) {
  if (collector.unsupported) {
    process.stdout.write("caption contrast: not measured (this page's engine has no Reel.setCaptionsOn; update the film to the current engine, then rerun only this check)\n");
    return;
  }
  if (collector.mode !== "records") {
    save(outPath, { method: "difference", rows: collector.rows });
    process.stdout.write(formatContrastReport(collector.rows));
    return;
  }
  const findings = contrastFindings(collector.states, { fps: collector.fps, minAlpha: VISIBLE_ALPHA });
  save(outPath, { method: "records", findings, errors: collector.rows });
  process.stdout.write(formatContrastFindings(findings, { title: "caption contrast" }));
  for (const r of collector.rows) process.stdout.write(`  ${r.lineId} t=${r.t.toFixed(2)}s not measured (${r.error})\n`);
}
