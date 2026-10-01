// scripts/glb-info.mjs: names as GLTFLoader sees them, clip durations, morph
// targets and triangle counts, from a GLB built here (JSON chunk only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { glbInfo, readGltfJson, loaderName, formatGlbInfo } from "../scripts/glb-info.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "glb-info.mjs");

const GLTF = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "rig", children: [1, 2, 3, 4] },
    { name: "Arm.L", mesh: 0, skin: 0 },
    { name: "Arm L" },
    { name: "hand[1]:tip/x" },
    { name: "ArmL" },
  ],
  meshes: [
    {
      name: "arm",
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1, targets: [{ POSITION: 2 }, { POSITION: 2 }] },
        { attributes: { POSITION: 0 }, mode: 5 },
      ],
      extras: { targetNames: ["blink", "smile"] },
    },
  ],
  accessors: [
    { count: 30, type: "VEC3", componentType: 5126 },
    { count: 36, type: "SCALAR", componentType: 5123 },
    { count: 30, type: "VEC3", componentType: 5126 },
    { count: 2, type: "SCALAR", componentType: 5126, min: [0], max: [1.5] },
    { count: 2, type: "SCALAR", componentType: 5126, min: [0], max: [2.25] },
  ],
  animations: [
    { name: "Wave", samplers: [{ input: 3 }, { input: 4 }], channels: [{}, {}] },
  ],
  materials: [{ name: "fur" }],
};

function toGlb(json) {
  let body = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (body.length % 4)) % 4;
  body = Buffer.concat([body, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}

test("loaderName: whitespace -> _, [ ] . : / removed (three.js sanitizeNodeName)", () => {
  assert.equal(loaderName("Arm.L"), "ArmL");
  assert.equal(loaderName("Arm L"), "Arm_L");
  assert.equal(loaderName("hand[1]:tip/x"), "hand1tipx");
});

test("readGltfJson: reads the JSON chunk of a GLB and a plain .gltf", () => {
  assert.equal(readGltfJson(toGlb(GLTF)).nodes.length, 5);
  assert.equal(readGltfJson(Buffer.from(JSON.stringify(GLTF))).nodes.length, 5);
});

test("glbInfo: roots, loader names, clips, morph targets, triangles, collisions", () => {
  const info = glbInfo(GLTF);
  assert.deepEqual(info.roots, ["rig"]);
  assert.deepEqual(
    info.nodes.map((n) => n.name),
    ["rig", "ArmL", "Arm_L", "hand1tipx", "ArmL"]
  );
  assert.equal(info.nodes[1].original, "Arm.L");
  assert.deepEqual(info.clips, [{ name: "Wave", durationSec: 2.25, channels: 2 }]);
  assert.deepEqual(info.meshes[0].morphTargets, ["blink", "smile"]);
  // 36 indices / 3 = 12, plus a strip of 30 vertices = 28
  assert.equal(info.meshes[0].triangles, 40);
  assert.equal(info.totalTriangles, 40);
  assert.equal(info.nodes[1].skin, true);
  assert.deepEqual(info.collisions, ["ArmL"]);
});

test("formatGlbInfo: shows the rewritten name with the original in parentheses", () => {
  const text = formatGlbInfo(glbInfo(GLTF));
  assert.match(text, /ArmL \(Arm\.L\)/);
  assert.match(text, /Wave \(2\.25 s/);
  assert.match(text, /morph: blink, smile/);
  assert.match(text, /triangles: 40 total/);
  assert.match(text, /same name after rewrite .*ArmL/);
});

test("CLI: prints the report for a .glb file and --json parses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sva-glb-"));
  const file = path.join(dir, "rig.glb");
  fs.writeFileSync(file, toGlb(GLTF));
  const text = execFileSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.match(text, /roots: rig/);
  const json = JSON.parse(execFileSync(process.execPath, [script, file, "--json"], { encoding: "utf8" }));
  assert.equal(json.totalTriangles, 40);
  fs.rmSync(dir, { recursive: true, force: true });
});
