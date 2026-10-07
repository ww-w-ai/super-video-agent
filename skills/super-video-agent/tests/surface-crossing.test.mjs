import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceOf, crossingsAt, pathCrossings, bestEnd, transformTriangles } from "../scripts/lib/surface-crossing.mjs";

function box([x0, x1, y0, y1, z0, z1]) {
  const q = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    ...q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    ...q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]),
    ...q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ...q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    ...q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
  ];
}
const S = (b) => surfaceOf(box(b));
const X = [1, 0, 0];

test("a box standing on another with its face on the other's face crosses nothing", () => {
  const a = S([0, 10, 0, 10, 0, 10]);
  const b = S([0, 10, 10, 20, 0, 10]);
  assert.equal(crossingsAt(a, [{ id: "b", surface: b }], [0, 0, 0], [0, 1, 0]).hits, 0);
});

test("a box that pokes through another's face is a crossing, and is named", () => {
  const wall = S([0, 2, -10, 10, -10, 10]);
  const bar = S([-5, 5, -1, 1, -1, 1]);
  const r = crossingsAt(bar, [{ id: "wall", surface: wall }], [0, 0, 0], X);
  assert.ok(r.hits > 0);
  assert.equal(r.pairs[0].with, "wall");
});

test("the same bar a little further away does not cross", () => {
  const wall = S([0, 2, -10, 10, -10, 10]);
  const bar = S([-5, -1, -1, 1, -1, 1]);
  assert.equal(crossingsAt(bar, [{ id: "wall", surface: wall }], [0, 0, 0], X).hits, 0);
});

test("a path counts what the part cuts through on the way in; the seat length at the end is not sampled", () => {
  const wall = S([30, 38, -10, 10, -10, 10]);
  const bar = S([-20, 20, -2, 2, -2, 2]);
  const placed = [{ id: "wall", surface: wall }];
  assert.ok(pathCrossings({ moving: bar, placed, dir: X, travel: 20, seatLen: 2, samples: 24 }).hits > 0);
  assert.equal(pathCrossings({ moving: bar, placed, dir: [-1, 0, 0], travel: 20, seatLen: 2, samples: 24 }).hits, 0);
  // from 10 units out the bar's end only reaches the wall's face (contact), and the last 2 units are the seat
  assert.equal(pathCrossings({ moving: bar, placed, dir: X, travel: 10, seatLen: 2, samples: 8 }).hits, 0);
  assert.equal(pathCrossings({ moving: bar, placed: [], dir: X, travel: 20, seatLen: 2, samples: 8 }).hits, 0);
});

test("bestEnd picks the end of the axis whose path crosses fewer triangle pairs", () => {
  const wall = S([30, 38, -10, 10, -10, 10]);
  const bar = S([-20, 20, -2, 2, -2, 2]);
  const r = bestEnd({ moving: bar, placed: [{ id: "wall", surface: wall }], dirs: [X, [-1, 0, 0]], travelOf: () => 20, seatLen: 2, samples: 24 });
  assert.deepEqual(r.dir, [-1, 0, 0]);
  assert.equal(r.hits, 0);
  assert.ok(r.trials.find((t) => t.dir === X).hits > 0);
});

test("faces that both run along the motion are left out; the same pair crosses when the motion is across them", () => {
  const inY0 = surfaceOf([0, 0, 0, 20, 0, 0, 0, 0, 20]); // plane y = 0, normal along y
  const inZ5 = surfaceOf([0, -5, 5, 20, -5, 5, 0, 5, 5]); // plane z = 5, normal along z; its edge passes through the other's inside
  assert.equal(crossingsAt(inZ5, [{ id: "p", surface: inY0 }], [0, 0, 0], X).hits, 0, "both faces are along x");
  assert.equal(crossingsAt(inZ5, [{ id: "p", surface: inY0 }], [0, 0, 0], [0, 0, 1]).hits, 1, "the z-plane face meets a motion along z head-on");
});

test("transformTriangles applies a 3x4 matrix to every point", () => {
  assert.deepEqual(transformTriangles([1, 2, 3, 0, 0, 0, 1, 1, 1], [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30]), [11, 22, 33, 10, 20, 30, 11, 21, 31]);
});
