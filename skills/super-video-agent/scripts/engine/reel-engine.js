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
  // clip blend (references/3d.md "Switching between clips")
  // ---------------------------------------------------------------------

  // clipBlend(switches, t, clips, opts) -> [{clip, weight, time}]
  // switches: [{at, clip}] sorted by `at`. clips: {name: {duration, loop?}} with the loaded clip's real
  // length (clip.duration), never a number typed into the page. A pure function of t, so any seek order
  // gives the same pose: the current clip is the last switch with at <= t, the previous clip is the one
  // before it, weight w = ease(clamp01((t - at) / blend)) for the current clip and 1 - w for the previous;
  // the previous clip is left out once w is 1. `time` is the clip's own local time: a looping clip wraps
  // at its length, any other holds its last pose. The first clip has no previous one: weight 1 throughout.
  // opts: {blend: seconds, default 0.25 (a starting point for a body action; a slow one wants longer),
  // ease: (u) => u, default linear}.
  function clipBlend(switches, t, clips, opts) {
    const o = opts || {};
    const blend = o.blend == null ? 0.25 : o.blend;
    const ease = o.ease || function (u) { return u; };
    let cur = 0;
    for (let i = 0; i < switches.length; i++) if (switches[i].at <= t) cur = i;
    const localTime = function (sw) {
      const c = clips[sw.clip];
      if (!c || !(c.duration > 0)) throw new Error("clipBlend: clips[" + JSON.stringify(sw.clip) + "] needs a duration from the loaded clip");
      const elapsed = Math.max(0, t - sw.at);
      return c.loop ? elapsed % c.duration : Math.min(elapsed, c.duration);
    };
    const w = cur === 0 || !(blend > 0) ? 1 : clamp01(ease(clamp01((t - switches[cur].at) / blend)));
    const out = [{ clip: switches[cur].clip, weight: w, time: localTime(switches[cur]) }];
    if (cur > 0 && w < 1) out.push({ clip: switches[cur - 1].clip, weight: 1 - w, time: localTime(switches[cur - 1]) });
    return out;
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
  // For tools only: render.mjs turns captions off for one extra capture of a frame it already drew, so the
  // caption's pixels can be told from the picture behind them (caption contrast). A page never calls this.
  function setCaptionsOn(on) {
    _captionsOn = !!on;
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
    var strings = p && p.strings;
    var v = pictureTextFrom(strings, key, fallback);
    // The language's own text is missing: the base text is drawn silently
    // otherwise (item 43). Reported as a fact; a brand kept as is can be
    // listed with the same value to say so. Never enumerates `strings`
    // (render.mjs's string-read tracking would see "all keys").
    if (v === fallback && _baseLang && p && p.lang && !samePrimaryLang(p.lang, _baseLang) && !hasOwnString(strings, key)) {
      recordIssue({ type: "picture-string-missing", key: String(key), lang: String(p.lang) });
    }
    return v;
  }
  function hasOwnString(strings, key) {
    if (!strings || typeof strings !== "object" || !Object.prototype.hasOwnProperty.call(strings, key)) return false;
    return typeof strings[key] === "string" && strings[key] !== "";
  }
  // The film's own language (plan.meta.lang); a page sets it once so a
  // missing translation is told from the base language drawing its own text.
  var _baseLang = null;
  function setBaseLang(lang) {
    _baseLang = lang ? String(lang) : null;
  }

  // overlayText(overlay, key, fallback, {dub, base}) — a 2D caption-layer
  // label in the language being drawn: overlay is dub/<code>/plan.json
  // meta.overlay, the fallback the base language's string. A key the language
  // lacks is recorded (overlay-text-missing) when dub names a language other
  // than base; the base language itself never reports.
  function overlayText(overlay, key, fallback, o) {
    const v = pictureTextFrom(overlay, key, fallback);
    const dub = o && o.dub;
    const base = (o && o.base) || _baseLang;
    if (v === fallback && dub && base && !samePrimaryLang(dub, base) && !hasOwnString(overlay, key)) {
      recordIssue({ type: "overlay-text-missing", key: String(key), lang: String(dub) });
    }
    return v;
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
    const note = safeAreaNote();
    if (note && typeof console !== "undefined") console.info(note);
  }

  // With "none" the whole frame is safe, so checkSafe can never record an
  // issue: a clean report then proves nothing. Says so (a fact, not a pass).
  function safeAreaNote() {
    return _safeKind === "none"
      ? 'checked nothing: the safe area is "none", so no text can fall outside it (text-outside-safe-area is never recorded). Confirm this video needs this check; if it does, make a safe-area preset (not "none") and rerun only this check.'
      : null;
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
  // opts.outline: the stroke width (px, local space) of an outline drawn
  // around the text; a stroke reaches half its width past the glyph box on
  // every side, so the box grows by outline / 2 before the test.
  function checkSafe(ctx, text, left, top, right, bottom, width, height, opts) {
    const cw = width || (ctx.canvas ? ctx.canvas.width : 1080);
    const ch = height || (ctx.canvas ? ctx.canvas.height : 1920);
    const s = safeArea(cw, ch);
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const pad = opts && opts.outline > 0 ? opts.outline / 2 : 0;
    const box = transformedBBox(m, left - pad, top - pad, right + pad, bottom + pad);
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
  //   - ko: a determiner or numeral ("몇", "한", "그", "열두") never ends a row,
  //     and a counter after one keeps the noun that follows ("열두 개 언어")
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
  // Per-language words that never end a row or chunk: a determiner or numeral
  // (CAPTION_LEAD_WORDS), and a counter that follows one of them or a digit
  // (CAPTION_LEAD_COUNTERS: "열두 개" keeps its noun).
  const CAPTION_LEAD_WORDS = {
    ko: wordSet("몇 한 두 세 네 다섯 여섯 일곱 여덟 아홉 열 열한 열두 스무 이 그 저 어떤 어느 모든 각 여러 새 첫"),
  };
  const CAPTION_LEAD_COUNTERS = {
    ko: wordSet("개 명 마리 권 장 번 곳 가지 분 대 채 편"),
  };
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
    const lead = CAPTION_LEAD_WORDS[lg];
    const leadCounters = CAPTION_LEAD_COUNTERS[lg];
    const spanCap = (opts && opts.spanCap) || SPAN_CAP_WORDS;
    for (let i = 0; i + 1 < n; i++) {
      const t = String(texts[i]);
      const nx = String(texts[i + 1]);
      const pause = CAPTION_PHRASE_END.test(t);
      if (/\d$/.test(t) && CAPTION_UNIT_WORDS[captionStripEdge(nx).toLowerCase()]) glue[i] = true;
      else if (pause) continue;
      else if (fw && fw[captionStripEdge(t).toLowerCase()]) glue[i] = true;
      else if (lg === "fr" && /^[A-Za-z]{1,2}['’]$/.test(t)) glue[i] = true;
      else if (lead && lead[captionStripEdge(t)]) glue[i] = true;
      else if (leadCounters && leadCounters[captionStripEdge(t)] && i > 0 &&
        (lead[captionStripEdge(String(texts[i - 1]))] || /\d$/.test(String(texts[i - 1])))) glue[i] = true;
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
  // The 4th argument is the language code, or an options object
  // {lang, stroke}. stroke (optional): the outline width (px) the film draws
  // around the caption; rows are fitted to maxW - stroke so the outline's
  // half-width on each side stays inside maxW. Pass the same value to
  // checkSafe's `outline`.
  function captionRows(ctx, text, maxW, langOrOpts) {
    const o = langOrOpts && typeof langOrOpts === "object" ? langOrOpts : { lang: langOrOpts };
    const lang = o.lang;
    const stroke = o.stroke > 0 ? o.stroke : 0;
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
    const b = balanceParts(widths, spaceW, maxW - stroke, sizes, { gaps: gaps, glue: glue });
    return { words: words, widths: widths, gaps: gaps, spaceW: spaceW, rows: b.rows, rowWidths: b.widths, stroke: stroke };
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

  function indexRange(from, to) {
    const out = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  }

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
  //   3. a one-word chunk merges into its neighbour (next if there is one,
  //      else previous) when the word is <=3 characters (a lone connector,
  //      e.g. "자,") or the joined chunk still fits maxChars.
  // Fallback rules (captionGlue, opts.lang = BCP 47): a "|" segment that fits
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
    // "fits one row" is judged per "|" segment: a piece the writer already cut
    // that fits maxChars keeps its commas even when the whole line is longer.
    const segmentFits = new Array(n);
    for (let from = 0; from < n; ) {
      let to = from;
      while (to < n - 1 && !isForcedBreak[to]) to++;
      const fits = phraseCharLen(indexRange(from, to), words) <= maxChars;
      for (let k = from; k <= to; k++) segmentFits[k] = fits;
      from = to + 1;
    }

    const phrases = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      cur.push(i);
      const punctEnd = !segmentFits[i] && !glue[i] && CAPTION_PHRASE_END.test(String(words[i].w));
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

    // A writer's "|" always wins: a one-word chunk merges only across an
    // automatic boundary, never across a forced one. A word of <= 3 chars
    // always merges; a longer lone word merges when the joined chunk still
    // fits maxChars (a single-word caption is a flash, not a phrase).
    const endsForced = function (c) { return !!isForcedBreak[c[c.length - 1]]; };
    const joinable = function (lone, other) {
      return String(words[lone[0]].w).length <= 3 || phraseCharLen(lone.concat(other), words) <= maxChars;
    };
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length !== 1) continue;
      if (i + 1 < chunks.length && !endsForced(chunks[i]) && joinable(chunks[i], chunks[i + 1])) {
        chunks[i] = chunks[i].concat(chunks[i + 1]);
        chunks.splice(i + 1, 1);
      } else if (i > 0 && !endsForced(chunks[i - 1]) && joinable(chunks[i], chunks[i - 1])) {
        chunks[i - 1] = chunks[i - 1].concat(chunks[i]);
        chunks.splice(i, 1);
        i--;
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
    const placed = lines.map((line) => {
      let dx = x;
      const lw = ctx.measureText(line).width;
      if (align === "center") dx = x + (w - lw) / 2;
      else if (align === "right") dx = x + (w - lw);
      left = Math.min(left, dx);
      right = Math.max(right, dx + lw);
      return { line, dx };
    });
    if (lines.length && o.band) {
      const padX = o.bandPadX == null ? lineHeight * 0.4 : o.bandPadX;
      const padY = o.bandPadY == null ? lineHeight * 0.15 : o.bandPadY;
      ctx.fillStyle = o.band;
      ctx.fillRect(left - padX, y - padY, right - left + padX * 2, totalHeight + padY * 2);
      ctx.fillStyle = color;
    }
    placed.forEach((p, i) => ctx.fillText(p.line, p.dx, y + i * lineHeight));
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
  // wrapped lines fit the shorter frame. With no o.color the text is white on
  // a dark translucent band (o.band, o.bandPadX, o.bandPadY; o.band = "" or a
  // transparent colour turns the band off).
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
    const family = captionFontFor(o.captionFonts, o.lang || pictureLang()) || "'Pretendard'";
    const font = o.font == null ? "800 " + fontPx + "px " + family : o.font;
    // Default look reads on any picture: light text on a dark translucent band.
    // An explicit o.color is the page's own choice and draws no band unless o.band is given.
    const look = o.color == null ? { color: "#fff", band: "rgba(0,0,0,0.62)" } : {};
    const captionOpts = Object.assign({ align: "center", font: font, lineHeight: lineHeight, lang: pictureLang() || undefined }, look, o);
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
  // corner notes (a term gloss in a corner of the frame) — drawn in the
  // per-language caption layer. A plan line carries
  //   notes: [{ at: "start" | "word:<text>", text, corner?: "tl"|"tr"|"bl"|"br", holdSec? }]
  // The note's wording is that language's own plan line (same line id); the
  // moment is the first word containing <text> in that language's own word
  // times (its timings line), so a note follows its word in every language.
  // ---------------------------------------------------------------------
  const NOTE_HOLD_SEC = 3.5;
  const NOTE_FADE_SEC = 0.2;
  const NOTE_CORNERS = { tl: 1, tr: 1, bl: 1, br: 1 };

  function planLinesById(plan) {
    const byId = Object.create(null);
    ((plan && plan.lines) || []).forEach(function (l) { byId[l.id] = l; });
    return byId;
  }

  // The moment a note appears on that language's clock; a word the line does
  // not contain falls back to the line start and is recorded.
  function noteStart(note, idx, line, tl) {
    const at = note.at == null ? "start" : note.at;
    if (at === "start") return line.start;
    if (typeof at === "string" && at.indexOf("word:") === 0) {
      const wi = firstWordIndexContaining(line.text, at.slice(5));
      const win = wi === -1 ? null : tl.word(idx, wi);
      if (win) return win.start;
    }
    recordIssue({ type: "note-word-not-found", lineId: line.id, at: String(at) });
    return line.start;
  }

  // cornerNotes({timings, plan, basePlan?}) -> [{id, lineId, text, corner, from, to}]
  // Pure. `timings` is the language being drawn (dub timings.placed.json),
  // `plan` that language's plan. A base note the language's line lacks is
  // recorded (note-missing-in-language) — the note would silently vanish.
  function cornerNotes(src) {
    const timings = src && src.timings;
    const lines = (timings && timings.lines) || [];
    const tl = timeline(timings);
    const own = planLinesById(src && src.plan);
    const base = planLinesById(src && src.basePlan);
    const duration = timings && Number.isFinite(timings.duration) ? timings.duration : Infinity;
    const out = [];
    lines.forEach(function (line, idx) {
      const notes = (own[line.id] && own[line.id].notes) || [];
      const baseNotes = (base[line.id] && base[line.id].notes) || [];
      if (src.basePlan && src.plan !== src.basePlan && baseNotes.length > notes.length) {
        recordIssue({ type: "note-missing-in-language", lineId: line.id, have: notes.length, base: baseNotes.length });
      }
      notes.forEach(function (note, k) {
        if (!note || typeof note.text !== "string" || !note.text) {
          recordIssue({ type: "note-text-missing", lineId: line.id, index: k });
          return;
        }
        const from = noteStart(note, idx, line, tl);
        const hold = note.holdSec > 0 ? note.holdSec : NOTE_HOLD_SEC;
        out.push({
          id: line.id + "#" + k,
          lineId: line.id,
          text: note.text,
          corner: NOTE_CORNERS[note.corner] ? note.corner : "tr",
          from: from,
          to: Math.min(from + hold, duration),
        });
      });
    });
    return out;
  }

  // drawCornerNotes(ctx, notes, t, opts) — the notes showing at t, each in
  // its corner of the safe area with a short fade; a pure function of t.
  // opts: {width, height, lang, font, fontPx, color, panel}
  function drawCornerNotes(ctx, notes, t, opts) {
    const o = opts || {};
    const width = o.width == null ? (ctx.canvas ? ctx.canvas.width : 1080) : o.width;
    const height = o.height == null ? (ctx.canvas ? ctx.canvas.height : 1920) : o.height;
    const fontPx = o.fontPx == null ? Math.max(24, Math.round(captionFontSizePx(height) * 0.55)) : o.fontPx;
    const lineHeight = Math.round(fontPx * 1.3);
    const pad = Math.round(fontPx * 0.5);
    const safe = safeArea(width, height);
    const boxW = Math.round(Math.min(safe.w * 0.45, width * 0.4));
    const font = o.font || "700 " + fontPx + "px " + (captionFontFor(o.captionFonts, o.lang) || "'Pretendard'");
    (notes || []).forEach(function (n) {
      if (t < n.from || t >= n.to) return;
      const a = Math.min(1, (t - n.from) / NOTE_FADE_SEC, (n.to - t) / NOTE_FADE_SEC);
      ctx.save();
      ctx.font = font;
      const lines = wrapLines(ctx, n.text, boxW - 2 * pad);
      const h = lines.length * lineHeight + 2 * pad;
      const x = n.corner.charAt(1) === "l" ? safe.x : safe.x + safe.w - boxW;
      const y = n.corner.charAt(0) === "t" ? safe.y : safe.y + safe.h - h;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = o.panel || "rgba(0,0,0,0.62)";
      ctx.fillRect(x, y, boxW, h);
      textBlock(ctx, n.text, x + pad, y + pad, boxW - 2 * pad, h - 2 * pad, {
        font: font, lineHeight: lineHeight, color: o.color || "#fff", lang: o.lang, width: width, height: height,
      });
      ctx.restore();
    });
  }

  // ---------------------------------------------------------------------
  // page declarations — optional window.__reel fields a tool reads:
  //   regions: [{id, kind: "key"|"label"|"overlay"|"reserve", box: [x0,y0,x1,y1], outline?, from?, to?}]
  //   holds: [{from, to, id?, reason?}]
  //   langSpans: [{start, end, in?: "layer"|"scene"}]
  //   captionFonts: {"<lang>": "<css font-family list>", "*": "<fallback>"}
  // A malformed entry is definitely wrong: the check throws and names it.
  // ---------------------------------------------------------------------
  const REGION_KINDS = { key: 1, label: 1, overlay: 1, reserve: 1 };
  const CORNER_NAMES = ["tl", "tr", "bl", "br"];
  const SPAN_PLACES = { layer: 1, scene: 1 };

  function declared(name, list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new Error("window.__reel." + name + " must be an array");
    return list;
  }
  function finite(v) {
    return typeof v === "number" && Number.isFinite(v);
  }
  function checkRegions(regions) {
    const list = declared("regions", regions);
    list.forEach(function (r, i) {
      const at = "window.__reel.regions[" + i + "]";
      if (!r || typeof r.id !== "string" || !r.id) throw new Error(at + ": id must be a non-empty string");
      if (!REGION_KINDS[r.kind]) throw new Error(at + " (" + r.id + '): kind must be "key", "label", "overlay" or "reserve"');
      const b = r.box;
      if (!Array.isArray(b) || b.length !== 4 || !b.every(finite) || !(b[2] > b[0]) || !(b[3] > b[1])) {
        throw new Error(at + " (" + r.id + "): box must be [x0, y0, x1, y1] in canvas px with x1 > x0 and y1 > y0");
      }
      if (r.outline != null && !(finite(r.outline) && r.outline >= 0)) throw new Error(at + " (" + r.id + "): outline must be a number >= 0");
      checkWindow(at + " (" + r.id + ")", r.from, r.to, "from", "to");
    });
    return list;
  }
  // cornerRegions(corners) -> regions: plan.json meta.corners ({tl|tr|bl|br: {box: [x0,y0,x1,y1], label?}})
  // as page regions of kind "reserve" (id "corner-<name>"), for `window.__reel.regions`. `label` is the
  // text the corner's own label draws; state-checks.mjs does not report that text as an intruder.
  function cornerRegions(corners) {
    if (!corners) return [];
    return CORNER_NAMES.filter(function (c) { return corners[c]; }).map(function (c) {
      const r = { id: "corner-" + c, kind: "reserve", box: corners[c].box };
      if (corners[c].label != null) r.text = String(corners[c].label);
      return r;
    });
  }
  function checkWindow(at, from, to, fromName, toName) {
    if (from != null && !finite(from)) throw new Error(at + ": " + fromName + " must be seconds");
    if (to != null && !finite(to)) throw new Error(at + ": " + toName + " must be seconds");
    if (from != null && to != null && !(to > from)) throw new Error(at + ": " + toName + " must be after " + fromName);
  }
  function checkHolds(holds) {
    const list = declared("holds", holds);
    list.forEach(function (h, i) {
      const at = "window.__reel.holds[" + i + "]";
      if (!h || !finite(h.from) || !finite(h.to) || !(h.to > h.from)) throw new Error(at + ": {from, to} seconds with to > from");
    });
    return list;
  }
  function checkLangSpans(spans) {
    const list = declared("langSpans", spans);
    list.forEach(function (s, i) {
      const at = "window.__reel.langSpans[" + i + "]";
      if (!s || !finite(s.start) || !finite(s.end) || !(s.end > s.start)) throw new Error(at + ": {start, end} seconds with end > start");
      if (s.in != null && !SPAN_PLACES[s.in]) throw new Error(at + ': in must be "layer" (drawn in the caption layer) or "scene" (text inside the picture)');
    });
    return list;
  }

  // captionFontFor(captionFonts, lang) -> the CSS font-family list for that
  // language: its exact tag, then its primary subtag, then "*"; null when
  // the map names none (the caller keeps its default).
  function captionFontFor(map, lang) {
    if (!map || typeof map !== "object") return null;
    const keys = Object.keys(map);
    const want = String(lang || "").toLowerCase();
    const exact = keys.find(function (k) { return k.toLowerCase() === want; });
    const primary = keys.find(function (k) { return k !== "*" && want && k.toLowerCase() === want.split(/[-_]/)[0]; });
    const key = exact || primary || (map["*"] != null ? "*" : null);
    return key && typeof map[key] === "string" && map[key] ? map[key] : null;
  }

  // ---------------------------------------------------------------------
  // parallax — 2.5D: flat layers at different depths under one camera path
  // ---------------------------------------------------------------------
  // Depth convention: depth >= 1. depth 1 is the nearest layer and follows the camera 1:1; a layer
  // at depth d moves 1/d as far and zooms (zoom - 1)/d as much, so a larger depth is farther away.
  // Every output is a pure function of (spec, t): no state between frames, safe to seek.

  const PARALLAX_EASES = {
    linear: function (u) {
      return u;
    },
    inOut: function (u) {
      return u * u * (3 - 2 * u);
    },
    out: easeOutCubic,
  };

  function parallaxEase(ease) {
    if (typeof ease === "function") return ease;
    return PARALLAX_EASES[ease || "inOut"] || PARALLAX_EASES.inOut;
  }

  function parallaxKeyPose(k) {
    return { x: k.x || 0, y: k.y || 0, zoom: k.zoom > 0 ? k.zoom : 1, rot: k.rot || 0 };
  }

  function parallaxMixPose(a, b, u) {
    return {
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      zoom: a.zoom * Math.pow(b.zoom / a.zoom, u),
      rot: a.rot + (b.rot - a.rot) * u,
    };
  }

  function parallaxSortedKeys(camera) {
    const keys = camera && Array.isArray(camera.keys) ? camera.keys.slice() : [];
    if (!keys.length) keys.push({ t: 0 });
    return keys.sort(function (a, b) {
      return a.t - b.t;
    });
  }

  // parallaxCamera(camera, t) -> {x, y, zoom, rot}: the camera at time t, held before the first key
  // and after the last; zoom is mixed by ratio so a push-in has even speed. rot is in degrees.
  function parallaxCamera(camera, t) {
    const keys = parallaxSortedKeys(camera);
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (t <= first.t) return parallaxKeyPose(first);
    if (t >= last.t) return parallaxKeyPose(last);
    let i = 0;
    while (keys[i + 1].t <= t) i++;
    const u = parallaxEase(camera.ease)((t - keys[i].t) / (keys[i + 1].t - keys[i].t));
    return parallaxMixPose(parallaxKeyPose(keys[i]), parallaxKeyPose(keys[i + 1]), u);
  }

  // parallaxPose(cam, depth, w, h) -> {tx, ty, zoom, rot}: where the frame centre lands for a layer
  // at `depth` (tx, ty in px), the layer's zoom about it and its rotation in radians.
  function parallaxPose(cam, depth, w, h) {
    const k = 1 / Math.max(depth, 1);
    return {
      tx: w / 2 - cam.x * k,
      ty: h / 2 - cam.y * k,
      zoom: 1 + (cam.zoom - 1) * k,
      rot: ((cam.rot * k) * Math.PI) / 180,
    };
  }

  function parallaxCheckLayer(layer, i) {
    const at = "parallax layers[" + i + "]";
    if (!layer || !(layer.image || typeof layer.draw === "function")) throw new Error(at + ": needs image or draw(ctx, w, h)");
    if (!(layer.depth >= 1) || !isFinite(layer.depth)) throw new Error(at + ": depth must be a number >= 1 (1 = nearest)");
  }

  // Layers back to front (deepest first); equal depths keep their array order.
  function parallaxOrdered(spec) {
    const layers = (spec && spec.layers) || [];
    layers.forEach(parallaxCheckLayer);
    return layers
      .map(function (layer, index) {
        return { layer: layer, index: index };
      })
      .sort(function (a, b) {
        return b.layer.depth - a.layer.depth || a.index - b.index;
      });
  }

  function parallaxSize(ctx, spec) {
    const w = spec.width || (ctx.canvas && ctx.canvas.width);
    const h = spec.height || (ctx.canvas && ctx.canvas.height);
    if (!(w > 0) || !(h > 0)) throw new Error("parallax: spec.width and spec.height are needed when ctx.canvas has no size");
    return { w: w, h: h };
  }

  // The layer's rest rectangle in frame px, before the camera: an image is cover-fitted to the frame
  // (fit "natural" keeps its own size), a draw layer is w x h (default the frame), then scaled about
  // the frame centre by layer.scale and spec.overscan and shifted by x, y.
  function parallaxRect(layer, overscan, w, h) {
    const src = layer.image;
    const iw = src ? src.naturalWidth || src.width : layer.w || w;
    const ih = src ? src.naturalHeight || src.height : layer.h || h;
    const fit = src && layer.fit !== "natural" ? Math.max(w / iw, h / ih) : 1;
    const s = fit * (layer.scale > 0 ? layer.scale : 1) * overscan;
    const rw = iw * s;
    const rh = ih * s;
    return { x: w / 2 + (layer.x || 0) - rw / 2, y: h / 2 + (layer.y || 0) - rh / 2, w: rw, h: rh };
  }

  function parallaxBlurPx(layer, spec) {
    if (layer.blur != null) return Math.max(0, layer.blur);
    const focus = spec.focusDepth == null ? 1 : spec.focusDepth;
    return Math.max(0, (spec.depthBlur || 0) * Math.abs(layer.depth - focus));
  }

  function drawParallaxLayer(ctx, layer, cam, spec, size) {
    const pose = parallaxPose(cam, layer.depth, size.w, size.h);
    const r = parallaxRect(layer, spec.overscan || 1, size.w, size.h);
    const blur = parallaxBlurPx(layer, spec);
    ctx.save();
    ctx.translate(pose.tx, pose.ty);
    if (pose.rot) ctx.rotate(pose.rot);
    ctx.scale(pose.zoom, pose.zoom);
    ctx.translate(-size.w / 2, -size.h / 2);
    if (layer.opacity != null) ctx.globalAlpha = layer.opacity;
    if (blur > 0) ctx.filter = "blur(" + blur + "px)";
    if (layer.image) {
      ctx.drawImage(layer.image, r.x, r.y, r.w, r.h);
    } else {
      ctx.translate(r.x, r.y);
      layer.draw(ctx, r.w, r.h);
    }
    ctx.restore();
  }

  // parallax(ctx, t, spec) — draws the layers back to front under the camera at time t.
  //   spec.layers[]  {image | draw(ctx, w, h), depth >= 1, x, y, scale, opacity, blur, fit, cover}
  //   spec.camera    {keys: [{t, x, y, zoom, rot}], ease: "inOut" | "linear" | "out" | fn}
  //   spec.focusDepth, spec.depthBlur   blur px per unit of depth from the focus (default focus 1)
  //   spec.overscan  extra scale on every layer; spec.width / spec.height when ctx.canvas has no size
  function parallax(ctx, t, spec) {
    const size = parallaxSize(ctx, spec);
    const cam = parallaxCamera(spec.camera, t);
    parallaxOrdered(spec).forEach(function (o) {
      drawParallaxLayer(ctx, o.layer, cam, spec, size);
    });
  }

  function parallaxSampleTimes(keys, step) {
    const t0 = keys[0].t;
    const t1 = keys[keys.length - 1].t;
    const times = [];
    for (let t = t0; t < t1; t += step) times.push(t);
    times.push(t1);
    return times;
  }

  // The frame's four corners mapped back into the layer's rest space under the layer's pose.
  function parallaxFrameInLayer(pose, w, h) {
    const cos = Math.cos(-pose.rot);
    const sin = Math.sin(-pose.rot);
    return [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(function (c) {
      const dx = c[0] - pose.tx;
      const dy = c[1] - pose.ty;
      return { x: (dx * cos - dy * sin) / pose.zoom + w / 2, y: (dx * sin + dy * cos) / pose.zoom + h / 2 };
    });
  }

  // The factor the layer's rect must grow by (about its centre) to hold the frame at one instant.
  function parallaxNeedAt(layer, spec, cam, size) {
    const pose = parallaxPose(cam, layer.depth, size.w, size.h);
    const r = parallaxRect(layer, spec.overscan || 1, size.w, size.h);
    const margin = parallaxBlurPx(layer, spec);
    let need = 0;
    parallaxFrameInLayer(pose, size.w, size.h).forEach(function (p) {
      need = Math.max(need, (2 * (Math.abs(p.x - (r.x + r.w / 2)) + margin)) / r.w, (2 * (Math.abs(p.y - (r.y + r.h / 2)) + margin)) / r.h);
    });
    return need;
  }

  function parallaxSpans(times, step) {
    const spans = [];
    times.forEach(function (t) {
      const open = spans[spans.length - 1];
      if (open && t - open.to <= step * 1.5) open.to = t;
      else spans.push({ from: t, to: t });
    });
    return spans;
  }

  function parallaxLayerCoverage(o, spec, times, size, step) {
    const failing = [];
    let need = 1;
    times.forEach(function (t) {
      const n = parallaxNeedAt(o.layer, spec, parallaxCamera(spec.camera, t), size);
      if (n > 1 + 1e-9) failing.push(t);
      need = Math.max(need, n);
    });
    if (!failing.length) return null;
    return { layer: o.index, depth: o.layer.depth, overscan: Math.ceil(need * 1000) / 1000, spans: parallaxSpans(failing, step) };
  }

  // parallaxCoverage(spec, w, h, {step}) -> {ok, width, height, step, layers: [{layer, depth, overscan, spans}]}
  // Walks the camera path every `step` s (default one 30 fps frame) and lists each layer whose rect
  // leaves a frame edge bare, the spans in s where it does, and `overscan`: the factor to multiply that
  // layer's scale by so the edge stays covered. A layer with cover: false is skipped. Blur is counted
  // as lost margin. Only rect geometry is checked, not whether the pixels in it are opaque.
  function parallaxCoverage(spec, w, h, opts) {
    const step = (opts && opts.step) || 1 / 30;
    const size = { w: w, h: h };
    const times = parallaxSampleTimes(parallaxSortedKeys(spec.camera), step);
    const layers = parallaxOrdered(spec)
      .filter(function (o) {
        return o.layer.cover !== false;
      })
      .map(function (o) {
        return parallaxLayerCoverage(o, spec, times, size, step);
      })
      .filter(Boolean);
    return { ok: layers.length === 0, width: w, height: h, step: step, layers: layers };
  }

  // ---- layers from one still ----

  function parallaxCanvas(w, h, make) {
    if (make) return make(w, h);
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function parallaxTrace(ctx, path) {
    ctx.beginPath();
    if (typeof path === "function") return path(ctx);
    path.forEach(function (p, i) {
      const x = Array.isArray(p) ? p[0] : p.x;
      const y = Array.isArray(p) ? p[1] : p.y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }

  // A white mask of the path, grown by `grow` px and softened by `feather` px of blur.
  function parallaxMask(path, w, h, o) {
    const mask = parallaxCanvas(w, h, o.makeCanvas);
    const mctx = mask.getContext("2d");
    if (o.feather > 0) mctx.filter = "blur(" + o.feather + "px)";
    mctx.fillStyle = "#fff";
    parallaxTrace(mctx, path);
    mctx.fill();
    if (o.grow > 0) {
      mctx.strokeStyle = "#fff";
      mctx.lineWidth = o.grow * 2;
      mctx.lineJoin = "round";
      mctx.stroke();
    }
    return mask;
  }

  function parallaxSourceSize(image, o) {
    return { w: o.width || image.naturalWidth || image.width, h: o.height || image.naturalHeight || image.height };
  }

  // cutLayer(image, path, {feather, width, height, makeCanvas}) -> canvas the size of the image with
  // only the pixels inside `path` ([{x,y}] or [[x,y]] points, or fn(ctx) that adds a path), the rest
  // transparent. `feather` px of blur softens the edge, so a moving cut-out does not show a hard
  // outline. Hold the result as an ImageBitmap before drawing it each frame (createImageBitmap).
  function cutLayer(image, path, opts) {
    const o = opts || {};
    const size = parallaxSourceSize(image, o);
    if (o.mask) parallaxAligned(o.mask, size, "cutLayer mask");
    const out = parallaxCanvas(size.w, size.h, o.makeCanvas);
    const octx = out.getContext("2d");
    octx.drawImage(image, 0, 0, size.w, size.h);
    octx.globalCompositeOperation = "destination-in";
    if (o.mask && o.feather > 0) octx.filter = "blur(" + o.feather + "px)";
    octx.drawImage(o.mask || parallaxMask(path, size.w, size.h, { feather: o.feather, makeCanvas: o.makeCanvas }), 0, 0);
    return out;
  }

  function parallaxAligned(image, size, label) {
    const actual = parallaxSourceSize(image, {});
    if (actual.w !== size.w || actual.h !== size.h) throw new Error(label + ": dimensions must match the source");
  }

  // mixKeyPhoto draws an aligned base and a prepared alpha-masked key patch.
  // Precompute the patch with cutLayer; no image decoding or canvas allocation occurs here.
  function mixKeyPhoto(ctx, base, keyPatch, amount, opts) {
    if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error("mixKeyPhoto: amount must be 0 to 1");
    const o = opts || {};
    const source = parallaxSourceSize(base, {});
    parallaxAligned(keyPatch, source, "mixKeyPhoto key patch");
    const size = parallaxSourceSize(base, o);
    const opacity = ctx.globalAlpha == null ? 1 : ctx.globalAlpha;
    ctx.save();
    ctx.drawImage(base, 0, 0, size.w, size.h);
    if (amount > 0) {
      ctx.globalAlpha = opacity * amount;
      ctx.drawImage(keyPatch, 0, 0, size.w, size.h);
    }
    ctx.restore();
  }

  // depthLayers partitions a same-size grayscale map once. White is near by default.
  // The caller supplies a repaired far plate; these transparent bands do not fill holes.
  function depthLayers(image, depthMap, opts) {
    const o = opts || {};
    const count = o.count == null ? 6 : o.count;
    if (!Number.isInteger(count) || count < 5 || count > 8) throw new Error("depthLayers: count must be 5 to 8");
    const size = parallaxSourceSize(image, {});
    parallaxAligned(depthMap, size, "depthLayers map");
    const reader = parallaxCanvas(size.w, size.h, o.makeCanvas).getContext("2d");
    reader.drawImage(depthMap, 0, 0);
    const pixels = reader.getImageData(0, 0, size.w, size.h).data;
    const masks = Array.from({ length: count }, function () { return reader.createImageData(size.w, size.h); });
    depthBandPixels(pixels, masks, o.nearWhite !== false);
    return masks.map(function (data, index) {
      const mask = parallaxCanvas(size.w, size.h, o.makeCanvas);
      mask.getContext("2d").putImageData(data, 0, 0);
      return { image: cutLayer(image, null, { mask: mask, makeCanvas: o.makeCanvas }), depth: index + 1, cover: false };
    });
  }

  function depthBandPixels(pixels, masks, nearWhite) {
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / (3 * 255);
      const far = nearWhite ? 1 - value : value;
      const band = Math.min(masks.length - 1, Math.floor(far * masks.length));
      const target = masks[band].data;
      target[i] = target[i + 1] = target[i + 2] = 255;
      target[i + 3] = pixels[i + 3];
    }
  }

  function parallaxPatchShift(path, o) {
    if (o.dx != null || o.dy != null) return { dx: o.dx || 0, dy: o.dy || 0 };
    if (typeof path === "function") throw new Error("holePlate: pass opts.dx / opts.dy when path is a function");
    const xs = path.map(function (p) {
      return Array.isArray(p) ? p[0] : p.x;
    });
    const lo = Math.min.apply(null, xs);
    const hi = Math.max.apply(null, xs);
    const gap = hi - lo + 2 * (o.grow || 0);
    return { dx: lo - gap >= 0 ? gap : -gap, dy: 0 };
  }

  // holePlate(image, path, {grow, feather, blur, dx, dy, makeCanvas}) -> canvas: the image with the
  // region inside `path` (grown by `grow` px, default 4) painted over by the image shifted by dx, dy
  // and blurred by `blur` px. Use it as the far layer behind a cut-out: the subject's old place shows
  // neighbouring background, not a hole, when the layers separate. dx defaults to one path-width
  // sideways; give dx / dy (or a clean plate you drew) when that lands on something else.
  function holePlate(image, path, opts) {
    const o = opts || {};
    const size = parallaxSourceSize(image, o);
    const grow = o.grow == null ? 4 : o.grow;
    const shift = parallaxPatchShift(path, { dx: o.dx, dy: o.dy, grow: grow });
    const patch = parallaxCanvas(size.w, size.h, o.makeCanvas);
    const pctx = patch.getContext("2d");
    if (o.blur > 0) pctx.filter = "blur(" + o.blur + "px)";
    pctx.drawImage(image, shift.dx, shift.dy, size.w, size.h);
    pctx.filter = "none";
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(parallaxMask(path, size.w, size.h, { feather: o.feather == null ? 2 : o.feather, grow: grow, makeCanvas: o.makeCanvas }), 0, 0);
    const out = parallaxCanvas(size.w, size.h, o.makeCanvas);
    const octx = out.getContext("2d");
    octx.drawImage(image, 0, 0, size.w, size.h);
    octx.drawImage(patch, 0, 0);
    return out;
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
    setCaptionsOn,
    layer,
    dubCode,
    layerFiles,
    clocks,
    pictureText,
    pictureTextFrom,
    overlayText,
    setBaseLang,
    cornerNotes,
    drawCornerNotes,
    checkRegions,
    cornerRegions,
    checkHolds,
    checkLangSpans,
    captionFontFor,
    safeAreaNote,
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
    clipBlend,
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
    parallax,
    parallaxCamera,
    parallaxPose,
    parallaxCoverage,
    cutLayer,
    depthLayers,
    mixKeyPhoto,
    holePlate,
  };
})();
