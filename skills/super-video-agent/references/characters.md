# Characters — people and figures that act on screen

Read this only when the film has characters: a presenter, a host, a cast that moves or talks.
Contents: Name the technique · Cut-out rig · Mouth shapes · A person from a photo (3D) · Credit line

**Every technique in this file is an example, never a menu.** The model may use a technique not
listed here, or a better one for this film's look. Check each example against what the content
needs before choosing it; do not pick one only because it is written here.

## Name the technique

People, hands and pen lines drawn from plain shapes in code look crude beside the rest of a frame.
Do not draw a character that way unless the user asks for it. Choose a named technique for each
scene and write its name in `FILM.md` (and in the plan's visual notes). The name makes you choose
on purpose. When the user asks for code-drawn parts (a rig of shapes, a drawn figure), the user's
request wins over this advice: name it as the technique and build it.

Techniques the skill already has code or assets for (tested, so the quality is known):

| Technique | What the skill has |
|---|---|
| A 3D character from GLB files, animated from `t` | the 3D scaffold (`new-reel.mjs <dir> --3d`), the cast stage, `glb-info.mjs`, the library models (`assets.mjs search --role character`), `references/3d.md` |
| A photo placed inside a 3D scene | the 3D scaffold; `references/3d.md` |
| Soft-body wobble, cover over a posed body, blinks from a fixed list | `examples/3d-round-plush-cast/`, `overlap.mjs`, `blink-check.mjs` |
| Generated-image cut-outs on a rig | the pattern below (written in the page; no bundled library) |

These are examples. When none fits, find the technique that suits the content's style (for
example collage, photo animation, 2.5D parallax; see `references/craft.md` "Named 2D techniques"),
name it, and build it. State in `FILM.md` why the chosen technique suits this film better than
the others you considered.

## Cut-out rig (example)

A figure cut into parts (head, torso, upper and lower limbs), each part an image with a pivot at
its joint, parented in a chain, each rotating about its pivot. Parts come from generated images
of the figure; they share one fabric and shade at every overlap. To make them: generate the
figure in a neutral pose on a flat background (an image-generation tool of your choice), remove
the background, then crop each part along its joint with any image tool or a short script, keeping
a margin past each joint so the overlap hides the seam. Record each part's pivot in its own
image as you crop.

A bundled helper, offered as an example and not a required look: copy
`scripts/engine/reel-rig.js` into the reel's `src/` and load it with `<script src="src/reel-rig.js">`
(no dependencies; it adds `globalThis.ReelRig`). Use it, change it or build a different rig.

- `ReelRig.makeRig(parts)`: a part is `{id, parent, pivot: [x, y], anchor: [x, y], z, size: [w, h], image | draw, limits}`.
  `pivot` is the joint in the part's own image, `anchor` is where that joint sits in the parent's image.
  It throws on a duplicate id, an unknown parent or a loop.
- `ReelRig.poseAt(tracks, t)`: joint angles (degrees, `rot`), offsets (`dx`, `dy`) and `scale` as pure
  functions of `t` from keyed values (`ReelRig.keyed`, eased); never accumulated. Sample at `t - lag` to
  trail a forearm behind its parent.
- `ReelRig.draw(ctx, rig, pose, images)` paints the parts in z order; the root's `dx`, `dy` place the figure.
- **Numeric joint check.** `ReelRig.jointCheck(rig, t => pose, times)` returns, per joint, the largest
  gap in canvas px between the child's pivot and the parent's anchor, when it happened and how many
  samples were over 2 px, plus a count of angles outside a part's `limits`. Expose it from the page as
  `window.__reel.rigCheck = (times) => ReelRig.jointCheck(rig, poseAt, times)`; then
  `scripts/rig-check.mjs <reel-dir> [--step <sec>] [--out <json>]` samples the film and prints one line per joint.
- The check reports and never blocks, and `jointCheck` never throws: a joint left apart on purpose
  (a part that flies off, `dx`/`dy` on a child) is a choice, and the model decides whether a reported
  gap is a flaw.
- The check measures anchor offsets only. With `ReelRig` every child is placed at its parent's anchor,
  so the gap is exactly 0 px unless a pose moves a child with `dx`/`dy`; "0.0 px" does not say the
  figure has no visible seam. Two drawn parts that do not overlap at the joint show a seam with a
  gap of 0: that is a drawing question, so look at a still of the pose (`still.mjs --at <sec>`).

Once a rig works, keep the part images, the pivots and the pose list with the film's assets so a
later film can reuse the figure.

## Mouth shapes (example)

A talking character needs a mouth that follows the voice. `scripts/mouth.mjs <reel-dir>` writes, per
line, when the mouth is open: `{mode, params, lines: [{id, start, end, spans: [{from, to, open}]}], skipped}`,
in film seconds, closed between spans. It knows no phonemes and no language: the default `--mode amplitude`
follows how loud each line's audio (`voice/line-<id>.wav`) is, measured against that line's own loud level
(`--threshold`, `--step`); a closed gap under 50 ms is bridged and an open run under 60 ms is dropped. A
line with no clip is listed under `skipped`. The page reads it with `ReelRig.mouthTrack(schedule)(t)`,
a pure function of `t` from 0 (closed) to 1 (open); `ReelRig` is in `scripts/engine/reel-rig.js` (above).

The AI decides whether to use it. In a film with several languages the mouth shapes of one language
do not match another's speech, so lips may not match, or may need to be made again for each
language. Options:

- A per-language overlay layer: run `mouth.mjs <reel-dir> --dub <code>` (it reads
  `dub/<code>/voice/timings.json` and writes `mouth.json` beside it) and draw the mouth in that
  language's caption layer, so each dub gets its own schedule. Check that the schedule's times match
  the placed times of that dub (`--timings` takes another timings file).
- A simple open and close not tied to sound: `mouth.mjs <reel-dir> --mode steady [--rate <hz>]`
  opens and closes at a steady rate from each line's start to its end. It fits any language and
  avoids a mismatch the viewer can see.
- No visible mouth (a character seen from behind, a mask, a puppet that nods).

Choose by how close the viewer sees the face and by how many languages the film ships.

## A person from a photo (3D) (example)

A real presenter can appear as a 3D character built from photos. One route:

1. **Consent first.** Ask for the person's consent to use their photos and likeness, and to
   upload them to an outside service. Put it under "Needs from the owner" in `FILM.md` and wait
   for the answer before any upload.
2. **Prepare the input.** Crop to the person. Remove other people, documents and private
   details, and keep the file private (no public link) until the service has fetched it. Do this
   before every upload.
3. **Albedo-style input.** Service models bake what they see into the texture. Give an image
   with flat, even colour: no cast shadows, no highlights, no strong light direction; front view,
   little perspective, a plain background. A generated or edited input is often easier than a
   photo; remove the background (a green background is easy to key out).
4. **Generate the model** with an image-to-3D service (below), then download a GLB.
5. **Check it as any received model** (`references/3d.md`: the cast stage, `glb-info.mjs`,
   lighting before materials). Likeness, hands and accessories vary from run to run; expect to
   run it more than once. Details baked into the mesh and texture (glasses) are hard to remove
   afterwards. Reducing triangles can break the UV map, so bake the texture again after it.
6. **Motion.** A static model moves by whole-body motion from `t`; a walk or a gesture needs a
   skeleton. Some services rig a result; judge the rig in motion before you build on it.
7. **Record** the service, its terms and the credit line in `FILM.md`, and keep the input and the
   output together.

Services, as examples. Facts only, from each service's own documentation or repository. The one
this skill's author used is marked "used". No ranking and no recommendation: a service not
listed may fit better, and these change often.

| Service | Input | Output | Texture / rigging | Runs | Billing |
|---|---|---|---|---|---|
| Tripo (used) | image or text | GLB; rigged result as GLB or FBX | rigging task with a Mixamo-compatible or its own skeleton spec | hosted API and web app | credits (an API wallet is separate from web credits); output rights differ between free and paid use, read the terms |
| Meshy | `.jpg`, `.jpeg`, `.png`, by URL or base64 | GLB, OBJ, FBX, USDZ, STL, 3MF | base colour 2K, 4K or 8K; PBR maps (metallic, roughness, normal) when enabled; rigging not on the image-to-3D page | hosted API | credits per task |
| Rodin (Hyper3D) | image or text | downloadable asset; format not stated on the page read | not stated on the page read | hosted API | credits; the page says to check current pricing |
| Hunyuan3D 2.1 | image | textured mesh with PBR materials | PBR | local, plus a web demo and an API | VRAM stated: 10 GB shape, 21 GB texture, 29 GB both |
| TRELLIS | image or text | meshes, GLB, 3D Gaussians, radiance fields | not stated | local | MIT licence; NVIDIA GPU with 16 GB or more |

Checked 2026-10-07 on the documentation pages and repositories, except the Tripo row, checked
2026-09-30. Re-check a service's page before relying on any cell.

## Credit line

When a character model comes from a service or a library whose terms ask for credit, add one
line to the film's credits and to the description of each language version:

`3D character model: <service name>, <licence or plan used>, <date generated>`

Name only what the terms require. Record the line and the terms page in `FILM.md` with the asset.

## Photo cutouts

For detailed photo cutouts or photo animation, see `parallax.md` for optional
alpha masks. Keep identity, crop, and lighting consistent across source photos.
For talking photo characters or small expression changes, use its aligned masked
key-photo mixing guidance and check the change at the final framing.
