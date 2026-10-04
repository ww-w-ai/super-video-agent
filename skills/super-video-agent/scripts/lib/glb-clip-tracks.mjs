// Reads morph-target weight keyframes of a GLB/glTF animation clip: the eye-closure curve a clip
// drives, without loading three.js. Pure over a file buffer; the blink check turns the series into
// blinks. Handles FLOAT and normalized integer outputs, LINEAR/STEP/CUBICSPLINE sampling.
import fs from "node:fs";
import path from "node:path";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
// glTF componentType -> [bytes, Buffer reader, signed, float]
const COMPONENT = { 5120: [1, "readInt8", true, false], 5121: [1, "readUInt8", false, false], 5122: [2, "readInt16LE", true, false],
  5123: [2, "readUInt16LE", false, false], 5125: [4, "readUInt32LE", false, false], 5126: [4, "readFloatLE", true, true] };
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Default morph names that close an eye: eyeBlinkLeft, blink_R, eyeClose, eyesClosed, Eye_Closed... */
export const BLINK_MORPH = /blink|eyes?_?clos|clos\w*_?eyes?/i;

/** @returns {{json:object, bin:Buffer|null}} from a .glb or .gltf buffer (embedded or sibling .bin via `dir`) */
export function readGltf(buf, dir) {
  if (buf.length >= 20 && buf.readUInt32LE(0) === GLB_MAGIC) {
    let json = null, bin = null;
    for (let p = 12; p + 8 <= buf.length; ) {
      const len = buf.readUInt32LE(p), type = buf.readUInt32LE(p + 4);
      const body = buf.subarray(p + 8, p + 8 + len);
      if (type === CHUNK_JSON) json = JSON.parse(body.toString("utf8"));
      else if (type === CHUNK_BIN && !bin) bin = body;
      p += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error("GLB has no JSON chunk");
    return { json, bin };
  }
  const json = JSON.parse(buf.toString("utf8"));
  const b0 = json.buffers && json.buffers[0];
  let bin = null;
  if (b0 && b0.uri) {
    bin = b0.uri.startsWith("data:") ? Buffer.from(b0.uri.split(",")[1], "base64") : fs.readFileSync(path.join(dir || ".", decodeURIComponent(b0.uri)));
  }
  return { json, bin };
}

function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const [size, reader, signed, isFloat] = COMPONENT[acc.componentType] || [];
  if (!size) throw new Error(`accessor ${index}: unsupported component type ${acc.componentType}`);
  const n = TYPE_SIZE[acc.type];
  const stride = view.byteStride || size * n;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float64Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) {
      const o = base + i * stride + c * size;
      let v = bin[reader](o);
      if (acc.normalized && !isFloat) {
        v = signed ? Math.max(v / (2 ** (size * 8 - 1) - 1), -1) : v / (2 ** (size * 8) - 1);
      }
      out[i * n + c] = v;
    }
  }
  return { values: out, count: acc.count, width: n };
}

/** Mesh node name -> morph target names (extras.targetNames on the mesh or its first primitive). */
function targetNames(json, mesh) {
  const names = (mesh.extras && mesh.extras.targetNames) || (mesh.primitives && mesh.primitives[0] && mesh.primitives[0].extras && mesh.primitives[0].extras.targetNames) || [];
  const count = Math.max(0, ...(mesh.primitives || []).map((p) => (p.targets || []).length));
  return Array.from({ length: count }, (_, i) => (names[i] != null ? String(names[i]) : String(i)));
}

/**
 * Eye-closure series of every weights channel whose morph name matches `morphRe`.
 * @param {{json:object, bin:Buffer|null}} gltf
 * @returns {{clip:string, node:string, morph:string, series:{t:number,v:number}[]}[]}
 */
export function morphTracks({ json, bin }, morphRe = BLINK_MORPH) {
  const out = [];
  for (const [ai, anim] of (json.animations || []).entries()) {
    for (const ch of anim.channels || []) {
      if (!ch.target || ch.target.path !== "weights") continue;
      const node = (json.nodes || [])[ch.target.node];
      const mesh = node && node.mesh != null ? json.meshes[node.mesh] : null;
      if (!mesh) continue;
      const names = targetNames(json, mesh);
      const hits = names.map((n, i) => [n, i]).filter(([n]) => morphRe.test(n));
      if (!hits.length) continue;
      if (!bin) throw new Error("animation data needs a binary buffer, and the file has none");
      const sampler = anim.samplers[ch.sampler];
      const input = readAccessor(json, bin, sampler.input);
      const output = readAccessor(json, bin, sampler.output);
      const mode = sampler.interpolation || "LINEAR";
      const per = names.length;
      for (const [morph, k] of hits) {
        const series = [];
        for (let f = 0; f < input.count; f++) {
          const at = mode === "CUBICSPLINE" ? (f * 3 + 1) * per + k : f * per + k;
          const t = input.values[f];
          if (mode === "STEP" && f > 0) series.push({ t: t - 1e-6, v: series[series.length - 1].v });
          series.push({ t, v: output.values[at] });
        }
        out.push({ clip: anim.name || `animation_${ai}`, node: (node.name || `node_${ch.target.node}`), morph, series });
      }
    }
  }
  return out;
}
