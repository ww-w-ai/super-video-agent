# Native (no-browser) render POC

To render a 2D reel natively: `SVA_RENDERER=native node SKILL/scripts/render.mjs <reel>`. The scripts below are the
first standalone measurements.

Machine: Apple M2, 8-core. 1920x1080, 300 frames, 30 fps, libx264 veryfast, raw RGBA piped to ffmpeg.

| Backend | Script | Libs | fps | Browser baseline |
|---|---|---|---|---|
| 2D | `render-2d.mjs` | skia-canvas 4.x, node 24 | 88.0 | 77.7 |
| 3D | `render-3d.mjs` | gl (headless-gl 8.1.6) + three 0.160.0 (alias `three-webgl1`), node 22 | 105.1 | 48 (GPU) / 31 (software) |

3D RENDERER string: `ANGLE` (`gl.RENDERER`; WEBGL_debug_renderer_info absent). VERSION `WebGL 1.0 stack-gl 8.1.6`.
The string does not say whether ANGLE sits on Metal/GL hardware or a CPU path. Not determined here.

ffprobe: both `out/native-2d.mp4` and `out/native-3d.mp4` = 1920x1080, 300 frames, 10.0 s. A 3D frame was decoded and visually checked (lit torus knot + sphere, not blank).

## Comparison caveats

- The 2D number (88 vs 77.7) is only about 13% faster. The encode (libx264 veryfast, piped) overlaps frame drawing but still shares the same 8 cores. Scenes differ (this scene is not an SVA reel), so treat it as the same order of magnitude, not a proven win.
- The 3D scene is one torus knot plus a sphere. The browser 48 fps scene was different. 105 fps is not a like-for-like comparison.
- Single run each, no warm-up discarded.

## Install findings (blockers hit)

- `gl` does not build on node 24 (V8 headers need C++20, bundled ANGLE needs `auto_ptr`; also needs `python` on PATH). There is no prebuilt binary for node 24. It installs from prebuild on node 22 (`/Users/taehyoungkim/.nvm/versions/node/v22.18.0`). `render-3d.mjs` must run under node 22.
- headless-gl is WebGL1 only. three >= r163 requires WebGL2 (`gl.texImage3D is not a function` on current three 0.186). Fallback used: three 0.160.0 installed as the alias `three-webgl1`. Current `three` 0.186 is also installed (SVA `new-reel.mjs --3d` vendors it for the browser path).
- Not committed. `package.json` gained `skia-canvas`, `three`, and (from the node 22 install) `gl` and `three-webgl1`. Review before merging; `gl` is a native module with a Node-ABI constraint.
- headless-gl is unmaintained-ish (last 8.1.6, 9.0.0-rc only). A GPU path on the server (EGL on L40S) would need a different binding, to be benchmarked separately.

## Portability: how SVA authors scenes today

Read: `scripts/new-reel.mjs`, `assets/template/reel.html`, `reel-3d.html`, `references/3d.md`.

- 2D reels: a single `<canvas id="stage">` and `ctx = canvas.getContext("2d")`. All visuals are drawn with Canvas2D calls (`fillText`, `fillRect`, `drawImage`, transforms). Text is drawn via `ctx.fillText`, not DOM. The page exposes `window.__reel` (plan.json, engine inlined) and the renderer captures `canvas.toDataURL()` per frame (`scripts/lib/browser.mjs`). No DOM/CSS layout drives the visuals; `verify.mjs` even enforces a single `<canvas>` tag.
- 3D reels: three.js (WebGL2, import map, ES modules) draws into a detached canvas, which is copied into the 2D stage canvas each frame; captions and titles are 2D overlay.

Verdict:

- Portable today: the Canvas2D drawing path. Skia-canvas implements the same API; fonts need registering (`FontLibrary`) instead of `@font-face`, images need loading via skia-canvas `Image`/`loadImage`. The engine and `plan.json` are plain JS, so the pure scene functions can run in Node.
- Not portable without a contract change: (1) the engine is authored as a browser page (`window`, `document.fonts`, `document.getElementById`, Image elements), so it needs a Node shim or a split into a DOM-free engine core; (2) 3D reels use modern three (WebGL2, ES module import map, addons like GLTFLoader) and headless-gl only gives WebGL1, so three <= r160 or a different GL binding is required, and shader/material parity must be re-verified; (3) any reel that adds DOM/CSS layout for visuals would need a layout engine, but the template does not do this by design.
- Rough share: all 2D reels (the default template) are servable once the engine is made DOM-free. 3D reels are only servable after a WebGL2-capable native GL binding is found.
- Not verified here: running a real SVA reel.html through a Node shim. The POC scenes are standalone, not SVA templates.
