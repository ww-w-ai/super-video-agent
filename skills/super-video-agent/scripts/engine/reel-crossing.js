// Super Video Agent surface-crossing check — no imports, no network, no wall-clock; runs in node and in a page.
// Decides whether a part's path crosses the surfaces of parts already placed, on triangles, not boxes
// (references/assembly.md "Collision by surface, not by box"). Boxes only skip pairs that are clearly apart.
// A triangle pair counts as a crossing when an edge of one passes through the inside of the other.
// Pairs whose two faces both run along the motion are left out: they can only slide along each other
// (a stud in its tube, an axle in its hole), and a real crossing also has a face that meets the motion head-on.
// Optional: copy this file into <reel>/src/ and call it from window.__reel.overlap (the example is in assembly.md).
// Attaches globalThis.ReelCrossing. Triangles are flat arrays, 9 numbers per triangle, in one common frame.
(function () {
  "use strict";

  const EPS = 1e-6;
  const PARALLEL = 0.08; // |normal . motion| under this = the face runs along the motion
  const CELL = 8;
  const INSIDE = 1e-4; // barycentric margin: a point on an edge or corner is contact, not a crossing

  /** @param {ArrayLike<number>} verts 9 numbers per triangle @returns {object} a surface with normals, box and grid */
  function surfaceOf(verts) {
    const n = Math.floor(verts.length / 9);
    const v = Float64Array.from(verts);
    const nrm = new Float64Array(n * 3);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      setNormal(v, nrm, i);
      const b = triBox(v, i, [0, 0, 0]);
      for (let a = 0; a < 3; a++) {
        if (b[a] < box[a]) box[a] = b[a];
        if (b[a + 3] > box[a + 3]) box[a + 3] = b[a + 3];
      }
      forCells(b, (key) => {
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      });
    }
    return { v, nrm, n, box, grid };
  }

  function setNormal(v, nrm, i) {
    const o = i * 9;
    const ax = v[o + 3] - v[o], ay = v[o + 4] - v[o + 1], az = v[o + 5] - v[o + 2];
    const bx = v[o + 6] - v[o], by = v[o + 7] - v[o + 1], bz = v[o + 8] - v[o + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const len = Math.hypot(cx, cy, cz) || 1;
    nrm[i * 3] = cx / len;
    nrm[i * 3 + 1] = cy / len;
    nrm[i * 3 + 2] = cz / len;
  }

  function triBox(v, i, off) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      for (let a = 0; a < 3; a++) {
        const x = v[i * 9 + k * 3 + a] + off[a];
        if (x < b[a]) b[a] = x;
        if (x > b[a + 3]) b[a + 3] = x;
      }
    }
    return b;
  }

  function forCells(b, fn) {
    for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[3] / CELL); x++)
      for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[4] / CELL); y++)
        for (let z = Math.floor(b[2] / CELL); z <= Math.floor(b[5] / CELL); z++) fn(x + "," + y + "," + z);
  }

  /** Does the segment p->q pass through the inside of triangle (a, b, c)? Moller-Trumbore, strict. */
  function segHitsTri(p, q, a, b, c) {
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < EPS) return false; // the edge lies in the triangle's plane: contact, not a crossing
    const inv = 1 / det;
    const tx = p[0] - a[0], ty = p[1] - a[1], tz = p[2] - a[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u <= INSIDE || u >= 1 - INSIDE) return false;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (dx * qx + dy * qy + dz * qz) * inv;
    if (w <= INSIDE || u + w >= 1 - INSIDE) return false;
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return s > INSIDE && s < 1 - INSIDE;
  }

  function corner(v, i, k, off) {
    return [v[i * 9 + k * 3] + off[0], v[i * 9 + k * 3 + 1] + off[1], v[i * 9 + k * 3 + 2] + off[2]];
  }

  function trisCross(A, i, offA, B, j) {
    const zero = [0, 0, 0];
    const a = [0, 1, 2].map((k) => corner(A.v, i, k, offA));
    const b = [0, 1, 2].map((k) => corner(B.v, j, k, zero));
    for (let k = 0; k < 3; k++) {
      if (segHitsTri(a[k], a[(k + 1) % 3], b[0], b[1], b[2])) return true;
      if (segHitsTri(b[k], b[(k + 1) % 3], a[0], a[1], a[2])) return true;
    }
    return false;
  }

  const along = (nrm, i, dir) => Math.abs(nrm[i * 3] * dir[0] + nrm[i * 3 + 1] * dir[1] + nrm[i * 3 + 2] * dir[2]) < PARALLEL;
  const apart = (b, B) => b[3] < B.box[0] || b[0] > B.box[3] || b[4] < B.box[1] || b[1] > B.box[4] || b[5] < B.box[2] || b[2] > B.box[5];

  /** Crossing pairs of one moving triangle against one placed surface. */
  function triangleVsSurface(A, i, off, B, dir, stamp) {
    const b = triBox(A.v, i, off);
    if (apart(b, B)) return 0;
    const alongA = along(A.nrm, i, dir);
    let hits = 0;
    forCells(b, (key) => {
      const cell = B.grid.get(key);
      if (!cell) return;
      for (const j of cell) {
        if (stamp[j] === i) continue;
        stamp[j] = i;
        if (alongA && along(B.nrm, j, dir)) continue;
        if (trisCross(A, i, off, B, j)) hits++;
      }
    });
    return hits;
  }

  /**
   * Crossing triangle pairs between the moving surface shifted by `off` and each placed surface.
   * @param {object} moving surfaceOf(...)
   * @param {{id:string, surface:object}[]} placed
   * @param {number[]} off the shift of the moving part, [x,y,z]
   * @param {number[]} dir the unit direction of the motion (faces along it are skipped)
   * @returns {{hits:number, pairs:{with:string, count:number}[]}}
   */
  function crossingsAt(moving, placed, off, dir) {
    let hits = 0;
    const pairs = [];
    for (const q of placed) {
      const stamp = new Int32Array(q.surface.n).fill(-1);
      let count = 0;
      for (let i = 0; i < moving.n; i++) count += triangleVsSurface(moving, i, off, q.surface, dir, stamp);
      if (count) pairs.push({ with: q.id, count });
      hits += count;
    }
    return { hits, pairs };
  }

  /**
   * Samples the path from `travel` away (along dir) to `seatLen` away and counts crossing pairs. The last
   * `seatLen` of the path is the joint closing (stud into tube, hole onto axle) and is not sampled.
   * @returns {{hits:number, firstHitAt:number|null, detail:{u:number, d:number, pairs:object[]}[]}}
   */
  function pathCrossings({ moving, placed, dir, travel, seatLen, samples }) {
    const out = { hits: 0, firstHitAt: null, detail: [] };
    if (!placed.length) return out;
    for (let s = 0; s <= samples; s++) {
      const u = s / samples;
      const d = travel + (seatLen - travel) * u;
      const r = crossingsAt(moving, placed, dir.map((x) => x * d), dir);
      if (!r.hits) continue;
      out.hits += r.hits;
      if (out.firstHitAt == null) out.firstHitAt = u;
      out.detail.push({ u, d, pairs: r.pairs });
    }
    return out;
  }

  /**
   * Of the candidate directions (the two ends of an axis), the one whose path crosses the fewest triangle pairs.
   * `travelOf(dir)` gives the path length for each end.
   * @returns {{dir:number[], hits:number, trials:{dir:number[], travel:number, hits:number}[]}}
   */
  function bestEnd({ moving, placed, dirs, travelOf, seatLen, samples }) {
    const trials = dirs.map((dir) => {
      const travel = travelOf(dir);
      return { dir, travel, hits: pathCrossings({ moving, placed, dir, travel, seatLen, samples }).hits };
    });
    const best = trials.reduce((a, b) => (b.hits < a.hits ? b : a));
    return { dir: best.dir, hits: best.hits, trials };
  }

  globalThis.ReelCrossing = { surfaceOf, crossingsAt, pathCrossings, bestEnd, PARALLEL };
})();
