// Browser side of state-checks.mjs and the captions-on contrast measure: records every on-screen text
// draw per seek by wrapping the 2D context's drawing calls (so any reel is covered with no change to
// its page), reads the optional hook window.__reel.visibleAt(t), and asks the browser which glyphs a
// font really has. What crosses back to Node is state (strings, fonts, colours, boxes, alpha, and a
// luminance histogram of the pixels under a text box when its background is not a known colour),
// never frames.
//
// Per text draw: {text, font, alpha (globalAlpha), box, kind: "fill"|"stroke", color (CSS string, or
// "paint" for a gradient/pattern), effAlpha (globalAlpha x colour alpha), lineWidth (strokes, canvas
// px), role: "caption"|"picture" (the engine sets window.__svaDrawing = "caption" around its caption
// layer), backing, picture?}. backing = the last fill drawn earlier in the same seek on the same canvas
// whose box covers >= 95% of the text box ({kind: "fill", color, alpha}), or a strokeText of the same
// string at the same box with lineWidth >= 2 px ({kind: "outline", ...}); null when nothing backs it or
// a draw that does not cover the box (an image, a clear, a partial fill) came after the backing.
import { lastFilmFrame } from "./frame-count.mjs";

/**
 * Wraps the 2D context on the page; draws on canvases attached to the document are recorded.
 * pixels: also read the canvas under a text box that has no opaque solid backing (contrast checks).
 * paused: install without recording until a probe seek arms it (a render records only sampled frames).
 */
export async function installTextProbe(page, { pixels = false, paused = false } = {}) {
  await page.evaluate(installProbeInPage, { pixels, paused });
}

/**
 * Seeks every `step`th frame and returns the page state at each: the texts drawn by that seek and
 * the optional hook's visible-element list. `range` ({from, to} seconds) limits the frames to that
 * span; `onProgress(done, total)` is called after each sampled frame. `dom` also returns the DOM text
 * over the canvas (computed colour and backing) as `dom`.
 * @returns {Promise<{frames:{frame:number, t:number, texts:object[], layers:object[]|null, dom?:object[]}[], hook:boolean}>}
 */
export async function collectFrameStates(page, { fps, duration, step, range = null, onProgress = null, dom = false }) {
  const hook = await page.evaluate(() => typeof window.__reel.visibleAt === "function");
  const end = lastFilmFrame(duration, fps);
  const first = range ? Math.min(end, Math.ceil(range.from * fps - 1e-9)) : 0;
  const last = range ? Math.min(end, Math.floor(range.to * fps + 1e-9)) : end;
  const total = Math.floor((last - first) / step) + 1;
  const frames = [];
  for (let frame = first; frame <= last; frame += step) {
    const t = frame / fps;
    const state = await page.evaluate(seekAndRead, { time: t, dom, layers: true });
    if (state.layers !== null && !Array.isArray(state.layers)) {
      throw new Error(`window.__reel.visibleAt(${t.toFixed(3)}) returned ${typeof state.layers}, not an array of {id, opacity?}`);
    }
    for (const [i, e] of (state.layers || []).entries()) {
      if (!e || typeof e.id !== "string" || !e.id) throw new Error(`window.__reel.visibleAt(${t.toFixed(3)})[${i}] has no "id" string`);
    }
    frames.push({ frame, t, texts: state.texts, layers: state.layers, ...(state.dom ? { dom: state.dom } : {}) });
    if (onProgress) onProgress(frames.length, total);
  }
  return { frames, hook };
}

/**
 * One armed seek of a paused probe (installTextProbe with paused): records the draws of seeking to `t`,
 * then pauses again so the frames in between cost nothing.
 * @returns {Promise<object[]>} the text records of that seek
 */
export async function probeSeek(page, t) {
  const state = await page.evaluate(seekAndRead, { time: t, dom: false, layers: false });
  return state.texts;
}

// Runs in the page: clears the per-seek records, seeks, returns what the seek drew.
async function seekAndRead({ time, dom, layers }) {
  const probe = window.__svaProbe;
  const wasPaused = probe.paused;
  probe.paused = false;
  probe.texts.length = 0;
  if (probe.ops) probe.ops.length = 0;
  try {
    const r = window.__reel;
    const res = r.seek(time);
    if (res && typeof res.then === "function") await res;
    let visible = null;
    if (layers && typeof r.visibleAt === "function") {
      visible = r.visibleAt(time);
      if (visible && typeof visible.then === "function") visible = await visible;
    }
    const domTexts = dom && probe.domTexts ? probe.domTexts() : null;
    return { texts: probe.texts.splice(0), layers: visible, dom: domTexts };
  } finally {
    probe.paused = wasPaused;
    if (probe.ops) probe.ops.length = 0;
  }
}

// Runs in the page, so it is self-contained: no imports reach it. The luminance band formula repeats
// lumBand of caption-contrast.mjs for that reason.
function installProbeInPage({ pixels, paused }) {
  const existing = window.__svaProbe;
  if (existing && existing.ops) {
    existing.pixels = existing.pixels || pixels;
    return;
  }
  const probe = (window.__svaProbe = { texts: [], ops: [], pixels, paused, domTexts: null });
  const P = CanvasRenderingContext2D.prototype;
  const measure = P.measureText;
  const readPixels = P.getImageData;
  const COVER = 0.95, OUTLINE_PX = 2, OPAQUE = 0.99, KNOWN_ALPHA = 250;
  const lin = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  const band = (r, g, b) => Math.round(Math.sqrt(0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b]) * 255);

  const live = (ctx) => !probe.paused && ctx.canvas && ctx.canvas.isConnected;
  const flat = (m) => Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const shared = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice());
  const sameBox = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  const styleColor = (s) => (typeof s === "string" ? s : "paint");
  const cssAlpha = (css) => {
    if (typeof css !== "string") return 1;
    if (css === "transparent") return 0;
    const h = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(css);
    if (h) return parseInt(h[1], 16) / 255;
    const m = /^rgba?\(([^)]*)\)$/i.exec(css);
    const p = m ? m[1].split(/[\s,/]+/).filter(Boolean) : [];
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };
  const boxOf = (m, x0, y0, x1, y1) => {
    const xs = [], ys = [];
    for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      xs.push(m.a * px + m.c * py + m.e);
      ys.push(m.b * px + m.d * py + m.f);
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const wholeCanvas = (ctx) => [0, 0, ctx.canvas.width, ctx.canvas.height];

  // ---- draws that can back or break a text's backing --------------------------------------------
  const addOp = (ctx, op) => probe.ops.push(Object.assign(op, { canvas: ctx.canvas }));
  const addFill = (ctx, boxes, rectOnly) => {
    const color = styleColor(ctx.fillStyle);
    addOp(ctx, { type: "fill", boxes, box: boxes.reduce((u, b) => union(u, b), null), color,
      solid: rectOnly && ctx.globalCompositeOperation === "source-over", alpha: ctx.globalAlpha * cssAlpha(color) });
  };
  const wrap = (name, note) => {
    const f = P[name];
    if (typeof f !== "function") return;
    P[name] = function () {
      try {
        if (live(this)) note(this, arguments);
      } catch (e) { /* recording must never break the draw */ }
      return f.apply(this, arguments);
    };
  };
  const paths = new WeakMap();
  const pathOf = (ctx) => paths.get(ctx) || paths.set(ctx, { boxes: [], ext: null, other: false }).get(ctx);
  const growPath = (ctx, pts, other) => {
    const p = pathOf(ctx);
    const m = ctx.getTransform();
    for (let i = 0; i < pts.length; i += 2) p.ext = union(p.ext, boxOf(m, pts[i], pts[i + 1], pts[i], pts[i + 1]));
    if (other) p.other = true;
  };
  const pathRect = (ctx, [x, y, w, h]) => {
    const p = pathOf(ctx);
    const m = ctx.getTransform();
    const b = boxOf(m, x, y, x + w, y + h);
    p.boxes.push(b);
    p.ext = union(p.ext, b);
    if (!flat(m)) p.other = true;
  };
  wrap("beginPath", (ctx) => paths.set(ctx, { boxes: [], ext: null, other: false }));
  wrap("rect", pathRect);
  wrap("roundRect", pathRect);
  wrap("moveTo", (ctx, a) => growPath(ctx, [a[0], a[1]], false));
  wrap("lineTo", (ctx, a) => growPath(ctx, [a[0], a[1]], true));
  wrap("quadraticCurveTo", (ctx, a) => growPath(ctx, [a[0], a[1], a[2], a[3]], true));
  wrap("bezierCurveTo", (ctx, a) => growPath(ctx, [a[0], a[1], a[2], a[3], a[4], a[5]], true));
  wrap("arcTo", (ctx, a) => growPath(ctx, [a[0], a[1], a[2], a[3]], true));
  wrap("arc", (ctx, a) => growPath(ctx, [a[0] - a[2], a[1] - a[2], a[0] + a[2], a[1] + a[2]], true));
  wrap("ellipse", (ctx, a) => {
    const r = Math.max(a[2], a[3]);
    growPath(ctx, [a[0] - r, a[1] - r, a[0] + r, a[1] + r], true);
  });
  wrap("fillRect", (ctx, [x, y, w, h]) => {
    const m = ctx.getTransform();
    addFill(ctx, [boxOf(m, x, y, x + w, y + h)], flat(m));
  });
  wrap("fill", (ctx, a) => {
    if (typeof Path2D !== "undefined" && a[0] instanceof Path2D) return addFill(ctx, [wholeCanvas(ctx)], false);
    const p = paths.get(ctx);
    if (!p || !p.ext) return;
    addFill(ctx, p.other ? [p.ext] : p.boxes, !p.other);
  });
  wrap("clearRect", (ctx, [x, y, w, h]) => addOp(ctx, { type: "cover", box: boxOf(ctx.getTransform(), x, y, x + w, y + h) }));
  wrap("drawImage", (ctx, a) => {
    const img = a[0];
    const [dx, dy, dw, dh] = a.length >= 9 ? [a[5], a[6], a[7], a[8]] : a.length >= 5 ? [a[1], a[2], a[3], a[4]]
      : [a[1], a[2], img.naturalWidth || img.videoWidth || img.width || 0, img.naturalHeight || img.videoHeight || img.height || 0];
    addOp(ctx, { type: "cover", box: boxOf(ctx.getTransform(), dx, dy, dx + dw, dy + dh) });
  });
  wrap("putImageData", (ctx, a) => addOp(ctx, { type: "cover", box: [a[1], a[2], a[1] + a[0].width, a[2] + a[0].height] }));

  // ---- the backing of a text: walk back to the last draw that touches its box --------------------
  const backingOf = (ctx, rec) => {
    for (let i = probe.ops.length - 1; i >= 0; i--) {
      const op = probe.ops[i];
      if (op.canvas !== ctx.canvas) continue;
      if (op.type === "outline") {
        const o = op.rec;
        if (rec.kind === "fill" && o.text === rec.text && o.lineWidth >= OUTLINE_PX && sameBox(o.box, rec.box)) return { backing: { kind: "outline", color: o.color, alpha: o.effAlpha }, outline: o };
        continue;
      }
      if (!shared(op.box, rec.box)) continue;
      const covers = op.type === "fill" && op.solid && op.boxes.some((b) => shared(b, rec.box) >= COVER * area(rec.box));
      return { backing: covers ? { kind: "fill", color: op.color, alpha: op.alpha } : null };
    }
    return { backing: null };
  };
  const needsPixels = (b) => !b || b.color === "paint" || !(b.alpha >= OPAQUE);

  // Luminance histogram of the canvas inside the box, read before the text is drawn: the background as
  // the viewer will see it behind the letters. No pixel is dropped for matching the text colour: white text
  // on a white picture must count that white, it is exactly the case to catch.
  const pictureUnder = (ctx, box) => {
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(box[2])), y1 = Math.min(ctx.canvas.height, Math.ceil(box[3]));
    if (x1 <= x0 || y1 <= y0) return { hist: null, n: 0, reason: "the text box lies outside its canvas" };
    let d;
    try {
      d = readPixels.call(ctx, x0, y0, x1 - x0, y1 - y0).data;
    } catch (e) {
      return { hist: null, n: 0, reason: "the canvas pixels cannot be read (a cross-origin image)" };
    }
    return histogramOf(d);
  };
  const histogramOf = (d) => {
    const hist = new Array(256).fill(0);
    let n = 0, clear = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < KNOWN_ALPHA) { clear++; continue; }
      hist[band(d[i], d[i + 1], d[i + 2])]++;
      n++;
    }
    if (n === 0 || n < clear) return { hist: null, n, reason: "the background is not on this canvas (transparent under the text)" };
    return { hist, n };
  };

  // ---- text draws ---------------------------------------------------------------------------------
  const textRecord = (ctx, kind, s, x, y, maxWidth) => {
    const m = measure.call(ctx, s);
    const sx = maxWidth !== undefined && m.width > maxWidth ? maxWidth / m.width : 1;
    const mat = ctx.getTransform();
    const box = boxOf(mat, x - m.actualBoundingBoxLeft * sx, y - m.actualBoundingBoxAscent, x + m.actualBoundingBoxRight * sx, y + m.actualBoundingBoxDescent);
    const color = styleColor(kind === "fill" ? ctx.fillStyle : ctx.strokeStyle);
    const rec = { text: s, font: ctx.font, alpha: ctx.globalAlpha, box, kind, color, effAlpha: ctx.globalAlpha * cssAlpha(color),
      role: window.__svaDrawing === "caption" ? "caption" : "picture" };
    if (kind === "stroke") rec.lineWidth = ctx.lineWidth * Math.sqrt(Math.abs(mat.a * mat.d - mat.b * mat.c));
    return rec;
  };
  const noteText = (ctx, kind, s, x, y, maxWidth) => {
    const rec = textRecord(ctx, kind, s, x, y, maxWidth);
    const { backing, outline } = backingOf(ctx, rec);
    rec.backing = backing;
    if (outline) outline.servesAsOutline = true;
    if (probe.pixels && needsPixels(backing)) rec.picture = pictureUnder(ctx, rec.box);
    probe.texts.push(rec);
    if (kind === "stroke") addOp(ctx, { type: "outline", rec });
  };
  for (const name of ["fillText", "strokeText"]) {
    const orig = P[name];
    P[name] = function (text, x, y, maxWidth) {
      try {
        const s = String(text);
        if (s.trim() && live(this)) noteText(this, name === "fillText" ? "fill" : "stroke", s, x, y, maxWidth);
      } catch (e) { /* recording must never break the draw */ }
      return orig.apply(this, arguments);
    };
  }

  // ---- DOM text over a canvas: computed colour and the nearest background behind it ---------------
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity) || 0;
    return o;
  };
  const domBacking = (el, canvas) => {
    // An ancestor that holds the canvas paints under the canvas, not under the text.
    for (let e = el; e && e !== document.documentElement && !e.contains(canvas); e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      const a = cssAlpha(c);
      if (a > 0) return { kind: "fill", color: c, alpha: a * opacityOf(e) };
    }
    return null;
  };
  const canvasPixelsUnder = (canvas, box) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { hist: null, n: 0, reason: "not measured: drawn by WebGL" };
    return pictureUnder(ctx, box);
  };
  const domRecord = (node, canvases) => {
    const el = node.parentElement;
    const text = node.nodeValue.trim();
    if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    const under = r.width && r.height ? canvases.find((c) => shared([r.left, r.top, r.right, r.bottom], c.box) > 0) : null;
    const cs = under ? getComputedStyle(el) : null;
    if (!under || cs.visibility === "hidden") return null;
    const sx = under.canvas.width / (under.box[2] - under.box[0]);
    const sy = under.canvas.height / (under.box[3] - under.box[1]);
    const box = [(r.left - under.box[0]) * sx, (r.top - under.box[1]) * sy, (r.right - under.box[0]) * sx, (r.bottom - under.box[1]) * sy];
    const opacity = opacityOf(el);
    const rec = { text, font: cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, alpha: opacity, box, kind: "dom", color: cs.color,
      effAlpha: opacity * cssAlpha(cs.color), role: "picture", source: "dom", backing: domBacking(el, under.canvas) };
    if (needsPixels(rec.backing)) rec.picture = canvasPixelsUnder(under.canvas, box);
    return rec;
  };
  probe.domTexts = () => {
    const canvases = [...document.querySelectorAll("canvas")].map((canvas) => {
      const b = canvas.getBoundingClientRect();
      return { canvas, box: [b.left, b.top, b.right, b.bottom] };
    }).filter((c) => area(c.box) > 0);
    const out = [];
    if (!canvases.length || !document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const rec = domRecord(node, canvases);
      if (rec) out.push(rec);
    }
    return out;
  };
}

/**
 * Whether each [families, char] is drawn by a named family of the list rather than a fallback:
 * the character is drawn with the families, then with a family that does not exist (the browser's
 * default font); a glyph that comes out identical in both was drawn by the fallback.
 * @param {[string, string][]} pairs
 * @returns {Promise<boolean[]>}
 */
export async function glyphCoverage(page, pairs) {
  return page.evaluate((list) => {
    const draw = (family, ch) => {
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.font = `64px ${family}`;
      x.textBaseline = "alphabetic";
      x.fillStyle = "#000";
      x.fillText(ch, 8, 72);
      return { w: x.measureText(ch).width, d: x.getImageData(0, 0, 96, 96).data };
    };
    return list.map(([families, ch]) => {
      const a = draw(families, ch);
      const b = draw('"__sva_no_such_font__"', ch);
      if (a.w !== b.w) return true;
      for (let i = 0; i < a.d.length; i++) if (a.d[i] !== b.d[i]) return true;
      return false;
    });
  }, pairs);
}
