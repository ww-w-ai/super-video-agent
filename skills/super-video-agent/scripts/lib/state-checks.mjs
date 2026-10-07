// Pure checks over per-frame page state (state-checks.mjs collects it): text boxes that overlap,
// glyphs drawn by a fallback font, and elements visible for a single frame. No browser here, so
// the logic is unit-tested on plain data. Facts only; nothing here fails a reel.
import { overlapSpans } from "./overlap.mjs";
import { checkedNothingNext } from "./checked-nothing.mjs";

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
export function formatStateChecks({ overlaps, glyphs, flicker, sampledFrames, hooks, nothing, covers, coverScope, langGlyphs, reserve = null, reserveCorners = 0 }) {
  let s = `sampled ${sampledFrames} frames\n`;
  const skip = new Set((nothing || []).map((n) => n.check));
  if (overlaps) {
    const names = Object.keys(overlaps).sort();
    s += names.length ? `text overlap: ${names.length} pair${names.length > 1 ? "s" : ""}\n` : skip.has("text overlap") ? "" : "text overlap: none\n";
    for (const n of names) {
      const sp = overlaps[n].spans.map((x) => `${x.start.toFixed(3)}–${x.end.toFixed(3)} s (max ${x.maxCount} px² at ${x.maxAt.toFixed(3)} s)`);
      s += `  ${n}: ${sp.join("; ")}\n`;
    }
  }
  if (glyphs) {
    const total = glyphs.fallbacks.length + glyphs.missingFamilies.length;
    s += total ? `glyph fallback: ${glyphs.fallbacks.length} character${glyphs.fallbacks.length === 1 ? "" : "s"} and ${glyphs.missingFamilies.length} font famil${glyphs.missingFamilies.length === 1 ? "y" : "ies"} drawn by a fallback font\n` : skip.has("glyph fallback") ? "" : "glyph fallback: none\n";
    for (const m of glyphs.missingFamilies) {
      s += `  none of the ${m.chars} characters drawn with ${m.families} are in it (font not loaded?): ${m.firstAt.toFixed(3)}–${m.lastAt.toFixed(3)} s, in ${m.strings.slice(0, 5).map((x) => `"${x}"`).join(", ")}\n`;
    }
    for (const g of glyphs.fallbacks) {
      s += `  ${g.codepoint} "${g.char}" not in ${g.families}: ${g.firstAt.toFixed(3)}–${g.lastAt.toFixed(3)} s, in ${g.strings.map((x) => `"${x}"`).join(", ")}\n`;
    }
    for (const u of glyphs.uncheckedFonts) s += `  not checked (generic family only): ${u.font}\n`;
  }
  if (flicker) {
    s += flicker.length ? `one-frame flicker: ${flicker.length}\n` : skip.has("one-frame flicker") ? "" : `one-frame flicker: none (${hooks ? "texts and layer hook" : "texts only; no window.__reel.visibleAt hook"})\n`;
    for (const f of flicker) s += `  ${f.t.toFixed(3)} s (frame ${f.frame}): ${f.key}\n`;
  }
  for (const n of nothing || []) s += `${n.check}: checked nothing (${n.reason}). ${checkedNothingNext()}\n`;
  if (covers && covers.length) {
    s += `label or overlay over key content: ${covers.length}\n`;
    for (const c of covers) s += `  ${c.label} over ${c.key}: ${c.from.toFixed(3)}–${c.to.toFixed(3)} s, ${c.sharePx} px² (${Math.round(c.shareOfKey * 100)}% of the key area)${c.alwaysOn ? ", always on" : ""}\n`;
  }
  else if (covers && coverScope && !coverNothingReason(coverScope)) {
    s += `label or overlay over key content: checked ${coverScope.keys} key region${coverScope.keys === 1 ? "" : "s"} against ${coverScope.covering} label/overlay region${coverScope.covering === 1 ? "" : "s"}, 0 covered\n`;
  }
  s += formatReserve(reserve, reserveCorners);
  if (langGlyphs) s += formatLangGlyphs(langGlyphs);
  return s;
}

function formatReserve(reserve, corners) {
  if (!reserve) return "";
  if (reserve.length) {
    return `picture text inside a reserved corner: ${reserve.length}\n` +
      reserve.map((r) => `  "${r.text}" in ${r.reserve}: ${r.from.toFixed(3)}–${r.to.toFixed(3)} s (${r.frames} frame${r.frames === 1 ? "" : "s"}, up to ${r.sharePx} px²)\n`).join("");
  }
  return corners ? `picture text inside a reserved corner: checked ${corners} reserved corner${corners === 1 ? "" : "s"}, 0 intruders\n` : "";
}

/**
 * Checks that looked at nothing, so the report says "checked nothing" and never reads as a pass.
 * @param {{frames:{texts:object[]}[], checks:string[], hasLayerHook:boolean}} args
 * @returns {{check:string, reason:string}[]}
 */
export function checkedNothingReasons({ frames, checks, hasLayerHook }) {
  const out = [];
  if (checks.includes("overlap") && !frames.some((f) => f.texts.filter((t) => t.alpha >= VISIBLE_ALPHA).length >= 2)) {
    out.push({ check: "text overlap", reason: "no frame had two texts on screen" });
  }
  if (checks.includes("glyphs") && !frames.some((f) => f.texts.some((t) => t.alpha >= VISIBLE_ALPHA && t.text.trim()))) {
    out.push({ check: "glyph fallback", reason: `no text was drawn in any sampled frame (text drawn once at load into an offscreen canvas is not seen: call fillText during seek() on a canvas in the document)` });
  }
  if (checks.includes("flicker") && frames.length < FLICKER_MAX_FRAMES + 1) {
    out.push({ check: "one-frame flicker", reason: `only ${frames.length} sampled frame${frames.length === 1 ? "" : "s"}; a flicker needs a frame on each side` });
  } else if (checks.includes("flicker") && !hasLayerHook && !frames.some((f) => f.texts.length)) {
    out.push({ check: "one-frame flicker", reason: "no text drawn and no window.__reel.visibleAt hook" });
  }
  return out;
}

const box = (r) => {
  const pad = r.outline > 0 ? r.outline / 2 : 0;
  return [r.box[0] - pad, r.box[1] - pad, r.box[2] + pad, r.box[3] + pad];
};

const validRegions = (regions) => (regions || []).filter((r) => r && Array.isArray(r.box) && r.box.length === 4);

/** How many key regions and how many label/overlay regions the page declared (the two sides of the covers check). */
export function regionScope(regions) {
  const list = validRegions(regions);
  return { keys: list.filter((r) => r.kind === "key").length, covering: list.filter(isCovering).length };
}

/** A region that can cover key content: a label, an overlay, or a corner a persistent label reserves. */
const isCovering = (r) => r.kind === "label" || r.kind === "overlay" || r.kind === "reserve";

/** How many reserve regions (corner boxes kept clear) the page declared. */
export function reserveScope(regions) {
  return validRegions(regions).filter((r) => r.kind === "reserve").length;
}

/**
 * Picture text drawn inside a reserve region while that region is active: the text's box shares area with
 * the reserve box (at least OVERLAP_MIN_AREA_PX px² and OVERLAP_MIN_SHARE of the text box). The reserve's
 * own `text` (the label it holds) is not an intruder. Report only.
 * @param {{frame:number, texts:{text:string, box:number[], alpha:number}[]}[]} frames
 * @param {{id:string, kind:string, box:number[], text?:string, from?:number, to?:number}[]} regions
 * @param {{fps:number, duration:number}} args
 * @returns {{reserve:string, text:string, from:number, to:number, frames:number, sharePx:number}[]}
 */
export function reserveIntrusions(frames, regions, { fps, duration }) {
  const reserves = validRegions(regions).filter((r) => r.kind === "reserve");
  const found = new Map();
  for (const f of frames) {
    const t = f.frame / fps;
    for (const r of reserves) {
      if (t < (Number.isFinite(r.from) ? r.from : 0) || t >= (Number.isFinite(r.to) ? r.to : duration)) continue;
      for (const txt of f.texts) noteIntrusion(found, r, txt, f.frame);
    }
  }
  const sec = (x) => Math.round((x / fps) * 1000) / 1000;
  return [...found.values()].map((e) => ({ reserve: e.reserve, text: e.text, from: sec(e.first), to: sec(e.last + 1), frames: e.frames, sharePx: e.sharePx }));
}

function noteIntrusion(found, reserve, txt, frame) {
  if (txt.alpha < VISIBLE_ALPHA || !txt.text.trim() || txt.text === reserve.text || area(txt.box) <= 0) return;
  const w = Math.min(txt.box[2], reserve.box[2]) - Math.max(txt.box[0], reserve.box[0]);
  const h = Math.min(txt.box[3], reserve.box[3]) - Math.max(txt.box[1], reserve.box[1]);
  const shared = w > 0 && h > 0 ? w * h : 0;
  if (shared < OVERLAP_MIN_AREA_PX || shared < OVERLAP_MIN_SHARE * area(txt.box)) return;
  const key = `${reserve.id}\u0000${txt.text}`;
  const e = found.get(key) || { reserve: reserve.id, text: clip(txt.text), first: frame, last: frame, frames: 0, sharePx: 0 };
  e.last = frame;
  e.frames++;
  e.sharePx = Math.max(e.sharePx, Math.round(shared));
  found.set(key, e);
}

/** Why the covers check looked at nothing, or null when both sides were declared. */
export function coverNothingReason({ keys, covering }) {
  if (!keys && !covering) return "the page declares no regions (window.__reel.regions)";
  if (!keys) return "no key region declared";
  if (!covering) return "no label or overlay region declared";
  return null;
}

/**
 * Page-declared regions only (window.__reel.regions): every label or always-on overlay whose box
 * (grown by half its outline) shares area with a key region while both are on screen. Report only.
 * @param {{id:string, kind:"key"|"label"|"overlay", box:number[], outline?:number, from?:number, to?:number}[]} regions
 * @param {{duration:number}} args
 * @returns {{label:string, key:string, from:number, to:number, sharePx:number, shareOfKey:number, alwaysOn:boolean}[]}
 */
export function regionCovers(regions, { duration }) {
  const norm = (r) => ({ ...r, from: Number.isFinite(r.from) ? r.from : 0, to: Number.isFinite(r.to) ? r.to : duration });
  const list = validRegions(regions).map(norm);
  const keys = list.filter((r) => r.kind === "key");
  const out = [];
  for (const cover of list.filter(isCovering)) {
    const cb = box(cover);
    for (const key of keys) {
      const from = Math.max(cover.from, key.from);
      const to = Math.min(cover.to, key.to);
      const w = Math.min(cb[2], key.box[2]) - Math.max(cb[0], key.box[0]);
      const h = Math.min(cb[3], key.box[3]) - Math.max(cb[1], key.box[1]);
      if (to <= from || w <= 0 || h <= 0) continue;
      const keyArea = area(key.box);
      out.push({ label: cover.id || cover.kind, key: key.id || "key", from, to, sharePx: Math.round(w * h),
        shareOfKey: keyArea > 0 ? (w * h) / keyArea : 0, alwaysOn: cover.kind === "overlay" && cover.from === 0 && cover.to === duration });
    }
  }
  return out;
}

/** The font list for a language: the page's captionFonts (lang, then "*"), else plan style.fonts (lang, caption, body, default). */
export function fontForLang(lang, pageFonts, planFonts) {
  const pick = (o, keys) => keys.map((k) => o && o[k]).find((v) => typeof v === "string" && v.trim());
  return pick(pageFonts, [lang, "*"]) || pick(planFonts, [lang, "caption", "body", "default"]) || null;
}

/** Characters of a caption text as drawn: break marks and newlines are not glyphs. */
export function captionChars(text) {
  return Array.from(String(text || "").replace(/\|/g, "").replace(/\s+/g, " ")).filter((c) => !/[\p{Z}\p{C}]/u.test(c));
}

/**
 * Pairs [family list, char] to test, per language, with the line ids that use each character.
 * Languages without a font are listed in `noFont` (not checked), never passed.
 * @param {{lang:string, lines:{id:string, text?:string}[]}[]} langs
 * @param {(lang:string)=>string|null} fontOf
 */
export function langGlyphPairs(langs, fontOf) {
  const pairs = [];
  const noFont = [];
  const users = new Map();
  for (const l of langs) {
    const font = fontOf(l.lang);
    // A generic family (sans-serif) is the browser's own fallback: it cannot be told apart from one.
    if (!font || namedFamilies(`1px ${font}`).length === 0) { noFont.push(l.lang); continue; }
    for (const line of l.lines) {
      for (const ch of new Set(captionChars(line.text))) {
        const key = `${l.lang}\u0000${ch}`;
        if (!users.has(key)) { users.set(key, { lang: l.lang, font, char: ch, lineIds: [] }); pairs.push([font, ch]); }
        users.get(key).lineIds.push(line.id);
      }
    }
  }
  return { pairs, entries: [...users.values()], noFont };
}

/** Per-language result: characters the language's font does not have (definitely wrong for that language). */
export function langGlyphReport({ entries, noFont }, covered, langs) {
  const missing = new Map();
  const checked = new Map();
  const notLoaded = new Map();
  entries.forEach((e, i) => {
    if (covered[i] === null) { notLoaded.set(e.lang, e.font); return; }
    checked.set(e.lang, (checked.get(e.lang) || 0) + 1);
    if (covered[i]) return;
    const list = missing.get(e.lang) || [];
    list.push({ char: e.char, codepoint: "U+" + e.char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"), font: e.font, lineIds: e.lineIds });
    missing.set(e.lang, list);
  });
  return {
    languages: langs.map((l) => ({ lang: l.lang, checkedChars: checked.get(l.lang) || 0, missing: missing.get(l.lang) || [], noFont: noFont.includes(l.lang),
      fontNotLoaded: notLoaded.get(l.lang) || null })),
    definitelyWrong: missing.size > 0,
  };
}

function formatLangGlyphs(r) {
  let s = "";
  for (const l of r.languages) {
    if (l.noFont) s += `glyphs ${l.lang}: checked nothing (no named font for this language, a generic family cannot be told from the fallback: set window.__reel.captionFonts or plan style.fonts). ${checkedNothingNext("a named caption font for this language")}\n`;
    else if (l.fontNotLoaded && l.checkedChars === 0) s += `glyphs ${l.lang}: not checked: font not loaded (${l.fontNotLoaded}: not declared, not installed, or drawn like the browser default face)\n`;
    else if (l.checkedChars === 0) s += `glyphs ${l.lang}: checked nothing (no caption characters). ${checkedNothingNext("caption text in this language")}\n`;
    else if (!l.missing.length) s += `glyphs ${l.lang}: ${l.checkedChars} characters, all in the font${l.fontNotLoaded ? ` (the rest not checked: font not loaded: ${l.fontNotLoaded})` : ""}\n`;
    else {
      s += `glyphs ${l.lang}: ${l.missing.length} of ${l.checkedChars} characters are not in the font — definitely wrong for ${l.lang}\n`;
      if (l.fontNotLoaded) s += `  (the rest not checked: font not loaded: ${l.fontNotLoaded})\n`;
      for (const m of l.missing) s += `  ${m.codepoint} "${m.char}" not in ${m.font}: lines ${m.lineIds.slice(0, 8).join(", ")}${m.lineIds.length > 8 ? ", …" : ""}\n`;
    }
  }
  return s;
}

/**
 * In the page: whether each [families, char] has a glyph in the named font. true = present, false = missing,
 * null = not checked: the font is declared (@font-face / FontFace) and none of its faces loaded, or it draws
 * the plain letters "H" and "a" exactly like a generic family (not installed, or the browser default face),
 * so no glyph can be told from a fallback. Test: the char drawn as "<font>, <generic>" is compared with plain
 * <generic> for monospace, serif and sans-serif; missing = it matches one of them (measured: the fallback for a
 * char the font lacks depends on the font, so requiring a match on both monospace and serif misses real gaps).
 * The glyph mask (alpha > 8) is dilated by outlineEm / 2 of the font size first, so a caption drawn with an
 * outline is compared on the shape it draws.
 * @param {import("playwright-core").Page} page
 * @param {[string, string][]} pairs
 * @param {{outlineEm?:number}} [opts]
 * @returns {Promise<(boolean|null)[]>}
 */
export async function glyphMaskCoverage(page, pairs, { outlineEm = 0 } = {}) {
  return page.evaluate(async ({ list, em }) => {
    const N = 96, FONT = 64, r = Math.round((em * FONT) / 2);
    const bare = (f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase();
    await Promise.allSettled(list.map(([families, ch]) => document.fonts.load(`${FONT}px ${families}`, ch)));
    await document.fonts.ready;
    const notLoaded = new Map();
    const fontNotLoaded = (families) => {
      if (!notLoaded.has(families)) {
        const want = new Set(families.split(",").map(bare));
        const faces = [...document.fonts].filter((f) => want.has(bare(f.family)));
        notLoaded.set(families, faces.length > 0 && !faces.some((f) => f.status === "loaded"));
      }
      return notLoaded.get(families);
    };
    const mask = (family, ch) => {
      const c = document.createElement("canvas");
      c.width = c.height = N;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.font = `${FONT}px ${family}`;
      x.fillStyle = "#000";
      x.fillText(ch, 8, 72);
      const d = x.getImageData(0, 0, N, N).data;
      const m = new Uint8Array(N * N);
      for (let i = 0; i < N * N; i++) m[i] = d[i * 4 + 3] > 8 ? 1 : 0;
      if (r <= 0) return { w: x.measureText(ch).width, m };
      const out = new Uint8Array(N * N);
      for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
        if (!m[y * N + xx]) continue;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy, px = xx + dx;
          if (yy >= 0 && yy < N && px >= 0 && px < N) out[yy * N + px] = 1;
        }
      }
      return { w: x.measureText(ch).width, m: out };
    };
    const differs = (a, b) => {
      if (a.w !== b.w) return true;
      for (let i = 0; i < a.m.length; i++) if (a.m[i] !== b.m[i]) return true;
      return false;
    };
    // Which font draws a char the first family lacks depends on that family, so the fallback of "<font>, monospace"
    // is not always plain monospace: a missing glyph matches at least one of the three plain generics, a present
    // one matches none. That also means a font drawn exactly like a generic cannot be told from it.
    const matchesGeneric = (families, ch) =>
      ["monospace", "serif", "sans-serif"].some((fb) => !differs(mask(`${families}, ${fb}`, ch), mask(fb, ch)));
    const undecidable = new Map();
    const cannotTell = (families) => {
      if (!undecidable.has(families)) undecidable.set(families, fontNotLoaded(families) || ["H", "a"].some((c) => matchesGeneric(families, c)));
      return undecidable.get(families);
    };
    return list.map(([families, ch]) => (cannotTell(families) ? null : !matchesGeneric(families, ch)));
  }, { list: pairs, em: outlineEm });
}
