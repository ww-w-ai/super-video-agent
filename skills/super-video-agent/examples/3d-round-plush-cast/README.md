# Example: a round plush cast built in code

**This folder is one example, not a default.** It holds the working generator for one film's
cast: round, big-headed, plush animal characters (a bear, a cat, a rabbit and a puppy) in a cozy
life-sim game style, with a pastel café, a small town and a bedroom around them. The next film may
want a different look and a different build. Take what fits; leave the rest.

The style is described in words only. Nothing here copies an existing game's characters, names,
logos or UI, and a new cast should not either.

## What is here

| File | What it does |
|---|---|
| `make_cast.py` | Blender generator: shape helpers, the biped build from one spec per species, one skeleton with 19 clips, the puppy rig, the hero pancake stack, all props, sockets, GLB export and preview stills |
| `textures.py` | Pillow painter: face sheets, outfit decals, pancake surface, prop patterns (no letters anywhere) |
| `build_all.sh` | Builds the textures, then every target, four Blender jobs at a time |
| `sheet.py` | Tiles preview stills into one labelled contact sheet |
| `testbed/reel.html` | A `window.__reel` page that loads every GLB: lineup and turntable views, one view per second, with `actor`, `setFace`, `prop`, `hold`, `holdLevel`, `gradientSky` and `restyleFoliage` |
| `cover/cover-mask.js` | Cover mask for three.js: the quilt's footprint rendered per seek, tagged parts discarded inside it (`createCoverMask`, `tagBones`, `tagMesh`), and the wrong-side vertex count behind the testbed's `overlap(t)` hook (`coverOverlap`) |
| `soft-body/wobble.js` | SCENE block of a page where a fork taps a soufflé stack and it jiggles on a CPU displacement field (`wobbleField`, `addDeformable`, `deformStack`, the fork riding the field) |
| `soft-body/measure.mjs` | Samples `measure(t)` per frame and writes pixel offsets to CSV, because stills cannot show motion |
| `CONTRACT.md` | What the GLBs promise the film page: node names, faces, sockets, clips with lengths, seat and table heights, the hold table, sub-nodes, the quilt morph, scale factors |

## Reusable in any style vs bound to this style

The general rules live in `references/3d.md`: node names without dots (GLTFLoader strips them),
root-bone axes, seat-top origins, hand-sized props, level hold vs parented hold, face decal shells
with projected UVs, per-scene accessories as separate nodes, cloth draped on the real pose and
stored as a morph, pivoted sub-nodes, rigging pitfalls, split head turns, gestures checked from the
film's camera, and the character check list. Those hold for any cast.

What belongs to this style only, and is shown here as an example:

- Proportions: head ellipsoid r (0.56, 0.52, 0.50) at z 1.22 sunk about 25 % into the body under a
  collar; body r (0.40, 0.36, 0.42) at z 0.55; neck 0.80 (`SHAPES`, `ARM_*`, `LEG_*`).
- Each arm one continuous tapered capsule from the side of the upper torso, root buried, elbow blend
  inside the arm; each leg one stub. Chains of balls read as a segmented muscle-man in this style.
- Gesture limits for this head size: raised arm up to about 115°, wave arm up 96° and yaw 42°,
  elbow up to about 60°.
- Species details: round bear ears; short wide flattened cat ears at the outer top corners; long
  rabbit ears, one bent as one continuous tube. Bear muzzle ellipsoid, cat cheek puffs, rabbit nose
  only. Cat head ×1.12 wide.
- Painted faces (4× supersampled), outfit decals, accessories (ribbon, nightcap, beret, sun hat,
  Peter Pan collar), and the female-read cues used here: a small ribbon on one ear and lashes, with
  the body unchanged.
- The hero pancake stack, its syrup layout (a pool over one arc of the rim plus three drips of
  different lengths; six even drips read as spider legs) and its camera (vertical FOV 30°, 30°
  above).
- The café, town and bedroom props, the palette, and the town scaled ×1.7.
- The look: gradient sky, HDRI for environment light only, NeutralToneMapping, PCF soft shadows,
  downloaded foliage restyled pastel.

## How to run it

Built and checked with **Blender 5.2.2** (headless), system `python3` with **Pillow** for the
textures, and the numpy bundled with Blender (used for the quilt drape).

```sh
# textures first (make_cast.py calls textures.py with system python3)
blender --background --python make_cast.py -- tex --out <out-dir>
# one target
blender --background --python make_cast.py -- bear --out <out-dir> [--previews]
# everything, four jobs at a time (BLENDER=<path to the Blender binary>)
sh build_all.sh --out <out-dir> [--previews]
# contact sheet of previews
python3 sheet.py <sheet.png> 4 360 CFE7F2 <out-dir>/previews/bear-*.png
```

Targets: `tex`, `bear`, `cat`, `rabbit`, `puppy`, `pancake`, `props-small`, `props-set`,
`props-town`. Outputs go to `<out-dir>/models/<target>.glb`, `<out-dir>/tex/` and
`<out-dir>/previews/`. Without `--out`, `<out-dir>` is `./out` next to the script. `props-set`
builds a bear internally to drape the quilt, so run `tex` first.

The testbed page expects the reel layout: copy `testbed/reel.html` into a reel folder and the
`cover/` folder next to it, put the GLBs in `assets/models/`, three.js and its addons in
`assets/vendor/`, and the CC0 scenery in `assets/scenery/`:

- `assets/scenery/quaternius/`: `CommonTree_1/2/4`, `Bush_Common`, `Bush_Common_Flowers`,
  `Flower_3_Group`, `Flower_4_Group` (`.gltf` with their textures) from the Quaternius
  "Stylized Nature MegaKit" (CC0, https://quaternius.itch.io/stylized-nature-megakit).
- `assets/scenery/hdri/kloppenheim_03_puresky_2k.hdr` from Poly Haven (CC0,
  https://polyhaven.com/a/kloppenheim_03_puresky).

Any CC0 trees and sky work; change the names in `files` and the HDR path in the testbed.
`build_all.sh` defaults to the macOS Blender path; set `BLENDER` elsewhere.

The last two views play the bear snuggling in while the quilt slides up, first with the cover
mask off, then on. In this pose the paws rest on the belly under the quilt, so the mask hides
the bear's legs, torso, arms and outfit inside the quilt's footprint; only her head comes out
(`CONTRACT.md`, "Bed"). Check it with `node scripts/overlap.mjs <reel-dir>`: with the mask off
`quilt/legs`, `quilt/torso` and `quilt/arms` report spans, with it on they report none. The hook
counts only tagged parts: the head above the quilt is meant to show.

For the soft body: scaffold a page with `new-reel.mjs --3d`, paste `soft-body/wobble.js` into its
SCENE block, then `node soft-body/measure.mjs <reel-dir> <skill-dir> --csv <out.csv>`.

## The contract and how a film page uses it

`CONTRACT.md` is the worked instance. On every seek the page:

1. poses each character with `mixer.setTime(t)` (never frame deltas);
2. shows exactly one `face_<name>` node and hides the rest (`setFace` in the testbed);
3. places held props with `holdLevel()` after the mixer, using the hold table;
4. rebuilds the leash tube and drives the quilt's `up` morph from `t`;
5. updates the quilt's cover mask after posing, before the render (`mask.update()`).

## How to adapt it

1. Change the species spec in `CHARS` (fur, muzzle, nose, shirt, collar, outfit, faces,
   accessories, `head_wide`), the shared `SHAPES`, and the face specs in `textures.py`
   (`FACE_SPECS`).
2. Rebuild with `--previews` and look at the stills and a contact sheet.
3. Judge the lineup in three.js stills from the testbed, not in the Blender previews: EEVEE's
   Standard view reads paler, and blush and decal edges read darker and sharper in three.js.
4. Go through the character check list in `references/3d.md` against that lineup.
5. Write the new cast's own `CONTRACT.md` with its own numbers.

## Never checked

- Clips were judged as single frames (front and three-quarter stills per clip), not in motion.
- The wobble values in `WOB` were tuned and measured on this one prop only; another stack needs
  its own tuning and its own `measure.mjs` run.
- From this folder every target was rebuilt without `--previews`, and the testbed's lineup,
  bedroom, faces and moving-quilt views were rendered; the previews and the soft-body page were
  not re-run from here.
- The cover mask was checked on the quilt only; no per-seek re-drape is implemented here.

Licence: our own code, under the repository licence.
