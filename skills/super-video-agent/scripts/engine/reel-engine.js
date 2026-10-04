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
  // amp in px, rot in degrees. opts.moving (0..1, default 0) scales the
  // jitter down: a static scene boils by default (moving=0); while an
  // element moves, boil fades out (moving=1 -> exactly zero jitter) and
  // returns once it settles — see `moving()` below for computing this
  // from move intervals.
  function boil(key, t, opts) {
    const o = opts || {};
    const hz = o.hz == null ? 8 : o.hz;
    const amp = o.amp == null ? 1.2 : o.amp;
    const rotAmp = o.rot == null ? 0.35 : o.rot;
    const moving = o.moving == null ? 0 : o.moving;
    const scale = 1 - moving;
    const bucket = Math.floor(t * hz);
    const [r1, r2, r3] = rngValues(key + ":" + bucket, 3);
    return {
      // `|| 0` turns a -0 result (negative jitter times scale=0) into a
      // plain 0, so moving=1 gives exactly {dx:0, dy:0, rot:0}.
      dx: (r1 * 2 - 1) * amp * scale || 0,
      dy: (r2 * 2 - 1) * amp * scale || 0,
      rot: (r3 * 2 - 1) * rotAmp * scale || 0,
    };
  }

  // moving(t, intervals, opts) -> 0..1
  // Pure function of t: 1 while t falls inside any {start, end} interval in
  // `intervals` (an element is moving), 0 well outside all of them, ramping
  // linearly over opts.settleSec (default 0.15s) on the way in and out of
  // each interval — so boil fades out just before a move starts and fades
  // back in just after it settles, instead of snapping. Feed the result
  // straight into boil's `opts.moving`.
  function moving(t, intervals, opts) {
    const o = opts || {};
    const settleSec = o.settleSec == null ? 0.15 : o.settleSec;
    if (!intervals || !intervals.length) return 0;
    let m = 0;
    for (const iv of intervals) {
      let v;
      if (t >= iv.start && t <= iv.end) {
        v = 1;
      } else if (t < iv.start) {
        const d = iv.start - t;
        v = d >= settleSec ? 0 : 1 - d / settleSec;
      } else {
        const d = t - iv.end;
        v = d >= settleSec ? 0 : 1 - d / settleSec;
      }
      if (v > m) m = v;
    }
    return clamp01(m);
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
  // keyframe tracks
  // ---------------------------------------------------------------------

  // monotoneTrack(keys) -> (t) => number[]
  // keys: [{t, v: number[] | number, ease?: "io"}], sorted by t. A monotone
  // cubic (Fritsch-Carlson tangents, Brodlie's weighted harmonic mean)
  // through every key, per dimension: smooth through the keys and never
  // outside the range of the two keys around t, so a camera diving to a low
  // key does not carry on below it. A Catmull-Rom track overshoots there.
  // The end keys keep the speed of their own segment, so a shot can cut
  // while moving. `ease: "io"` on a key eases in and out of the segment that
  // ends at it (zero tangents). Pure function of t; clamps outside the keys.
  function monotoneTrack(keys) {
    if (!keys || !keys.length) throw new Error("monotoneTrack: at least one key is required");
    const pts = keys.map(function (k) {
      return { t: k.t, v: Array.isArray(k.v) ? k.v : [k.v], ease: k.ease };
    });
    const n = pts.length;
    const dims = pts[0].v.length;
    const tangents = monotoneTangents(pts, dims);
    return function (t) {
      if (n === 1 || t <= pts[0].t) return pts[0].v.slice();
      if (t >= pts[n - 1].t) return pts[n - 1].v.slice();
      let i = 0;
      while (i < n - 2 && t > pts[i + 1].t) i++;
      return hermiteSegment(pts[i], pts[i + 1], tangents[i], tangents[i + 1], t);
    };
  }

  function monotoneTangents(pts, dims) {
    const n = pts.length;
    const m = pts.map(function () { return new Array(dims).fill(0); });
    if (n < 2) return m;
    for (let d = 0; d < dims; d++) {
      const slope = [];
      for (let i = 0; i < n - 1; i++) {
        slope.push((pts[i + 1].v[d] - pts[i].v[d]) / ((pts[i + 1].t - pts[i].t) || 1));
      }
      m[0][d] = slope[0];
      m[n - 1][d] = slope[n - 2];
      for (let k = 1; k < n - 1; k++) {
        const a = slope[k - 1];
        const b = slope[k];
        if (a * b <= 0) continue; // a turning point: flat, so no overshoot
        const h0 = pts[k].t - pts[k - 1].t;
        const h1 = pts[k + 1].t - pts[k].t;
        const w1 = 2 * h1 + h0;
        const w2 = h1 + 2 * h0;
        m[k][d] = (w1 + w2) / (w1 / a + w2 / b);
      }
    }
    return m;
  }

  function hermiteSegment(k1, k2, m1, m2, t) {
    const h = k2.t - k1.t;
    const io = k2.ease === "io";
    let u = h > 0 ? (t - k1.t) / h : 1;
    if (io) u = u * u * (3 - 2 * u);
    const u2 = u * u;
    const u3 = u2 * u;
    const out = [];
    for (let d = 0; d < k1.v.length; d++) {
      const s1 = io ? 0 : m1[d] * h;
      const s2 = io ? 0 : m2[d] * h;
      out.push(
        (2 * u3 - 3 * u2 + 1) * k1.v[d] + (u3 - 2 * u2 + u) * s1 +
          (-2 * u3 + 3 * u2) * k2.v[d] + (u3 - u2) * s2
      );
    }
    return out;
  }

  // inWindows(t, windows) -> boolean — t inside any [start, end) of
  // `windows` ([{start, end}]). Null or empty windows -> false.
  function inWindows(t, windows) {
    if (!windows) return false;
    for (const w of windows) {
      if (t >= w.start && t < w.end) return true;
    }
    return false;
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
  // captions on/off — for a picture-first render (dub.mjs, design.md
  // "Picture first"): render.mjs --no-captions loads the page with
  // ?captions=0 so the picture renders once with no caption baked in, and
  // dub.mjs lays a caption layer + a language's voice over it afterwards.
  // Read once from location.search at load, never inside seek(t), so
  // seek stays a pure function of t.
  // ---------------------------------------------------------------------
  var _captionsOn = true;
  try {
    if (typeof location !== "undefined" && location.search) {
      var _params = new URLSearchParams(location.search);
      if (_params.get("captions") === "0") _captionsOn = false;
    }
  } catch (e) {
    _captionsOn = true;
  }
  function captionsOn() {
    return _captionsOn;
  }

  // ---------------------------------------------------------------------
  // layer / dubCode — for dub.mjs's "let the reel draw its own captions"
  // path (references/pipeline.md "Picture first"): ?layer=captions&dub=<code>
  // tells a page that supports it (declares "captions" in __reel.layers) to
  // load that dub's placed timings + plan instead of its own (layerFiles
  // below), skip the picture, clear to transparent, and draw only its
  // overlay (captions, titles, stickers). ?layer=captions with no dub draws
  // the base language's overlay (review.mjs --scan --layer captions).
  // Read once from location.search at load, never inside seek(t).
  // ---------------------------------------------------------------------
  var _layer = null;
  var _dubCode = null;
  try {
    if (typeof location !== "undefined" && location.search) {
      var _layerParams = new URLSearchParams(location.search);
      _layer = _layerParams.get("layer") || null;
      _dubCode = _layerParams.get("dub") || null;
    }
  } catch (e) {
    _layer = null;
    _dubCode = null;
  }
  function layer() {
    return _layer;
  }
  function dubCode() {
    return _dubCode;
  }

  // ---------------------------------------------------------------------
  // picture strings — text drawn INTO the picture (not the caption layer)
  // that changes per dub language. render.mjs --no-captions --lang <code>
  // injects globalThis.__svaPicture = {lang, strings} before the page runs:
  // `strings` is dub/<code>/plan.json meta.overlay.picture, `lang` is <code>
  // (a base render injects the plan's own language and no strings). Read at
  // call time, so a seek stays a pure function of t.
  // pictureText(key, fallback) -> strings[key] when present, else fallback.
  // ---------------------------------------------------------------------
  function pictureState() {
    var p = typeof globalThis !== "undefined" ? globalThis.__svaPicture : null;
    return p && typeof p === "object" ? p : null;
  }
  function pictureTextFrom(strings, key, fallback) {
    if (strings && typeof strings === "object" && Object.prototype.hasOwnProperty.call(strings, key)) {
      var v = strings[key];
      if (typeof v === "string" && v !== "") return v;
    }
    return fallback;
  }
  function pictureText(key, fallback) {
    var p = pictureState();
    return pictureTextFrom(p && p.strings, key, fallback);
  }
  function pictureLang() {
    var p = pictureState();
    if (p && p.lang) return p.lang;
    return _dubCode || (_layerParamsLang || null);
  }
  var _layerParamsLang = null;
  try {
    if (typeof location !== "undefined" && location.search) {
      _layerParamsLang = new URLSearchParams(location.search).get("lang") || null;
    }
  } catch (e) {
    _layerParamsLang = null;
  }

  function samePrimaryLang(a, b) {
    if (!a || !b) return false;
    return String(a).split("-")[0].toLowerCase() === String(b).split("-")[0].toLowerCase();
  }

  // layerFiles(baseLang, state?) -> {timings: [url...], plan: [url...]} —
  // the files a page loads, first one that exists wins. A normal render, and
  // the caption layer with no dub code, read the film's own voice/timings.json
  // and plan.json. With ?dub=<code> the caption layer reads that dub's placed
  // timings and plan; for the base language (same primary subtag as
  // plan.meta.lang) the film's own files follow as a fallback, because
  // dub/<base>/timings.placed.json exists only after a dub run. `state`
  // ({layer, dub}) replaces the URL's values (tests).
  function layerFiles(baseLang, state) {
    const s = state || { layer: _layer, dub: _dubCode };
    const own = { timings: ["voice/timings.json"], plan: ["plan.json"] };
    if (s.layer !== "captions" || !s.dub) return own;
    const dubTimings = "dub/" + s.dub + "/timings.placed.json";
    const dubPlan = "dub/" + s.dub + "/plan.json";
    if (samePrimaryLang(s.dub, baseLang)) {
      return { timings: [dubTimings].concat(own.timings), plan: [dubPlan].concat(own.plan) };
    }
    return { timings: [dubTimings], plan: [dubPlan] };
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

  // setSafeArea("shorts" | "ads" | "none" | {top, bottom, left, right}).
  // The presets are for platforms that draw buttons over the video. "none"
  // frees the whole frame (a messenger, a TV, a site player, the film's own
  // layout); an object sets the film's own margins in canvas px.
  function setSafeArea(kind) {
    if (kind && typeof kind === "object") {
      const m = { top: kind.top || 0, bottom: kind.bottom || 0, left: kind.left || 0, right: kind.right || 0 };
      if (![m.top, m.bottom, m.left, m.right].every((v) => Number.isFinite(v) && v >= 0)) {
        throw new Error("safe area margins must be numbers >= 0");
      }
      _safeKind = m;
      return;
    }
    if (kind !== "none" && !SAFE_MARGINS_9x16[kind]) throw new Error("unknown safe area: " + kind);
    _safeKind = kind;
  }

  // safeArea(width, height) -> {x, y, w, h} of the text-safe box.
  function safeArea(width, height) {
    if (_safeKind === "none") return { x: 0, y: 0, w: width, h: height };
    if (typeof _safeKind === "object") {
      const m = _safeKind;
      return { x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom };
    }
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

  // centeredSafeArea(width, height) -> the widest box inside the safe area
  // that shares the frame's centre line. The 9:16 safe box is off-centre
  // (right margin 192 for the button column, left 80), so text centred on it
  // sits left of the frame's middle; centred text uses this box instead.
  function centeredSafeArea(width, height) {
    const s = safeArea(width, height);
    const inset = Math.max(s.x, width - (s.x + s.w));
    return { x: inset, y: s.y, w: width - 2 * inset, h: s.h };
  }

  // transformedBBox(m, left, top, right, bottom) — the axis-aligned box (in
  // the space `m` maps *into*) that contains a box's four corners after
  // `m` (a DOMMatrix-shaped {a,b,c,d,e,f}) is applied. Pure: no ctx, no
  // canvas — unit-testable on a plain matrix object.
  function transformedBBox(m, left, top, right, bottom) {
    const corners = [
      [left, top],
      [right, top],
      [left, bottom],
      [right, bottom],
    ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }

  // Records an issue when drawn text extends outside the safe area. `left`,
  // `top`, `right`, `bottom` are in the *local* (pre-transform) coordinate
  // space text was drawn in; ctx.getTransform() carries whatever
  // rotate/scale/translate was active when it was drawn (a tilted sticker
  // label, a scaled stamp), so the box is transformed into canvas space
  // before it is tested against the safe area — otherwise a rotated or
  // scaled label can sit outside the safe area with no issue recorded.
  function checkSafe(ctx, text, left, top, right, bottom, width, height) {
    const cw = width || (ctx.canvas ? ctx.canvas.width : 1080);
    const ch = height || (ctx.canvas ? ctx.canvas.height : 1920);
    const s = safeArea(cw, ch);
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const box = transformedBBox(m, left, top, right, bottom);
    if (box.left < s.x || box.top < s.y || box.right > s.x + s.w || box.bottom > s.y + s.h) {
      recordIssue({
        type: "text-outside-safe-area",
        text: String(text).slice(0, 80),
        drawn: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) },
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

  // ---- caption break rules (the automatic fallback; a writer's "|" always wins) ----
  // One rule set, used by every caption path: row wrapping (wrapParts,
  // captionRows) and word-by-word chunking (captionChunks). A "glue" array
  // marks the places a caption must not break: glue[i] true = never between
  // unit i and unit i+1.
  //   - a number never parts from its unit ("10 kg", "30 %", "3 개")
  //   - an article/preposition never ends a row (per-language short lists)
  //   - ko: a dependent noun or particle token stays with the word before it
  //     ("할 수 밖에 없다" is one piece)
  //   - nothing breaks inside a short parenthesis or quote span
  //   - CJK (ja, zh) wraps by characters, but a number+unit, a Latin word and
  //     a closing/opening mark each stay whole (captionUnits)
  function wordSet(s) {
    const o = Object.create(null);
    s.split(/\s+/).forEach(function (w) { if (w) o[w] = true; });
    return o;
  }
  const CAPTION_FUNCTION_WORDS = {
    en: wordSet("a an the of to in on at by for with from into onto over under about as than"),
    fr: wordSet("le la les un une des du de au aux à en dans sur sous avec pour par sans chez ce cet cette ces"),
    es: wordSet("el la los las un una unos unas de del a al en con por para sin sobre entre"),
    pt: wordSet("o a os as um uma uns umas de do da dos das em no na nos nas por para com sem sobre ao aos à às"),
    it: wordSet("il lo la i gli le un uno una di del dello della dei degli delle a al allo alla ai agli alle da dal dalla in nel nella con su sul per tra fra"),
    de: wordSet("der die das den dem des ein eine einen einem einer eines von zu zum zur mit in im an am auf aus bei nach für über unter vor durch gegen ohne um"),
  };
  // Korean tokens that attach to the word before them (dependent nouns,
  // spaced particles, counters).
  const CAPTION_KO_DEPENDENT = wordSet("수 것 줄 뿐 때문 따름 만큼 대로 듯 척 밖에 은 는 을 를 에 의 도 로 와 과 부터 까지 처럼 보다 에서 에게 한테 번 개 명 마리 원 분 시간 달 살 권 장 대");
  const CAPTION_UNIT_WORDS = wordSet(
    "% percent kg g mg km m cm mm l ml s sec ms min h hr hrs mb gb tb kb kbps fps px usd eur gbp krw " +
    "second seconds minute minutes hour hours day days week weeks month months year years dollars euros pounds " +
    "secondes minutes heure heures jour jours semaines mois an ans euros segundos minutos hora horas día días semana semanas mes meses año años " +
    "dia dias ano anos mês meses secondi minuti ora ore giorno giorni settimana settimane mese anno anni " +
    "sekunden minuten stunde stunden tag tage woche wochen monat monate jahr jahre prozent " +
    "개 명 원 번 살 시 분 초 년 월 일 퍼센트 배 마리 권 장 대 층 위 점 만 억 조 " +
    "分钟 分鐘 分 秒 小时 小時 時間 时 時 天 日 年 月 个 個 本 人 円 元 块 塊 歳 岁 歲 回 次 倍 万 萬 億 亿 度"
  );
  const CAPTION_CJK_UNIT_ALT = "分钟|分鐘|小时|小時|時間|秒钟|秒鐘|个|個|年|月|日|号|號|天|周|週|岁|歲|歳|円|元|块|塊|人|回|次|倍|本|台|件|位|万|萬|億|亿|度|時|时|分|秒";
  const CJK_CHAR_RE = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿]/;
  const CJK_TOKEN_RE = new RegExp(
    "\\d+(?:[.,]\\d+)*(?:%|％|[A-Za-z]+|" + CAPTION_CJK_UNIT_ALT + ")?|[A-Za-z][A-Za-z0-9'’\\-_]*|[\\uAC00-\\uD7A3]+|[\\s\\S]",
    "g"
  );
  // marks that never start a row / never end a row (kinsoku)
  const CJK_NO_START = "、。，．！？：；…）」』”’】》〉］｝ー々ゝゞゃゅょっぁぃぅぇぉゎャュョッァィゥェォヮ,.!?;:)]";
  const CJK_NO_END = "（「『“‘【《〈［｛([";
  const SPAN_OPENER_RE = /^[(\[（「『“‘«‹"]/;
  const SPAN_CLOSER_RE = /[)\]）」』”’»›"][.,!?…;:]*$/;
  const SPAN_CAP_WORDS = 6;
  const SPAN_CAP_UNITS = 14;

  function captionStripEdge(t) {
    return String(t).replace(/^[("'“‘«\[（「『]+/, "").replace(/[)"'”’»\]）」』.,!?…:;，。！？]+$/, "");
  }

  // The language a caption is in: an explicit tag's primary subtag, else
  // guessed from the script (Hangul -> ko, kana -> ja, Han -> zh).
  function captionLang(lang, texts) {
    const p = String(lang || "").split(/[-_]/)[0].toLowerCase();
    if (p) return p;
    const s = (texts || []).join(" ");
    if (/[가-힣]/.test(s)) return "ko";
    if (/[぀-ヿ]/.test(s)) return "ja";
    if (CJK_CHAR_RE.test(s)) return "zh";
    return "";
  }

  // captionGlue(texts, lang, opts) -> boolean[] — glue[i]: no break between
  // texts[i] and texts[i+1]. opts.spanCap sets the longest parenthesis/quote
  // span kept whole (a longer one could never fit a row).
  function captionGlue(texts, lang, opts) {
    const n = texts.length;
    const glue = new Array(n).fill(false);
    const lg = captionLang(lang, texts);
    const fw = CAPTION_FUNCTION_WORDS[lg];
    const spanCap = (opts && opts.spanCap) || SPAN_CAP_WORDS;
    for (let i = 0; i + 1 < n; i++) {
      const t = String(texts[i]);
      const nx = String(texts[i + 1]);
      const pause = CAPTION_PHRASE_END.test(t);
      if (/\d$/.test(t) && CAPTION_UNIT_WORDS[captionStripEdge(nx).toLowerCase()]) glue[i] = true;
      else if (pause) continue;
      else if (fw && fw[captionStripEdge(t).toLowerCase()]) glue[i] = true;
      else if (lg === "fr" && /^[A-Za-z]{1,2}['’]$/.test(t)) glue[i] = true;
      else if (lg === "ko" && (CAPTION_KO_DEPENDENT[captionStripEdge(nx)] || (captionStripEdge(t) === "밖에" && /^없/.test(nx)))) glue[i] = true;
    }
    let open = -1;
    for (let i = 0; i < n; i++) {
      const t = String(texts[i]);
      if (open < 0) {
        if (SPAN_OPENER_RE.test(t) && !(t.length > 1 && SPAN_CLOSER_RE.test(t.slice(1)))) open = i;
      } else if (SPAN_CLOSER_RE.test(t)) {
        if (i - open <= spanCap) for (let k = open; k < i; k++) glue[k] = true;
        open = -1;
      } else if (i - open > spanCap) {
        open = -1;
      }
    }
    return glue;
  }

  // captionUnits(part, lang) -> {texts, sp, glue} — the break units of one
  // caption part. A whitespace word is one unit, except a word holding Han or
  // kana, which splits into characters (wrapping by character) while a
  // number+unit, a Latin word and a Hangul run stay whole and closing /
  // opening marks stay with their neighbour. sp[i]: a space precedes unit i.
  function captionUnits(part, lang) {
    const tokens = String(part || "").split(/\s+/).filter(function (t) { return t.length > 0; });
    const texts = [];
    const sp = [];
    const own = [];
    let anyCjk = false;
    tokens.forEach(function (tok, ti) {
      if (!CJK_CHAR_RE.test(tok)) {
        texts.push(tok);
        sp.push(ti > 0);
        own.push(false);
        return;
      }
      anyCjk = true;
      const pieces = tok.match(CJK_TOKEN_RE) || [tok];
      pieces.forEach(function (p, pi) {
        const k = texts.length;
        texts.push(p);
        sp.push(pi === 0 && ti > 0);
        own.push(false);
        if (pi > 0 && CJK_NO_START.indexOf(p) >= 0) own[k - 1] = true;
        if (CJK_NO_END.indexOf(p) >= 0) own[k] = true;
      });
    });
    const glue = captionGlue(texts, lang, { spanCap: anyCjk ? SPAN_CAP_UNITS : SPAN_CAP_WORDS });
    for (let i = 0; i < glue.length - 1; i++) glue[i] = glue[i] || own[i];
    if (glue.length) glue[glue.length - 1] = false;
    return { texts: texts, sp: sp, glue: glue };
  }

  // greedyFillRows(widths, spaceW, w, gaps) — packs word indices into rows,
  // filling each row to w before starting the next (the plain wrap rule).
  // A single word always starts its own row even if it alone exceeds w.
  // gaps[i] (optional) replaces spaceW as the space before word i.
  function greedyFillRows(widths, spaceW, w, gaps) {
    const rows = [];
    let cur = [];
    let curW = 0;
    for (let i = 0; i < widths.length; i++) {
      const gap = gaps ? gaps[i] : spaceW;
      const next = cur.length ? curW + gap + widths[i] : widths[i];
      if (cur.length && next > w) {
        rows.push(cur);
        cur = [i];
        curW = widths[i];
      } else {
        cur.push(i);
        curW = next;
      }
    }
    if (cur.length) rows.push(cur);
    return rows;
  }

  function balanceRowsCore(widths, spaceW, maxW, gaps) {
    if (!widths.length) return { rows: [], widths: [] };
    const greedy = greedyFillRows(widths, spaceW, maxW, gaps);
    const n = greedy.length;
    const rowWidth = function (row) {
      return row.reduce(function (sum, i, idx) {
        return sum + widths[i] + (idx > 0 ? (gaps ? gaps[i] : spaceW) : 0);
      }, 0);
    };
    if (n <= 1) return { rows: greedy, widths: greedy.map(rowWidth) };
    const widestWord = Math.max.apply(null, widths);
    let lo = widestWord;
    let hi = maxW;
    for (let iter = 0; iter < 30; iter++) {
      const mid = (lo + hi) / 2;
      const rows = greedyFillRows(widths, spaceW, mid, gaps);
      if (rows.length <= n) hi = mid;
      else lo = mid;
    }
    const balanced = greedyFillRows(widths, spaceW, hi, gaps);
    return { rows: balanced, widths: balanced.map(rowWidth) };
  }

  // balanceRows(widths, spaceW, maxW, opts) -> {rows, widths} — same row count
  // as a plain greedy fill at maxW, but rows are as even as possible instead
  // of each one packed to the limit (which strands a short last word
  // alone). Binary-searches the narrowest width, no narrower than the
  // widest single word, that still greedy-fills to that same row count.
  // opts.gaps[i]: the space before word i (0 inside a CJK run).
  // opts.glue[i]: words i and i+1 never split across rows (captionGlue); a
  // glued group wider than maxW falls back to splitting at its words.
  function balanceRows(widths, spaceW, maxW, opts) {
    const o = opts || {};
    const gaps = o.gaps || null;
    const glue = o.glue || null;
    if (!glue || !glue.some(Boolean)) return balanceRowsCore(widths, spaceW, maxW, gaps);
    const gapOf = function (i) { return gaps ? gaps[i] : spaceW; };
    const atoms = [];
    for (let i = 0; i < widths.length; i++) {
      let j = i;
      while (j + 1 < widths.length && glue[j]) j++;
      let w = 0;
      for (let k = i; k <= j; k++) w += widths[k] + (k > i ? gapOf(k) : 0);
      if (j > i && w > maxW) {
        for (let k = i; k <= j; k++) atoms.push({ from: k, to: k, w: widths[k] });
      } else {
        atoms.push({ from: i, to: j, w: w });
      }
      i = j;
    }
    const core = balanceRowsCore(
      atoms.map(function (a) { return a.w; }),
      spaceW,
      maxW,
      atoms.map(function (a) { return gapOf(a.from); })
    );
    const rows = core.rows.map(function (row) {
      const out = [];
      row.forEach(function (ai) { for (let k = atoms[ai].from; k <= atoms[ai].to; k++) out.push(k); });
      return out;
    });
    const rowWidths = rows.map(function (row) {
      return row.reduce(function (sum, i, idx) { return sum + widths[i] + (idx > 0 ? gapOf(i) : 0); }, 0);
    });
    return { rows: rows, widths: rowWidths };
  }

  // balanceParts(widths, spaceW, maxW, partSizes, opts) -> {rows, widths} —
  // balanceRows over consecutive runs of words: partSizes[k] words form part
  // k, and a part never shares a row with the next (a caption's own "\n").
  // Row entries are indices into the full `widths` array. opts.gaps/opts.glue
  // are full-length arrays (see balanceRows).
  function balanceParts(widths, spaceW, maxW, partSizes, opts) {
    const o = opts || {};
    const rows = [];
    const rowWidths = [];
    let off = 0;
    for (const n of partSizes) {
      if (n > 0) {
        const glue = o.glue ? o.glue.slice(off, off + n) : null;
        if (glue) glue[n - 1] = false;
        const r = balanceRows(widths.slice(off, off + n), spaceW, maxW, {
          gaps: o.gaps ? o.gaps.slice(off, off + n) : null,
          glue: glue,
        });
        r.rows.forEach(function (row, k) {
          rows.push(row.map(function (i) { return i + off; }));
          rowWidths.push(r.widths[k]);
        });
      }
      off += n;
    }
    return { rows: rows, widths: rowWidths };
  }

  // The parts of a caption text: a "\n" or a standalone "|" (a writer's own
  // break) starts a new part. Each part wraps on its own rows.
  function splitCaptionParts(text) {
    return String(text || "").split(/\n|(?:^|\s)\|(?=\s|$)/);
  }

  // captionRows(ctx, text, maxW, lang) -> {words, widths, gaps, spaceW, rows,
  // rowWidths} for a film that draws its own caption (pills, per-word colour):
  // the break units with "|" markers removed (a word, or a character inside a
  // CJK run), each unit's width in ctx's current font, gaps[i] = the space
  // before unit i (spaceW between words, 0 inside a CJK run), and balanced
  // rows where a "\n" in `text` always starts a new row and the break rules
  // above hold. Join a row's units with gaps[i] to draw it.
  function captionRows(ctx, text, maxW, lang) {
    const spaceW = ctx.measureText(" ").width;
    const words = [];
    const gaps = [];
    const glue = [];
    const sizes = [];
    splitCaptionParts(text).forEach(function (part) {
      const u = captionUnits(part, lang);
      u.texts.forEach(function (t, i) {
        words.push(t);
        gaps.push(u.sp[i] ? spaceW : 0);
        glue.push(u.glue[i]);
      });
      sizes.push(u.texts.length);
    });
    const widths = words.map(function (word) { return ctx.measureText(word).width; });
    const b = balanceParts(widths, spaceW, maxW, sizes, { gaps: gaps, glue: glue });
    return { words: words, widths: widths, gaps: gaps, spaceW: spaceW, rows: b.rows, rowWidths: b.widths };
  }

  // wrapParts(ctx, text, w, lang) — "\n" in `text` forces a break (a caption
  // the automatic wrap would split badly); each part then wraps at its break
  // units to fit w, balanced (balanceRows above) rather than packed to the
  // limit. Returns one entry per part: its wrapped line strings and how many
  // units landed on each row (textBlock's orphan check reads the latter;
  // wrapLines below just flattens the former).
  function wrapParts(ctx, text, w, lang) {
    const spaceW = ctx.measureText(" ").width;
    const parts = [];
    for (const part of splitCaptionParts(text)) {
      const u = captionUnits(part, lang);
      if (!u.texts.length) continue;
      const widths = u.texts.map(function (t) { return ctx.measureText(t).width; });
      const gaps = u.sp.map(function (s) { return s ? spaceW : 0; });
      const balanced = balanceRows(widths, spaceW, w, { gaps: gaps, glue: u.glue });
      const lines = balanced.rows.map(function (row) {
        return row.map(function (i, k) {
          return (k > 0 && u.sp[i] ? " " : "") + u.texts[i];
        }).join("");
      });
      parts.push({ lines: lines, rowWordCounts: balanced.rows.map(function (row) { return row.length; }) });
    }
    return parts;
  }

  // wrapLines(ctx, text, w) — the flat line strings from wrapParts, for
  // callers that only need the wrapped text (height, drawing y-offsets).
  function wrapLines(ctx, text, w) {
    return wrapParts(ctx, text, w).reduce(function (all, part) {
      return all.concat(part.lines);
    }, []);
  }

  // Phrase-ending punctuation (half- and full-width): a caption chunk
  // never splits a phrase mid-clause when it doesn't have to.
  const CAPTION_PHRASE_END = /[,.!?…，。！？]$/;

  // char length of a run of words as captionChunks would render it
  // (word lengths + one separator char between each).
  function phraseCharLen(idxs, words) {
    let total = 0;
    for (let j = 0; j < idxs.length; j++) {
      total += String(words[idxs[j]].w).length;
      if (j > 0) total += 1;
    }
    return total;
  }

  // Splits `idxs` into `k` contiguous groups as even as possible by word
  // count (remainder words go to the earliest groups). Word-by-word
  // captions read a chunk at a time, so an even split reads at a steady
  // pace; a char-length-minimizing split can still strand a short last
  // group (e.g. one long word pushes everything else forward one chunk).
  // `glue` (optional, indexed by word index): a cut never lands where
  // glue[idxs[p-1]] is set; the nearest allowed cut is used instead.
  function splitEvenlyByCount(idxs, k, glue) {
    const n = idxs.length;
    const base = Math.floor(n / k);
    let remainder = n % k;
    const cuts = [];
    let want = 0;
    let prev = 0;
    for (let g = 1; g < k; g++) {
      want += base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const lo = prev + 1;
      let cut = Math.min(Math.max(want, lo), n - (k - g));
      if (glue) {
        // glued words can leave fewer legal cuts than k-1: a cut with no
        // legal place is dropped (a chunk longer than the even share) rather
        // than made inside a glued pair
        cut = -1;
        for (let d = 0; d <= n && cut < 0; d++) {
          const cands = d === 0 ? [want] : [want - d, want + d];
          const ok = cands.filter(function (p) { return p >= lo && p <= n - 1 && !glue[idxs[p - 1]]; });
          if (ok.length) cut = ok[0];
        }
        if (cut < 0) continue;
      }
      cuts.push(cut);
      prev = cut;
    }
    const groups = [];
    let at = 0;
    cuts.concat([n]).forEach(function (c) {
      groups.push(idxs.slice(at, c));
      at = c;
    });
    return groups;
  }

  // captionChunks(words, maxChars, opts) -> array of chunks, each an array
  // of indices into `words` ([{w, start, end}, ...]). The film's own
  // word-by-word caption code (pipeline.md "Picture first") uses this to
  // decide where a caption breaks, instead of a running char count that
  // breaks wherever it happens to cross maxChars — that leaves a lone
  // trailing word whenever the break lands one word short of the limit
  // (references/craft.md; the owner's report: "다음 토큰은 뭘까? ...
  // 답을 만들어" / "가!").
  //   1. split at phrase-ending punctuation (CAPTION_PHRASE_END) or a
  //      forced break (opts.breaks — captionBreaksFromText, a plan line's
  //      own "|" marker) — a phrase runs through the word that carries the
  //      punctuation or the forced break.
  //   2. a phrase longer than maxChars splits into k = ceil(len/maxChars)
  //      chunks, words distributed evenly by count (splitEvenlyByCount).
  //      A forced-break phrase goes through this same step, so a long
  //      "|"-delimited piece still balances instead of overflowing.
  //   3. a one-word chunk of <=3 characters (a lone connector, e.g. "자,")
  //      merges into its neighbour (next if there is one, else previous).
  // Fallback rules (captionGlue, opts.lang = BCP 47): a line that fits
  // maxChars is not cut at a comma; no cut splits a number from its unit,
  // follows an article/preposition, or falls inside a parenthesis/quote span.
  // A writer's "|" always wins over all of them.
  function captionChunks(words, maxChars, opts) {
    const n = words.length;
    if (!n) return [];
    const forcedBreaks = (opts && opts.breaks) || [];
    const isForcedBreak = {};
    for (let i = 0; i < forcedBreaks.length; i++) isForcedBreak[forcedBreaks[i]] = true;

    // Automatic fallback rules (captionGlue): a line that fits one chunk is
    // not cut at a comma, and no cut falls inside a number+unit, after a
    // short function word, or inside a parenthesis/quote span. A forced
    // break ("|") overrides all of it.
    const glue = captionGlue(words.map(function (x) { return String(x.w); }), opts && opts.lang);
    const allIdx = words.map(function (x, i) { return i; });
    const fitsOneRow = phraseCharLen(allIdx, words) <= maxChars;

    const phrases = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      cur.push(i);
      const punctEnd = !fitsOneRow && !glue[i] && CAPTION_PHRASE_END.test(String(words[i].w));
      if (punctEnd || isForcedBreak[i]) {
        phrases.push(cur);
        cur = [];
      }
    }
    if (cur.length) phrases.push(cur);

    let chunks = [];
    for (const phrase of phrases) {
      const len = phraseCharLen(phrase, words);
      if (phrase.length <= 1 || len <= maxChars) {
        chunks.push(phrase);
        continue;
      }
      const k = Math.min(phrase.length, Math.max(1, Math.ceil(len / maxChars)));
      chunks = chunks.concat(splitEvenlyByCount(phrase, k, glue));
    }

    // A writer's "|" always wins: a short piece merges only across an
    // automatic boundary, never across a forced one.
    const endsForced = function (c) { return !!isForcedBreak[c[c.length - 1]]; };
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length !== 1) continue;
      if (String(words[chunks[i][0]].w).length > 3) continue;
      if (i + 1 < chunks.length && !endsForced(chunks[i])) {
        chunks[i] = chunks[i].concat(chunks[i + 1]);
        chunks.splice(i + 1, 1);
      } else if (i > 0 && !endsForced(chunks[i - 1])) {
        chunks[i - 1] = chunks[i - 1].concat(chunks[i]);
        chunks.splice(i, 1);
      }
    }

    // Balancing already made this rare; a chunk it still can't fix (the
    // merge above only catches <=3-char remnants) is reported, not forced.
    if (n >= 3) {
      for (let ci = 0; ci < chunks.length; ci++) {
        const c = chunks[ci];
        const forcedAround = endsForced(c) || (ci > 0 && endsForced(chunks[ci - 1]));
        if (c.length === 1 && !forcedAround) {
          recordIssue({
            type: "caption-orphan",
            text: words.map(function (x) { return x.w; }).join(" ").slice(0, 80),
            lastRow: words[c[0]].w,
          });
        }
      }
    }

    return chunks;
  }

  // A plan line's own "|" forces a caption-chunk break there (validate-plan.mjs
  // rejects "||" and a leading/trailing "|" — it must appear as its own
  // whitespace-separated token). "|" is never spoken (pronounce.mjs's
  // stripCaptionBreaks removes it before TTS/STT and before a word-timing
  // split) and never a word itself, so captionBreaksFromText(text) walks the
  // same whitespace tokenization skipping "|" tokens, returning the index
  // (into the real, marker-free words — the same indexing captionChunks'
  // `words` and a word-timing split both use) after which the break falls.
  function captionBreaksFromText(text) {
    const tokens = String(text || "").split(/\s+/).filter(function (t) { return t.length > 0; });
    const breaks = [];
    let idx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "|") {
        if (idx >= 0) breaks.push(idx);
        continue;
      }
      idx++;
    }
    return breaks;
  }

  // Tokenizes `text` the same way, but as the words themselves (never
  // counting a "|" marker as a word) — the fallback path for a word index
  // derived straight from text (cue matching, proportional word-timing) when
  // no measured per-word timing exists.
  function textWordsExcludingBreaks(text) {
    return String(text || "").split(/\s+/).filter(function (t) { return t.length > 0 && t !== "|"; });
  }

  // `text` for the engine's default Reel.caption() box: every "|" marker
  // becomes a "\n" (a writer's break starts a new row), so the marker is
  // never shown and wrapParts never joins the two sides.
  function stripCaptionBreaksForDisplay(text) {
    return splitCaptionParts(text)
      .map(function (part) {
        return part.split(/\s+/).filter(function (t) { return t.length > 0; }).join(" ");
      })
      .join("\n");
  }

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
    const parts = wrapParts(ctx, text, w, o.lang);
    const lines = parts.reduce(function (all, part) {
      return all.concat(part.lines);
    }, []);

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

    // A row balanced down to one word still happens when a part's other
    // rows can't shrink further (references/craft.md — a caption row never
    // holds one short word alone). Report it; balancing already made it
    // rare, and this is a report, not an enforcement (tools report facts).
    for (const part of parts) {
      const n = part.rowWordCounts.length;
      if (n < 2) continue;
      const lastRowWords = part.rowWordCounts[n - 1];
      const prevRowWords = part.rowWordCounts[n - 2];
      if (lastRowWords === 1 && prevRowWords >= 3) {
        recordIssue({
          type: "caption-orphan",
          text: String(text).slice(0, 80),
          lastRow: part.lines[n - 1],
        });
      }
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
    if (!_captionsOn) return;
    const o = opts || {};
    if (!line || !line.text) return;
    const width = o.width == null ? (ctx.canvas ? ctx.canvas.width : 1080) : o.width;
    const height = o.height == null ? (ctx.canvas ? ctx.canvas.height : 1920) : o.height;
    const fontPx = o.fontPx == null ? captionFontSizePx(height) : o.fontPx;
    const lineHeight = o.lineHeight == null ? Math.round(fontPx * 1.25) : o.lineHeight;
    const safe = centeredSafeArea(width, height);
    const boxW = o.boxW == null ? (width > height ? Math.min(safe.w, width * 0.7) : safe.w) : o.boxW;
    const boxH = o.boxH == null ? lineHeight * 2 + 20 : o.boxH;
    const x = o.x == null ? safe.x + (safe.w - boxW) / 2 : o.x;
    const y = o.y == null ? safe.y + safe.h - boxH - (o.marginBottom == null ? 0 : o.marginBottom) : o.y;
    const font = o.font == null ? "800 " + fontPx + "px 'Pretendard'" : o.font;
    const captionOpts = Object.assign({ align: "center", font: font, lineHeight: lineHeight, lang: pictureLang() || undefined }, o);
    return textBlock(ctx, stripCaptionBreaksForDisplay(line.text), x, y, boxW, boxH, captionOpts);
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
      const words = textWordsExcludingBreaks(text);
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
      const words = textWordsExcludingBreaks(text);
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
    // lead: seconds of opening before the first story line (plan meta.lead); scene code draws
    // it from t = 0 like any other span.
    return { line, word, phrase, lead: (timings && timings.lead) || 0 };
  }

  // ---------------------------------------------------------------------
  // asset library cues (design.md §2.5)
  // ---------------------------------------------------------------------

  // Index (within line.text's whitespace-split words) of the first word
  // containing `substr`, or -1.
  function firstWordIndexContaining(text, substr) {
    const words = textWordsExcludingBreaks(text);
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

  // clocks(captionTimings, baseTimings) — the two clocks of a dub. In
  // ?layer=captions&dub=<code> the caption layer follows that language's
  // voice (captionTimings = dub/<code>/timings.placed.json), while every other
  // layer a film draws there (labels, beats, stickers, animations keyed to a
  // word, sound cues) reads the base language's clock (baseTimings =
  // voice/timings.json), unchanged from the original film.
  //   .caption / .base            timeline() of each clock
  //   .cueTime(cue, lineId)       a word/start/end cue in base-clock seconds
  //   .baseLine(lineId)           the base clock's line {id, start, end, ...}
  //   .word(lineId, text)         {start, end} of the first word containing
  //                               `text` in the base language, base clock
  // Line ids are shared by both clocks (dub lines keep their base line's id).
  // With no baseTimings both clocks are captionTimings.
  function clocks(captionTimings, baseTimings) {
    const baseT = baseTimings || captionTimings;
    const base = timeline(baseT);
    const baseLines = (baseT && baseT.lines) || [];
    function baseLine(lineId) {
      return baseLines.find(function (l) { return l.id === lineId; }) || null;
    }
    return {
      caption: timeline(captionTimings),
      base: base,
      baseTimings: baseT,
      baseLine: baseLine,
      cueTime: function (cue, lineId) {
        const line = baseLine(lineId);
        if (!line) {
          recordIssue({ type: "cue-line-not-found", asset: cue && cue.asset, lineId: lineId });
          return 0;
        }
        return cueTime(cue, line, baseT);
      },
      word: function (lineId, text) {
        const idx = baseLines.findIndex(function (l) { return l.id === lineId; });
        if (idx === -1) return null;
        const wi = firstWordIndexContaining(baseLines[idx].text, text);
        return wi === -1 ? null : base.word(idx, wi);
      },
    };
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
    moving,
    wobblePath,
    hold,
    drawOn,
    imageCover,
    textBlock,
    balanceRows,
    balanceParts,
    captionRows,
    captionChunks,
    captionGlue,
    captionUnits,
    captionBreaksFromText,
    caption,
    captionsOn,
    layer,
    dubCode,
    layerFiles,
    clocks,
    pictureText,
    pictureTextFrom,
    get lang() {
      return pictureLang();
    },
    safeArea,
    centeredSafeArea,
    setSafeArea,
    checkSafe,
    transformedBBox,
    easeOutCubic,
    easeOutBack,
    settle,
    monotoneTrack,
    inWindows,
    timeline,
    issues,
    clearIssues,
    recordIssue,
    cueTime,
    registerClip,
    clipFrame,
  };
})();
