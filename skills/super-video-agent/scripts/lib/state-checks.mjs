// Pure checks over per-frame page state (state-checks.mjs collects it): text boxes that overlap,
// glyphs drawn by a fallback font, and elements visible for a single frame. No browser here, so
// the logic is unit-tested on plain data. Facts only; nothing here fails a reel.
import { overlapSpans } from "./overlap.mjs";

/** A text drawn with canvas alpha under this counts as not visible. */
export const VISIBLE_ALPHA = 0.05;
/** Two text boxes overlap when the shared area is at least this share of the smaller box... */
export const OVERLAP_MIN_SHARE = 0.1;
/** ...and at least this many px². Anti-aliasing slivers between touching lines stay out. */
export const OVERLAP_MIN_AREA_PX = 16;
/** An element visible for fewer sampled frames than this, with neither neighbour visible, is a flicker. */
export const FLICKER_MAX_FRAMES = 2;

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif",
  "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

/**
 * The family list of a canvas font string ("bold 40px/1.2 \"JetBrains Mono\", monospace"), generic
 * families dropped. Empty when only generic families are named.
 */
export function namedFamilies(font) {
  const m = /(?:^|\s)\d*\.?\d+(?:px|pt|em|rem|%|vw|vh)(?:\/\S+)?\s+(.+)$/.exec(String(font).trim());
  const list = m ? m[1] : "";
  return list.split(",").map((f) => f.trim()).filter((f) => f && !GENERIC_FAMILIES.has(f.replace(/^["']|["']$/g, "").toLowerCase()));
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Text pairs whose boxes overlap in one frame, as overlap.mjs-style entries {pair, count} with
 * count = shared area in px² (0 for a pair that is on screen and clear, so spans can close).
 * Two texts with the same string are one element drawn twice (shadow, outline) and are skipped.
 * @param {{text:string, box:number[], alpha:number}[]} texts
 */
export function textOverlaps(texts) {
  const live = texts.filter((t) => t.alpha >= VISIBLE_ALPHA && area(t.box) > 0);
  const out = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.text === b.text) continue;
      const w = Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]);
      const h = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);
      const shared = w > 0 && h > 0 ? w * h : 0;
      const hit = shared >= OVERLAP_MIN_AREA_PX && shared >= OVERLAP_MIN_SHARE * Math.min(area(a.box), area(b.box));
      const pair = [clip(a.text), clip(b.text)].sort().join(" / ");
      out.push({ pair, count: hit ? Math.round(shared) : 0 });
    }
  }
  return out;
}

/** Spans of frames per overlapping text pair (overlap.mjs's span merge, count = px² shared). */
export function textOverlapSpans(frames, { fps, step }) {
  const samples = frames.map((f) => ({ frame: f.frame, pairs: textOverlaps(f.texts) }));
  const byPair = overlapSpans(samples, { fps, step });
  for (const k of Object.keys(byPair)) if (!byPair[k].spans.length) delete byPair[k];
  return byPair;
}

/**
 * Elements visible in one sampled frame only. Neither neighbour (previous and next sampled
 * frame) may show the element, so the first and last sampled frames are never reported.
 * @param {{frame:number, keys:string[]}[]} frames visible element keys per sampled frame, in order
 * @returns {{key:string, frame:number, t:number, frames:number}[]}
 */
export function findFlicker(frames, { fps }) {
  const keys = new Set(frames.flatMap((f) => f.keys));
  const sets = frames.map((f) => new Set(f.keys));
  const out = [];
  for (const key of keys) {
    let i = 0;
    while (i < frames.length) {
      if (!sets[i].has(key)) { i++; continue; }
      let j = i;
      while (j < frames.length && sets[j].has(key)) j++;
      const run = j - i;
      if (run < FLICKER_MAX_FRAMES && i > 0 && j < frames.length) {
        out.push({ key, frame: frames[i].frame, t: Math.round((frames[i].frame / fps) * 1000) / 1000, frames: run });
      }
      i = j;
    }
  }
  return out.sort((a, b) => a.frame - b.frame || a.key.localeCompare(b.key));
}

/** The element keys visible in one frame: drawn texts (alpha enough) and hook-reported layers. */
export function visibleKeys(frame) {
  const keys = new Set();
  for (const t of frame.texts) if (t.alpha >= VISIBLE_ALPHA && t.text.trim()) keys.add(`text "${clip(t.text)}"`);
  for (const e of frame.layers || []) if (e.opacity === undefined || e.opacity >= VISIBLE_ALPHA) keys.add(`layer ${e.id}`);
  return [...keys];
}

/**
 * Characters drawn by a fallback font. `covered(families, char)` answers whether any named family
 * of the font has the glyph (true), has not (false), or cannot be told (null: only generic families).
 * @param {{frame:number, texts:{text:string, font:string, alpha:number}[]}[]} frames
 * @param {(families:string, char:string)=>boolean|null} covered
 */
export function glyphFallbacks(frames, covered, { fps }) {
  const found = new Map();
  const unchecked = new Map();
  const checked = new Map(); // families -> every character drawn with them
  for (const f of frames) {
    for (const t of f.texts) {
      if (t.alpha < VISIBLE_ALPHA) continue;
      const families = namedFamilies(t.font).join(", ");
      if (!families) {
        const u = unchecked.get(t.font) || { font: t.font, frames: 0 };
        u.frames++;
        unchecked.set(t.font, u);
        continue;
      }
      for (const ch of new Set(Array.from(t.text))) {
        if (/[\p{Z}\p{C}]/u.test(ch)) continue;
        const ok = covered(families, ch);
        (checked.get(families) || checked.set(families, new Set()).get(families)).add(ch);
        if (ok === null || ok) continue;
        const key = `${families}\u0000${ch}`;
        const e = found.get(key) || { families, char: ch,
          codepoint: "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"),
          strings: new Set(), firstFrame: f.frame, lastFrame: f.frame, frames: 0 };
        e.strings.add(clip(t.text));
        e.lastFrame = f.frame;
        e.frames++;
        found.set(key, e);
      }
    }
  }
  const sec = (x) => Math.round((x / fps) * 1000) / 1000;
  // A family with none of the characters drawn with it is not loaded (or not this script's font): one entry, not one per character.
  const missingFamilies = [];
  for (const [families, chars] of checked) {
    const mine = [...found.values()].filter((e) => e.families === families);
    if (chars.size >= 2 && mine.length === chars.size) {
      missingFamilies.push({ families, chars: chars.size, strings: [...new Set(mine.flatMap((e) => [...e.strings]))],
        firstAt: Math.min(...mine.map((e) => sec(e.firstFrame))), lastAt: Math.max(...mine.map((e) => sec(e.lastFrame))) });
      for (const e of mine) found.delete(`${families}\u0000${e.char}`);
    }
  }
  return {
    fallbacks: [...found.values()].map((e) => ({ families: e.families, char: e.char, codepoint: e.codepoint,
      strings: [...e.strings], firstAt: sec(e.firstFrame), lastAt: sec(e.lastFrame), frames: e.frames })),
    missingFamilies,
    uncheckedFonts: [...unchecked.values()],
  };
}

/** Printable report of the three checks; each section says what it covered. */
export function formatStateChecks({ overlaps, glyphs, flicker, sampledFrames, hooks }) {
  let s = `sampled ${sampledFrames} frames\n`;
  if (overlaps) {
    const names = Object.keys(overlaps).sort();
    s += names.length ? `text overlap: ${names.length} pair${names.length > 1 ? "s" : ""}\n` : "text overlap: none\n";
    for (const n of names) {
      const sp = overlaps[n].spans.map((x) => `${x.start.toFixed(3)}–${x.end.toFixed(3)} s (max ${x.maxCount} px² at ${x.maxAt.toFixed(3)} s)`);
      s += `  ${n}: ${sp.join("; ")}\n`;
    }
  }
  if (glyphs) {
    const total = glyphs.fallbacks.length + glyphs.missingFamilies.length;
    s += total ? `glyph fallback: ${glyphs.fallbacks.length} character${glyphs.fallbacks.length === 1 ? "" : "s"} and ${glyphs.missingFamilies.length} font famil${glyphs.missingFamilies.length === 1 ? "y" : "ies"} drawn by a fallback font\n` : "glyph fallback: none\n";
    for (const m of glyphs.missingFamilies) {
      s += `  none of the ${m.chars} characters drawn with ${m.families} are in it (font not loaded?): ${m.firstAt.toFixed(3)}–${m.lastAt.toFixed(3)} s, in ${m.strings.slice(0, 5).map((x) => `"${x}"`).join(", ")}\n`;
    }
    for (const g of glyphs.fallbacks) {
      s += `  ${g.codepoint} "${g.char}" not in ${g.families}: ${g.firstAt.toFixed(3)}–${g.lastAt.toFixed(3)} s, in ${g.strings.map((x) => `"${x}"`).join(", ")}\n`;
    }
    for (const u of glyphs.uncheckedFonts) s += `  not checked (generic family only): ${u.font}\n`;
  }
  if (flicker) {
    s += flicker.length ? `one-frame flicker: ${flicker.length}\n` : `one-frame flicker: none (${hooks ? "texts and layer hook" : "texts only; no window.__reel.visibleAt hook"})\n`;
    for (const f of flicker) s += `  ${f.t.toFixed(3)} s (frame ${f.frame}): ${f.key}\n`;
  }
  return s;
}
