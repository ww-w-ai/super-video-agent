# Characters — people and figures that act on screen

Read this only when the film has characters: a presenter, a host, a cast that moves or talks.
Contents: Name the technique · Cut-out rig · Mouth shapes · A person from a photo (3D) · Credit line

**Every technique in this file is an example, never a menu.** The model may use a technique not
listed here, or a better one for this film's look. Check each example against what the content
needs before choosing it; do not pick one only because it is written here.

## Name the technique

People, hands and pen lines drawn from plain shapes in code look crude beside the rest of a frame.
Do not draw a character that way. Choose a named technique for each scene and write its name in
`FILM.md` (and in the plan's visual notes). The name makes you choose on purpose.

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
of the figure, cut out and separated; they share one fabric and shade at every overlap.

A pattern for the page (not a bundled helper):

- A part is `{id, image, pivot: [x, y], parent, rest: {x, y, rot}}`. Joint angles are pure
  functions of `t` (keyed poses, eased, with a trailing forearm), never accumulated.
- Compute each part's joint point in canvas pixels from the chain at time `t`.
- **Numeric joint check.** For each joint, measure the distance between the child's joint point
  and the parent's joint point at sampled times. A gap larger than a few pixels means a part has
  come apart; an angle past the limb's natural range means a pose that reads wrong. Print the
  numbers per joint and time.
- The check reports and never blocks: a joint left apart on purpose (a part that flies off) is
  a choice, and the model decides whether a reported gap is a flaw.

Once a rig works, keep the part images, the pivots and the pose list with the film's assets so a
later film can reuse the figure.

## Mouth shapes (example)

A talking character needs a mouth that follows the voice. A mouth-shape schedule is a list
`[{from, to, shape}]` per line, built from that line's word times in `voice/timings.json` (a
shape per word or syllable span, `closed` between words), read as a pure function of `t`.

The AI decides whether to use it. In a film with several languages the mouth shapes of one language
do not match another's speech, so lips may not match, or may need to be made again for each
language. Options:

- A per-language overlay layer: draw the mouth in the language's caption layer from that language's
  own timings (`dub/<code>/timings.placed.json`), so each dub gets its own schedule.
- A simple open and close not tied to sound: the mouth opens and closes at a steady rate while
  the line is spoken. It fits any language and avoids a mismatch the viewer can see.
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
