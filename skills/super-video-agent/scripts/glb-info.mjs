#!/usr/bin/env node
// Lists what a GLB (or .gltf) holds, under the names the page will use:
// three.js GLTFLoader rewrites node names (whitespace -> "_", the reserved
// track characters [ ] . : / removed), so a Blender bone "Arm.L" is
// getObjectByName("ArmL") on the page. Reads the file's JSON chunk only;
// never loads three.js.
import fs from "node:fs";
import { parseArgs, printHelpAndExit, fail, abs } from "./lib/cli.mjs";

const HELP = `usage: glb-info.mjs <file.glb|file.gltf> [--json]

Prints the scene's root nodes, animation clips with their durations, every
node as GLTFLoader names it (whitespace -> "_", the characters [ ] . : /
removed; the original name follows in parentheses when it changed), morph
targets per mesh, and triangle counts per mesh node and in total.
Names that collide after that rewrite are listed: GLTFLoader renames the
later ones <name>_1, <name>_2 in load order.
--json prints the same facts as JSON.
`;

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const RESERVED = /[[\].:/]/g;

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || positional.length === 0) {
    printHelpAndExit(HELP, flags.help || flags.h ? 0 : 1);
    return;
  }
  const file = abs(positional[0]);
  let info;
  try {
    info = glbInfo(readGltfJson(fs.readFileSync(file)));
  } catch (e) {
    fail(`${file}: ${e.message}`);
    return;
  }
  process.stdout.write(flags.json ? JSON.stringify(info, null, 2) + "\n" : formatGlbInfo(info));
}

/** GLTFLoader's node name: PropertyBinding.sanitizeNodeName. */
export function loaderName(name) {
  return String(name || "").replace(/\s/g, "_").replace(RESERVED, "");
}

/** The glTF JSON from a .glb buffer (first chunk) or a .gltf text buffer. */
export function readGltfJson(buf) {
  if (buf.length >= 20 && buf.readUInt32LE(0) === GLB_MAGIC) {
    const chunkLength = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== CHUNK_JSON) throw new Error("first GLB chunk is not JSON");
    return JSON.parse(buf.subarray(20, 20 + chunkLength).toString("utf8"));
  }
  return JSON.parse(buf.toString("utf8"));
}

/**
 * Facts about one glTF document.
 * @param {object} gltf the glTF JSON
 * @returns {{roots:string[], clips:{name:string, durationSec:number, channels:number}[],
 *   nodes:{name:string, original:string, depth:number, mesh:string|null, triangles:number,
 *   skin:boolean, morphTargets:string[]}[], meshes:{name:string, triangles:number, morphTargets:string[]}[],
 *   totalTriangles:number, collisions:string[]}}
 */
export function glbInfo(gltf) {
  const nodes = gltf.nodes || [];
  const meshes = (gltf.meshes || []).map((m, i) => meshFacts(gltf, m, i));
  const sceneIndex = gltf.scene != null ? gltf.scene : 0;
  const scene = (gltf.scenes || [])[sceneIndex];
  const rootIndices = scene ? scene.nodes || [] : topLevelNodes(nodes);

  const listed = [];
  const walk = (i, depth) => {
    const n = nodes[i];
    if (!n) return;
    const mesh = n.mesh != null ? meshes[n.mesh] : null;
    listed.push({
      name: loaderName(n.name),
      original: n.name || "",
      depth,
      mesh: mesh ? mesh.name : null,
      triangles: mesh ? mesh.triangles : 0,
      skin: n.skin != null,
      morphTargets: mesh ? mesh.morphTargets : [],
    });
    (n.children || []).forEach((c) => walk(c, depth + 1));
  };
  rootIndices.forEach((i) => walk(i, 0));

  return {
    roots: rootIndices.map((i) => loaderName(nodes[i] && nodes[i].name)),
    clips: (gltf.animations || []).map((a, i) => clipFacts(gltf, a, i)),
    nodes: listed,
    meshes,
    materials: (gltf.materials || []).map((m, i) => m.name || "material_" + i),
    totalTriangles: listed.reduce((sum, n) => sum + n.triangles, 0),
    collisions: nameCollisions(listed),
  };
}

function topLevelNodes(nodes) {
  const children = new Set();
  nodes.forEach((n) => (n.children || []).forEach((c) => children.add(c)));
  return nodes.map((_, i) => i).filter((i) => !children.has(i));
}

function meshFacts(gltf, mesh, index) {
  const accessors = gltf.accessors || [];
  let triangles = 0;
  let targetCount = 0;
  for (const p of mesh.primitives || []) {
    triangles += primitiveTriangles(p, accessors);
    targetCount = Math.max(targetCount, (p.targets || []).length);
  }
  const names = (mesh.extras && mesh.extras.targetNames) || [];
  const morphTargets = [];
  for (let k = 0; k < targetCount; k++) morphTargets.push(names[k] != null ? String(names[k]) : String(k));
  return { name: mesh.name || "mesh_" + index, triangles, morphTargets };
}

// glTF primitive modes: 4 triangles (default), 5 strip, 6 fan; points and lines draw no triangles.
function primitiveTriangles(p, accessors) {
  const mode = p.mode == null ? 4 : p.mode;
  const source = p.indices != null ? accessors[p.indices] : accessors[p.attributes && p.attributes.POSITION];
  const count = source ? source.count : 0;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function clipFacts(gltf, anim, index) {
  const accessors = gltf.accessors || [];
  let durationSec = 0;
  for (const s of anim.samplers || []) {
    const input = accessors[s.input];
    if (input && input.max && input.max.length) durationSec = Math.max(durationSec, input.max[0]);
  }
  return { name: anim.name || "animation_" + index, durationSec, channels: (anim.channels || []).length };
}

function nameCollisions(listed) {
  const counts = new Map();
  for (const n of listed) {
    if (!n.name) continue;
    counts.set(n.name, (counts.get(n.name) || 0) + 1);
  }
  return [...counts].filter(([, c]) => c > 1).map(([name]) => name);
}

/** Human-readable report of glbInfo(). */
export function formatGlbInfo(info) {
  const out = [];
  out.push("roots: " + (info.roots.join(", ") || "(none)"));
  out.push(
    "clips: " +
      (info.clips.map((c) => `${c.name} (${c.durationSec.toFixed(2)} s, ${c.channels} channels)`).join(", ") || "(none)")
  );
  out.push("nodes (GLTFLoader names):");
  for (const n of info.nodes) {
    const extra = [];
    if (n.mesh != null) extra.push(`mesh ${n.mesh}, ${n.triangles} tris`);
    if (n.skin) extra.push("skinned");
    if (n.morphTargets.length) extra.push("morph: " + n.morphTargets.join(", "));
    const renamed = n.original && n.original !== n.name ? ` (${n.original})` : "";
    out.push("  " + "  ".repeat(n.depth) + (n.name || "(unnamed)") + renamed + (extra.length ? "  [" + extra.join("; ") + "]" : ""));
  }
  out.push("materials: " + (info.materials.join(", ") || "(none)"));
  const morphMeshes = info.meshes.filter((m) => m.morphTargets.length);
  out.push("morph targets: " + (morphMeshes.map((m) => `${m.name}: ${m.morphTargets.join(", ")}`).join(" | ") || "(none)"));
  out.push(`triangles: ${info.totalTriangles} total`);
  if (info.collisions.length) {
    out.push("same name after rewrite (GLTFLoader adds _1, _2 in load order): " + info.collisions.join(", "));
  }
  return out.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
