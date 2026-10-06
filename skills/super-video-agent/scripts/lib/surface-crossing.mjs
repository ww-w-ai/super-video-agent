// Node side of the surface-crossing check. The one implementation is the page helper
// scripts/engine/reel-crossing.js (it attaches globalThis.ReelCrossing); the baker and the page run the same code.
import "../engine/reel-crossing.js";

const RC = globalThis.ReelCrossing;

export const { surfaceOf, crossingsAt, pathCrossings, bestEnd } = RC;

/**
 * Triangles (9 numbers each) moved by a 3x4 row-major matrix [a b c x, d e f y, g h i z].
 * @param {ArrayLike<number>} tris
 * @param {number[]} M
 * @returns {number[]}
 */
export function transformTriangles(tris, M) {
  const out = new Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    out[i] = M[0] * x + M[1] * y + M[2] * z + M[3];
    out[i + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
    out[i + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
  }
  return out;
}
