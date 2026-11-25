# Installed Blender for 3D films

Use this path when `scripts/probe-blender.mjs` selects `engine: "blender"`.
Both Claude Code and Codex use this same probe and guide. No Blender installation is required
of the user. If the probe fails, use the existing Three.js workflow in [3d.md](3d.md).

## Select before authoring

Run `node <skill>/scripts/probe-blender.mjs` before the cast or scene stage. It checks PATH and
standard app locations. `SVA_BLENDER_BIN` can name an absolute executable path; when set, only
that executable is tested. It runs factory settings with auto-execution disabled, renders a
small PNG through EEVEE, and checks the process result, completion marker and image header.
Each executable has a timeout (`--timeout-ms`, default 60000). Temporary files are removed.
Exit 0 means a decision was returned. Read `engine`; do not treat exit 0 as Blender success.

Save the JSON result in `FILM.md`. Use its executable path for subsequent calls. Re-probe in a
new environment or after a runtime failure. Do not repeatedly retry an unusable runtime.
If the probe command itself cannot run, record that failure and choose Three.js for a new film.
Respect an explicit engine choice; report a failed explicit Blender request rather than
silently changing it. Keep an existing film's backend during partial edits.

Passing example: EEVEE writes the test image and exits cleanly. Author the new scene in Blender.
Rejected example: `blender --version` works, but EEVEE crashes or writes no image. Use Three.js.
Missing Blender is a normal fallback. Do not download or install it.

## Author and check the picture

Keep the existing script, voice review and measured `voice/timings.json` workflow. The measured
clock, frame size, fps, lead and ending hold apply equally to Blender. Start with EEVEE, the
engine the probe tested. Cycles is optional; test its selected device and render a representative
frame before using it. The EEVEE probe does not establish Cycles support or scene quality.

Create the scene with Python through the selected executable:

```text
<blender> --background --factory-startup --disable-autoexec --python-exit-code 1 --python <absolute-scene.py>
```

Use an argument array when launching a subprocess. Never interpolate executable paths into a
shell expression. BASH PATHS: never `cd` in a Bash command — every path absolute. `cd X && …` trips the permission classifier as a path-resolution bypass even in bypass mode, and stalls an autonomous run on a prompt.

Keep the maintained `scene.py` and its assets in the reel. Save a `.blend` for inspection.
Record which file is authoritative; do not regenerate over manual `.blend` edits. `reel.html`
owns the timing contract, captions and sound, not the Blender geometry.

Keep visible Blender text in a keyed, language-aware data table read by `scene.py`.
Record the keys in `FILM.md`. `Reel.pictureText` and the browser text scanner cannot inspect
Blender objects. A language-neutral picture is reused; translated text baked into the scene
requires rendering only its affected ranges and assembling that language's picture. Use the
existing language-specific picture insertion path:
`render.mjs <dir> --no-captions --lang <code> --insert <localized.mp4>@0`.
Declare each baked-in text interval in the overlay page's `window.__reel.langSpans` as
`{start, end, in: "scene"}`. This keeps the dub gate from accepting the base-language picture
for translated scene text (`references/pipeline.md`). Do not claim that dubbing alone changes
baked-in text. Do not combine `--span` with `--insert`; assemble the changed Blender ranges
into the full localized clip before insertion.

Build and inspect the hardest frame first. For a cast, inspect a lineup in the final Blender
renderer and get the same owner approval required by the cast stage. Record object names,
rigs, actions, sockets and scale in `FILM.md`. GLB export and a Three.js testbed are unnecessary
unless this film actually uses them. Inspect start, middle and end poses and transitions.
For partial edits, render only the affected frame ranges and reassemble the picture. Bake
stateful simulations before rendering isolated ranges. Do not use browser pixel-determinism,
overlap or blink hooks as evidence about Blender geometry.

## Product stills (covers and hero cuts)

For a still that has to sell the object (cover, thumbnail, final reveal), light it like a product
photo and render it in Cycles. Test the Cycles device and time one frame first.

**Lighting (any product):**
- A soft photo-studio HDRI as the world, for light and reflections (confirmed: Poly Haven CC0
  `studio_small_09`, 2k, strength 0.6; record the source and license of the one you use). Camera
  rays see a plain seamless backdrop, not the HDRI.
- Aim the HDRI's brightest area at the subject's face or front: derive the yaw from the model's
  front direction and the camera (about 25 degrees off the camera axis, slightly above). Never
  reuse a fixed world yaw on another model.
- If the front still reads dull, add one large camera-side fill above the lens, its emission
  fading to zero at the edges, hidden from the camera and from shadows.
- Measure clipping on the light surfaces (share of pixels at 254 or above, about 1% at most) and
  look at the render.
- Avoid thin strip softboxes and plain rectangular area lights on glossy surfaces: they reflect
  as hard-edged windows and tint the colour under them. When a stray tint appears, switch lights
  off one at a time in test renders to find the one that makes it.

**Material (per subject).** Confirmed only on glossy ABS toy bricks: Principled BSDF roughness
0.09, coat weight 0.6, coat roughness 0.07; 32 samples with denoising looked the same as 64 and
256. Metal, glass and matte subjects are unverified: tune them on the first film that needs them,
and check that metal does not mirror the HDRI's shapes badly and that clear parts keep an edge
against the backdrop.

## Reuse the audio and caption pipeline

1. Scaffold a normal browser reel with `new-reel.mjs <dir>` (without `--3d`). Keep its timing,
   caption and sound contract. Set its frame size, fps and duration to the film's agreed values.
2. Render Blender PNG frames without captions at exactly that fps and size. Frame 1 represents
   t=0; frame n represents `(n-1)/fps`. The frame count must match the browser reel's full frame
   span, including its lead and ending hold. Inspect representative images before encoding.
3. Encode the sequence to a video-only MP4 with FFmpeg. Check its dimensions, fps and decoded
   frame count with ffprobe. Call it `<dir>/blender/picture.mp4`.
4. Use the existing full-picture insertion path:

   ```text
   node <skill>/scripts/render.mjs <dir> --no-captions --insert <dir>/blender/picture.mp4@0
   ```

   It skips browser picture rendering for covered shots, validates inserted frames, and produces
   `out/picture.mp4`, `out/picture.bed.wav` and `out/picture.timings.json`. The lightweight browser
   page is still used for timing, sound and overlays. See [pipeline.md](pipeline.md).
5. Use the existing `dub.mjs <dir> --lang <code>` flow, including the base-language dub folder,
   to add captions and voice. Review the final file with `review.mjs --file <final.mp4>` and
   inspect extracted frames. A browser still of the placeholder page is not Blender QA.

### A wordless film with an on-screen text layer

`--insert` replaces the page's frames for the inserted span (`render.mjs` skips browser picture
rendering for covered segments), so the page's own text and overlay layer does not appear in that
span. For a film whose picture is a Blender clip with text drawn over it, either:

- draw the Blender frames inside the page as its background (an image sequence or video texture
  under the overlay) and render the page normally, without `--insert`, so the overlay keeps
  drawing; or
- render the overlay separately (transparent background) and composite it over the Blender clip.

Do not pass `.blend` or Python directly to `render.mjs`. It accepts the browser reel and an
already-rendered clip. A Blender render failure does not automatically convert its scene into
Three.js. Preserve the scene and evidence; before substantial authoring, an unusable runtime
can fall back to Three.js. After authoring, report the failure and repair the affected scene
without silently discarding it or claiming a successful fallback render.
