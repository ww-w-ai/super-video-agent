# Photo to 3D — a shape matched to reference photos, then bricks (or any 3D film)

Read this for a curved or organic subject that has to look like a real one: a statue, a person, an
animal, a vehicle body. The route was proven on a LEGO statue head (ww-w-kids, King Sejong,
2026-10-27; EV-37 in `docs/evolution/ledger.md`). The owner called it a core capability: "사진을 3d
만드는 노하우 가지고 있으면 이제 할 수 있는게 많아짐!!! 레고에도 도움되고 다른 쪽으로도". The mesh
stage is useful on its own for any 3D film (a Blender or three.js scene); the brick stage is for
LDraw models (`references/assembly.md`).

Contents: Why this route · Collect the photos · Model the shape · Match it to the photos ·
A brick version · Bricks from the shape · Checks · What it costs · Other uses

## Why this route

Placing bricks by hand fixes proportions brick by brick, and a 7-stud face never read as the
person. Shaping a smooth 3D model first, against the photos, fixes the proportions in minutes; the
bricks then follow the shape. The mesh is made from our own code (signed-distance primitives in
numpy), so no third-party model or licence is involved.

## Collect the photos

Real photos first, never a shape from memory: front, both three-quarter views, both sides, the
back if it exists, and a close front of the face. Keep them with their sources (one folder per
subject and a `SOURCES.md`). Note the proportions in reference pixels (head height, eye line, nose,
mouth, chin, shoulder width) and the scale (how many pixels per unit at the subject).

## Model the shape

`scripts/mesh/sdf.py` is a small signed-distance kit (plain Python 3 + numpy):

- Primitives: `ellipsoid`, `sphere`, `capsule`, `round_cone`, `box` (rounded), `disc`, `plane`;
  `rot` turns the points into a part's own frame.
- Booleans: `smin` / `smax` (smooth union and intersection with a blend radius), `sub`.
- Exact mirror symmetry: build a paired feature once with `mx(x)` (= |x|); left and right are then
  identical by construction (eyes, ears, cheeks, shoulders).
- `save_outputs(f, name, bounds, h, outdir)` evaluates the field on a grid of step `h`, writes
  `<name>.obj` (surface-nets mesh), `<name>.sdf.bin` + `<name>.sdf.json` (the float32 grid, negative
  inside) and prints the solid bounds.

Write one figure script per subject, in the units of the target (LDU for LDraw: 1 stud = 20, 1
plate = 8; x right, y down, z back, the face toward -z):

```python
import sys; sys.path.insert(0, "<skill>/scripts/mesh")
from sdf import *
def figure(x, y, z):
    head = ellipsoid(x, y, z, (0, -60, 0), (40, 50, 42))
    ear  = sphere(mx(x), y, z, (42, -60, 4), 9)       # both ears
    return smin(head, ear, 4)
save_outputs(figure, "head", ((-80, 80), (-140, 10), (-80, 80)), 3.0, "<work>/out")
```

Keep the true-shape model and add a switch for the brick version (below) in the same script
(an environment variable or argument), so the reference shape is never lost.

## Match it to the photos

Render the mesh with Blender headless (`scripts/probe-blender.mjs` finds a usable Blender;
`references/blender.md`):

```
<blender> --background --factory-startup --disable-autoexec --python-exit-code 1 --python <skill>/scripts/blender/render-mesh.py -- <head.obj> <outdir> 700 "front:0:-6,q34L:38:-10,side:90:0,ofront:0:0:O:<cx>:<cy>:<width>:<height>"
```

- Perspective views `name:azimuth:elevation[:fov]` (azimuth 0 faces the figure, +90 is from its
  left). An orthographic view `name:az:el:O:cx:cy:width:height` is framed in model units, so it
  overlays a photo cropped to the same window at the same scale.
- `scripts/mesh-overlay.mjs overlay <photo> <ortho render> <out.png>` puts photo, render and a 50 %
  blend side by side with guide lines; `still.mjs --sheet` tiles the views next to the photos.
- Change the primitives, re-run, compare again. One script that runs model → views → overlay →
  sheet per round keeps the loop fast. The Sejong head took six rounds.
- Judge it by eye against the photos: silhouette from the front and the side, the eye line, the
  nose and brow depth, the jaw and beard, the hat. A model that reads in the overlay is ready.

## A brick version

Bricks quantise the surface: a stud is 20 units wide and a plate 8 tall, so about half of every
relief disappears. Make an exaggerated copy of the same field for the bricks: eye sockets about
1.5 times deeper, nose and moustache 6–8 units further forward, a beard at least one stud proud of
the chest; every thin part (a wing, a braid, a beard tip) at least one stud thick. Model the base of
a bust (collar, shoulders) in the field too, or the bust reads as a pawn.

## Bricks from the shape

The ww-w-kids brickifier (`youtube/ww-w-kids/models/gwanghwamun/sejong3d/mesh2bricks.mjs`, a
project tool built on that project's sculpt toolkit, not bundled) shows the steps; rebuild them in a
film's own tool when needed:

1. Voxels of one stud by one plate, symmetric about x = 0; a cell is solid when at least half of its
   samples are inside.
2. Outside air by flood fill from the grid border; a visible cell touches air.
3. A hollow core with support walls every few studs, so the model stays light and buildable.
4. Side reliefs: where the surface faces sideways (or front/back) by at least about 0.6, a column of
   bricks with side studs (32952) replaces the outer cells, and a relief is built outward on it at
   plate resolution, with curved slopes, cheese slopes and round tiles at its edges. This rounds the
   plan and the profile.
5. A top shell: every top edge becomes curved slopes or cheese slopes, low side out.
6. Level by level: tiles on exposed tops, shell-colour plates on visible cells, core-colour plates
   and bricks inside; hanging cells first take a plate that reaches a held neighbour (anchor-first;
   trimming orphans instead erodes chins and brims).
7. Work on one half only, then mirror (left/right pair parts swapped; parts on the centre line merge
   into one centred part).
8. Write the model with one step per part, bottom-up, and report overlaps and part/colour
   availability.

Two physical rules found by the order gate: no stud may sit under a sideways relief (the cell under
a relief gets a tile), and no top stud of a side-stud brick may sit under another relief. With both,
crossings went from 259 to 0.

Part choice and faces follow `references/assembly.md` "Sculpted subjects": parts by curvature from
every line, a palette table, an exact mirror, faces first.

## Checks

- `ldraw-order-check.mjs <model> --lib <parts> --structure-only` while designing; the full gate
  with the film's camera track before any render (`references/assembly.md`).
- Mirror check: every part has a partner at (-x, y, z) with the mirrored orientation.
- `scripts/mesh-overlay.mjs centreline <front render> <out.png>` on a front render lit from the
  centre plane.
- Stills of the brick model from the photo angles, sheeted beside the photos and the mesh.

## What it costs

A face under about 14 studs wide does not read as a face from an automatic brick pass: the relief
between cheek and nose is only a few cells deep. Plan 20 or more studs across the face, and
hand-tune the face front (a studs-forward relief with smooth tiles) even when the rest is generated.
Many 1x1 parts look noisy; favour runs of 1x2 cheese slopes, 2x1 and 2x2 curves and large plates.

## Other uses

The same mesh can go straight into a 3D film: import the OBJ in a Blender scene
(`references/blender.md`) or export it as GLB for three.js (`references/3d.md`), with the material
and lights of that film.
