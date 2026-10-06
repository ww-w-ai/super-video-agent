// Browser side of state-checks.mjs: records every on-screen text draw per seek by wrapping the
// 2D context's fillText/strokeText (so any reel is covered with no change to its page), reads the
// optional hook window.__reel.visibleAt(t), and asks the browser which glyphs a font really has.
// What crosses back to Node is state (strings, fonts, boxes, alpha), never pixels.

/** Wraps fillText/strokeText on the page; draws on canvases attached to the document are recorded. */
export async function installTextProbe(page) {
  await page.evaluate(() => {
    if (window.__svaProbe) return;
    const probe = (window.__svaProbe = { texts: [] });
    const P = CanvasRenderingContext2D.prototype;
    const measure = P.measureText;
    for (const name of ["fillText", "strokeText"]) {
      const orig = P[name];
      P[name] = function (text, x, y, maxWidth) {
        try {
          const s = String(text);
          if (s.trim() && this.canvas && this.canvas.isConnected) {
            const m = measure.call(this, s);
            const sx = maxWidth !== undefined && m.width > maxWidth ? maxWidth / m.width : 1;
            const local = [x - m.actualBoundingBoxLeft * sx, y - m.actualBoundingBoxAscent,
              x + m.actualBoundingBoxRight * sx, y + m.actualBoundingBoxDescent];
            const mat = this.getTransform();
            const xs = [], ys = [];
            for (const [px, py] of [[local[0], local[1]], [local[2], local[1]], [local[2], local[3]], [local[0], local[3]]]) {
              xs.push(mat.a * px + mat.c * py + mat.e);
              ys.push(mat.b * px + mat.d * py + mat.f);
            }
            probe.texts.push({ text: s, font: this.font, alpha: this.globalAlpha,
              box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
          }
        } catch (e) { /* recording must never break the draw */ }
        return orig.apply(this, arguments);
      };
    }
  });
}

/**
 * Seeks every `step`th frame and returns the page state at each: the texts drawn by that seek and
 * the optional hook's visible-element list. `range` ({from, to} seconds) limits the frames to that
 * span; `onProgress(done, total)` is called after each sampled frame.
 * @returns {Promise<{frames:{frame:number, t:number, texts:object[], layers:object[]|null}[], hook:boolean}>}
 */
export async function collectFrameStates(page, { fps, duration, step, range = null, onProgress = null }) {
  const hook = await page.evaluate(() => typeof window.__reel.visibleAt === "function");
  const end = Math.max(0, Math.ceil(duration * fps - 1e-9) - 1);
  const first = range ? Math.min(end, Math.ceil(range.from * fps - 1e-9)) : 0;
  const last = range ? Math.min(end, Math.floor(range.to * fps + 1e-9)) : end;
  const total = Math.floor((last - first) / step) + 1;
  const frames = [];
  for (let frame = first; frame <= last; frame += step) {
    const t = frame / fps;
    const state = await page.evaluate(async (time) => {
      window.__svaProbe.texts.length = 0;
      const r = window.__reel;
      const res = r.seek(time);
      if (res && typeof res.then === "function") await res;
      let layers = null;
      if (typeof r.visibleAt === "function") {
        layers = r.visibleAt(time);
        if (layers && typeof layers.then === "function") layers = await layers;
      }
      return { texts: window.__svaProbe.texts.splice(0), layers };
    }, t);
    if (state.layers !== null && !Array.isArray(state.layers)) {
      throw new Error(`window.__reel.visibleAt(${t.toFixed(3)}) returned ${typeof state.layers}, not an array of {id, opacity?}`);
    }
    for (const [i, e] of (state.layers || []).entries()) {
      if (!e || typeof e.id !== "string" || !e.id) throw new Error(`window.__reel.visibleAt(${t.toFixed(3)})[${i}] has no "id" string`);
    }
    frames.push({ frame, t, texts: state.texts, layers: state.layers });
    if (onProgress) onProgress(frames.length, total);
  }
  return { frames, hook };
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
