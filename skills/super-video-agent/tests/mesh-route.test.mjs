// Photo -> 3D route helpers (references/photo-to-3d.md, EV-37): scripts/mesh/sdf.py and scripts/mesh-overlay.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOverlayArgs } from "../scripts/mesh-overlay.mjs";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDF_DIR = path.join(SKILL, "scripts", "mesh");
const OVERLAY = path.join(SKILL, "scripts", "mesh-overlay.mjs");
const PYTHON = process.env.SVA_PYTHON || (process.platform === "win32" ? "python" : "python3");
// 2x2 opaque PNG (grey)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNsaGhgYGBgYmBgYGBgAAAMcADBLh2oHQAAAABJRU5ErkJggg==", "base64");

function hasNumpy() {
  const r = spawnSync(PYTHON, ["-c", "import numpy"], { encoding: "utf8", timeout: 30000 });
  return r.status === 0;
}

test("mesh-overlay: argument parsing", () => {
  const o = parseOverlayArgs(["overlay", "a.png", "b.png", "c.png", "--alpha", "0.3"]);
  assert.equal(o.mode, "overlay");
  assert.equal(o.value, 0.3);
  assert.equal(o.inputs.length, 2);
  assert.ok(path.isAbsolute(o.out));
  assert.equal(parseOverlayArgs(["overlay", "a.png", "b.png", "c.png"]).value, 0.5);
  const c = parseOverlayArgs(["centerline", "f.png", "o.png", "--x=0.4"]);
  assert.equal(c.mode, "centreline");
  assert.equal(c.value, 0.4);
  assert.throws(() => parseOverlayArgs(["overlay", "a.png", "b.png"]), /needs/);
  assert.throws(() => parseOverlayArgs(["overlay", "a.png", "b.png", "c.png", "--alpha", "2"]), /alpha/);
  assert.throws(() => parseOverlayArgs(["centreline", "f.png", "o.png", "--x", "1"]), /--x/);
  assert.throws(() => parseOverlayArgs(["blend", "a", "b"]), /unknown mode/);
});

test("sdf.py: a mirrored figure writes a mesh and a grid that is exactly left-right symmetric", (t) => {
  if (!hasNumpy()) { t.skip(`no python with numpy (${PYTHON}; set SVA_PYTHON)`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-sdf-"));
  const script = String.raw`
import sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from sdf import *
import numpy as np
def f(x, y, z):
    head = ellipsoid(x, y, z, (0, -60, 0), (40, 50, 42))
    ear = sphere(mx(x), y, z, (42, -60, 4), 9)          # one call, both sides
    nose = capsule(x, y, z, (0, -62, -40), (0, -48, -46), 6)
    return smin(smin(head, ear, 4), nose, 3)
F = save_outputs(f, "fig", ((-60, 60), (-120, 0), (-60, 60)), 3.0, sys.argv[2])
meta = json.load(open(sys.argv[2] + "/fig.sdf.json"))
grid = np.fromfile(sys.argv[2] + "/fig.sdf.bin", "<f4").reshape(meta["shape"])
print(json.dumps({"shape": meta["shape"], "h": meta["h"], "sym": float(np.abs(grid - grid[::-1]).max()), "inside": int((grid < 0).sum())}))
`;
  const r = spawnSync(PYTHON, ["-c", script, SDF_DIR, dir], { encoding: "utf8", timeout: 120000, env: { ...process.env, PYTHONUTF8: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const last = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.deepEqual(last.shape, [41, 41, 41]);
  assert.equal(last.h, 3);
  assert.ok(last.inside > 1000, "solid inside the figure");
  assert.ok(last.sym < 1e-3, `grid mirrored about x = 0 (max diff ${last.sym})`);
  const obj = fs.readFileSync(path.join(dir, "fig.obj"), "utf8");
  const verts = obj.split("\n").filter((l) => l.startsWith("v ")).length;
  const faces = obj.split("\n").filter((l) => l.startsWith("f ")).length;
  assert.ok(verts > 100 && faces > 100, `mesh has ${verts} vertices, ${faces} faces`);
  assert.match(r.stdout, /solid bounds LDU/);
});

test("mesh-overlay: overlay and centreline write PNGs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-overlay-"));
  const a = path.join(dir, "ref.png"), b = path.join(dir, "ren.png");
  fs.writeFileSync(a, PNG); fs.writeFileSync(b, PNG);
  const out1 = path.join(dir, "ov.png"), out2 = path.join(dir, "cl.png");
  const r1 = spawnSync(process.execPath, [OVERLAY, "overlay", a, b, out1], { encoding: "utf8", timeout: 120000 });
  if (r1.status !== 0 && /playwright-core is not installed|Executable doesn't exist/.test(r1.stderr)) { t.skip("no browser in this copy"); return; }
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = spawnSync(process.execPath, [OVERLAY, "centreline", a, out2, "--x", "0.5"], { encoding: "utf8", timeout: 120000 });
  assert.equal(r2.status, 0, r2.stderr);
  for (const f of [out1, out2]) assert.equal(fs.readFileSync(f).subarray(1, 4).toString(), "PNG");
  const missing = spawnSync(process.execPath, [OVERLAY, "overlay", path.join(dir, "nope.png"), b, out1], { encoding: "utf8", timeout: 60000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});
