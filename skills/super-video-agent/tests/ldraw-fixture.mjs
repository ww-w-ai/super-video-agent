// A tiny synthetic parts library and model for the LDraw-format tests: boxes only, written to a temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const I = "1 0 0 0 1 0 0 0 1";

/** A box as 6 type-4 lines (colour 16) plus one edge line (colour 24). */
export function boxDat(title, [x0, x1, y0, y1, z0, z1], extra = []) {
  const q = (a, b, c, d) => `4 16 ${[...a, ...b, ...c, ...d].join(" ")}`;
  return [
    `0 ${title}`,
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]),
    q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    `2 24 ${x0} ${y0} ${z0} ${x1} ${y0} ${z0}`,
    ...extra,
  ].join("\n") + "\n";
}

/** Writes the library into a fresh temp folder and returns its path. */
export function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-ldraw-"));
  for (const d of ["parts", "p", "parts/s"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const put = (rel, text) => fs.writeFileSync(path.join(root, rel), text);
  put("p/stud.dat", boxDat("Stud", [-6, 6, -4, 0, -6, 6]));
  put("parts/plate.dat", boxDat("Plate 2 x 2", [-20, 20, 0, 8, -20, 20], [`1 16 0 0 0 ${I} stud.dat`, `1 1 10 0 10 ${I} stud.dat`]));
  put("parts/brick.dat", boxDat("Brick 2 x 2", [-20, 20, 0, 24, -20, 20]));
  put("parts/wall.dat", boxDat("Wall", [0, 8, -10, 10, -10, 10]));
  put("parts/axle.dat", boxDat("Technic Axle 2", [-20, 20, -2, 2, -2, 2]));
  put("parts/old.dat", "0 ~Moved to brick\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 brick.dat\n");
  put("LDConfig.ldr", "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333\n0 !COLOUR Blue CODE 1 VALUE #0055BF EDGE #333333 ALPHA 128\n");
  return root;
}

/** The main model wraps model.ldr; model.ldr has a plate, a sub-model in step 2 and a brick in step 3. */
export const TREE_MPD = [
  "0 FILE main.ldr",
  `1 16 0 0 0 ${I} model.ldr`,
  "0 FILE model.ldr",
  `1 4 0 0 0 ${I} plate.dat`,
  "0 STEP",
  `1 16 0 -24 0 ${I} sub.ldr`,
  "0 STEP",
  `1 16 0 -72 0 ${I} brick.dat`,
  "0 STEP",
  "0 FILE sub.ldr",
  `1 1 0 0 0 ${I} brick.dat`,
  "0 STEP",
  `1 2 0 -24 0 ${I} brick.dat`,
  "",
].join("\n");

/** A brick, then a plate held from below by it. */
export const BELOW_MPD = ["0 FILE main.ldr", `1 4 0 -24 0 ${I} brick.dat`, "0 STEP", `1 1 0 0 0 ${I} plate.dat`, ""].join("\n");

/** A wall at +X, then an axle along X that must come in from the end with no wall. */
export const AXLE_MPD = ["0 FILE main.ldr", `1 4 30 0 0 ${I} wall.dat`, "0 STEP", `1 1 0 0 0 ${I} axle.dat`, ""].join("\n");
