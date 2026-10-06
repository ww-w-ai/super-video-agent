// Super Video Agent cut-out rig helper — browser-side, no imports, no network, no wall-clock.
// An EXAMPLE helper, not a required look: a 2D part hierarchy (parts with a pivot, a parent, a z),
// a pose that is a pure function of t, a canvas draw, a numeric joint check that only reports,
// and a reader for the mouth schedule that mouth.mjs writes. Attaches globalThis.ReelRig.
// Not inlined by new-reel.mjs: copy this file into <reel>/src/ and load it with <script src>.
(function () {
  "use strict";

  // 2D affine matrices in canvas order [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f.
  const IDENTITY = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const translate = (x, y) => [1, 0, 0, 1, x, y];
  const rotate = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  };
  const scale = (s) => [s, 0, 0, s, 0, 0];
  const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  /**
   * parts: [{id, parent|null, pivot:[x,y], anchor:[x,y], z, size:[w,h], image?, draw?, limits?:[minDeg,maxDeg]}]
   * pivot  = the joint point in the part's own image space (the part rotates about it).
   * anchor = where that joint sits in the PARENT's image space (ignored for a root).
   * Throws on a definition that cannot work (duplicate id, unknown parent, cycle).
   */
  function makeRig(parts) {
    const byId = {};
    parts.forEach((p, i) => {
      if (!p || typeof p.id !== "string" || !p.id) throw new Error("ReelRig part " + i + " has no id");
      if (byId[p.id]) throw new Error("ReelRig part id used twice: " + p.id);
      byId[p.id] = Object.assign({ parent: null, pivot: [0, 0], anchor: [0, 0], z: 0, index: i }, p);
    });
    for (const id of Object.keys(byId)) {
      const seen = new Set([id]);
      for (let p = byId[id].parent; p; p = byId[p] && byId[p].parent) {
        if (!byId[p]) throw new Error("ReelRig part " + id + " has unknown parent " + p);
        if (seen.has(p)) throw new Error("ReelRig parent chain loops at " + p);
        seen.add(p);
      }
    }
    const drawOrder = Object.values(byId).sort((a, b) => a.z - b.z || a.index - b.index);
    return { byId, drawOrder };
  }

  // keys: [{t, v}] sorted by t. Eased between keys, held before the first and after the last.
  const smooth = (u) => u * u * (3 - 2 * u);
  function keyed(keys, t, ease) {
    if (!keys || !keys.length) return 0;
    if (t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    let lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].t <= t) lo = mid; else hi = mid;
    }
    const u = (t - keys[lo].t) / (keys[hi].t - keys[lo].t);
    return keys[lo].v + (keys[hi].v - keys[lo].v) * (ease || smooth)(u);
  }

  // tracks: {partId: {rot?: keys, dx?: keys, dy?: keys, scale?: keys}} -> pose {partId: {rot, dx, dy, scale}}.
  // rot is degrees; dx, dy move the joint off its anchor in the parent's image space (0 keeps it attached).
  // For a root part dx, dy are its canvas position. To trail a limb behind its parent, sample at t - lag.
  function poseAt(tracks, t) {
    const pose = {};
    for (const id of Object.keys(tracks)) {
      const k = tracks[id];
      pose[id] = { rot: keyed(k.rot, t), dx: keyed(k.dx, t), dy: keyed(k.dy, t), scale: k.scale ? keyed(k.scale, t) : 1 };
    }
    return pose;
  }

  /** Canvas matrix of every part for this pose: {partId: matrix}. Parts missing from the pose rest at 0. */
  function world(rig, pose) {
    const out = {};
    const matrixOf = (id) => {
      if (out[id]) return out[id];
      const p = rig.byId[id];
      const s = (pose && pose[id]) || {};
      const parentM = p.parent ? matrixOf(p.parent) : IDENTITY;
      const anchor = p.parent ? p.anchor : [0, 0];
      let m = mul(parentM, translate(anchor[0] + (s.dx || 0), anchor[1] + (s.dy || 0)));
      m = mul(m, rotate(s.rot || 0));
      m = mul(m, scale(s.scale === undefined ? 1 : s.scale));
      out[id] = mul(m, translate(-p.pivot[0], -p.pivot[1]));
      return out[id];
    };
    for (const id of Object.keys(rig.byId)) matrixOf(id);
    return out;
  }

  /** Draws every part in z order. A part draws with part.draw(ctx, part), else its image (images[id] or part.image). */
  function draw(ctx, rig, pose, images) {
    const m = world(rig, pose);
    for (const p of rig.drawOrder) {
      ctx.save();
      ctx.transform(m[p.id][0], m[p.id][1], m[p.id][2], m[p.id][3], m[p.id][4], m[p.id][5]);
      const img = (images && images[p.id]) || p.image;
      if (typeof p.draw === "function") p.draw(ctx, p);
      else if (img) ctx.drawImage(img, 0, 0, p.size ? p.size[0] : img.width, p.size ? p.size[1] : img.height);
      ctx.restore();
    }
  }

  /**
   * Numeric joint check. For every child, the distance in canvas px between the child's pivot and the
   * parent's anchor point at each sampled time, and the child's angle against its limits when it has some.
   * Reports only and never throws: a joint left apart on purpose is a choice. poseAt(t) returns a pose.
   * @returns {{joints: object[], rows: object[], lines: string[], notes: string[]}}
   */
  function jointCheck(rig, poseFn, times, opts) {
    const tol = (opts && opts.tolerancePx) || 2;
    const joints = [], rows = [], notes = [];
    try {
      const children = Object.values(rig.byId).filter((p) => p.parent);
      const stat = {};
      for (const c of children) stat[c.id] = { joint: c.id + ">" + c.parent, maxGapPx: 0, atT: times[0], over: 0, angleOver: 0, samples: 0 };
      for (const t of times) {
        const pose = poseFn(t);
        const m = world(rig, pose);
        for (const c of children) {
          const a = apply(m[c.id], c.pivot[0], c.pivot[1]);
          const b = apply(m[c.parent], c.anchor[0], c.anchor[1]);
          const gap = Math.hypot(a.x - b.x, a.y - b.y);
          const rot = (pose[c.id] && pose[c.id].rot) || 0;
          const outside = !!c.limits && (rot < c.limits[0] || rot > c.limits[1]);
          const s = stat[c.id];
          s.samples++;
          if (gap > s.maxGapPx) { s.maxGapPx = gap; s.atT = t; }
          if (gap > tol) s.over++;
          if (outside) s.angleOver++;
          if (gap > tol || outside) rows.push({ t, joint: s.joint, gapPx: gap, rot, outsideLimits: outside });
        }
      }
      for (const c of children) joints.push(stat[c.id]);
    } catch (e) {
      notes.push("joint check could not run: " + (e && e.message ? e.message : String(e)));
    }
    const lines = joints.map((j) =>
      "joint " + j.joint + ": max gap " + j.maxGapPx.toFixed(1) + " px at t=" + Number(j.atT).toFixed(2) +
      " (" + j.over + " of " + j.samples + " samples over " + tol + " px" +
      (j.angleOver ? "; " + j.angleOver + " outside the angle limits" : "") + ")");
    return { joints, rows, lines: lines.concat(notes), notes };
  }

  /**
   * Mouth reader. schedule is the JSON mouth.mjs writes ({lines:[{spans:[{from,to,open}]}]}) or a flat
   * spans array. Returns f(t) -> 0 (closed) to 1 (wide open), a pure function of t.
   */
  function mouthTrack(schedule) {
    const lines = Array.isArray(schedule) ? [{ spans: schedule }] : (schedule && schedule.lines) || [];
    const spans = [];
    for (const l of lines) for (const s of l.spans || []) spans.push(s);
    spans.sort((a, b) => a.from - b.from);
    return function mouthAt(t) {
      let lo = 0, hi = spans.length - 1, hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].from <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
      }
      for (let i = hit; i >= 0 && i > hit - 3; i--) if (t < spans[i].to) return spans[i].open === undefined ? 1 : spans[i].open;
      return 0;
    };
  }

  globalThis.ReelRig = { makeRig, keyed, poseAt, world, draw, jointCheck, mouthTrack };
})();
