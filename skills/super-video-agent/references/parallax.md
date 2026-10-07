# 2.5D parallax (a living photo)

Contents: What it is · Depth convention · The call · Camera moves · Depth blur · Edge coverage · Layers from one still · Worked example

## What it is

For a parallax shot, automatically load and review the whole set: source choice, three-layer separation,
optional alpha masks and depth maps, and masked key-photo mixing. Use only the parts
the shot needs. Polygon cuts remain the default.

Choose a real photograph with a foreground subject and a separable middle and far
background. A flat illustration or a rendered 3D frame does not meet this photo
workflow. If a suitable photo is unavailable, choose another technique.
Check reuse rights before editing. Record the source URL, creator, license and
changes in the project record. Keep a readable source credit visible for the whole
time the photo is on screen. This source check also applies to other photo scenes.

A still is split into flat layers at different depths. One camera path moves over all of them: a
near layer slides far, a far layer slides little. The eye reads the difference as depth. The 2D
engine does this with `Reel.parallax(ctx, t, spec)`; the picture at `t` depends only on `t`, so it
is safe for the renderer's out-of-order seeks (`references/pipeline.md`).

## Depth convention

`depth >= 1`. `depth: 1` is the nearest layer and follows the camera one to one. A layer at depth `d`
moves `1/d` as far and zooms `(zoom - 1)/d` as much, and rotates `1/d` as much. Larger is farther.
Typical values: subject 1, mid ground 2 to 3, background 5 to 10. A sky or far wall at 20 hardly moves.
Layers are drawn deepest first. A depth under 1 throws.

## The call

```js
Reel.parallax(ctx, t, {
  width, height,                    // only when ctx.canvas has no size
  layers: [
    { image, depth: 8 },            // an ImageBitmap; or draw(ctx, w, h) in place of image
    { image: subject, depth: 1, x: 0, y: 0, scale: 1.1, opacity: 1, blur: 0 },
  ],
  camera: { keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 6, x: 60, y: 0, zoom: 1.15, rot: 0 }], ease: "inOut" },
  focusDepth: 1, depthBlur: 0,      // blur px per unit of depth away from the focus
  overscan: 1,                      // extra scale on every layer
});
```

- An image layer is cover-fitted to the frame and centred; `scale` multiplies that, `x`, `y` shift it in
  px. `fit: "natural"` keeps the image's own size. A `draw` layer is called with the rect it fills
  (default the frame, or `w`, `h` on the layer) after the camera transform is applied.
- Camera `x`, `y` are px of camera travel at depth 1 (positive `x` = the camera moves right, the scene
  moves left); `zoom` 1 = none; `rot` degrees. `ease` is `"inOut"` (default), `"linear"`, `"out"` or a
  function of 0..1. Before the first key and after the last, the camera holds. Zoom is mixed by ratio.
- Hold each image as an `ImageBitmap` (`references/pipeline.md` "Drawing and mixing cues").

## Camera moves

| Move | Keys |
|---|---|
| slow push-in | zoom 1 to 1.1 or 1.2 over the shot, `x`, `y` near 0 |
| lateral slide | `x` from -50 to 50, zoom 1; the near layer travels 50, a depth-5 layer 10 |
| dolly-zoom feel | a zoom rise with the subject at depth 1 and the background at 10: the subject grows, the room barely does |
| drift with a turn | a push-in plus `rot` 1 to 2 degrees |

Keep travel small: the larger the camera move, the larger the overscan every layer needs. Ease in and
out so the shot does not start or stop with a jerk.

## Depth blur

`depthBlur` px of blur per unit of depth from `focusDepth` gives a shallow depth of field: with
`focusDepth: 1` and `depthBlur: 1.5`, a depth-5 layer is blurred 6 px. A layer's own `blur` overrides
it. Blur uses `ctx.filter`, so it softens the layer's own edges too; the coverage check counts that as
lost margin.

## Edge coverage

A layer that is too small for the camera path shows a bare edge. `Reel.parallaxCoverage(spec, width,
height, {step})` walks the path (every frame by default) and returns
`{ok, layers: [{layer, depth, overscan, spans: [{from, to}]}]}`: each layer that fails, the seconds it
fails in, and `overscan`, the factor to multiply that layer's `scale` by. Far layers move least, so
they need the least; the nearest layer needs the most. A layer with `cover: false` (a sprite meant to
be smaller than the frame) is skipped. The check measures rectangles, not whether the pixels in them
are opaque.

Expose it so the scripts print it, as a report only:

```js
window.__reel.parallaxReport = () => Reel.parallaxCoverage(spec, width, height);
```

`render.mjs` and `verify.mjs` print `parallax layer 1 (depth 2): edge bare at 0.60-2.00 s; multiply its
scale by 1.15 or more`. Apply it: `layer.scale *= overscan`.

## Layers from one still

Cut near layers out of the photo in code; the rest of the photo is the far plate.

1. Trace the subject as a polygon in image px (a list of `{x, y}`), or a function that adds a path to
   the context.
2. `Reel.cutLayer(image, path, {feather})` returns a canvas the size of the image with only that region
   opaque. A `feather` of 3 to 8 px blurs the edge. Without it the cut-out's outline is a hard,
   aliased line that shimmers as the layers separate.
3. The subject's old place is a hole in the far plate. `Reel.holePlate(image, path, {grow, blur, dx, dy})`
   returns the image with that region (grown by `grow` px, default 4) painted over by the image shifted
   by `dx`, `dy` and blurred. By default it takes the strip one path-width to the side with room. Pick
   `dx`, `dy` yourself when that strip holds something else, or draw a clean plate and use it as the layer.
4. Turn each canvas into an `ImageBitmap` once (`await createImageBitmap(canvas)`) before the first seek.

Cut as few layers as the shot needs: two or three (subject, mid ground, background) read as depth; more
cut-outs make more edges to hide.

## Worked example

Use a licensed real street photo with all three regions. Trace the actual outlines;
these example coordinates assume a 1080 × 1920 source and are not a reusable cut.
Check each hole repair at the largest camera offset. A shifted patch may repeat
objects; use an edited clean plate when it does.

```js
const photo = await createImageBitmap(await (await fetch("assets/street.jpg")).blob());
// The real photo has a near subject, a middle planter, and a far street.
const midPath = [{ x: 90, y: 650 }, { x: 350, y: 650 }, { x: 350, y: 960 }, { x: 90, y: 960 }];
const subjectPath = [{ x: 410, y: 220 }, { x: 640, y: 210 }, { x: 690, y: 880 }, { x: 380, y: 900 }];
const subject = await createImageBitmap(Reel.cutLayer(photo, subjectPath, { feather: 5 }));
const middle = await createImageBitmap(Reel.cutLayer(photo, midPath, { feather: 4 }));
const withoutSubject = Reel.holePlate(photo, subjectPath, { grow: 12, blur: 14 });
const plate = await createImageBitmap(Reel.holePlate(withoutSubject, midPath, { grow: 10, blur: 12 }));

const spec = {
  width: 1080, height: 1920,
  camera: { keys: [{ t: 0, x: -30, y: 0, zoom: 1 }, { t: 6, x: 30, y: 0, zoom: 1.12 }] },
  focusDepth: 1, depthBlur: 1,
  layers: [
    { image: plate, depth: 6, scale: 1.05 },
    { image: middle, depth: 3, scale: 1.1, cover: false },
    { image: subject, depth: 1, scale: 1.2, cover: false },
  ],
};
window.__reel.parallaxReport = () => Reel.parallaxCoverage(spec, 1080, 1920);
// in seek(t):
// Reel.parallax(ctx, t, spec);
// Draw a readable source credit above the transformed layers throughout the shot.
```

Run `verify.mjs`; if it names a layer, multiply that layer's `scale` by the printed factor and run again.

## Optional alpha masks and depth maps

Use an alpha mask for hair, fur, or a detailed cutout. Use a depth map when five to
eight photo bands help a larger camera move. Keep polygon cuts for simple outlines.
These inputs also help cutout animation, photo composition, background photos in
3D scenes, and depth blur.

The optional local helper writes a same-size PNG and a provenance JSON file.
Install its dependencies in a separate environment: `rembg`, `onnxruntime` and
`Pillow` for masks; `transformers`, `torch`, `safetensors` and `Pillow` for depth.
Supply a trusted existing foreground-segmentation `.onnx` file for mask mode.
Supply a trusted local small inverse-depth model directory with safe-tensor weights
and processor files for depth mode. The helper downloads nothing, uses CPU mask
inference, rejects remote model names, and disables remote model code and pickle
weights. The supported implementation identifiers and official license sources
are recorded in the helper, separate from creative guidance.

```sh
/path/to/python /path/to/skill/scripts/photo-layers.py mask /path/to/assets/photo.jpg /path/to/assets/subject.png \
  --model /path/to/local/foreground.onnx --model-source '<official source URL>' --model-license '<verified license>'
/path/to/python /path/to/skill/scripts/photo-layers.py depth /path/to/assets/photo.jpg /path/to/assets/depth.png \
  --model /path/to/local/depth-model --model-source '<official source URL>' --model-license '<verified license>'
```

Verify the chosen weights' license separately from the runtime license and record
both with the model hash in the project record.

```js
const mask = await createImageBitmap(await (await fetch("assets/subject.png")).blob());
const cut = Reel.cutLayer(photo, null, { mask, feather: 2 });
const map = await createImageBitmap(await (await fetch("assets/depth.png")).blob());
const bands = Reel.depthLayers(photo, map, { count: 6, nearWhite: true });
// Prepare cleanPlate by repairing exposed regions before the first seek.
const layers = [{ image: cleanPlate, depth: 12 }, ...bands];
```

`mask` reads alpha, not grayscale brightness: white background pixels must be
transparent. Both mask and map must match the photo dimensions and crop exactly.
`depthLayers` reads grayscale brightness, assigns white to depth 1 and black to
the farthest band, and returns transparent image layers with `cover: false`.
Use `nearWhite: false` only for a map with the opposite convention. Bands are
relative depth, not physical distances. Cache their image bitmaps before seeking.
The helper's supported depth model produces inverse depth; other model types
may require a different normalization and are outside this adapter.

Depth does not reveal hidden background. Repair the far plate and inspect holes,
band seams, fine edges and the largest camera offset. A mask or map passing a
dimension check does not prove a convincing shot. Model quality and full photo
inference require a separate visual check; local contract tests do not prove them.

## Masked key photos

For a small expression change, edit the same source photo into a few key photos.
Keep the same identity, lighting, camera, crop, and background. Align the unchanged
landmarks on one canvas before masking. Matching dimensions alone does not prove
alignment. Inspect the face at full size and the final framing.

Mask only the changed region. Feather that mask and prepare a transparent patch
once with `cutLayer`. Mix the patch over the subject inside its parallax layer,
so both share the same camera transform. Do not fade the entire photo for a small
expression change: the background and unchanged features would ghost.

```js
// All images share the source photo dimensions and aligned landmarks.
// expressionMask is transparent outside the changed facial region.
const expressionPatch = await createImageBitmap(
  Reel.cutLayer(expressionPhoto, null, { mask: expressionMask, feather: 3 })
);
let shotTime = 0;
const expressiveSubject = {
  depth: 1, scale: 1.2, cover: false,
  draw(layerCtx, w, h) {
    const amount = Math.min(1, Math.max(0, (shotTime - 2) / 0.4));
    Reel.mixKeyPhoto(layerCtx, subject, expressionPatch, amount, { width: w, height: h });
  },
};
// In seek(t), assign shotTime = t before Reel.parallax(ctx, t, spec).
// Replace the subject layer in spec.layers with expressiveSubject.
```

`mixKeyPhoto` accepts a prepared alpha patch and a finite amount from 0 to 1.
It restores the drawing context and allocates no canvas during the mix. The patch
and base must have the same dimensions; the helper does not estimate alignment
or validate identity. Derive the amount only from the current seek time. Keep
prepared photos and masks unchanged so repeated out-of-order seeks agree.
Preview the start, middle, and end of each change for doubled features, lighting
jumps, and visible mask edges. Large arm or pose changes need more intermediate
photos or a cutout joint technique. A small masked fade cannot invent motion.
The same preparation can help photo animation and talking photo characters.
