// Super Video Agent render engine — browser-side, no imports, no network, no wall-clock.
// Every helper is a pure function of its explicit arguments (or of `t`).
// Attaches everything under globalThis.Reel. Inlined verbatim into each reel.html.
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // hash + seeded RNG
  // ---------------------------------------------------------------------

  // 32-bit FNV-1a string hash. Deterministic, no Math.random.
  function hash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // mulberry32 PRNG seeded from a string key. Returns a function () => [0,1).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // rng(key) → deterministic generator function bound to that key.
  // Same key always produces the same sequence from call 0.
  function rng(key) {
    const gen = mulberry32(hash(key));
    return function next() {
      return gen();
    };
  }

  // Draw n values from rng(key), used when a single bucket needs several
  // independent-looking numbers (e.g. dx, dy, rot for one boil step).
  function rngValues(key, n) {
    const next = rng(key);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = next();
    return out;
  }

  // ---------------------------------------------------------------------
  // boil — stepped pose noise
  // ---------------------------------------------------------------------

  // boil(key, t, opts) -> {dx, dy, rot}
  // Quantises t into buckets of 1/hz seconds; identical output within a
  // bucket, reseeded (independent) at the next bucket. hz default 8,
  // amp in px, rot in degrees.
  function boil(key, t, opts) {
    const o = opts || {};
    const hz = o.hz == null ? 8 : o.hz;
    const amp = o.amp == null ? 1.2 : o.amp;
    const rotAmp = o.rot == null ? 0.35 : o.rot;
    const bucket = Math.floor(t * hz);
    const [r1, r2, r3] = rngValues(key + ":" + bucket, 3);
    return {
      dx: (r1 * 2 - 1) * amp,
      dy: (r2 * 2 - 1) * amp,
      rot: (r3 * 2 - 1) * rotAmp,
    };
  }

  // wobblePath(points, key, t, opts) -> new array of {x,y}
  // Densifies the polyline (adds `step`-spaced interpolated points, default
  // step=8px) then displaces each point by a boil sample keyed on its index,
  // so the whole path steps together but each point offsets independently.
  function wobblePath(points, key, t, opts) {
    const o = opts || {};
    const step = o.step == null ? 8 : o.step;
    const dense = densify(points, step);
    return dense.map((p, i) => {
      const b = boil(key + ":" + i, t, o);
      return { x: p.x + b.dx, y: p.y + b.dy };
    });
  }

  function densify(points, step) {
    if (!points || points.length < 2) return (points || []).slice();
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.round(len / step));
      for (let k = 1; k <= n; k++) {
        out.push({ x: a.x + (dx * k) / n, y: a.y + (dy * k) / n });
      }
    }
    return out;
  }

  // hold(t, step) — quantise time to a step grid (e.g. on-twos: step = 2/fps).
  function hold(t, step) {
    if (!step) return t;
    return Math.floor(t / step) * step;
  }

  // ---------------------------------------------------------------------
  // easing
  // ---------------------------------------------------------------------

  function easeOutCubic(u) {
    const x = clamp01(u);
    return 1 - Math.pow(1 - x, 3);
  }

  function easeOutBack(u) {
    const x = clamp01(u);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  // settle(u) — ease in fast, small overshoot back, come to rest. u in [0,1].
  function settle(u) {
    const x = clamp01(u);
    if (x < 0.7) return easeOutCubic(x / 0.7) * 1.06;
    const t2 = (x - 0.7) / 0.3;
    return 1.06 + (1 - 1.06) * easeOutCubic(t2);
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  // ---------------------------------------------------------------------
  // issues() sink — layout problems recorded by draw helpers
  // ---------------------------------------------------------------------

  const _issues = [];
  function recordIssue(issue) {
    _issues.push(issue);
  }
  function issues() {
    return _issues.slice();
  }
  function clearIssues() {
    _issues.length = 0;
  }

  // ---------------------------------------------------------------------
  // safe area — where text stays clear of the platform's own buttons.
  // Pictures may fill the whole frame; only text must sit inside.
  // ---------------------------------------------------------------------

  // Margins in px on a 1080×1920 frame, scaled to the canvas.
  // "ads": YouTube's official vertical-ad overlay (measured: box x 48–887,
  // y 288–1247), with TikTok's wider left edge. "shorts": organic Shorts and
  // TikTok feeds — YouTube's right rail, TikTok's top tabs and bottom caption.
  const SAFE_MARGINS_9x16 = {
    shorts: { top: 200, bottom: 450, left: 80, right: 192 },
    ads: { top: 288, bottom: 672, left: 80, right: 192 },
  };
  // Non-vertical frames: the 90% title-safe convention.
  const SAFE_FRACTION_OTHER = 0.05;
  let _safeKind = "shorts";

  function setSafeArea(kind) {
    if (!SAFE_MARGINS_9x16[kind]) throw new Error("unknown safe area: " + kind);
    _safeKind = kind;
  }

  // safeArea(width, height) -> {x, y, w, h} of the text-safe box.
  function safeArea(width, height) {
    if (height > width * 1.5) {
      const m = SAFE_MARGINS_9x16[_safeKind];
      const sx = width / 1080;
      const sy = height / 1920;
      const x = Math.round(m.left * sx);
      const y = Math.round(m.top * sy);
      return { x, y, w: Math.round(width - m.right * sx) - x, h: Math.round(height - m.bottom * sy) - y };
    }
    const x = Math.round(width * SAFE_FRACTION_OTHER);
    const y = Math.round(height * SAFE_FRACTION_OTHER);
    return { x, y, w: width - 2 * x, h: height - 2 * y };
  }

  // Records an issue when drawn text extends outside the safe area.
  function checkSafe(ctx, text, left, top, right, bottom, width, height) {
    const cw = width || (ctx.canvas ? ctx.canvas.width : 1080);
    const ch = height || (ctx.canvas ? ctx.canvas.height : 1920);
    const s = safeArea(cw, ch);
    if (left < s.x || top < s.y || right > s.x + s.w || bottom > s.y + s.h) {
      recordIssue({
        type: "text-outside-safe-area",
        text: String(text).slice(0, 80),
        drawn: { left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom) },
        safe: s,
      });
    }
  }

  // ---------------------------------------------------------------------
  // stroke drawing — wobbled path rendering
  // ---------------------------------------------------------------------

  function strokePoints(ctx, pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  // drawOn(ctx, path, u, key, t, opts) — reveals `path` (array of {x,y})
  // progressively as u goes 0→1, in point order ("marks are made, in order").
  // Returns the sub-path actually drawn (for chaining).
  function drawOn(ctx, path, u, key, t, opts) {
    const o = opts || {};
    const uu = clamp01(u);
    const dense = densify(path, o.step || 6);
    const n = Math.max(1, Math.round(dense.length * uu));
    const visible = dense.slice(0, n);
    if (visible.length >= 2) {
      const wobbled = key
        ? visible.map((p, i) => {
            const b = boil(key + ":drawOn:" + i, t, o);
            return { x: p.x + b.dx, y: p.y + b.dy };
          })
        : visible;
      ctx.save();
      ctx.strokeStyle = o.color || "#111";
      ctx.lineWidth = o.width == null ? 3 : o.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      strokePoints(ctx, wobbled);
      ctx.restore();
    }
    return visible;
  }

  // imageCover(ctx, img, x,y,w,h) — draws img into the box, cropped to cover.
  function imageCover(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // text — wrap + overflow detection. Reading text never boils.
  // ---------------------------------------------------------------------

  // textBlock(ctx, text, x,y,w,h, opts) — wraps `text` inside the box.
  // Records an issue if the wrapped lines overflow h. Never boils (still).
  function textBlock(ctx, text, x, y, w, h, opts) {
    const o = opts || {};
    const font = o.font || "32px sans-serif";
    const lineHeight = o.lineHeight == null ? 40 : o.lineHeight;
    const align = o.align || "left";
    const color = o.color || "#111";
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const word of words) {
      const test = cur ? cur + " " + word : word;
      if (ctx.measureText(test).width > w && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);

    const totalHeight = lines.length * lineHeight;
    if (totalHeight > h) {
      recordIssue({
        type: "text-overflow",
        text: String(text).slice(0, 80),
        box: { x, y, w, h },
        neededHeight: totalHeight,
        lines: lines.length,
      });
    }

    let left = Infinity;
    let right = -Infinity;
    lines.forEach((line, i) => {
      let dx = x;
      const lw = ctx.measureText(line).width;
      if (align === "center") dx = x + (w - lw) / 2;
      else if (align === "right") dx = x + (w - lw);
      ctx.fillText(line, dx, y + i * lineHeight);
      left = Math.min(left, dx);
      right = Math.max(right, dx + lw);
    });
    if (lines.length && !o.outsideSafeOk) checkSafe(ctx, text, left, y, right, y + totalHeight, o.width, o.height);
    ctx.restore();
    return { lines: lines.length, height: totalHeight, overflow: totalHeight > h };
  }

  // caption(ctx, line, t, opts) — draws the active caption text, still
  // (no boil), centered near the bottom-safe area by default. Default font
  // is 800 56px Pretendard; default lineHeight/boxH are sized to fit two
  // wrapped lines of that font without overflowing (issues() still reports
  // overflow past that).
  // Reference is the 9:16 default: 56px caption text at 1920px canvas
  // height. A 16:9 canvas (1080px tall) has far less vertical safe area per
  // pixel of width, so the font scales down with height, floored at 48px
  // (never above the 9:16 default of 56px) rather than growing with width.
  const CAPTION_FONT_REF_HEIGHT = 1920;
  const CAPTION_FONT_REF_PX = 56;
  const CAPTION_FONT_MIN_PX = 48;
  function captionFontSizePx(height) {
    const px = Math.round((CAPTION_FONT_REF_PX * height) / CAPTION_FONT_REF_HEIGHT);
    return Math.max(CAPTION_FONT_MIN_PX, Math.min(CAPTION_FONT_REF_PX, px));
  }

  // caption(ctx, line, t, opts) — draws the active caption text, still (no
  // boil), at the bottom of the safe area by default. Font size and box
  // width follow the canvas (captionFontSizePx above, safeArea); a
  // landscape (16:9) canvas also caps the box at ~70% width so two
  // wrapped lines fit the shorter frame.
  function caption(ctx, line, t, opts) {
    const o = opts || {};
    if (!line || !line.text) return;
    const width = o.width == null ? (ctx.canvas ? ctx.canvas.width : 1080) : o.width;
    const height = o.height == null ? (ctx.canvas ? ctx.canvas.height : 1920) : o.height;
    const fontPx = o.fontPx == null ? captionFontSizePx(height) : o.fontPx;
    const lineHeight = o.lineHeight == null ? Math.round(fontPx * 1.25) : o.lineHeight;
    const safe = safeArea(width, height);
    const boxW = o.boxW == null ? (width > height ? Math.min(safe.w, width * 0.7) : safe.w) : o.boxW;
    const boxH = o.boxH == null ? lineHeight * 2 + 20 : o.boxH;
    const x = o.x == null ? safe.x + (safe.w - boxW) / 2 : o.x;
    const y = o.y == null ? safe.y + safe.h - boxH - (o.marginBottom == null ? 0 : o.marginBottom) : o.y;
    const font = o.font == null ? "800 " + fontPx + "px 'Pretendard'" : o.font;
    const captionOpts = Object.assign({ align: "center", font: font, lineHeight: lineHeight }, o);
    return textBlock(ctx, line.text, x, y, boxW, boxH, captionOpts);
  }

  // ---------------------------------------------------------------------
  // timeline(timings) — derives per-line and per-word time windows.
  // ---------------------------------------------------------------------

  function timeline(timings) {
    const lines = (timings && timings.lines) || [];
    function line(i) {
      const l = lines[i];
      if (!l) return null;
      const start = l.start;
      const end = l.end;
      const dur = Math.max(1e-6, end - start);
      return {
        start,
        end,
        u: function (t) {
          return clamp01((t - start) / dur);
        },
      };
    }
    function word(i, j) {
      const l = lines[i];
      if (!l) return null;
      if (l.words && l.words[j]) {
        return { start: l.words[j].start, end: l.words[j].end };
      }
      // proportional fallback within the measured line, by character count
      const text = l.text || "";
      const words = text.split(/\s+/).filter(Boolean);
      const w = words[j];
      if (w == null) return null;
      const totalChars = words.reduce((a, ww) => a + ww.length, 0) || 1;
      let before = 0;
      for (let k = 0; k < j; k++) before += words[k].length;
      const dur = l.end - l.start;
      const wStart = l.start + (before / totalChars) * dur;
      const wDur = (w.length / totalChars) * dur;
      return { start: wStart, end: wStart + wDur };
    }
    // phrase(i, substring) -> {start, end} window spanning the words that
    // contain `substring` within line i's text, or null if the substring
    // isn't in the line.
    function phrase(i, substr) {
      const l = lines[i];
      if (!l || !substr) return null;
      const text = l.text || "";
      const charStart = text.indexOf(substr);
      if (charStart === -1) return null;
      const charEnd = charStart + substr.length; // exclusive
      const words = text.split(/\s+/).filter(Boolean);
      if (!words.length) return null;
      let cursor = 0;
      let firstWordIdx = null;
      let lastWordIdx = null;
      for (let w = 0; w < words.length; w++) {
        const wStart = text.indexOf(words[w], cursor);
        if (wStart === -1) continue;
        const wEnd = wStart + words[w].length;
        cursor = wEnd;
        if (wEnd > charStart && wStart < charEnd) {
          if (firstWordIdx === null) firstWordIdx = w;
          lastWordIdx = w;
        }
      }
      if (firstWordIdx === null) return null;
      const startWin = word(i, firstWordIdx);
      const endWin = word(i, lastWordIdx);
      if (!startWin || !endWin) return null;
      return { start: startWin.start, end: endWin.end };
    }
    return { line, word, phrase };
  }

  // ---------------------------------------------------------------------
  // asset library cues (design.md §2.5)
  // ---------------------------------------------------------------------

  // Index (within line.text's whitespace-split words) of the first word
  // containing `substr`, or -1.
  function firstWordIndexContaining(text, substr) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (words[i].indexOf(substr) !== -1) return i;
    }
    return -1;
  }

  // cueTime(cue, line, timings) -> absolute seconds (design.md §2.5).
  // `at` is "start" | "end" | "word:<text>". word:<text> resolves to the
  // start of the first word in `line.text` containing <text>, using the
  // same timeline() word timings scene code draws from; an unresolvable
  // word (not found, or line missing from timings) falls back to the
  // line's start and records an issue instead of throwing, so a stale cue
  // degrades the film rather than breaking the render.
  function cueTime(cue, line, timings) {
    const lines = (timings && timings.lines) || [];
    const idx = lines.findIndex(function (l) {
      return l.id === line.id;
    });
    let base = line.start;
    const at = cue && cue.at;
    if (at === "start") {
      base = line.start;
    } else if (at === "end") {
      base = line.end;
    } else if (typeof at === "string" && at.indexOf("word:") === 0) {
      const text = at.slice(5);
      const wordIdx = idx === -1 ? -1 : firstWordIndexContaining(line.text, text);
      const tl = timeline(timings);
      const win = wordIdx === -1 ? null : tl.word(idx, wordIdx);
      if (win) {
        base = win.start;
      } else {
        base = line.start;
        recordIssue({ type: "cue-word-not-found", asset: cue && cue.asset, at: at, lineId: line.id });
      }
    } else {
      base = line.start;
      recordIssue({ type: "cue-bad-at", asset: cue && cue.asset, at: at, lineId: line.id });
    }
    const offsetSec = (cue && cue.offsetMs ? cue.offsetMs : 0) / 1000;
    return base + offsetSec;
  }

  // registerClip/clipFrame — preloaded video-clip frames (design.md §2.5
  // "Picture"). `frames` is an ordered array (image or any held value);
  // clipFrame(id, tLocal) is a pure function of its local time within the
  // clip: frame = floor(tLocal*fps), held on the last frame past the
  // clip's end, so the same tLocal always returns the same frame.
  const _clips = Object.create(null);
  function registerClip(id, frames, fps) {
    _clips[id] = { frames: frames || [], fps: fps || 1 };
  }
  function clipFrame(id, tLocal) {
    const clip = _clips[id];
    if (!clip || clip.frames.length === 0) return null;
    const raw = Math.floor(Math.max(0, tLocal) * clip.fps);
    const i = Math.max(0, Math.min(clip.frames.length - 1, raw));
    return clip.frames[i];
  }

  // ---------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------

  globalThis.Reel = {
    hash,
    rng,
    boil,
    wobblePath,
    hold,
    drawOn,
    imageCover,
    textBlock,
    caption,
    safeArea,
    setSafeArea,
    easeOutCubic,
    easeOutBack,
    settle,
    timeline,
    issues,
    clearIssues,
    recordIssue,
    cueTime,
    registerClip,
    clipFrame,
  };
})();
