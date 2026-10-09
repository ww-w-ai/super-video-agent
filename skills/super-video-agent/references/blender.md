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

Build and inspect the hardest frame first. For a cast, inspect a lineup in the final Blender
renderer and get the same owner approval required by the cast stage. Record object names,
rigs, actions, sockets and scale in `FILM.md`. GLB export and a Three.js testbed are unnecessary
unless this film actually uses them. Inspect start, middle and end poses and transitions.
For partial edits, render only the affected frame ranges and reassemble the picture. Bake
stateful simulations before rendering isolated ranges. Do not use browser pixel-determinism,
overlap or blink hooks as evidence about Blender geometry.

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

Do not pass `.blend` or Python directly to `render.mjs`. It accepts the browser reel and an
already-rendered clip. A Blender render failure does not automatically convert its scene into
Three.js. Preserve the scene and evidence; before substantial authoring, an unusable runtime
can fall back to Three.js. After authoring, report the failure and repair the affected scene
without silently discarding it or claiming a successful fallback render.
