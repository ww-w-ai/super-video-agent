// Super Video Agent layout helpers — browser-side, no imports, no network, no wall-clock.
// Optional: copy this file into <reel>/src/ and load it with <script src="src/reel-layout.js">
// (not inlined by new-reel.mjs). Attaches globalThis.ReelLayout. Every helper is a pure function of its
// arguments; a problem is recorded through Reel.recordIssue (when reel-engine.js is loaded), so
// review.mjs counts it as a layout issue.
//   child-outside-box        a chip, tag or any child box that crosses the container it belongs to
//   highlight-misses-target  a frame, bracket or arrow whose rect does not enclose, overlap or sit
//                            near the target the way it was declared
//   highlight-under-target   the highlight was drawn before its target, so the target covers it
//   highlight-target-missing a highlight names a target that was never drawn in this frame
(function () {
  "use strict";

  const BOX_TOLERANCE_PX = 0.5;
  const DEFAULT_REACH_PX = 24;
  const HIGHLIGHT_MODES = { enclose: 1, overlap: 1, near: 1 };
  const DEFAULT_MODE = { frame: "enclose", bracket: "near", arrow: "near" };

  function report(issue) {
    const engine = globalThis.Reel;
    if (engine && typeof engine.recordIssue === "function") engine.recordIssue(issue);
    return issue;
  }

  const num = (v) => typeof v === "number" && Number.isFinite(v);

  /** {left, top, right, bottom} from {x, y, w, h}, {left, top, right, bottom} or [x0, y0, x1, y1]; throws on anything else. */
  function toBox(r, what) {
    let b = null;
    if (Array.isArray(r) && r.length === 4) b = { left: r[0], top: r[1], right: r[2], bottom: r[3] };
    else if (r && num(r.x) && num(r.y) && num(r.w) && num(r.h)) b = { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h };
    else if (r && num(r.left) && num(r.top) && num(r.right) && num(r.bottom)) b = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    if (!b || !num(b.left) || !num(b.top) || !num(b.right) || !num(b.bottom) || b.right < b.left || b.bottom < b.top) {
      throw new Error("ReelLayout: " + what + " must be {x, y, w, h}, {left, top, right, bottom} or [x0, y0, x1, y1] in canvas px");
    }
    return b;
  }

  const rounded = (b) => ({ left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) });

  // -------------------------------------------------------------------
  // a child inside its container
  // -------------------------------------------------------------------

  /**
   * checkInside(id, child, container, {tolerance}) -> {inside, over: {left, top, right, bottom}}
   * `over` is how far (px, 0 = within) the child reaches past each side of the container. A child that
   * crosses records `child-outside-box`.
   */
  function checkInside(id, child, container, opts) {
    const tol = opts && num(opts.tolerance) ? opts.tolerance : BOX_TOLERANCE_PX;
    const c = toBox(child, "child");
    const box = toBox(container, "container");
    const over = {
      left: Math.max(0, box.left - c.left),
      top: Math.max(0, box.top - c.top),
      right: Math.max(0, c.right - box.right),
      bottom: Math.max(0, c.bottom - box.bottom),
    };
    const inside = over.left <= tol && over.top <= tol && over.right <= tol && over.bottom <= tol;
    if (!inside) report({ type: "child-outside-box", id: String(id), child: rounded(c), box: rounded(box), over: rounded(over) });
    return { inside, over };
  }

  /** The rows a list of chip widths packs into, greedy in order: arrays of indexes. */
  function packRows(widths, maxWidth, gapX) {
    const rows = [];
    let row = [];
    let rowW = 0;
    widths.forEach(function (w, i) {
      if (row.length && rowW + gapX + w > maxWidth) {
        rows.push(row);
        row = [];
        rowW = 0;
      }
      rowW += (row.length ? gapX : 0) + w;
      row.push(i);
    });
    if (row.length) rows.push(row);
    return rows;
  }

  /**
   * layoutChips(measure, labels, container, opts) -> {chips: [{text, x, y, w, h, row}], rows, fits, overflow}
   * Packs chips (tags, pills, tool names) into rows by their measured width, each row centred in the
   * container (opts.align "left" starts rows at the side margin) and the block centred vertically, then
   * checks every chip against the container (checkInside, so a chip that cannot fit records
   * `child-outside-box` with its text as id). `measure(text)` returns the text's width in px — the page
   * sets ctx.font first, then passes (s) => ctx.measureText(s).width.
   * opts: padX 16, height 48, gapX 12, gapY 12, margin 28 (side margin inside the container), align.
   * Draw each chip at its x, y with width w and height h.
   */
  function layoutChips(measure, labels, container, opts) {
    const o = opts || {};
    const box = toBox(container, "container");
    const padX = num(o.padX) ? o.padX : 16;
    const h = num(o.height) ? o.height : 48;
    const gapX = num(o.gapX) ? o.gapX : 12;
    const gapY = num(o.gapY) ? o.gapY : 12;
    const margin = num(o.margin) ? o.margin : 28;
    const texts = labels.map(String);
    const widths = texts.map(function (t) { return Math.ceil(measure(t)) + 2 * padX; });
    const rows = packRows(widths, box.right - box.left - 2 * margin, gapX);
    const blockH = rows.length * h + Math.max(0, rows.length - 1) * gapY;
    const top = box.top + (box.bottom - box.top - blockH) / 2;
    const chips = [];
    rows.forEach(function (row, r) {
      const rowW = row.reduce(function (s, i) { return s + widths[i]; }, 0) + (row.length - 1) * gapX;
      let x = o.align === "left" ? box.left + margin : box.left + (box.right - box.left - rowW) / 2;
      row.forEach(function (i) {
        chips.push({ text: texts[i], x: x, y: top + r * (h + gapY), w: widths[i], h: h, row: r });
        x += widths[i] + gapX;
      });
    });
    const overflow = chips.filter(function (c) { return !checkInside(c.text, { x: c.x, y: c.y, w: c.w, h: c.h }, box).inside; });
    return { chips: chips, rows: rows.length, fits: overflow.length === 0, overflow: overflow };
  }

  // -------------------------------------------------------------------
  // a highlight bound to its target
  // -------------------------------------------------------------------

  /** Distance (px) between two boxes; 0 when they touch or overlap. */
  function boxGap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

  const encloses = (outer, inner, tol) =>
    outer.left <= inner.left + tol && outer.top <= inner.top + tol && outer.right >= inner.right - tol && outer.bottom >= inner.bottom - tol;

  /**
   * checkHighlight({id, kind, rect, target, mode, reach, tolerance}) -> {ok, gap, issue}
   * `kind` is "frame", "bracket" or "arrow" (the arrow's rect is its head and tail); `mode` says what the
   * highlight must do to the target rect: "enclose" (frame default), "overlap", or "near" (bracket and
   * arrow default: within `reach` px, default 24). A miss records `highlight-misses-target`.
   */
  function checkHighlight(spec) {
    const mode = spec.mode || DEFAULT_MODE[spec.kind] || "overlap";
    if (!HIGHLIGHT_MODES[mode]) throw new Error('ReelLayout: highlight mode must be "enclose", "overlap" or "near"');
    const tol = num(spec.tolerance) ? spec.tolerance : BOX_TOLERANCE_PX;
    const reach = num(spec.reach) ? spec.reach : DEFAULT_REACH_PX;
    const h = toBox(spec.rect, "highlight rect");
    const t = toBox(spec.target, "target rect");
    const gap = boxGap(h, t);
    const ok = mode === "enclose" ? encloses(h, t, tol) : mode === "overlap" ? gap <= tol : gap <= reach;
    const issue = ok ? null : report({ type: "highlight-misses-target", id: String(spec.id), kind: String(spec.kind || "highlight"), mode: mode,
      highlight: rounded(h), target: rounded(t), gap: Math.round(gap) });
    return { ok: ok, gap: gap, issue: issue };
  }

  /**
   * drawLog() -> {target(id, rect), highlight(id, targetId, rect, opts), check()}
   * One per seek. Call target() right after drawing a target and highlight() right after drawing the
   * highlight; check() at the end of the seek records `highlight-under-target` (the target was drawn
   * after the highlight, so it covers it), `highlight-target-missing` and the geometry misses of
   * checkHighlight. Returns the issues it recorded.
   */
  function drawLog() {
    const targets = {};
    const highlights = [];
    let order = 0;
    return {
      target: function (id, rect) { targets[id] = { box: toBox(rect, "target rect"), order: order++ }; },
      highlight: function (id, targetId, rect, opts) {
        highlights.push({ id: id, targetId: targetId, rect: rect, opts: opts || {}, order: order++ });
      },
      check: function () {
        const found = [];
        highlights.forEach(function (hl) {
          const t = targets[hl.targetId];
          if (!t) {
            found.push(report({ type: "highlight-target-missing", id: String(hl.id), target: String(hl.targetId) }));
            return;
          }
          if (t.order > hl.order) found.push(report({ type: "highlight-under-target", id: String(hl.id), target: String(hl.targetId) }));
          const r = checkHighlight(Object.assign({}, hl.opts, { id: hl.id, rect: hl.rect, target: t.box }));
          if (r.issue) found.push(r.issue);
        });
        return found;
      },
    };
  }

  globalThis.ReelLayout = { checkInside, layoutChips, checkHighlight, drawLog, boxGap };
})();
