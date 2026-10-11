// Text contrast from what the page drew, not from pixels guessed to be text. The text probe
// (lib/page-probe.mjs) records each text draw's colour, alpha, box and backing (the solid fill or
// outline drawn under it). A text on an opaque solid backing is a pair of known colours: WCAG ratio,
// no pixels. Anything else (a picture, a gradient, a translucent band) needs the picture: the probe
// hands over a luminance histogram of the pixels under the text box, read before the text was drawn,
// and the ratio is taken against its poorest tenth, the same rule caption-contrast.mjs uses.
// Pure: no browser, no files. Facts and grades only; nothing here stops a run.
import { relLuminance, contrastRatio, gradeContrast, describeDirection, worstRatio, histogramQuantile, CONTRAST_LOW, CONTRAST_MARGINAL } from "./caption-contrast.mjs";
import { checkedNothingNext } from "./checked-nothing.mjs";

const OPAQUE = 0.99;
const FONT_BUCKET_PX = 4;

/**
 * A CSS colour as canvas and getComputedStyle give it ("#rgb", "#rrggbb", "#rrggbbaa", "rgb()/rgba()",
 * "transparent"), or null for anything else (a gradient or pattern reaches here as "paint").
 * @returns {{rgb:number[], a:number}|null}
 */
export function parseCssColor(css) {
  const s = String(css || "").trim().toLowerCase();
  if (s === "transparent") return { rgb: [0, 0, 0], a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) return parseHex(hex[1]);
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat);
  if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return { rgb: parts.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v)))), a: parts.length > 3 ? Math.max(0, Math.min(1, parts[3])) : 1 };
}

function parseHex(h) {
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  const v = (i) => Number.parseInt(full.slice(i, i + 2), 16);
  return { rgb: [v(0), v(2), v(4)], a: full.length === 8 ? v(6) / 255 : 1 };
}

/** "#rrggbb" of an RGB triple. */
export function hexOf(rgb) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const lumOf = (rgb) => relLuminance(rgb[0], rgb[1], rgb[2]);
const blend = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));

/** The font size in px of a canvas/CSS font string, or null. */
export function fontPx(font) {
  const m = /(\d*\.?\d+)px/.exec(String(font || ""));
  return m ? Number(m[1]) : null;
}

/** Ink alpha of a record: the probe's effective alpha (globalAlpha x colour alpha), else globalAlpha. */
const inkAlpha = (rec) => (Number.isFinite(rec.effAlpha) ? rec.effAlpha : Number.isFinite(rec.alpha) ? rec.alpha : 1);

/** The backing as a known opaque colour, or null when the backing is missing, translucent, or a paint. */
function solidBacking(backing) {
  if (!backing) return null;
  const c = parseCssColor(backing.color);
  if (!c) return null;
  // The probe's alpha is already globalAlpha x colour alpha; a bare colour carries only its own.
  const a = Number.isFinite(backing.alpha) ? backing.alpha : c.a;
  return a >= OPAQUE ? c.rgb : null;
}

/** Whether a record needs the picture under it: no opaque solid backing. */
export function needsPicture(rec) {
  return !solidBacking(rec.backing);
}

/**
 * How one text draw reads. pair: text (blended by its alpha) over its opaque backing. picture: text
 * against the poorest tenth of the background histogram under its box. unmeasured: with the reason.
 * @param {{color:string, alpha?:number, effAlpha?:number, backing?:{kind:string,color:string,alpha:number}|null, picture?:{hist:number[]|null,n:number,reason?:string}|null}} rec
 * @returns {{method:"pair"|"picture"|"unmeasured", ratio?:number, grade?:string, textColor?:string, backColor?:string|null, bgMedianLum?:number, direction?:string, reason?:string}}
 */
export function judgeRecord(rec) {
  const ink = parseCssColor(rec.color);
  if (!ink) return { method: "unmeasured", reason: "text drawn with a gradient or pattern" };
  const alpha = Math.max(0, Math.min(1, inkAlpha(rec)));
  const back = solidBacking(rec.backing);
  if (back) return pairJudgement(ink.rgb, alpha, back);
  if (rec.picture && rec.picture.hist && rec.picture.n > 0) return pictureJudgement(ink.rgb, alpha, rec.picture);
  return { method: "unmeasured", reason: (rec.picture && rec.picture.reason) || "the background under the text was not sampled" };
}

function pairJudgement(ink, alpha, back) {
  const seen = blend(ink, alpha, back);
  const ratio = contrastRatio(lumOf(seen), lumOf(back));
  return { method: "pair", ratio, grade: gradeContrast(ratio), textColor: hexOf(ink), backColor: hexOf(back), bgMedianLum: lumOf(back), direction: describeDirection(lumOf(seen), lumOf(back)) };
}

function pictureJudgement(ink, alpha, picture) {
  const textLum = lumOf(ink);
  // Linear mix of luminances stands in for the sRGB blend: close enough to grade, and needs no colour per band.
  const over = alpha >= OPAQUE ? textLum : (bgLum) => alpha * textLum + (1 - alpha) * bgLum;
  const ratio = worstRatio(picture, over);
  const bgMedianLum = histogramQuantile(picture, 0.5);
  return { method: "picture", ratio, grade: gradeContrast(ratio), textColor: hexOf(ink), backColor: null, bgMedianLum, direction: describeDirection(textLum, bgMedianLum) };
}

/**
 * One judged record in caption-contrast's region shape ({kind, box, tones, bgMedianLum, ratio, worstRatio,
 * grade, direction}), so dub.mjs's row report reads it unchanged; `method` says how it was measured.
 */
export function recordAsRegion(rec, j) {
  const ink = parseCssColor(rec.color);
  const tones = ink ? [{ color: ink.rgb, lum: lumOf(ink.rgb), share: 1 }] : [];
  if (j.method === "unmeasured") return { kind: "caption", box: rec.box, tones, bgMedianLum: null, ratio: null, worstRatio: null, grade: "unmeasured", direction: null, method: j.method, reason: j.reason, text: rec.text };
  return { kind: "caption", box: rec.box, tones, bgMedianLum: j.bgMedianLum, ratio: j.ratio, worstRatio: j.ratio, grade: j.grade, direction: j.direction, method: j.method, backColor: j.backColor, text: rec.text };
}

const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Dedupe key: a pair is the same finding wherever those colours meet at that size; a picture check is per text. */
function groupKey(rec, j) {
  const role = rec.role || "picture";
  if (j.method === "pair") return `pair\u0000${role}\u0000${j.textColor}\u0000${j.backColor}\u0000${Math.round((fontPx(rec.font) || 0) / FONT_BUCKET_PX)}`;
  if (j.method === "picture") return `picture\u0000${role}\u0000${rec.text}\u0000${j.textColor}`;
  return `unmeasured\u0000${j.reason}\u0000${rec.text}`;
}

function addToGroup(groups, key, rec, j, at) {
  let g = groups.get(key);
  if (!g) {
    g = { method: j.method, role: rec.role || "picture", source: rec.source || "canvas", text: clip(rec.text), texts: new Set(), textColor: j.textColor || null,
      backColor: j.backColor || null, fontPx: fontPx(rec.font), ratio: Infinity, direction: null, reason: j.reason || null, first: at.t, last: at.t, frames: 0, lineIds: new Set() };
    groups.set(key, g);
  }
  g.texts.add(rec.text);
  g.frames++;
  g.first = Math.min(g.first, at.t);
  g.last = Math.max(g.last, at.t);
  if (at.lineId) g.lineIds.add(at.lineId);
  if (Number.isFinite(j.ratio) && j.ratio < g.ratio) Object.assign(g, { ratio: j.ratio, direction: j.direction });
}

function finishGroup(g) {
  const measured = g.method !== "unmeasured";
  return { ...g, texts: g.texts.size, lineIds: [...g.lineIds], ratio: measured ? g.ratio : null, grade: measured ? gradeContrast(g.ratio) : "unmeasured",
    first: Math.round(g.first * 1000) / 1000, last: Math.round(g.last * 1000) / 1000 };
}

/**
 * Every visible text draw of the sampled frames, judged and grouped. Outline strokes that back a fill are
 * the fill's backing, not text of their own.
 * @param {{frame:number, t?:number, lineId?:string, texts?:object[], dom?:object[]}[]} frames
 * @param {{fps:number, minAlpha:number}} o minAlpha = the alpha under which a text counts as not visible
 * @returns {{groups:object[], measured:number, pair:number, picture:number, unmeasured:number, records:number}}
 */
export function contrastFindings(frames, { fps, minAlpha }) {
  const groups = new Map();
  let records = 0;
  for (const f of frames) {
    const at = { t: Number.isFinite(f.t) ? f.t : f.frame / fps, lineId: f.lineId };
    for (const rec of [...(f.texts || []), ...(f.dom || [])]) {
      if (rec.servesAsOutline || inkAlpha(rec) < minAlpha || !String(rec.text || "").trim()) continue;
      records++;
      const j = judgeRecord(rec);
      addToGroup(groups, groupKey(rec, j), rec, j, at);
    }
  }
  const list = [...groups.values()].map(finishGroup).sort((a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity) || a.first - b.first);
  const count = (m) => list.filter((g) => g.method === m).length;
  return { groups: list, measured: count("pair") + count("picture"), pair: count("pair"), picture: count("picture"), unmeasured: count("unmeasured"), records };
}

function findingLine(g) {
  const span = `${g.first.toFixed(2)}–${g.last.toFixed(2)} s`;
  const what = g.texts > 1 ? `"${g.text}" and ${g.texts - 1} other text${g.texts === 2 ? "" : "s"}` : `"${g.text}"`;
  const colours = g.method === "pair" ? `text ${g.textColor} on ${g.backColor}${g.fontPx ? `, ${g.fontPx}px` : ""}` : `text ${g.textColor}, poorest tenth of the picture under its box`;
  const lines = g.lineIds.length ? `; lines ${g.lineIds.slice(0, 6).join(", ")}${g.lineIds.length > 6 ? ", …" : ""}` : "";
  return `  ${g.grade.toUpperCase()} ${g.ratio.toFixed(2)}:1 ${g.method} ${g.role}${g.source === "dom" ? " (DOM)" : ""} ${what} ${span} (${g.frames} frame${g.frames === 1 ? "" : "s"}, ${g.direction}; ${colours}${lines})`;
}

/**
 * The findings as text: a count line, each flagged group, then what could not be measured and why.
 * @param {ReturnType<typeof contrastFindings>} f
 * @param {{title?:string}} [o]
 */
export function formatContrastFindings(f, { title = "text contrast" } = {}) {
  if (!f.records) return `${title}: checked nothing — no 2D-canvas or DOM text was drawn in the sampled frames (text drawn by WebGL is not measured). ${checkedNothingNext("a sampled frame that draws text with fillText/strokeText on a canvas in the document")}\n`;
  const flagged = f.groups.filter((g) => g.method !== "unmeasured" && g.grade !== "ok");
  const out = [`${title} (WCAG ratio from the drawn colours: pair = text vs its own opaque backing, picture = text vs the poorest tenth of the picture under its box; low < ${CONTRAST_LOW}, marginal < ${CONTRAST_MARGINAL}): ` +
    `${f.measured} measured (${f.pair} pair, ${f.picture} picture), ${flagged.length} flagged`];
  for (const g of flagged) out.push(findingLine(g));
  const skipped = f.groups.filter((g) => g.method === "unmeasured");
  if (skipped.length) out.push(`  not measured: ${skipped.length} — ${skipped.slice(0, 5).map((g) => `"${g.text}" (${g.reason})`).join("; ")}${skipped.length > 5 ? "; …" : ""}`);
  return out.join("\n") + "\n";
}
