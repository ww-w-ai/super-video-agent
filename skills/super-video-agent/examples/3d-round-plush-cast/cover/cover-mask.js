// EXAMPLE cover mask for three.js (references/3d.md "Covers and soft bodies: nothing pokes through").
// A cover (a quilt, a lid, a cloth) hides the parts tagged as staying under it: every seek, after
// posing, the cover's footprint on its base plane is rendered into a mask texture, and tagged
// fragments inside that footprint are discarded. Outside it they draw, cut at the cover's edge.
// Everything is computed from the posed scene, so the frame stays a pure function of t.
//
//   const mask = createCoverMask({ renderer, scene, cover, frame, half });
//   tagBones(bearBody, ["thighL", "thighR", "spine"], mask);   // vertices weighted to these bones
//   tagMesh(bearOutfit, mask);                                  // a whole node
//   // per seek: pose → mask.update() → renderer.render(scene, camera)
//   coverOverlap({ cover, frame, part: bearBody, mask })        // facts for window.__reel.overlap(t)
//
// Tag only what must stay under the cover (legs, torso under a quilt); never what may come out
// (head, arms). A tagged part that should rise under the cover needs the cover to bulge: re-drape
// the cover per seek instead (references/3d.md).
import * as THREE from "three";

const MASK_LAYER = 31;

/**
 * Builds the footprint mask of `cover` on the plane of `frame` (its local XZ plane; local +Y is
 * up). `half` is the half-size of the square the mask covers, in frame units, centred on the
 * frame's origin; it must contain the whole cover.
 */
export function createCoverMask({ renderer, scene, cover, frame, half, size = 512, height = 20 }) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  });
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0, 2 * height);
  camera.matrixAutoUpdate = false;
  camera.layers.set(MASK_LAYER);
  cover.traverse((o) => { if (o.isMesh) o.layers.enable(MASK_LAYER); });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
  const uniforms = {
    coverMask: { value: target.texture },
    coverMatrix: { value: new THREE.Matrix4() },
    coverOn: { value: 1 },
  };
  const down = new THREE.Matrix4().makeTranslation(0, height, 0)
    .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  let pixels = null;

  function update() {
    scene.updateMatrixWorld(true);
    camera.matrix.multiplyMatrices(frame.matrixWorld, down);
    camera.updateMatrixWorld(true);
    uniforms.coverMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const saved = {
      target: renderer.getRenderTarget(), background: scene.background, override: scene.overrideMaterial,
      clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate,
    };
    scene.background = null;
    scene.overrideMaterial = white;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(saved.target);
    renderer.setClearColor(saved.clear, saved.alpha);
    renderer.shadowMap.autoUpdate = saved.shadows;
    scene.background = saved.background;
    scene.overrideMaterial = saved.override;
    pixels = null;
  }

  /** True when the world point lies inside the rendered footprint (reads the mask back once per update). */
  function covers(world) {
    if (!pixels) {
      pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    }
    const p = world.clone().applyMatrix4(uniforms.coverMatrix.value);
    const u = Math.floor((p.x * 0.5 + 0.5) * size), v = Math.floor((p.y * 0.5 + 0.5) * size);
    if (u < 0 || v < 0 || u >= size || v >= size) return false;
    return pixels[(v * size + u) * 4] > 127;
  }

  return {
    uniforms, update, covers,
    get on() { return uniforms.coverOn.value > 0.5; },
    set on(v) { uniforms.coverOn.value = v ? 1 : 0; },
  };
}

/** Tags every vertex of every mesh under `root`. */
export function tagMesh(root, mask) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    setTag(o, new Float32Array(o.geometry.attributes.position.count).fill(1));
    patchMaterials(o, mask);
  });
}

/** Tags the vertices of skinned meshes under `root` whose weights on `boneNames` sum to ≥ 0.5. */
export function tagBones(root, boneNames, mask) {
  const wanted = new Set(boneNames);
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const inSet = o.skeleton.bones.map((b) => wanted.has(b.name));
    const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
    const tag = new Float32Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (inSet[si.getComponent(i, k)]) w += sw.getComponent(i, k);
      tag[i] = w >= 0.5 ? 1 : 0;
    }
    setTag(o, tag);
    patchMaterials(o, mask);
  });
}

function setTag(mesh, tag) {
  mesh.geometry = mesh.geometry.clone();
  mesh.geometry.setAttribute("coverTag", new THREE.BufferAttribute(tag, 1));
}

// Clones the materials (other copies of the model keep theirs) and adds the discard.
function patchMaterials(mesh, mask) {
  const patch = (m) => {
    const c = m.clone();
    c.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, mask.uniforms);
      shader.vertexShader = "attribute float coverTag;\nvarying float vCoverTag;\nvarying vec3 vCoverWorld;\n" +
        shader.vertexShader.replace("#include <project_vertex>",
          "#include <project_vertex>\nvCoverTag = coverTag;\nvCoverWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = "uniform sampler2D coverMask;\nuniform mat4 coverMatrix;\nuniform float coverOn;\n" +
        "varying float vCoverTag;\nvarying vec3 vCoverWorld;\n" +
        shader.fragmentShader.replace("void main() {", `void main() {
  if (coverOn > 0.5 && vCoverTag > 0.5) {
    vec4 cp = coverMatrix * vec4(vCoverWorld, 1.0);
    vec2 cuv = cp.xy / cp.w * 0.5 + 0.5;
    if (all(greaterThanEqual(cuv, vec2(0.0))) && all(lessThanEqual(cuv, vec2(1.0))) &&
        texture2D(coverMask, cuv).r > 0.5) discard;
  }`);
    };
    c.customProgramCacheKey = () => "cover-mask";
    return c;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(patch) : patch(mesh.material);
}

/** A vertex selector for coverOverlap: skinned vertices whose weights on `boneNames` sum to ≥ 0.5. */
export function boneSelector(boneNames) {
  const wanted = new Set(boneNames);
  return (mesh, i) => {
    if (!mesh.isSkinnedMesh) return false;
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    let w = 0;
    for (let k = 0; k < 4; k++) if (wanted.has(mesh.skeleton.bones[si.getComponent(i, k)].name)) w += sw.getComponent(i, k);
    return w >= 0.5;
  };
}

/**
 * Counts the vertices of `part` (meshes under it; `only(mesh, i)` narrows to some vertices) that
 * lie on the wrong side of `cover`: inside its footprint and more than `eps` above its lowest
 * surface there, in `frame`'s up direction. `count` leaves out the vertices the mask hides (tagged,
 * inside the rendered footprint, mask on); `geometric` keeps them. Call after posing and
 * mask.update().
 */
export function coverOverlap({ cover, frame, part, only = null, mask = null, eps = 0 }) {
  frame.updateMatrixWorld(true);
  const toFrame = frame.matrixWorld.clone().invert();
  const grid = coverGrid(cover, toFrame);
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  let count = 0, geometric = 0;
  part.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh) o.skeleton.update();
    const n = o.geometry.attributes.position.count;
    const tag = o.geometry.attributes.coverTag;
    for (let i = 0; i < n; i++) {
      if (only && !only(o, i)) continue;
      o.getVertexPosition(i, v);
      w.copy(v).applyMatrix4(o.matrixWorld);
      v.copy(w).applyMatrix4(toFrame);
      const low = grid.lowest(v.x, v.z);
      if (low === null || v.y <= low + eps) continue;
      geometric++;
      const hidden = mask && mask.on && tag && tag.getX(i) > 0.5 && mask.covers(w);
      if (!hidden) count++;
    }
  });
  return { count, geometric };
}

// The cover's posed triangles in frame space, bucketed on a grid over the base plane, so a vertex
// tests only the triangles above its own cell (never every triangle).
function coverGrid(cover, toFrame) {
  const tris = [];
  const p = new THREE.Vector3();
  cover.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, n = g.attributes.position.count;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      o.getVertexPosition(i, p);
      p.applyMatrix4(o.matrixWorld).applyMatrix4(toFrame);
      pts[i * 3] = p.x; pts[i * 3 + 1] = p.y; pts[i * 3 + 2] = p.z;
    }
    const idx = g.index ? g.index.array : null, m = idx ? idx.length : n;
    for (let k = 0; k < m; k += 3) {
      const a = idx ? idx[k] : k, b = idx ? idx[k + 1] : k + 1, c = idx ? idx[k + 2] : k + 2;
      tris.push([pts[a * 3], pts[a * 3 + 1], pts[a * 3 + 2], pts[b * 3], pts[b * 3 + 1], pts[b * 3 + 2],
        pts[c * 3], pts[c * 3 + 1], pts[c * 3 + 2]]);
    }
  });
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const t of tris) for (let j = 0; j < 9; j += 3) {
    x0 = Math.min(x0, t[j]); x1 = Math.max(x1, t[j]); z0 = Math.min(z0, t[j + 2]); z1 = Math.max(z1, t[j + 2]);
  }
  const cells = Math.max(1, Math.ceil(Math.sqrt(tris.length / 2)));
  const cw = (x1 - x0) / cells || 1, ch = (z1 - z0) / cells || 1;
  const cell = (x, z) => [Math.min(cells - 1, Math.max(0, Math.floor((x - x0) / cw))),
    Math.min(cells - 1, Math.max(0, Math.floor((z - z0) / ch)))];
  const buckets = Array.from({ length: cells * cells }, () => []);
  for (const t of tris) {
    const [ia, ja] = cell(Math.min(t[0], t[3], t[6]), Math.min(t[2], t[5], t[8]));
    const [ib, jb] = cell(Math.max(t[0], t[3], t[6]), Math.max(t[2], t[5], t[8]));
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) buckets[j * cells + i].push(t);
  }
  return {
    lowest(x, z) {
      if (x < x0 || x > x1 || z < z0 || z > z1) return null;
      const [i, j] = cell(x, z);
      let low = null;
      for (const t of buckets[j * cells + i]) {
        const y = heightIn(t, x, z);
        if (y !== null && (low === null || y < low)) low = y;
      }
      return low;
    },
  };
}

// Height of triangle t above (x, z), or null when (x, z) is outside its projection.
function heightIn(t, x, z) {
  const d = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
  if (Math.abs(d) < 1e-12) return null;
  const a = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d;
  const b = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d;
  const c = 1 - a - b;
  if (a < -1e-9 || b < -1e-9 || c < -1e-9) return null;
  return a * t[1] + b * t[4] + c * t[7];
}
