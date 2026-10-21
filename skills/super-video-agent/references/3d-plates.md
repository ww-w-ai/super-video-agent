# 3D objects on a photo plate

A photographic background plate gives a 3D object a real setting: the object is modelled and lit in
three.js, the room around it is a photo, and a camera matched to the photo makes the two share one
table. Tools: `scripts/plate-match.mjs` (camera match, grid check) and the page helper
`scripts/engine/reel-plate.js` (`ReelPlate`: the same camera model, shot camera, edge coverage, the
projected photo material, the shadow catcher, the tone-curve inverse).

Contents: When to use a plate · Making the plate · Matching the camera · Scale · Light from the plate ·
Contact: shadow, occlusion, reflection · Motion with a still plate · Edge coverage · Pitfalls · Checks

## When to use a plate

- The object is the subject and needs a believable place (a product on a table, a tool on a bench), and a
  modelled room would cost more than it adds or look like a render.
- The camera stays near one viewpoint: a locked lens, a zoom, a small pan or tilt, a short lens dolly.
- Not for a camera that flies around the object or through the room. Model the set, or use several plates
  and cut between them.
- A 2D layered photo with no 3D object is `references/parallax.md`.

## Making the plate

Generate or shoot one plate per setting and per aspect ratio (a 9:16 crop of a 16:9 plate loses the table
in front of the object; a vertical plate composes the table into the depth). State in the prompt or the
shot list:

- **An empty spot** where the object will stand, wide enough for it and its shadow, with nothing standing in
  it and no object of the same kind anywhere in the frame.
- **The lens and camera**: focal length (or field of view), the camera height above the table, the
  distance to the empty spot, the tilt down, and "level, no roll". Record these with the plate: they are the
  starting values of the match.
- **Clear straight table lines** (plank seams, tile joints, a table edge) running away from the camera. They
  give the horizon. A plain surface (stone, cloth) leaves the horizon to the stated tilt and to the eye.
- **One stated light source** with its side and height ("low morning sun from the left window"). The 3D
  light copies it, so name it.
- Depth of field: the spot and the table around it sharp, the background soft.

Example prompt line (a cup on a kitchen table): "an empty patch in the middle of a wooden kitchen table,
50 mm lens, level, 25 cm above the tabletop, 60 cm from the patch, tilted down 12°, plank seams running
away from the camera, morning sun from the left window, background softly out of focus".

Look at each plate before matching: a spot that is not empty, a horizon that tilts, or lines that bend
mean a new plate, not a correction in the scene.

## Matching the camera

The camera model (shared by the tool and the page): `fov` = vertical field of view of the whole image,
`horizon` = horizon row as a fraction of the height from the top, `roll` (degrees, + = clockwise), `h` =
camera height above the table **in object units**, `spot` = `[x, y]` fractions where the object's foot
stands. The table top is the plane `y = 0`, the object's foot is the world origin, and the camera is placed
so that the spot ray meets the table there. Keep the values per plate in a JSON file
(`{name: {file, fov, horizon, roll, h, spot, light, surface}}`).

1. **Horizon from vanishing lines.** `plate-match.mjs auto <plate> --rows 0.5,0.98 --out lines.jpg` finds
   the receding table lines and their vanishing point; look at the sheet (green = lines used). On a plain
   surface read two line ends off `ruler` and use `vp <plate> x1,y1,x2,y2 x3,y3,x4,y4`.
2. **Field of view** from the stated lens (vertical fov = 2·atan(sensor height / 2f)). When the plate shows
   two table directions at right angles (a tiled floor seen at an angle), `fov <W>x<H> --vp1 x,y --vp2 x,y`
   measures fov and roll instead.
3. **Roll** 0 unless the horizon visibly tilts; then from the two vanishing points.
4. **Camera height** in object units: the stated height divided by the object's height, or measured from
   an object in the plate (see Scale).
5. **Verify by looking.** `grid <plates.json> <name>` draws the table plane as a grid every 2 units, the
   horizon, and an object-sized cylinder at the spot. The grid must run along the seams and joints, the
   cylinder's foot ellipse must sit flat on the table, and its size must agree with things around it.
   Adjust with `set <plates.json> <name> h=2.2 horizon=0.24` and draw again. Keep the grid sheets with the
   film: they are the evidence of the match.

In the page: `const base = ReelPlate.matchCamera(P, img.width, img.height)` and
`ReelPlate.threeCamera(THREE, base)` give the camera the grid was drawn with.

## Scale

The object must be the size the plate expects. Compare it with objects whose real size is known (a cup, a
book, a phone, a chair seat): `scale <plates.json> <name> --foot x,y --top x,y --size s` gives the camera
height that makes an object of true height `s` (in object units) stand from that foot pixel to that top
pixel. When the stated height and the measured height disagree, trust the measurement and look at the grid
again. Record how scale was judged (measured or by eye) in `FILM.md`.

## Light from the plate

All light comes from the plate's own source; nothing decorative is added (no light planes, shafts, glints
or bokeh that the photo does not have). Read three things off the plate and record them:

| What | How to read it | In the scene |
|---|---|---|
| Type | window, lamp, sun, studio box, overhead | sun / window = directional with soft shadow; lamp = point or spot nearby |
| Direction | shadows of objects in the plate, the bright side of round things | `az` from the lens axis (0 = behind the lens, 90 = right, ±180 = behind the set), `el` above the table; `ReelPlate.keyDir(az, el)` |
| Colour temperature | warm lamp, daylight, overcast | the key's hue; keep it near white (a strong tint turns a white object that colour) and judge a white object in a still |

Add a fill from the plate's ambient level (a hemisphere light with sky and ground colours taken from the
plate), and an environment map made from the plate (the photo blurred, the key as a soft bright patch in its
direction) so glossy surfaces reflect the room they stand in. Shadow softness follows the source: hard for
direct sun, soft for a window or a box.

## Contact: shadow, occlusion, reflection

An object without contact floats. Every object standing on the table gets:

- **Shadow catcher**: `ReelPlate.shadowCatcher(THREE, {color, opacity})` — a transparent plane at `y = 0`
  that shows only cast shadows, tinted toward the table's own dark colour. Match its density to the
  shadows of objects in the plate.
- **Ground occlusion**: a soft dark disc under the foot (the contact shadow light cannot make), a little
  wider than the foot, faint on a glass object.
- **Faint reflection** on a glossy table only: a mirrored copy of the object below the plane, a few percent
  opaque, fading with distance from the table. None on matte wood, stone or cloth.

## Motion with a still plate

A plate is one viewpoint. Motion that keeps the lens at that point is exact; moving the lens needs proxy
geometry.

| Motion | Parallax error | How |
|---|---|---|
| Camera locked, object moves (turns, slides, drops, is set down) | none | the strongest default |
| Zoom, pan, tilt about the lens point | none | `ReelPlate.shotCamera(base, {zoom, pan, tilt})` |
| Light or shadow patterns moving over table and object (blinds, leaves, a passing lamp, a drifting sun) | none | one pattern lights both, from the plate's source |
| Small lens dolly | small, only off the proxy | project the photo from the plate camera onto proxy geometry (`ReelPlate.photoMaterial` on a table plane and a back wall, cut-out cards for near objects); keep it small and check the edges |
| Large move, new angle | breaks | cut to another plate of the same setting |

Cutting between plates on the edit's existing cuts is cheap variety; keep light direction consistent
across plates of one setting.

## Edge coverage

A turned or moved lens can see past the photo. `ReelPlate.coverage(base, shot, {wallZ})` sends each frame
corner and edge midpoint to the proxy (table, then back wall) and projects it into the plate camera:
0 = covered, above 0 = past the edge, `Infinity` = looking behind the set. `ReelPlate.fitZoom(base,
{pan, tilt, dolly}, {wallZ})` returns the smallest zoom that covers the move (null when none does: make the
move smaller). Call `ReelPlate.check(base, shot, {wallZ, shotId, t})` per rendered frame: it records a
`plate-edge` issue through the engine so the review lists it.

## Pitfalls

**Tone mapping applies twice to the photo.** A renderer that tone-maps the whole frame (WebGPU node
pipeline, any output pass) maps the photo too, so it comes out flatter and darker than it was. There is no
per-material opt-out there: pre-invert the curve in the plate shader (`photoMaterial(..., {tsl})` undoes
Neutral with `invNeutralNode`; for another curve, invert that curve). On a WebGL renderer without an output
pass, `toneMapped = false` on the plate material is enough (the helper's fallback).

**Glass refracts its own decals.** A transmission (glass) material refracts what is behind it, including an
opaque decal on its own surface, so the print shows twice, shifted. Draw decals on glass alpha-blended in
the transparent pass, not as opaque or transmission. Do not alpha-test thin line art: at a distance mipmaps
thin the alpha below the cutoff and lines break into fragments; alpha-blend it.

**A plate that changes per frame.** The plate texture and the matched camera are constants; anything time
dependent (light patterns, gain, key swing) is a pure function of `t` like the rest of the scene. Node
uniforms that a renderer updates once per animation frame (light colour, intensity, position) can keep the
first rendered frame's values when frames are drawn by seeking: one still looks right, a sequence does not.
Compare the first and last frame of a shot with moving light.

## Checks

- Grid sheet per plate, looked at: grid on the table lines, cylinder flat and in scale.
- Stills of every shot: contact shadow and occlusion under every object, foot on the table, light from the
  plate's side, no decorative light.
- First and last frame of each moving shot, at full resolution, for dolly shots on proxy geometry
  (smears at near objects).
- No `plate-edge` issue in the drafts.
