// Minifig hand-hold check (scripts/lib/ldraw-handhold.mjs): a hand grips a 3.18 mm bar on its clip axis, nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handhold } from "../scripts/lib/ldraw-handhold.mjs";
import { boxDat } from "./ldraw-fixture.mjs";

// Synthetic library: a unit cylinder primitive, a hand named 3820.dat, a bar, a clip (inverted cylinder) and a box.
function cylinder(n = 16) {
  const out = ["0 Cylinder 1.0"];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n;
    const p = (t, y) => [Math.cos(t).toFixed(4), y, Math.sin(t).toFixed(4)].join(" ");
    out.push(`4 16 ${p(a, 0)} ${p(b, 0)} ${p(b, 1)} ${p(a, 1)}`);
  }
  return out.join("\n") + "\n";
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sva-handhold-"));
for (const d of ["parts", "p"]) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, "p/4-4cyli.dat"), cylinder());
// The hand body sits beside its grip (the real 3820 has its grip centre at 0,-0.8229,-9.8948).
fs.writeFileSync(path.join(root, "parts/3820.dat"), boxDat("Minifig Hand", [-3, 3, -2, 2, 0, 4]));
// Bar 3L: radius 4, 60 LDU along +x, centred on the origin.
fs.writeFileSync(path.join(root, "parts/bar.dat"), "0 Bar 3L\n1 16 -30 0 0 0 60 0 -4 0 0 0 0 4 4-4cyli.dat\n");
// A clip: the same cylinder turned inside out (a hole), which is not a bar.
fs.writeFileSync(path.join(root, "parts/clip.dat"), "0 Plate with Clip\n0 BFC INVERTNEXT\n1 16 -30 0 0 0 60 0 -4 0 0 0 0 4 4-4cyli.dat\n");
fs.writeFileSync(path.join(root, "parts/body.dat"), boxDat("Camera Body", [-8, 8, -6, 6, -6, 6]));

const G = [0, -0.8229, -9.8948]; // grip centre in the hand's frame
const U = [0, -10.64966, -2.75422].map((x) => x / Math.hypot(10.64966, 2.75422)); // grip axis
// A matrix whose local +x runs along the grip axis.
const along = (u) => { // columns: local x -> u, local y -> v, local z -> u x v
  const n = Math.hypot(u[1], u[2]), v = [0, u[2] / n, -u[1] / n];
  const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return [u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]];
};
function model(name, lines) { const f = path.join(root, name); fs.writeFileSync(f, ["0 test", "1 14 0 0 0 1 0 0 0 1 0 0 0 1 3820.dat", "0 STEP", ...lines, "0 STEP", ""].join("\n")); return f; }
const place = (part, at, m) => `1 0 ${at.join(" ")} ${m.join(" ")} ${part}`;
const M = along(U);

test("a bar on the clip axis passes", () => {
  const r = handhold(model("pass.ldr", [place("bar.dat", G, M)]), { lib: root });
  assert.equal(r.ok, true, r.problems.join("\n"));
  assert.equal(r.passes.length, 1);
});

test("a body in the clip fails: no bar", () => {
  const r = handhold(model("body.ldr", [place("body.dat", G, [1, 0, 0, 0, 1, 0, 0, 0, 1])]), { lib: root });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /presents no 3\.18 mm bar/);
});

test("a bar across the clip fails; a clip's inside-out cylinder is not a bar", () => {
  const across = handhold(model("across.ldr", [place("bar.dat", G, [0, 1, 0, 1, 0, 0, 0, 0, 1])]), { lib: root });
  assert.equal(across.ok, false);
  assert.match(across.problems[0], /deg off the clip axis/);
  const clip = handhold(model("clip.ldr", [place("clip.dat", G, M)]), { lib: root });
  assert.equal(clip.ok, false);
  assert.match(clip.problems[0], /presents no 3\.18 mm bar/);
});

test("moving.json: the held item may not turn without its hand, nor a rod about its own pivot with no hand", () => {
  const f = model("mv.ldr", [place("bar.dat", G, M)]);
  const mv = path.join(root, "mv.json");
  fs.writeFileSync(mv, JSON.stringify({ people: [{ camera: { steps: [2], pivot: G, axis: [1, 0, 0] } }] }));
  const r = handhold(f, { lib: root, moving: mv });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /without its hand/);
  const lone = model("lone.ldr", []);
  fs.writeFileSync(mv, JSON.stringify({ people: [{ rod: { steps: [2], pivot: [0, 0, 0], axis: [0, 0, 1] } }] }));
  fs.writeFileSync(lone, ["0 test", "1 0 100 0 0 1 0 0 0 1 0 0 0 1 bar.dat", "0 STEP", ""].join("\n"));
  const r2 = handhold(lone, { lib: root, moving: mv });
  assert.match(r2.problems.join("\n"), /no minifig hand grips it/);
});

test("orientation: a camera on its handle passes either way, but held upside down it is listed to look at (EV-44)", () => {
  // a camera: its handle bar runs along its own Y (radius 4, 11 long), the body above it (-Y is up)
  fs.writeFileSync(path.join(root, "parts/cam.dat"), "0 Minifig Camera with Handle\n1 16 0 -5.5 0 4 0 0 0 11 0 0 0 4 4-4cyli.dat\n" + boxDat("~body", [-8, 8, -22, -9, -6, 6]).split("\n").slice(1).join("\n"));
  const withY = (y) => { // local x -> world x, local y -> y, local z -> x cross y
    const x = [1, 0, 0], z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  };
  const upright = handhold(model("cam-up.ldr", [place("cam.dat", G, withY(U.map((v) => -v)))]), { lib: root }); // own Y along -U (down), so its -Y points up
  assert.equal(upright.ok, true, upright.problems.join("\n"));
  assert.equal(upright.checks.length, 0, upright.checks.join("\n"));
  const flipped = handhold(model("cam-down.ldr", [place("cam.dat", G, withY(U))]), { lib: root });
  assert.equal(flipped.ok, true, "the grip itself is right");
  assert.equal(flipped.checks.length, 1);
  assert.match(flipped.checks[0], /upside down\?/);
});
