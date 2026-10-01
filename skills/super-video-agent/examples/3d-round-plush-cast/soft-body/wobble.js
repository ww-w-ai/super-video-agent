// EXAMPLE soft-body scene: a soufflé pancake stack tapped by a fork, jiggling on a CPU
// displacement field. One example prop, not a default. The values in WOB were tuned on this
// prop only.
//
// This is the SCENE block of a page scaffolded with `new-reel.mjs --3d`: paste it between the
// SCENE:BEGIN and SCENE:END markers of reel.html (inside the <script type="module">). It uses the
// inlined engine (`Reel`, `ReelAudio`) and loads three.js and RoomEnvironment from
// ./assets/vendor/.
//
// Reusable parts: WOB, wobbleField(), addDeformable(), deformStack(), tapPointAt() and
// forkTipAt() (the fork rides the field), and measure(t) exposed as window.__wobbleDebug for
// soft-body/measure.mjs. To reuse on another stack, bake every stack mesh into world space
// (rest positions in world coordinates, mesh transform identity), register it with
// addDeformable, call deformStack(t) in seek(t) before rendering, set STACK_H, LAYER_H, BASE_Y,
// PUSH and TAP for that stack, and scale swayAmp with its width (about 0.13 x width).
(async function () {
  "use strict";
  var WIDTH = 1080;
  var HEIGHT = 1920;
  var FPS = 30;
  var HAS_HANDWRITING = false;

  // Internal 3D render resolution vs the full frame. Headless Chromium has
  // no GPU (SwiftShader, a CPU WebGL2 implementation) — 0.75 keeps frame
  // time down (references/3d.md "Speed"). The 3D scene renders at
  // RW x RH; the 2D overlay (captions, titles) always draws at full size.
  var RENDER_SCALE = 0.75;
  var RW = Math.round(WIDTH * RENDER_SCALE);
  var RH = Math.round(HEIGHT * RENDER_SCALE);

  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");

  // ---- three.js: dynamic import so a missing vendor file rejects `ready`
  // with a clear message instead of crashing the module script load
  // (references/3d.md "Install three.js"). three.js is never bundled with
  // this skill — the calling agent installs it into this reel folder.
  var THREE = null;
  var threeLoadError = null;
  try {
    THREE = await import("./assets/vendor/three.module.js");
  } catch (e) {
    threeLoadError = e;
  }
  var THREE_MISSING_MESSAGE =
    "three.js not found at assets/vendor/three.module.js. Install it into this reel, " +
    "then re-open the page:\n" +
    "  npm install three --prefix <reel-dir>\n" +
    "  mkdir -p <reel-dir>/assets/vendor\n" +
    "  cp <reel-dir>/node_modules/three/build/three.module.js <reel-dir>/assets/vendor/\n" +
    "  cp <reel-dir>/node_modules/three/build/three.core.js <reel-dir>/assets/vendor/\n" +
    "Record the installed version and its MIT license in FILM.md (references/3d.md).";

  var timings = null;
  var tl = null;
  var shots = [];

  // Reel.layer()/Reel.dubCode() (references/pipeline.md "Picture first"):
  // ?layer=captions&dub=<code> asks this page to draw only that dub's
  // captions, skipping the 3D picture — mirrors the 2D template so a 3D
  // film supports picture-first + per-language dubs the same way.
  var layer = Reel.layer();
  var dubCode = Reel.dubCode();
  var isCaptionLayer = layer === "captions" && !!dubCode;
  var dubPlan = null;

  function loadJSON(url, required) {
    return fetch(url).then(function (res) {
      if (!res.ok) {
        if (required) throw new Error(url + " not found — run voice.mjs first");
        return null;
      }
      return res.json();
    });
  }

  function timingsUrl() {
    return isCaptionLayer ? "dub/" + dubCode + "/timings.placed.json" : "voice/timings.json";
  }

  function loadFilmKey() {
    return loadJSON("plan.json", false).then(function (plan) {
      var meta = (plan && plan.meta) || {};
      ReelAudio.setFilmKey(meta.filmKey || meta.title || meta.id || "film");
    }).catch(function () {
      ReelAudio.setFilmKey("film");
    });
  }

  function loadTimings() {
    return loadJSON(timingsUrl(), true).then(function (data) {
      timings = data;
      tl = Reel.timeline(timings);
      var lines = timings.lines || [];
      shots = lines.map(function (l, i) {
        var start = i === 0 ? 0 : l.start;
        var end = i === lines.length - 1 ? timings.duration : lines[i + 1].start;
        return { id: l.id, start: start, end: end, readAt: (l.start + l.end) / 2 };
      });
    });
  }

  function loadDubPlan() {
    if (!isCaptionLayer) return Promise.resolve();
    return loadJSON("dub/" + dubCode + "/plan.json", true).then(function (data) {
      dubPlan = data;
    });
  }

  function loadDeclaredFonts() {
    var faces = Array.from(document.fonts);
    return Promise.all(
      faces.map(function (face) {
        return face.load().catch(function (err) {
          Reel.recordIssue({
            type: "font-load-failed",
            family: face.family,
            weight: face.weight,
            style: face.style,
            message: String((err && err.message) || err),
          });
          return null;
        });
      })
    ).then(function () {
      return document.fonts.ready;
    });
  }

  // ---- SFX (silent by default; wire cues the way the 2D scaffold does) --
  var SFX_CUES = [];
  function renderSfx(sampleRate) {
    var duration = timings ? timings.duration : 0;
    var m = ReelAudio.mix(duration, sampleRate);
    ReelAudio.master(m, { peakDb: -3 });
    return [Array.from(m.L), Array.from(m.R)];
  }

  // ======================================================================
  // Soufflé pancake stack + fork tap: a CPU wobble field.
  // Every moving thing is a pure function of t. The stack's shape comes
  // from wobbleField(rest position, t), applied to every stack vertex on
  // each seek, with normals from the field's Jacobian. The fork's tine is
  // placed on wobbleField(tap point, t), so it rides the surface it
  // presses. No AnimationMixer, no carried state, no physics.
  // ======================================================================

  var RoomEnvironment = null;

  var glCanvas = document.createElement("canvas"); // detached — the page
  // markup declares only the "stage" canvas tag (verify.mjs's static scan
  // requires exactly one); this one is created in script and never
  // appended to the DOM.
  glCanvas.width = RW;
  glCanvas.height = RH;

  var renderer = null;
  var scene = null;
  var camera = null;
  var glPixels = null;
  var smallCanvas = null;
  var smallCtx = null;
  var smallImg = null;
  var worldBuilt = false;

  // ---- wobble parameters (tuned on this one prop) ----------------------
  var WOB = {
    tTap: 0.6,          // s: the tine touches the top
    contact: 0.07,      // s: the tine rides the surface, then lifts
    swayAmp: 0.26,      // world units of lateral sway at the stack top
    swayHz: 2.6,
    swayTau: 0.6,       // s: amplitude e-folding time
    squashAmp: 0.11,    // peak vertical strain (-: squash, +: stretch)
    squashHz: 3.3,
    squashTau: 0.5,
    attack: 0.035,      // s: impulse rise time
    lagPerLayer: 0.045, // s: each pancake trails the one below
    lagRamp: 0.38,      // s: the lag grows in over the first sway period
    swayExp: 1.6,       // lateral profile eta^p (eta = height / stack height)
    tilt: 0.9,          // slices tilt with the sway gradient (bending)
    orbit: 0.22,        // cross-axis sway, a quarter period late
    bulgeBand: 0.4,     // eta band where the x/z bulge grows in from 0
    breatheAmp: 0.006,  // idle vertical strain
    breatheHz: 0.55,
    idleSway: 0.004,
    dentDepth: 0.045,   // how far the tine presses the cake in
    dentSigma: 0.13,
  };

  // Scene constants (world units; one pancake is ~2.0 across).
  var BASE_Y = 0.052;   // plate's inner surface: the stack's glued base
  var LAYERS = [
    { R: 1.02, H: 0.72, rt: 0.27, rb: 0.15, dome: 0.035, puff: 0.02, cx: 0.02, cz: -0.01, rot: 0.3 },
    { R: 0.99, H: 0.73, rt: 0.27, rb: 0.15, dome: 0.035, puff: 0.02, cx: -0.035, cz: 0.02, rot: 1.7 },
    { R: 0.965, H: 0.72, rt: 0.27, rb: 0.15, dome: 0.04, puff: 0.02, cx: 0.02, cz: 0.0, rot: 4.1 },
  ];
  var SINK = 0.028;     // each pancake settles this far into the dome below
  var LAYER_H = 0.72;
  var STACK_H = 0;      // set in layoutStack()
  var PUSH = normalize3([-1, 0, -0.25]);          // the tap pushes the top this way
  var PERP = [-PUSH[2], 0, PUSH[0]];
  var TAP = { x: 0, y: 0, z: 0 };                  // rest tap point, set in buildWorld
  var FORK_DIR = normalize3([0.7, 0.62, 0.35]);      // tines -> handle
  var SYRUP_T = 0.03;

  function normalize3(v) {
    var l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function smooth01(x) {
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    return x * x * (3 - 2 * x);
  }

  function layoutStack() {
    var base = BASE_Y;
    for (var k = 0; k < LAYERS.length; k++) {
      LAYERS[k].base = base;
      base = base + LAYERS[k].H + LAYERS[k].dome - SINK;
    }
    var top = LAYERS[LAYERS.length - 1];
    STACK_H = top.base + top.H + top.dome - BASE_Y;
  }

  // ---- the field ---------------------------------------------------------
  // Impulse response of a damped spring: 0 before the tap, rises within
  // `attack`, rings at hz, decays with tau.
  function ring(u, hz, tau) {
    if (u <= 0) return 0;
    return (1 - Math.exp(-u / WOB.attack)) * Math.exp(-u / tau) * Math.sin(2 * Math.PI * hz * u);
  }

  // Seconds a point at height h trails the plate. One lagPerLayer per
  // pancake, continuous in h (so touching layers never separate), grown in
  // over the first period (so the whole stack first moves away from the
  // fork together, then the upper layers fall behind).
  function delayAt(h, u) {
    return WOB.lagPerLayer * (h / LAYER_H) * smooth01(u / WOB.lagRamp);
  }

  function profileF(eta) {
    if (eta <= 0) return 0;
    if (eta <= 1) return Math.pow(eta, WOB.swayExp);
    return 1 + WOB.swayExp * (eta - 1); // butter, berries: straight on past the top
  }

  function swayAt(h, t, out) {
    var eta = h / STACK_H;
    var u = t - WOB.tTap;
    var ud = u - delayAt(h, u);
    var main = WOB.swayAmp * ring(ud, WOB.swayHz, WOB.swayTau);
    var side = WOB.swayAmp * WOB.orbit * ring(ud - 0.25 / WOB.swayHz, WOB.swayHz, WOB.swayTau);
    var idle = WOB.idleSway * Math.sin(2 * Math.PI * 0.37 * t - 0.9 * eta);
    var f = profileF(eta);
    out[0] = f * (PUSH[0] * main + PERP[0] * side + idle);
    out[1] = f * (PUSH[2] * main + PERP[2] * side);
  }

  function squashAt(h, t) {
    var u = t - WOB.tTap;
    var ud = u - delayAt(h, u);
    var s = -WOB.squashAmp * ring(ud, WOB.squashHz, WOB.squashTau);
    return s + WOB.breatheAmp * Math.sin(2 * Math.PI * WOB.breatheHz * t - 0.6 * h / STACK_H);
  }

  function dentAt(x, z, h, t) {
    var u = t - WOB.tTap;
    if (u <= 0) return 0;
    var c = u < WOB.contact ? smooth01(u / WOB.contact) : Math.exp(-(u - WOB.contact) / 0.07);
    var dx = x - TAP.x;
    var dz = z - TAP.z;
    var g = Math.exp(-(dx * dx + dz * dz) / (2 * WOB.dentSigma * WOB.dentSigma));
    return WOB.dentDepth * c * g * smooth01((h - (STACK_H - 0.35)) / 0.33);
  }

  var swA = [0, 0];
  var swB = [0, 0];
  var swC = [0, 0];
  var TILT_D = 0.02;

  // wobbleField(rest x, y, z, t) -> deformed position. Base glued: at the
  // plate (h = 0) sway, tilt, bulge and squash are all zero.
  function wobbleField(x, y, z, t, out) {
    var h = y - BASE_Y;
    if (h <= 0) {
      out[0] = x; out[1] = y; out[2] = z;
      return;
    }
    swayAt(h, t, swA);
    swayAt(h + TILT_D, t, swB);
    var hLo = Math.max(0, h - TILT_D);
    swayAt(hLo, t, swC);
    var dh = h + TILT_D - hLo;
    var eta = h / STACK_H;
    var tiltW = WOB.tilt * smooth01(eta / 0.12);
    var tx = (swB[0] - swC[0]) / dh;
    var tz = (swB[1] - swC[1]) / dh;
    var s = squashAt(h, t);
    var radial = 1 / Math.sqrt(1 + s * smooth01(eta / WOB.bulgeBand));
    out[0] = x * radial + swA[0];
    out[2] = z * radial + swA[1];
    out[1] = BASE_Y + h * (1 + s) - tiltW * (x * tx + z * tz) - dentAt(x, z, h, t);
  }

  // ---- deformable meshes -------------------------------------------------
  var deformables = [];
  var fo = [0, 0, 0];
  var fx = [0, 0, 0];
  var fy = [0, 0, 0];
  var fz = [0, 0, 0];
  var JE = 0.004;

  function addDeformable(geo, material, opts) {
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    var mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.castShadow = !opts || opts.cast !== false;
    mesh.receiveShadow = true;
    scene.add(mesh);
    var entry = {
      name: (opts && opts.name) || "",
      mesh: mesh,
      rp: Float32Array.from(geo.attributes.position.array),
      rn: Float32Array.from(geo.attributes.normal.array),
    };
    deformables.push(entry);
    return entry;
  }

  // Deformed normal = cofactor(J) * rest normal, J from finite differences.
  function deformEntry(e, t) {
    var rp = e.rp;
    var rn = e.rn;
    var P = e.mesh.geometry.attributes.position.array;
    var N = e.mesh.geometry.attributes.normal.array;
    var n = rp.length / 3;
    for (var i = 0; i < n; i++) {
      var x = rp[3 * i], y = rp[3 * i + 1], z = rp[3 * i + 2];
      wobbleField(x, y, z, t, fo);
      P[3 * i] = fo[0]; P[3 * i + 1] = fo[1]; P[3 * i + 2] = fo[2];
      wobbleField(x + JE, y, z, t, fx);
      wobbleField(x, y + JE, z, t, fy);
      wobbleField(x, y, z + JE, t, fz);
      var ax = fx[0] - fo[0], ay = fx[1] - fo[1], az = fx[2] - fo[2];
      var bx = fy[0] - fo[0], by = fy[1] - fo[1], bz = fy[2] - fo[2];
      var cx = fz[0] - fo[0], cy = fz[1] - fo[1], cz = fz[2] - fo[2];
      var nx = rn[3 * i], ny = rn[3 * i + 1], nz = rn[3 * i + 2];
      var ox = (by * cz - bz * cy) * nx + (cy * az - cz * ay) * ny + (ay * bz - az * by) * nz;
      var oy = (bz * cx - bx * cz) * nx + (cz * ax - cx * az) * ny + (az * bx - ax * bz) * nz;
      var oz = (bx * cy - by * cx) * nx + (cx * ay - cy * ax) * ny + (ax * by - ay * bx) * nz;
      var l = Math.hypot(ox, oy, oz) || 1;
      N[3 * i] = ox / l; N[3 * i + 1] = oy / l; N[3 * i + 2] = oz / l;
    }
    e.mesh.geometry.attributes.position.needsUpdate = true;
    e.mesh.geometry.attributes.normal.needsUpdate = true;
  }

  function deformStack(t) {
    for (var k = 0; k < deformables.length; k++) deformEntry(deformables[k], t);
  }

  // ---- geometry helpers --------------------------------------------------
  // Averages normals of vertices that share a position (lathe seams and
  // poles), so no seam line shows.
  function weldNormals(geo) {
    var pos = geo.attributes.position.array;
    var nrm = geo.attributes.normal.array;
    var groups = new Map();
    for (var i = 0; i < pos.length / 3; i++) {
      var key = Math.round(pos[3 * i] * 1e4) + "," + Math.round(pos[3 * i + 1] * 1e4) + "," + Math.round(pos[3 * i + 2] * 1e4);
      var g = groups.get(key);
      if (!g) { g = { x: 0, y: 0, z: 0, ids: [] }; groups.set(key, g); }
      g.x += nrm[3 * i]; g.y += nrm[3 * i + 1]; g.z += nrm[3 * i + 2];
      g.ids.push(i);
    }
    groups.forEach(function (g) {
      if (g.ids.length < 2) return;
      var l = Math.hypot(g.x, g.y, g.z) || 1;
      g.ids.forEach(function (j) {
        nrm[3 * j] = g.x / l; nrm[3 * j + 1] = g.y / l; nrm[3 * j + 2] = g.z / l;
      });
    });
  }

  function Merger() {
    this.pos = []; this.nrm = []; this.col = []; this.idx = []; this.count = 0;
  }
  Merger.prototype.add = function (geo, matrix, color) {
    var p = geo.attributes.position;
    var n = geo.attributes.normal;
    var own = geo.attributes.color; // used when no color is given
    var nm = new THREE.Matrix3().getNormalMatrix(matrix);
    var v = new THREE.Vector3();
    var w = new THREE.Vector3();
    var base = this.count;
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      w.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(w.x, w.y, w.z);
      if (color) this.col.push(color.r, color.g, color.b);
      else this.col.push(own.getX(i), own.getY(i), own.getZ(i));
    }
    if (geo.index) {
      for (i = 0; i < geo.index.count; i++) this.idx.push(base + geo.index.getX(i));
    } else {
      for (i = 0; i < p.count; i++) this.idx.push(base + i);
    }
    this.count += p.count;
    return { from: base, to: this.count };
  };
  Merger.prototype.build = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  };

  // Rounded block |x/ax|^e + |y/ay|^e + |z/az|^e = 1 with analytic normals.
  function superBlob(ax, ay, az, e, wSeg, hSeg) {
    var geo = new THREE.SphereGeometry(1, wSeg, hSeg);
    var p = geo.attributes.position;
    var n = geo.attributes.normal;
    var k = 2 / e;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var X = Math.sign(x) * Math.pow(Math.abs(x), k);
      var Y = Math.sign(y) * Math.pow(Math.abs(y), k);
      var Z = Math.sign(z) * Math.pow(Math.abs(z), k);
      p.setXYZ(i, X * ax, Y * ay, Z * az);
      var gx = Math.sign(X) * Math.pow(Math.abs(X), e - 1) / ax;
      var gy = Math.sign(Y) * Math.pow(Math.abs(Y), e - 1) / ay;
      var gz = Math.sign(Z) * Math.pow(Math.abs(Z), e - 1) / az;
      var l = Math.hypot(gx, gy, gz) || 1;
      n.setXYZ(i, gx / l, gy / l, gz / l);
    }
    return geo;
  }

  function linColor(hex) {
    return new THREE.Color(hex); // sRGB hex -> linear working space
  }

  // Keyed smooth noise from a few sine waves (position-based, so seam
  // duplicates get the same value).
  function makeNoise(key, n, freq) {
    var r = Reel.rng(key);
    var waves = [];
    for (var i = 0; i < n; i++) {
      waves.push({ a: (r() - 0.5) * 2 * freq, b: (r() - 0.5) * 2 * freq, c: (r() - 0.5) * 2 * freq, p: r() * 6.283 });
    }
    return function (x, y, z) {
      var s = 0;
      for (var j = 0; j < waves.length; j++) s += Math.sin(waves[j].a * x + waves[j].b * y + waves[j].c * z + waves[j].p);
      return s / Math.sqrt(waves.length);
    };
  }

  // ---- pancakes ----------------------------------------------------------
  // Profile from bottom centre to top centre (LatheGeometry's order for
  // outward normals): flat bottom, bottom fillet, puffed side, top fillet,
  // domed top.
  function pancakeProfile(p) {
    var pts = [];
    var i;
    for (i = 0; i <= 6; i++) pts.push([(p.R - p.rb) * i / 6, 0]);
    for (i = 1; i <= 10; i++) {
      var a = -Math.PI / 2 + (Math.PI / 2) * i / 10;
      pts.push([p.R - p.rb + p.rb * Math.cos(a), p.rb + p.rb * Math.sin(a)]);
    }
    for (i = 1; i < 8; i++) {
      pts.push([p.R + p.puff * Math.sin(Math.PI * i / 8), p.rb + (p.H - p.rt - p.rb) * i / 8]);
    }
    for (i = 0; i <= 12; i++) {
      var b = (Math.PI / 2) * i / 12;
      pts.push([p.R - p.rt + p.rt * Math.cos(b), p.H - p.rt + p.rt * Math.sin(b)]);
    }
    for (i = 1; i <= 10; i++) {
      var rr = (p.R - p.rt) * (1 - i / 10);
      var q = 1 - Math.pow(rr / (p.R - p.rt), 2);
      pts.push([rr, p.H + p.dome * q * q]);
    }
    return pts;
  }

  function profileNormals(pts) {
    return pts.map(function (q, j) {
      var a = pts[Math.max(0, j - 1)];
      var b = pts[Math.min(pts.length - 1, j + 1)];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l]; // (radial, y)
    });
  }

  var sideBump = null;
  var mottle = null;
  var sugarHaze = null;

  // Radial scale for the craggy side: 1 on flat faces, bumpy on the side.
  function bumpScale(x, y, z, sideW) {
    return 1 + 0.011 * sideBump(x, y, z) * sideW;
  }

  function buildPancake(p, isTop) {
    var prof = pancakeProfile(p);
    var pn = profileNormals(prof);
    var M = prof.length;
    var geo = new THREE.LatheGeometry(prof.map(function (q) { return new THREE.Vector2(q[0], q[1]); }), 128);
    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var pale = linColor(0xf8e6b8);
    var topBrown = linColor(0xd7964c);
    var botBrown = linColor(0xc98a45);
    var sugar = linColor(0xfffaf0);
    var c = new THREE.Color();
    var cs = Math.cos(p.rot), sn = Math.sin(p.rot);
    for (var i = 0; i < pos.count; i++) {
      var j = i % M;
      var lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      var x = p.cx + lx * cs + lz * sn;
      var z = p.cz - lx * sn + lz * cs;
      var y = p.base + ly;
      var ny = pn[j][1];
      var sideW = 1 - smooth01((Math.abs(ny) - 0.2) / 0.6);
      var k = bumpScale(x, y, z, sideW);
      x = p.cx + (x - p.cx) * k;
      z = p.cz + (z - p.cz) * k;
      pos.setXYZ(i, x, y, z);
      var brown = smooth01((Math.abs(ny) - 0.4) / 0.5);
      c.copy(pale).lerp(ny > 0 ? topBrown : botBrown, brown);
      var m = 1 + 0.07 * mottle(x, y, z) * brown;
      c.multiplyScalar(m);
      if (isTop && ny > 0.8) c.lerp(sugar, 0.32 * smooth01(sugarHaze(x, y, z) * 0.8 + 0.2));
      colors[3 * i] = c.r; colors[3 * i + 1] = c.g; colors[3 * i + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    weldNormals(geo);
    return geo;
  }

  // Top pancake surface by arc length s from the top centre, at angle phi
  // (x = r sin phi, z = r cos phi around the pancake centre).
  var topArc = null;
  function buildTopArc(p) {
    var prof = pancakeProfile(p);
    var pn = profileNormals(prof);
    var pts = prof.slice().reverse();
    var nrm = pn.slice().reverse();
    var s = [0];
    for (var i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    topArc = { p: p, pts: pts, nrm: nrm, s: s };
  }
  function surfaceAt(phi, sArc, out) {
    var A = topArc;
    var i = 1;
    while (i < A.s.length - 1 && A.s[i] < sArc) i++;
    var u = Math.min(1, Math.max(0, (sArc - A.s[i - 1]) / (A.s[i] - A.s[i - 1] || 1)));
    var r = A.pts[i - 1][0] + (A.pts[i][0] - A.pts[i - 1][0]) * u;
    var y = A.pts[i - 1][1] + (A.pts[i][1] - A.pts[i - 1][1]) * u;
    var nr = A.nrm[i - 1][0] + (A.nrm[i][0] - A.nrm[i - 1][0]) * u;
    var ny = A.nrm[i - 1][1] + (A.nrm[i][1] - A.nrm[i - 1][1]) * u;
    var nl = Math.hypot(nr, ny) || 1;
    nr /= nl; ny /= nl;
    var x = A.p.cx + r * Math.sin(phi);
    var z = A.p.cz + r * Math.cos(phi);
    var yy = A.p.base + y;
    var sideW = 1 - smooth01((Math.abs(ny) - 0.2) / 0.6);
    var k = bumpScale(x, yy, z, sideW);
    out.x = A.p.cx + (x - A.p.cx) * k;
    out.y = yy;
    out.z = A.p.cz + (z - A.p.cz) * k;
    out.nx = nr * Math.sin(phi);
    out.ny = ny;
    out.nz = nr * Math.cos(phi);
  }

  // ---- syrup -------------------------------------------------------------
  // The pool leans to the front-left (where it reaches the rim); drips
  // leave from there. The right side stays bare cake for the fork.
  var POOL_LEAN = -0.7;
  var DRIPS = [
    { phi: -0.9, len: 0.45, w: 0.14 },
    { phi: -0.25, len: 0.3, w: 0.12 },
    { phi: -1.6, len: 0.5, w: 0.13 },
  ];
  function angDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
  function poolBase(phi) {
    return 0.52 + 0.2 * Math.cos(angDiff(phi, POOL_LEAN)) + 0.025 * Math.sin(3 * phi + 0.7) + 0.015 * Math.sin(5 * phi + 2.1);
  }
  function poolLen(phi) {
    var L = poolBase(phi);
    for (var k = 0; k < DRIPS.length; k++) {
      var a = angDiff(phi, DRIPS[k].phi) / DRIPS[k].w;
      if (Math.abs(a) < 1) L += DRIPS[k].len * Math.pow(1 - a * a, 1.5);
    }
    return L;
  }
  // Rounded edge everywhere; a drip also swells into a drop at its tip.
  function syrupThickness(sArc, L, drip) {
    var d = Math.min(1, (L - sArc) / 0.07);
    d = Math.max(0, d);
    var e = (L - sArc - 0.06) / 0.045;
    return SYRUP_T * Math.sqrt(d * (2 - d)) + 0.014 * drip * d * Math.exp(-e * e) + 0.0025;
  }

  function buildSyrup() {
    var N = 256, M = 30;
    var pos = [];
    var idx = [];
    var q = {};
    for (var i = 0; i <= N; i++) {
      var phi = (i / N) * 2 * Math.PI;
      var L = poolLen(phi);
      var drip = smooth01((L - poolBase(phi) - 0.12) / 0.2);
      for (var j = 0; j <= M; j++) {
        var sArc = L * (1 - Math.pow(1 - j / M, 1.7));
        surfaceAt(phi, sArc, q);
        var th = syrupThickness(sArc, L, drip);
        pos.push(q.x + q.nx * th, q.y + q.ny * th, q.z + q.nz * th);
      }
    }
    for (i = 0; i < N; i++) {
      for (j = 0; j < M; j++) {
        var a = i * (M + 1) + j, b = (i + 1) * (M + 1) + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    weldNormals(geo);
    return geo;
  }

  // Rest height of the top of the stack (cake + syrup) at (x, z).
  function restTopY(x, z) {
    var p = topArc.p;
    var dx = x - p.cx, dz = z - p.cz;
    var r = Math.hypot(dx, dz);
    var phi = Math.atan2(dx, dz);
    var q = {};
    surfaceAt(phi, r, q);
    var L = poolLen(phi);
    return q.y + (r < L ? syrupThickness(r, L, 0) : 0);
  }

  // ---- toppings ----------------------------------------------------------
  function blueberryGeo(r) {
    var m = new Merger();
    var body = superBlob(r, r * 0.86, r, 2.2, 28, 18);
    m.add(body, new THREE.Matrix4(), linColor(0x4f5fa6));
    var crown = new THREE.ConeGeometry(r * 0.36, r * 0.22, 5);
    var cm = new THREE.Matrix4().makeRotationX(Math.PI).setPosition(0, r * 0.86 - r * 0.05, 0);
    m.add(crown, cm, linColor(0x262b57));
    return m.build();
  }

  function raspberryGeo(key) {
    var m = new Merger();
    var rng = Reel.rng(key);
    var core = superBlob(0.085, 0.1, 0.085, 2, 20, 14);
    m.add(core, new THREE.Matrix4().makeTranslation(0, 0.11, 0), linColor(0xb3243c));
    var drupe = new THREE.SphereGeometry(0.036, 10, 8);
    var rings = [[0.35, 5], [0.7, 9], [1.05, 11], [1.4, 12], [1.75, 11], [2.1, 10], [2.45, 7]];
    for (var k = 0; k < rings.length; k++) {
      var th = rings[k][0];
      var cnt = rings[k][1];
      for (var i = 0; i < cnt; i++) {
        var ph = (i + (k % 2) * 0.5) / cnt * 2 * Math.PI;
        var x = 0.098 * Math.sin(th) * Math.cos(ph);
        var z = 0.098 * Math.sin(th) * Math.sin(ph);
        var y = 0.11 + 0.118 * Math.cos(th);
        var tone = new THREE.Color(0xd8354f).lerp(new THREE.Color(0xe8566a), rng());
        m.add(drupe, new THREE.Matrix4().makeTranslation(x, y, z), tone);
      }
    }
    return m.build();
  }

  function placeGeo(geo, x, y, z, rx, ry, rz, s) {
    var mat = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(s, s, s)
    );
    geo.applyMatrix4(mat);
    return geo;
  }

  // Tiny flat hexagons of powdered sugar lying on a surface.
  function sugarFlakes(key, count, pick) {
    var rng = Reel.rng(key);
    var m = new Merger();
    var white = linColor(0xffffff);
    var disc = new THREE.CircleGeometry(1, 6);
    var q = new THREE.Quaternion();
    var up = new THREE.Vector3(0, 0, 1);
    for (var i = 0; i < count; i++) {
      var spot = pick(rng);
      if (!spot) continue;
      var s = 0.006 + 0.009 * rng();
      q.setFromUnitVectors(up, new THREE.Vector3(spot.nx, spot.ny, spot.nz));
      var spin = new THREE.Quaternion().setFromAxisAngle(up, rng() * 6.283);
      var mat = new THREE.Matrix4().compose(new THREE.Vector3(spot.x, spot.y, spot.z), q.clone().multiply(spin), new THREE.Vector3(s, s, s));
      m.add(disc, mat, white);
    }
    return m.build();
  }

  // ---- fork --------------------------------------------------------------
  var fork = null;
  var forkKc = new THREE.Vector3();  // local point of the contact tine that touches
  var forkQuat = new THREE.Quaternion();
  var forkTineRange = null;

  function buildFork() {
    var m = new Merger();
    var silver = linColor(0xdfe3e8);
    var tine = new THREE.CapsuleGeometry(0.034, 0.64, 6, 12);
    tine.scale(1, 1, 0.55);
    var ranges = [];
    for (var i = 0; i < 4; i++) {
      ranges.push(m.add(tine, new THREE.Matrix4().makeTranslation(i * 0.15, 0.034 + 0.32, 0), silver));
    }
    var head = superBlob(0.29, 0.2, 0.022, 4, 32, 16);
    m.add(head, new THREE.Matrix4().makeTranslation(0.225, 0.78, 0), silver);
    var neck = superBlob(0.12, 0.42, 0.024, 3, 24, 16);
    m.add(neck, new THREE.Matrix4().makeTranslation(0.225, 1.2, 0), silver);
    var handle = superBlob(0.16, 1.7, 0.036, 4, 32, 24);
    m.add(handle, new THREE.Matrix4().makeTranslation(0.225, 3.1, 0), silver);
    var geo = m.build();
    var mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.95, roughness: 0.22, envMapIntensity: 3 });
    fork = new THREE.Mesh(geo, mat);
    fork.castShadow = true;
    fork.receiveShadow = true;
    scene.add(fork);
    forkTineRange = ranges;

    // Orientation: tines point down-left along -FORK_DIR; the fork is on
    // its side, the tine row runs upward, so only the lowest tine taps.
    var Y = new THREE.Vector3(FORK_DIR[0], FORK_DIR[1], FORK_DIR[2]);
    var X = new THREE.Vector3(0, 1, 0).sub(Y.clone().multiplyScalar(Y.y)).normalize();
    var Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    forkQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    fork.quaternion.copy(forkQuat);

    // Contact point: the vertex of tine 0 lowest in world orientation.
    var p = geo.attributes.position;
    var v = new THREE.Vector3();
    var best = Infinity;
    for (var k = ranges[0].from; k < ranges[0].to; k++) {
      v.fromBufferAttribute(p, k).applyQuaternion(forkQuat);
      if (v.y < best) { best = v.y; forkKc.fromBufferAttribute(p, k); }
    }
  }

  var tapOut = [0, 0, 0];
  function tapPointAt(t) {
    wobbleField(TAP.x, TAP.y, TAP.z, t, tapOut);
    return new THREE.Vector3(tapOut[0], tapOut[1], tapOut[2]);
  }

  var FORK_IN = new THREE.Vector3(1.9, 2.3, 0.9);    // approach offset
  var FORK_OUT = new THREE.Vector3(2.3, 3.2, 1.2);   // retreat offset
  var FORK_T0 = 0.12;
  var FORK_T_OUT = 0.6;                               // s to leave frame

  // Tip position: in along an accelerating path, on the surface during
  // contact, out with a fast start.
  function forkTipAt(t) {
    var tc = WOB.tTap;
    var tr = WOB.tTap + WOB.contact;
    if (t < tc) {
      var u = Math.max(0, (t - FORK_T0) / (tc - FORK_T0));
      var g = 1 - u * u * (2 - u);
      return tapPointAt(tc).add(FORK_IN.clone().multiplyScalar(g));
    }
    if (t <= tr) return tapPointAt(t);
    var v = Math.min(1, (t - tr) / FORK_T_OUT);
    var k = 1 - Math.pow(1 - v, 3);
    return tapPointAt(tr).add(FORK_OUT.clone().multiplyScalar(k));
  }

  function placeFork(t) {
    var tip = forkTipAt(t);
    var off = forkKc.clone().applyQuaternion(forkQuat);
    fork.position.copy(tip.sub(off));
    fork.visible = t > FORK_T0 && t < WOB.tTap + WOB.contact + FORK_T_OUT;
  }

  // ---- textures ----------------------------------------------------------
  function woodTexture() {
    var c = document.createElement("canvas");
    c.width = 1024; c.height = 1024;
    var g = c.getContext("2d");
    var rng = Reel.rng("wood");
    var planks = 5;
    var pw = 1024 / planks;
    var tones = ["#c99463", "#c08a58", "#cf9c6b", "#c38d5c", "#cb9766"];
    for (var i = 0; i < planks; i++) {
      g.fillStyle = tones[i];
      g.fillRect(i * pw, 0, pw, 1024);
      for (var k = 0; k < 26; k++) {
        var x0 = i * pw + rng() * pw;
        var amp = 3 + rng() * 10;
        var fr = 0.004 + rng() * 0.01;
        var ph = rng() * 6.28;
        g.strokeStyle = rng() < 0.5 ? "rgba(120,70,35,0.10)" : "rgba(255,225,180,0.08)";
        g.lineWidth = 3 + rng() * 9;
        g.beginPath();
        for (var y = 0; y <= 1024; y += 16) {
          var x = x0 + amp * Math.sin(y * fr + ph);
          if (y === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
      g.fillStyle = "rgba(90,50,25,0.28)";
      g.fillRect(i * pw - 2, 0, 4, 1024);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    tex.anisotropy = 4;
    return tex;
  }

  function bokehTexture() {
    var c = document.createElement("canvas");
    c.width = 1024; c.height = 768;
    var g = c.getContext("2d");
    var rng = Reel.rng("bokeh");
    var bg = g.createLinearGradient(0, 0, 0, 768);
    bg.addColorStop(0, "#f7ead6");
    bg.addColorStop(1, "#ecd6b8");
    g.fillStyle = bg;
    g.fillRect(0, 0, 1024, 768);
    function blob(x, y, r, col, a) {
      var rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, "rgba(" + col + "," + a + ")");
      rg.addColorStop(0.6, "rgba(" + col + "," + a * 0.55 + ")");
      rg.addColorStop(1, "rgba(" + col + ",0)");
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    blob(400, 330, 360, "255,250,236", 0.95);   // window glow
    blob(760, 420, 200, "150,190,130", 0.6);   // plant
    blob(850, 530, 160, "120,165,110", 0.5);
    blob(250, 610, 120, "240,180,165", 0.55);    // pink mug
    for (var i = 0; i < 26; i++) {
      blob(150 + rng() * 724, 80 + rng() * 520, 18 + rng() * 40, "255,244,220", 0.25 + rng() * 0.35);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---- world ---------------------------------------------------------------
  var CAM_TARGET = new THREE.Vector3(0, 1.1, 0);
  var tracked = {};

  function buildWorld() {
    renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    renderer.setSize(RW, RH, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0dcc0);
    scene.fog = new THREE.Fog(0xf0dcc0, 12, 26);

    var pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;

    camera = new THREE.PerspectiveCamera(30, RW / RH, 0.1, 100);

    scene.add(new THREE.HemisphereLight(0xfff3e0, 0xb88a5a, 0.55));
    var key = new THREE.DirectionalLight(0xffe4c2, 2.6);
    key.position.set(-5, 8, 5);
    key.target.position.set(0, 0.8, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -3.2;
    key.shadow.camera.right = 3.2;
    key.shadow.camera.top = 3.2;
    key.shadow.camera.bottom = -3.2;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    scene.add(key);
    scene.add(key.target);
    var rim = new THREE.DirectionalLight(0xffd6a0, 1.6);
    rim.position.set(4, 3.5, -6);
    scene.add(rim);

    // counter + background
    var counter = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, metalness: 0 })
    );
    counter.rotation.x = -Math.PI / 2;
    counter.position.set(0, 0, 13);
    counter.receiveShadow = true;
    scene.add(counter);
    var backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 9),
      new THREE.MeshBasicMaterial({ map: bokehTexture(), fog: false, toneMapped: false })
    );
    backdrop.position.set(0, 4.3, -7);
    scene.add(backdrop);

    // plate
    var plateProfile = [
      [0, 0.012], [1.1, 0.012], [1.15, 0.0], [1.22, 0.0], [1.28, 0.02], [1.5, 0.07], [1.68, 0.12],
      [1.76, 0.155], [1.79, 0.175], [1.78, 0.19], [1.74, 0.195], [1.66, 0.18], [1.5, 0.13],
      [1.32, 0.08], [1.22, 0.058], [1.1, BASE_Y], [0.55, BASE_Y], [0, BASE_Y],
    ];
    var plateGeo = new THREE.LatheGeometry(plateProfile.map(function (q) { return new THREE.Vector2(q[0], q[1]); }), 128);
    plateGeo.computeVertexNormals();
    weldNormals(plateGeo);
    var plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: 0xbfe3cf, roughness: 0.28, metalness: 0 }));
    plate.castShadow = true;
    plate.receiveShadow = true;
    scene.add(plate);

    // stack
    sideBump = makeNoise("bump", 6, 9);
    mottle = makeNoise("mottle", 6, 14);
    sugarHaze = makeNoise("haze", 5, 11);
    layoutStack();
    var cakeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    for (var k = 0; k < LAYERS.length; k++) {
      addDeformable(buildPancake(LAYERS[k], k === LAYERS.length - 1), cakeMat, { name: "pancake" + k });
    }
    var topP = LAYERS[LAYERS.length - 1];
    buildTopArc(topP);

    var syrupMat = new THREE.MeshStandardMaterial({
      color: 0xb06020, roughness: 0.08, metalness: 0, emissive: 0x4a1c00, emissiveIntensity: 0.3,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    addDeformable(buildSyrup(), syrupMat, { name: "syrup", cast: false });

    // tap point: bare cake just outside the syrup pool, right-front
    var tapPhi = 1.12;
    var q = {};
    surfaceAt(tapPhi, 0.62, q);
    TAP.x = q.x; TAP.y = q.y; TAP.z = q.z;

    var topY0 = restTopY(topP.cx, topP.cz);
    var butterGeo = superBlob(0.22, 0.078, 0.18, 5, 48, 24);
    placeGeo(butterGeo, topP.cx + 0.03, topY0 + 0.078 - 0.022, topP.cz - 0.02, 0.03, 0.45, -0.04, 1);
    addDeformable(butterGeo, new THREE.MeshStandardMaterial({ color: 0xfde7a2, roughness: 0.38, metalness: 0 }), { name: "butter" });

    var berryMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 });
    var rasMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0 });
    var toppings = new Merger();
    var blue = [[0.08, 0.44], [-0.2, 0.46], [0.02, -0.45]];
    for (var b = 0; b < blue.length; b++) {
      var bx = topP.cx + blue[b][0], bz = topP.cz + blue[b][1];
      var bg = blueberryGeo(0.1);
      placeGeo(bg, bx, restTopY(bx, bz) + 0.086 - 0.012, bz, 0.2 * b, 1.3 * b, 0.15, 1);
      toppings.add(bg, new THREE.Matrix4(), null);
    }
    addDeformable(toppings.build(), berryMat, { name: "blueberries" });
    var ras = [[-0.4, 0.2, 0.25], [-0.3, -0.28, -0.4]];
    var rasM = new Merger();
    for (var r = 0; r < ras.length; r++) {
      var rx = topP.cx + ras[r][0], rz = topP.cz + ras[r][1];
      var rg = raspberryGeo("rasp" + r);
      placeGeo(rg, rx, restTopY(rx, rz) - 0.01, rz, ras[r][2], r * 2.1, 0.1, 1);
      rasM.add(rg, new THREE.Matrix4(), null);
    }
    addDeformable(rasM.build(), rasMat, { name: "raspberries" });

    // sugar on top (rides the stack) and on the plate (still)
    var topSugar = sugarFlakes("sugarTop", 520, function (rng) {
      var rr = Math.sqrt(rng()) * 0.68;
      var ph = rng() * 6.283;
      var x = topP.cx + rr * Math.sin(ph), z = topP.cz + rr * Math.cos(ph);
      if (Math.hypot(x - topP.cx, z - topP.cz) < 0.26) return null;
      return { x: x, y: restTopY(x, z) + 0.004, z: z, nx: 0, ny: 1, nz: 0 };
    });
    addDeformable(topSugar, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, emissive: 0x2a2620, vertexColors: true }), { name: "sugar", cast: false });
    var plateSugar = sugarFlakes("sugarPlate", 300, function (rng) {
      var rr = 1.08 + rng() * 0.16;
      var ph = rng() * 6.283;
      return { x: rr * Math.sin(ph), y: BASE_Y + 0.003, z: rr * Math.cos(ph), nx: 0, ny: 1, nz: 0 };
    });
    var ps = new THREE.Mesh(plateSugar, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, emissive: 0x2a2620, vertexColors: true }));
    ps.receiveShadow = true;
    scene.add(ps);

    // a berry on the plate
    var pb = blueberryGeo(0.1);
    placeGeo(pb, -1.12, BASE_Y + 0.086, 0.62, 0.3, 0.7, 0, 1);
    var pbm = new THREE.Mesh(pb, berryMat);
    pbm.castShadow = true;
    scene.add(pbm);
    var pr = raspberryGeo("raspPlate");
    placeGeo(pr, 1.12, BASE_Y + 0.1, 0.72, 1.35, 0.4, 0.2, 1);
    var prm = new THREE.Mesh(pr, rasMat);
    prm.castShadow = true;
    scene.add(prm);

    buildFork();

    // rest points measure(t) tracks
    var mid = LAYERS[1], bot = LAYERS[0];
    function sideMid(p, dir) {
      return [p.cx + dir * (p.R + p.puff), p.base + p.rb + (p.H - p.rt - p.rb) / 2, p.cz];
    }
    tracked = {
      topLeft: sideMid(topP, -1),
      topRight: sideMid(topP, 1),
      midRight: sideMid(mid, 1),
      botRight: sideMid(bot, 1),
      butterTop: [topP.cx + 0.03, topY0 + 0.156 - 0.022, topP.cz - 0.02],
      tap: [TAP.x, TAP.y, TAP.z],
    };

    worldBuilt = true;
  }

  function placeCamera(t) {
    var u = smooth01(t / 3);
    var dist = 10.4 - 0.3 * u;
    var el = (30 * Math.PI) / 180;
    var az = 0.04 - 0.05 * u;
    camera.position.set(
      CAM_TARGET.x + dist * Math.sin(az) * Math.cos(el),
      CAM_TARGET.y + dist * Math.sin(el),
      CAM_TARGET.z + dist * Math.cos(az) * Math.cos(el)
    );
    camera.lookAt(CAM_TARGET);
    camera.updateMatrixWorld();
  }

  function poseAt(t) {
    placeCamera(t);
    deformStack(t);
    placeFork(t);
  }

  function render3D(t) {
    poseAt(t);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  // Soft warm vignette in the 2D overlay (full resolution, after the copy).
  function drawVignette() {
    var g = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.47, HEIGHT * 0.3, WIDTH / 2, HEIGHT * 0.47, HEIGHT * 0.75);
    g.addColorStop(0, "rgba(70,40,15,0)");
    g.addColorStop(1, "rgba(70,40,15,0.28)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  // ---- measurements (soft-body/measure.mjs reads these) ----------------
  function projectPx(p) {
    var v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    return [((v.x + 1) / 2) * WIDTH, ((1 - v.y) / 2) * HEIGHT];
  }

  function measure(t) {
    poseAt(t);
    var out = { t: t, px: {}, restPx: {} };
    var o = [0, 0, 0];
    Object.keys(tracked).forEach(function (k) {
      var p = tracked[k];
      wobbleField(p[0], p[1], p[2], t, o);
      out.px[k] = projectPx(o);
      out.restPx[k] = projectPx(p); // same camera, undeformed
    });
    // lowest stack vertex vs the plate (glued base: must stay >= 0)
    var minH = Infinity;
    deformables.forEach(function (e) {
      var P = e.mesh.geometry.attributes.position.array;
      for (var i = 1; i < P.length; i += 3) if (P[i] - BASE_Y < minH) minH = P[i] - BASE_Y;
    });
    out.minAbovePlate = minH;
    // fork tine vertices vs the deformed top surface right under them
    var targets = deformables.filter(function (e) { return /pancake2|syrup|butter/.test(e.name); }).map(function (e) {
      e.mesh.geometry.computeBoundingSphere();
      e.mesh.geometry.computeBoundingBox();
      return e.mesh;
    });
    fork.updateMatrixWorld(true);
    var ray = new THREE.Raycaster();
    var pos = fork.geometry.attributes.position;
    var v = new THREE.Vector3();
    var worst = Infinity;
    if (fork.visible) {
      for (var r = 0; r < forkTineRange.length; r++) {
        for (var i = forkTineRange[r].from; i < forkTineRange[r].to; i += 3) {
          v.fromBufferAttribute(pos, i).applyMatrix4(fork.matrixWorld);
          ray.set(new THREE.Vector3(v.x, 20, v.z), new THREE.Vector3(0, -1, 0));
          var hit = ray.intersectObjects(targets, false)[0];
          if (hit) worst = Math.min(worst, v.y - hit.point.y);
        }
      }
    }
    out.forkClearance = worst === Infinity ? null : worst;
    var tip = forkTipAt(t);
    var tp = tapPointAt(t);
    out.tipToSurface = t >= WOB.tTap && t <= WOB.tTap + WOB.contact ? tip.distanceTo(tp) : null;
    out.forkTipPx = fork.visible ? projectPx([tip.x, tip.y, tip.z]) : null;
    return out;
  }

  window.__wobbleDebug = { measure: measure, params: WOB };

  // Copies the WebGL framebuffer to the 2D stage byte-for-byte. Never
  // ctx.drawImage(glCanvas) — copying a live WebGL canvas that way varies
  // by up to one colour level between draws of the identical frame and
  // fails verify.mjs's determinism probe (references/3d.md).
  // gl.readPixels + putImageData into a plain 2D canvas is
  // exact; scaling that 2D canvas up with drawImage is then safe, because
  // the source is a deterministic software (ImageData-backed) canvas, not
  // a WebGL one.
  function copyToStage() {
    var gl = renderer.getContext();
    if (!glPixels) {
      glPixels = new Uint8Array(RW * RH * 4);
      smallCanvas = document.createElement("canvas");
      smallCanvas.width = RW;
      smallCanvas.height = RH;
      smallCtx = smallCanvas.getContext("2d");
      smallImg = smallCtx.createImageData(RW, RH);
    }
    gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, glPixels);
    var row = RW * 4;
    for (var y = 0; y < RH; y++) {
      smallImg.data.set(glPixels.subarray((RH - 1 - y) * row, (RH - y) * row), y * row);
    }
    smallCtx.putImageData(smallImg, 0, 0);
    ctx.drawImage(smallCanvas, 0, 0, RW, RH, 0, 0, WIDTH, HEIGHT);
  }

  // ---- 2D overlay: captions and any text always draw here, at full
  // resolution, on top of the upscaled 3D picture (references/3d.md
  // "text always in the 2D overlay").
  function currentLineIndex(t) {
    if (!timings) return -1;
    for (var i = 0; i < timings.lines.length; i++) {
      var l = timings.lines[i];
      if (t >= l.start && t < l.end) return i;
    }
    if (timings.lines.length && t >= timings.lines[timings.lines.length - 1].end) {
      return timings.lines.length - 1;
    }
    return -1;
  }

  // drawCaptions(t) — this film's own caption look for the picture-first +
  // dub path (references/pipeline.md "Picture first"); replace
  // Reel.caption() with custom draw code the same way the 2D scaffold
  // documents. dubPlan carries that language's own per-line fields.
  function drawCaptions(t) {
    var idx = currentLineIndex(t);
    var line = idx >= 0 ? timings.lines[idx] : null;
    Reel.caption(ctx, line, t, { width: WIDTH, height: HEIGHT });
  }

  function seek(t) {
    if (isCaptionLayer) {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawCaptions(t);
      return;
    }
    if (!worldBuilt) return;
    render3D(t);
    copyToStage();
    drawVignette(); // picture only: no caption drawn here
  }

  var ready = threeLoadError
    ? Promise.reject(new Error(THREE_MISSING_MESSAGE))
    : Promise.all([
        loadDeclaredFonts(),
        loadFilmKey(),
        isCaptionLayer ? Promise.all([loadTimings(), loadDubPlan()]) : loadTimings(),
      ]).then(function () {
        if (isCaptionLayer) return null;
        return import("./assets/vendor/addons/environments/RoomEnvironment.js").then(function (mod) {
          RoomEnvironment = mod.RoomEnvironment;
          buildWorld();
        });
      });

  window.__reel = {
    get width() { return WIDTH; },
    get height() { return HEIGHT; },
    get fps() { return FPS; },
    get duration() { return timings ? timings.duration : 0; },
    ready: ready,
    seek: seek,
    get shots() { return shots; },
    get layers() { return ["captions"]; },
    issues: function () { return Reel.issues(); },
    audio: { narration: "voice/narration.wav", renderSfx: renderSfx },
    get marks() { return []; },
  };
})();
