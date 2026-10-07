// Tests for Reel.parallax / parallaxCoverage / cutLayer / holePlate (scripts/engine/reel-engine.js)
// and the report lines browser.mjs prints for the page hook window.__reel.parallaxReport.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parallaxReportLines } from "../scripts/lib/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "..", "scripts", "engine", "reel-engine.js"));
const Reel = globalThis.Reel;

const W = 400;
const H = 300;

// Records every call and every property set, in order.
function recordingCtx() {
  const log = [];
  const ctx = { log };
  for (const name of ["save", "restore", "translate", "rotate", "scale", "drawImage", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke"]) {
    ctx[name] = (...args) => log.push([name, ...args]);
  }
  for (const prop of ["filter", "globalAlpha", "globalCompositeOperation", "fillStyle", "strokeStyle", "lineWidth", "lineJoin"]) {
    Object.defineProperty(ctx, prop, { set: (v) => log.push(["set " + prop, v]) });
  }
  return ctx;
}

const img = (id, w = W, h = H) => ({ id, width: w, height: h });
const drawn = (ctx) => ctx.log.filter((e) => e[0] === "drawImage").map((e) => e[1].id);

test("parallaxPose: offset scales by 1/depth, zoom moves toward 1 by depth", () => {
  const cam = { x: 100, y: -40, zoom: 1.5, rot: 0 };
  const near = Reel.parallaxPose(cam, 1, W, H);
  assert.equal(near.tx, W / 2 - 100);
  assert.equal(near.ty, H / 2 + 40);
  assert.equal(near.zoom, 1.5);
  const far = Reel.parallaxPose(cam, 4, W, H);
  assert.equal(far.tx, W / 2 - 25);
  assert.equal(far.ty, H / 2 + 10);
  assert.equal(far.zoom, 1.125);
});

test("parallaxPose: depth below 1 is treated as 1", () => {
  const cam = { x: 10, y: 0, zoom: 1, rot: 0 };
  assert.deepEqual(Reel.parallaxPose(cam, 0.5, W, H), Reel.parallaxPose(cam, 1, W, H));
});

test("parallaxCamera: holds outside the keys, eases between, zoom by ratio", () => {
  const camera = { keys: [{ t: 1, x: 0, y: 0, zoom: 1 }, { t: 3, x: 100, y: 0, zoom: 4 }], ease: "linear" };
  assert.equal(Reel.parallaxCamera(camera, 0).x, 0);
  assert.equal(Reel.parallaxCamera(camera, 9).x, 100);
  const mid = Reel.parallaxCamera(camera, 2);
  assert.equal(mid.x, 50);
  assert.ok(Math.abs(mid.zoom - 2) < 1e-9);
  const eased = Reel.parallaxCamera({ keys: camera.keys }, 1.5);
  assert.ok(eased.x < 25, "the default ease starts slowly");
});

test("parallax: draws deepest layer first, with a translate/scale per layer pose", () => {
  const ctx = recordingCtx();
  const spec = {
    width: W,
    height: H,
    camera: { keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 40, y: 0, zoom: 1.2 }], ease: "linear" },
    layers: [
      { image: img("near"), depth: 1 },
      { image: img("far"), depth: 8 },
      { image: img("mid"), depth: 3 },
    ],
  };
  Reel.parallax(ctx, 2, spec);
  assert.deepEqual(drawn(ctx), ["far", "mid", "near"]);
  const translates = ctx.log.filter((e) => e[0] === "translate" && e[1] !== -W / 2);
  assert.deepEqual(translates[0].slice(1), [W / 2 - 40 / 8, H / 2]);
  assert.deepEqual(translates[2].slice(1), [W / 2 - 40, H / 2]);
});

test("parallax: same t gives the same calls, in any seek order and any layer order", () => {
  const layers = [
    { image: img("a"), depth: 1, x: 5 },
    { image: img("b"), depth: 2, opacity: 0.5 },
    { image: img("c"), depth: 5, blur: 3 },
  ];
  const camera = { keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 4, x: 60, y: 20, zoom: 1.3, rot: 2 }] };
  const at = (t, ls) => {
    const ctx = recordingCtx();
    Reel.parallax(ctx, t, { width: W, height: H, camera, layers: ls });
    return ctx.log;
  };
  const first = at(1.7, layers);
  at(3.3, layers);
  at(0.2, layers);
  assert.deepEqual(at(1.7, layers), first);
  assert.deepEqual(at(1.7, [layers[2], layers[0], layers[1]]), first);
});

test("parallax: a draw layer gets its rect size and is placed by translate", () => {
  const ctx = recordingCtx();
  const seen = [];
  Reel.parallax(ctx, 0, { width: W, height: H, layers: [{ draw: (c, w, h) => seen.push([w, h]), depth: 2, scale: 1.5 }] });
  assert.deepEqual(seen, [[W * 1.5, H * 1.5]]);
});

test("parallax: depth blur follows distance from the focus depth; explicit blur wins", () => {
  const ctx = recordingCtx();
  Reel.parallax(ctx, 0, {
    width: W,
    height: H,
    focusDepth: 2,
    depthBlur: 2,
    layers: [{ image: img("a"), depth: 5 }, { image: img("b"), depth: 2 }, { image: img("c"), depth: 3, blur: 0 }],
  });
  assert.deepEqual(ctx.log.filter((e) => e[0] === "set filter").map((e) => e[1]), ["blur(6px)"]);
});

test("parallax: rejects a layer with depth under 1 or nothing to draw", () => {
  assert.throws(() => Reel.parallax(recordingCtx(), 0, { width: W, height: H, layers: [{ image: img("a"), depth: 0.5 }] }), /depth must be a number >= 1/);
  assert.throws(() => Reel.parallax(recordingCtx(), 0, { width: W, height: H, layers: [{ depth: 2 }] }), /needs image or draw/);
});

const pushSpec = (overrides = {}) => ({
  camera: { keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 60, y: 0, zoom: 1 }], ease: "linear" },
  layers: [
    { image: img("near"), depth: 1, scale: 1.5 },
    { image: img("far"), depth: 2, scale: 1 },
  ],
  ...overrides,
});

test("parallaxCoverage: names the under-scanned layer, its spans, and the overscan that fixes it", () => {
  const spec = pushSpec();
  const r = Reel.parallaxCoverage(spec, W, H);
  assert.equal(r.ok, false);
  assert.equal(r.layers.length, 1);
  const bad = r.layers[0];
  assert.equal(bad.layer, 1);
  assert.equal(bad.depth, 2);
  assert.equal(bad.overscan, 1.15); // 2 * (200 + 30) / 400
  assert.ok(bad.spans[0].from > 0 && bad.spans[0].to === 2);
  spec.layers[1].scale *= bad.overscan;
  assert.deepEqual(Reel.parallaxCoverage(spec, W, H), { ok: true, width: W, height: H, step: 1 / 30, layers: [] });
});

test("parallaxCoverage: cover:false skips a layer; blur counts as lost margin; rotation is checked", () => {
  const skipped = pushSpec();
  skipped.layers[1].cover = false;
  assert.equal(Reel.parallaxCoverage(skipped, W, H).ok, true);

  const still = { camera: { keys: [{ t: 0, x: 0, y: 0, zoom: 1 }] }, layers: [{ image: img("a"), depth: 1, scale: 1.01 }] };
  assert.equal(Reel.parallaxCoverage(still, W, H).ok, true);
  still.layers[0].blur = 10;
  assert.equal(Reel.parallaxCoverage(still, W, H).layers[0].overscan, 1.057); // tall side: 2 * (150 + 10) / 303

  const turn = { camera: { keys: [{ t: 0, x: 0, y: 0, zoom: 1, rot: 0 }, { t: 1, x: 0, y: 0, zoom: 1, rot: 8 }] }, layers: [{ image: img("a"), depth: 1 }] };
  const r = Reel.parallaxCoverage(turn, W, H);
  assert.equal(r.ok, false);
  turn.layers[0].scale = r.layers[0].overscan;
  assert.equal(Reel.parallaxCoverage(turn, W, H).ok, true);
});

test("parallaxCoverage: a push-in keeps coverage and a pull-out does not", () => {
  const camera = (z) => ({ keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 0, y: 0, zoom: z }] });
  const layers = [{ image: img("a"), depth: 1 }];
  assert.equal(Reel.parallaxCoverage({ camera: camera(1.4), layers }, W, H).ok, true);
  assert.equal(Reel.parallaxCoverage({ camera: camera(0.8), layers }, W, H).layers[0].overscan, 1.25);
});

// A canvas that records into one shared log, tagged by an id.
function canvasFactory() {
  const made = [];
  const make = (w, h) => {
    const ctx = recordingCtx();
    const canvas = { id: "canvas" + made.length, width: w, height: h, getContext: () => ctx, ctx };
    made.push(canvas);
    return canvas;
  };
  return { make, made };
}

test("cutLayer: draws the image, then keeps only the feathered mask (destination-in)", () => {
  const { make, made } = canvasFactory();
  const source = img("photo");
  const out = Reel.cutLayer(source, [{ x: 10, y: 10 }, [100, 10], { x: 100, y: 90 }], { feather: 6, makeCanvas: make });
  const result = made[0];
  const mask = made[1];
  assert.equal(out, result);
  assert.deepEqual([out.width, out.height], [W, H]);
  assert.deepEqual(mask.ctx.log.filter((e) => e[0] === "set filter"), [["set filter", "blur(6px)"]]);
  assert.deepEqual(mask.ctx.log.filter((e) => e[0] === "moveTo" || e[0] === "lineTo").length, 3);
  const ops = result.ctx.log.map((e) => e[0] + (e[1] && e[1].id ? ":" + e[1].id : e[1] === "destination-in" ? ":dest-in" : ""));
  assert.deepEqual(ops, ["drawImage:photo", "set globalCompositeOperation:dest-in", "drawImage:canvas1"]);
});

test("cutLayer: no feather sets no blur; a function path is traced by the caller", () => {
  const { make, made } = canvasFactory();
  Reel.cutLayer(img("p"), (c) => c.moveTo(1, 2), { makeCanvas: make });
  assert.equal(made[1].ctx.log.some((e) => e[0] === "set filter"), false);
  assert.deepEqual(made[1].ctx.log.find((e) => e[0] === "moveTo"), ["moveTo", 1, 2]);
});

test("cutLayer: accepts aligned alpha masks and rejects mismatched dimensions", () => {
  const { make, made } = canvasFactory();
  Reel.cutLayer(img("p"), null, { mask: img("alpha"), feather: 2, makeCanvas: make });
  assert.equal(made.length, 1);
  assert.deepEqual(drawn(made[0].ctx), ["p", "alpha"]);
  assert.ok(made[0].ctx.log.some(e => e[0] === "set filter" && e[1] === "blur(2px)"));
  assert.throws(() => Reel.cutLayer(img("p"), null, { mask: img("small", 2, 2), makeCanvas: make }), /dimensions/);
});

test("depthLayers: maps each pixel to one band, white near; supports reversed maps", () => {
  const values = [255, 204, 153, 102, 51, 0];
  const pixels = new Uint8ClampedArray(values.flatMap(v => [v, v, v, 255]));
  function prepare(nearWhite) {
    const writes = [];
    const make = (w, h) => ({ width: w, height: h, getContext: () => ({
      ...recordingCtx(), getImageData: () => ({ data: pixels }),
      createImageData: () => ({ data: new Uint8ClampedArray(pixels.length) }),
      putImageData: data => writes.push(data.data),
    }) });
    const layers = Reel.depthLayers(img("p", 6, 1), img("map", 6, 1), { count: 6, nearWhite, makeCanvas: make });
    return { layers, writes };
  }
  const normal = prepare(true);
  assert.deepEqual(normal.layers.map(l => [l.depth, l.cover]), [[1,false],[2,false],[3,false],[4,false],[5,false],[6,false]]);
  normal.writes.forEach((data, i) => assert.equal(data[i * 4 + 3], 255));
  for (let i = 0; i < 6; i++) assert.equal(normal.writes.reduce((n, data) => n + data[i * 4 + 3], 0), 255);
  prepare(false).writes.forEach((data, i) => assert.equal(data[(5 - i) * 4 + 3], 255));
  assert.throws(() => Reel.depthLayers(img("p"), img("map"), { count: 4 }), /5 to 8/);
  assert.throws(() => Reel.depthLayers(img("p"), img("map", 3, 3)), /dimensions/);
});

test("mixKeyPhoto: mixes a prepared masked patch and restores the context", () => {
  const ctx = recordingCtx();
  const base = img("base"), patch = img("patch");
  const at = amount => {
    const output = recordingCtx();
    Reel.mixKeyPhoto(output, base, patch, amount, { width: 800, height: 600 });
    return output.log;
  };
  Reel.mixKeyPhoto(ctx, base, patch, 0.5);
  assert.deepEqual(drawn(ctx), ["base", "patch"]);
  assert.deepEqual(ctx.log.find(e => e[0] === "set globalAlpha"), ["set globalAlpha", 0.5]);
  assert.equal(ctx.log[0][0], "save");
  assert.equal(ctx.log.at(-1)[0], "restore");
  const halfway = at(0.5);
  at(1); at(0);
  assert.deepEqual(at(0.5), halfway);
  assert.equal(at(0).filter(e => e[0] === "drawImage").length, 1);
  assert.deepEqual(halfway.find(e => e[0] === "drawImage").slice(2), [0, 0, 800, 600]);
  for (const amount of [-1, 1.1, NaN, Infinity]) assert.throws(() => Reel.mixKeyPhoto(ctx, base, patch, amount), /amount/);
  assert.throws(() => Reel.mixKeyPhoto(ctx, base, img("small", 2, 3), 0.5), /dimensions/);
});

test("holePlate: paints the shifted, blurred image through a grown mask over the original", () => {
  const { make, made } = canvasFactory();
  const out = Reel.holePlate(img("photo"), [{ x: 200, y: 50 }, { x: 260, y: 50 }, { x: 260, y: 200 }], { grow: 10, blur: 12, makeCanvas: make });
  const [patch, mask, result] = made;
  assert.equal(out, result);
  // x range 200..260 plus 2*grow: one path-width of 80 px to the left (room on that side)
  assert.deepEqual(patch.ctx.log.find((e) => e[0] === "drawImage").slice(2, 4), [80, 0]);
  assert.ok(patch.ctx.log.some((e) => e[0] === "set filter" && e[1] === "blur(12px)"));
  assert.ok(mask.ctx.log.some((e) => e[0] === "set lineWidth" && e[1] === 20));
  assert.deepEqual(result.ctx.log.filter((e) => e[0] === "drawImage").map((e) => e[1].id), ["photo", "canvas0"]);
});

test("holePlate: a function path needs dx or dy", () => {
  const { make } = canvasFactory();
  assert.throws(() => Reel.holePlate(img("p"), (c) => c.moveTo(0, 0), { makeCanvas: make }), /pass opts.dx/);
  assert.doesNotThrow(() => Reel.holePlate(img("p"), (c) => c.moveTo(0, 0), { dx: 50, makeCanvas: make }));
});

test("parallaxReportLines: nothing without a hook, one line when clean, one line per bare layer", () => {
  assert.deepEqual(parallaxReportLines(null), []);
  assert.equal(parallaxReportLines({ ok: true, layers: [] }).length, 1);
  const lines = parallaxReportLines(Reel.parallaxCoverage(pushSpec(), W, H));
  assert.match(lines[0], /1 layer\(s\) leave a frame edge bare/);
  assert.match(lines[1], /parallax layer 1 \(depth 2\): edge bare at .* s; multiply its scale by 1\.15 or more/);
});
