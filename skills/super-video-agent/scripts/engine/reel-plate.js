// Super Video Agent photo-plate helper — browser-side, no imports, no network, no wall-clock.
// A 3D scene standing on a photographic background plate (references/3d-plates.md):
//   - the camera model matched to the photo (vertical fov, horizon row, roll, camera height, spot),
//     shared with scripts/plate-match.mjs so the grid you looked at is the camera you render with;
//   - the shot camera (zoom, pan, tilt about the lens point, small lens dolly) and the edge-coverage
//     check that says when a frame corner sees past the photo, plus the zoom that fixes it;
//   - Neutral tone mapping and its inverse, so a photo drawn inside a tone-mapped frame keeps its pixels;
//   - three.js builders (three.js is passed in, never imported): the projected photo material, the
//     shadow catcher, a three camera from the matched model.
// Attaches globalThis.ReelPlate. Not inlined by new-reel.mjs: copy this file into <reel>/src/.
// World convention (three.js): y up, table top at y = 0, the object's foot at the origin, the camera
// looks down -Z. Every value is a pure function of its inputs.
(function () {
  "use strict";

  const D2R = Math.PI / 180;

  // ---- 3x3 matrices, row-major [[..],[..],[..]], vectors [x, y, z] ---------------------------------
  const mul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const apply = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const applyT = (m, v) => [0, 1, 2].map((j) => m[0][j] * v[0] + m[1][j] * v[1] + m[2][j] * v[2]);
  const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const rotZ = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

  /** Pitch down (deg) of a level camera whose horizon sits at `horizon` (fraction of image height from the top). */
  function pitchFromHorizon(horizon, fovDeg) {
    return Math.atan((1 - 2 * horizon) * Math.tan((fovDeg * D2R) / 2)) / D2R;
  }

  /**
   * The camera matched to a plate. P: {fov (vertical, deg, whole image), horizon (0..1 from top), roll (deg,
   * positive turns the image clockwise), h (camera height above the table in object units), spot ([x, y]
   * fractions where the object's foot stands)}. The camera is placed so the spot ray meets the table at
   * the origin. Returns {R (world-from-camera), pos, ty, asp, pitch, dist, W, H}.
   */
  function matchCamera(P, W, H) {
    if (!(P.fov > 0 && P.fov < 180)) throw new Error("plate fov must be in (0, 180) degrees, got " + P.fov);
    if (!(P.h > 0)) throw new Error("plate camera height h must be > 0, got " + P.h);
    const ty = Math.tan((P.fov * D2R) / 2);
    const pitch = pitchFromHorizon(P.horizon, P.fov);
    // three.js Euler(-pitch, 0, roll, "YXZ") with yaw 0 = Rx(-pitch) * Rz(roll)
    const R = mul(rotX(-pitch * D2R), rotZ((P.roll || 0) * D2R));
    const asp = W / H;
    const spot = P.spot || [0.5, 0.5];
    const d = apply(R, [(2 * spot[0] - 1) * ty * asp, (1 - 2 * spot[1]) * ty, -1]);
    if (d[1] >= -1e-9) throw new Error("the spot ray does not meet the table: spot " + JSON.stringify(spot) + " is at or above the horizon");
    const t = -P.h / d[1];
    const pos = [-d[0] * t, P.h, -d[2] * t];
    return { R, pos, ty, asp, pitch, dist: Math.hypot(d[0] * t, d[2] * t), W, H };
  }

  /** World point -> {x, y} in pixels of the camera's image, ok = in front of the lens. */
  function project(cam, p, W, H) {
    const q = applyT(cam.R, [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]]);
    const z = -q[2];
    if (z <= 1e-6) return { x: NaN, y: NaN, ok: false, nx: NaN, ny: NaN };
    const nx = q[0] / z / (cam.ty * cam.asp), ny = q[1] / z / cam.ty;
    const w = W || cam.W || 2, h = H || cam.H || 2;
    return { x: ((nx + 1) / 2) * w, y: ((1 - ny) / 2) * h, ok: true, nx, ny };
  }

  /** World direction of the ray through normalised image point (nx, ny) in [-1, 1] (y up). */
  function ray(cam, nx, ny) {
    const d = apply(cam.R, [nx * cam.ty * cam.asp, ny * cam.ty, -1]);
    const n = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / n, d[1] / n, d[2] / n];
  }

  /**
   * The shot camera on a plate. Zoom, pan and tilt turn and narrow the lens about its own point, so they
   * never show a parallax error on the flat photo; dolly ([x, y, z] in the base camera's frame) moves the
   * lens and needs the photo projected onto proxy geometry. Pan turns about world up (positive = right),
   * tilt about the lens's own x (positive = up). zoom 1 fills the shot's aspect from the plate.
   */
  function shotCamera(base, { aspect = base.asp, zoom = 1, pan = 0, tilt = 0, dolly = null } = {}) {
    // 0.985: a hair inside the photo so a filtered edge row never reaches the frame
    const ty0 = 0.985 * Math.min(base.ty, (base.ty * base.asp) / aspect);
    let R = base.R;
    if (pan) R = mul(rotY(-pan * D2R), R);
    if (tilt) R = mul(R, rotX(tilt * D2R));
    const off = dolly ? apply(base.R, dolly) : [0, 0, 0];
    return { R, pos: [base.pos[0] + off[0], base.pos[1] + off[1], base.pos[2] + off[2]], ty: ty0 / zoom, asp: aspect, zoom };
  }

  /**
   * How far the shot's frame edges reach outside the photo, in normalised image units of the plate
   * (0 = covered, 0.1 = a tenth of the half-width past the edge). Each corner and edge-midpoint ray meets
   * the proxy (the table y = 0, or the back wall at z = wallZ) and is projected back into the plate camera.
   */
  function coverage(base, shot, { wallZ = -25 } = {}) {
    let over = 0;
    const o = shot.pos;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [-1, 0], [1, 0]]) {
      const d = ray(shot, sx, sy);
      let t = d[1] < -1e-9 ? -o[1] / d[1] : Infinity;
      if (!isFinite(t) || o[2] + d[2] * t < wallZ) t = d[2] < -1e-9 ? (wallZ - o[2]) / d[2] : Infinity;
      if (!isFinite(t)) return Infinity; // the ray never meets the proxy: it looks behind the set
      const p = project(base, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
      if (!p.ok) return Infinity;
      over = Math.max(over, Math.abs(p.nx) - 1, Math.abs(p.ny) - 1);
    }
    return Math.max(0, over);
  }

  /** The smallest zoom >= opts.zoom at which the shot stays inside the photo (bisection, max 1.6x). */
  function fitZoom(base, opts = {}, proxy = {}, tol = 0.001) {
    const z0 = opts.zoom || 1;
    const covered = (z) => coverage(base, shotCamera(base, Object.assign({}, opts, { zoom: z })), proxy) <= tol;
    if (covered(z0)) return z0;
    let lo = z0, hi = z0 * 1.6;
    if (!covered(hi)) return null; // no zoom fixes it: the move is too large for this plate
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid)) hi = mid; else lo = mid;
    }
    return hi;
  }

  /**
   * Record a `plate-edge` issue when the shot sees past the photo (Reel.recordIssue when the engine is
   * loaded). Returns the coverage value. Call it after placing the camera for each rendered frame.
   */
  function check(base, shot, { wallZ = -25, shotId = "", t = 0, threshold = 0.002 } = {}) {
    const over = coverage(base, shot, { wallZ });
    if (over > threshold) {
      const R = globalThis.Reel;
      const issue = { type: "plate-edge", shot: shotId, t: +(+t).toFixed(2), over: isFinite(over) ? +over.toFixed(3) : "behind" };
      if (R && typeof R.recordIssue === "function") R.recordIssue(issue);
    }
    return over;
  }

  /** Unit vector from the object toward the light: az 0 = from behind the lens, 90 = from the right, el up. */
  function keyDir(az, el) {
    return [Math.sin(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), Math.cos(az * D2R) * Math.cos(el * D2R)];
  }

  // ---- Neutral tone mapping (Khronos PBR Neutral, as three.js NeutralToneMapping) -----------------
  const SC = 0.8 - 0.04, DD = 1 - SC, DESAT = 0.15;

  /** Forward curve on a linear [r, g, b]; for checking the inverse. */
  function neutral(c) {
    const m = Math.min(c[0], c[1], c[2]);
    const off = m < 0.08 ? m - 6.25 * m * m : 0.04;
    let x = c.map((v) => v - off);
    const peak = Math.max(x[0], x[1], x[2]);
    if (peak < SC) return x;
    const np = 1 - (DD * DD) / (peak + DD - SC);
    x = x.map((v) => (v * np) / peak);
    const g = 1 - 1 / (DESAT * (peak - np) + 1);
    return x.map((v) => v * (1 - g) + np * g);
  }

  /**
   * The inverse (desaturation ignored, exact below the shoulder): what to feed the tone mapper so the
   * frame shows `c`. Values at 1 cannot be inverted; they are held at 0.995 before the shoulder.
   */
  function invNeutral(c) {
    const peak = Math.max(c[0], c[1], c[2]);
    const peakIn = peak < SC ? peak : (DD * DD) / (1 - Math.min(peak, 0.995)) - DD + SC;
    const x = c.map((v) => (v * peakIn) / Math.max(peak, 1e-5));
    const m = Math.min(x[0], x[1], x[2]);
    const off = m >= 0.04 ? 0.04 : Math.sqrt(Math.max(m, 0) / 6.25) - m;
    return x.map((v) => v + off);
  }

  // ---- three.js builders (three.js and its TSL module are passed in) ------------------------------

  /** A three.js PerspectiveCamera with the pose and vertical fov of a model camera (base or shot). */
  function threeCamera(THREE, cam, { near = 0.05, far = 400 } = {}) {
    const c = new THREE.PerspectiveCamera((2 * Math.atan(cam.ty)) / D2R, cam.asp, near, far);
    setThreeCamera(THREE, c, cam);
    return c;
  }

  function setThreeCamera(THREE, c, cam) {
    const R = cam.R;
    const m = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);
    c.quaternion.setFromRotationMatrix(m);
    c.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    c.fov = (2 * Math.atan(cam.ty)) / D2R;
    c.aspect = cam.asp;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return c;
  }

  /** TSL node: Neutral tone mapping undone, so the whole-frame tone mapper gives the photo back. */
  function invNeutralNode(tsl) {
    const { Fn, float, max, min, sqrt, select, oneMinus } = tsl;
    return Fn(([c]) => {
      const peak = max(c.r, max(c.g, c.b));
      const peakIn = select(peak.lessThan(SC), peak, float(DD * DD).div(oneMinus(min(peak, 0.995))).sub(DD).add(SC));
      const x = c.mul(peakIn.div(max(peak, 1e-5)));
      const m = min(x.r, min(x.g, x.b));
      const off = select(m.greaterThanEqual(0.04), float(0.04), sqrt(max(m, 0).div(6.25)).sub(m));
      return x.add(off);
    });
  }

  /**
   * Unlit material that shows the photo projected from the plate camera onto whatever proxy it is on
   * (table plane, back wall, cut-out cards), so a lens dolly gives parallax instead of a sliding picture.
   * opts.tsl (three/tsl) + a node-material build: undoes Neutral tone mapping in the shader (the frame is
   * tone-mapped as a whole). Otherwise a WebGL ShaderMaterial with toneMapped = false.
   * Returns {material, gain} — gain (uniform, 1 = as photographed) scales the photo's own light.
   */
  function photoMaterial(THREE, tex, plateCam, { tsl = null, undo = "neutral" } = {}) {
    const pv = new THREE.Matrix4().multiplyMatrices(plateCam.projectionMatrix, plateCam.matrixWorldInverse);
    if (tsl && THREE.MeshBasicNodeMaterial) {
      const { uniform, texture, positionWorld, vec4 } = tsl;
      const upv = uniform(pv), gain = uniform(1);
      const clip = upv.mul(vec4(positionWorld, 1));
      let col = texture(tex, clip.xy.div(clip.w).mul(0.5).add(0.5)).rgb.mul(gain);
      if (undo === "neutral") col = invNeutralNode(tsl)(col);
      const material = new THREE.MeshBasicNodeMaterial({ depthWrite: false });
      material.colorNode = col;
      return { material, gain };
    }
    const gain = { value: 1 };
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, pv: { value: pv }, gain },
      vertexShader: "varying vec4 vClip; uniform mat4 pv;\nvoid main(){ vec4 w = modelMatrix * vec4(position, 1.0); vClip = pv * w; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: "varying vec4 vClip; uniform sampler2D map; uniform float gain;\nvoid main(){ vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5; gl_FragColor = vec4(texture2D(map, uv).rgb * gain, 1.0);\n#include <colorspace_fragment>\n}",
      depthWrite: false,
      toneMapped: false,
    });
    return { material, gain };
  }

  /**
   * A transparent plane on the table (y = 0) that shows only the shadows cast onto it, tinted toward the
   * table's own dark colour. Lift it a hair above the proxy so it never z-fights the photo.
   */
  function shadowCatcher(THREE, { size = 60, color = 0x1a120c, opacity = 0.5, y = 0.0005 } = {}) {
    const Mat = THREE.ShadowNodeMaterial || THREE.ShadowMaterial;
    const material = new Mat({ color: new THREE.Color(color), opacity, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.name = "plate-catcher";
    return mesh;
  }

  globalThis.ReelPlate = {
    pitchFromHorizon, matchCamera, project, ray, shotCamera, coverage, fitZoom, check, keyDir,
    neutral, invNeutral, threeCamera, setThreeCamera, invNeutralNode, photoMaterial, shadowCatcher,
    _m: { mul, apply, applyT, rotX, rotY, rotZ },
  };
})();
