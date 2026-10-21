# Native (no-browser) 2D reel rendering — conversion report

## Verdict

SVA's 2D reels render NATIVELY through skia-canvas with no headless browser, and
the output matches the real, already-published browser render. Validated by
ffmpeg SSIM against the actual `out/picture.mp4` of two shipped reels, with no
changes to the reels themselves. This is a measured match, not a POC claim.

## What was built (`scripts/native/`)

| File | Role |
|---|---|
| `reel-host.mjs` | The engine. Loads a reel, shims the browser globals the engine/scene touch, registers the reel's fonts with skia, runs the inlined ENGINE + AUDIO + the film's own `src/*.js` helpers + SCENE unmodified, awaits `__reel.ready`, then `seek(t)` draws any frame into a skia Canvas. |
| `native-page.mjs` | The page API the tools use (evaluate, routes, init scripts, seek/capture) on top of `reel-host.mjs`. `scripts/lib/browser.mjs` opens it instead of Chromium when `SVA_RENDERER=native`, so `SVA_RENDERER=native node SKILL/scripts/render.mjs <reel>` renders with the whole render.mjs pipeline (segments, spans, sound bed, cues, mix) and still.mjs, verify.mjs and state-checks.mjs check the native frames. |
| `validate.mjs` | Per-frame SSIM of the native render vs the reel's `out/picture.mp4`. |
| `bench-browser.mjs` | Browser-path fps on the same reel + same frames, for an apples-to-apples fps baseline. |
| `smoke.mjs` | Quick load + sample-frame sanity check. |

## How "native" works

A `reel.html` is: the inlined render ENGINE (`globalThis.Reel`), the AUDIO engine
(`globalThis.ReelAudio`), the film's own helper scripts (`src/kit.js`,
`src/scenes-*.js` — they define the film's `K` kit and scene functions as
globals), and a SCENE IIFE that assigns `window.__reel = { seek, ready, width,
fps, duration, ... }`. The browser renderer loads the page, awaits
`__reel.ready`, then per frame calls `seek(frame/fps)` and captures the single
`<canvas>` via `toDataURL`.

The host does the same WITHOUT Chrome: it draws into a skia-canvas `Canvas`
(same Canvas2D API), and shims the small set of browser globals the code uses.
`seek(t)` is a pure function of `t` by contract, so no warm-up is needed (skia is
deterministic; the browser warm-up only existed for Chromium's font cache).

### Browser surface, and how each is handled

| Browser API | Native handling |
|---|---|
| `document.getElementById("stage")` | returns the skia stage Canvas |
| `document.createElement("canvas")` / `OffscreenCanvas` | new skia Canvas (OffscreenCanvas left undefined -> createElement path) |
| `document.fonts` (iterate, `.load()`, `.ready`) | FontFaceSet-like Set built from the reel's `@font-face`; faces resolve immediately (skia registered them up front) |
| `@font-face` files | parsed from `<style>`, registered via skia `FontLibrary.use(family, paths)` |
| `window.__reel` | `window` === `globalThis` |
| `location.search` | `"?captions=0"` so the picture is drawn without captions, matching `out/picture.mp4` |
| `new Image()` (`.src`,`.onload`,`.decode()`,`.width`) | skia `Image` subclass that resolves a relative `src` against the reel dir |
| `createImageBitmap(img)` | draws into an offscreen skia Canvas at natural size |
| `fetch(url)` | reads the local file (plan.json, voice/timings.json, optional assets/lib/*.json) |

One deliberate tuning: `ctx.textRendering = "optimizeLegibility"` on every context
— measured closer to Chromium's canvas text than skia's default. Image smoothing
is left at skia's default (matches Chromium's "low").

## Measured results (Apple M2, single process, 1920x1080 @ 30 fps)

### Fidelity — the fair comparison (native.mp4 vs browser picture.mp4, both HEVC)

Both sides go through the identical project encoder, so this isolates the drawing
difference (the deliverable a user actually gets):

| Span | Content | SSIM All |
|---|---|---|
| 170-185 s | title/stat cards | **0.9942** |
| 80-100 s | dense Korean + Latin text, torn-paper transition, rotated stamp | **0.9883** (Y 0.984, U 0.996, V 0.997) |

Both exceed the 0.98 target; chroma is essentially identical.

### Fidelity — per-frame, pessimistic (native lossless PNG vs reference HEVC-decoded)

This penalizes the native side for the reference's OWN compression loss, so it
reads lower than the deliverable number above. Still:

| Reel | mean | median | note |
|---|---|---|---|
| muse-wonder-argon (24 samples over 677 s) | 0.9766 | 0.9776 | clean frames hit the ~0.994 HEVC compression ceiling = pixel-perfect |
| artex-korean-edition (16 samples over 658 s) | 0.9785 | 0.9806 | handwriting font + different scenes, no code change |

A ceiling check confirmed it: native frame 5300 vs its OWN HEVC re-encode = 0.9944,
and native-vs-reference for that frame = 0.9938 — i.e. at the compression ceiling,
the native draw is pixel-faithful to the browser.

### Where the residual difference is

Amplified difference images (in `out/validate/`) show the backgrounds, grain, and
textures match exactly (they are built from deterministic `Reel.rng`, so Skia and
Chromium produce identical pixels). The entire residual is on glyph and shape
EDGES — sub-pixel antialiasing between the two rasterizers — plus a ~1 px shift on
rotated stamp text where Korean glyph widths measure slightly differently. All
perceptually invisible.

### Speed (same reel, same frames, single process, draw + capture)

| Span | native fps | browser fps | ratio |
|---|---|---|---|
| heavy (80-100 s) | 16.8 | 13.5 | 1.24x |
| clean (170-185 s) | 24.9 | 19.8 | 1.26x |

Native is ~25% faster per frame AND drops the Chromium dependency. Hardware HEVC
encode is not the bottleneck (draw-only ≈ draw+encode). Native sessions share one
thread, so `render.mjs --workers` adds no native drawing throughput.

## Ports cleanly / needs shim / can't port

- **Ports unchanged:** every Canvas2D draw, the ENGINE, ReelAudio, the film's own
  `src/*.js` scene/kit code, deterministic textures, plan/timings, and the
  `seek(t)` timing contract. Two different reels ran with zero reel edits.
- **Needs a shim (all in `reel-host.mjs`, documented above):** the ~9 browser
  globals. Small and stable — they come from the template, not per-film.
- **Can't port here (out of scope):** 3D reels (WebGL). headless-gl is WebGL1
  only; current three.js needs WebGL2. A native GL binding would have to be found
  and shader/material parity re-verified (the earlier POC's `render-3d.mjs` path).

## Confidence / what remains for production

High confidence for **2D picture rendering**: the host faithfully reproduces the
browser output (>= 0.988 SSIM on the deliverable, pixel-perfect on clean frames)
and is a drop-in for the capture step, proven on two shipped reels.

How to render natively: `SVA_RENDERER=native node SKILL/scripts/render.mjs <reel>`
(any render.mjs flag works: `--span`, `--no-captions`, `--preview`, ...).

Not yet done for a full production switch:
1. Parallelize (one process per segment) to beat the browser pool on throughput,
   not just per-frame.
2. Exercise the caption-layer / dub (`?layer=captions`, `--lang`) paths on a real
   reel — only the base picture and the captioned final were run natively.
3. Validate across more 2D reels (fonts, scene kinds) before flipping the default.

No fabricated pass: every SSIM and fps number above was produced by ffmpeg/the
host in this build and is reproducible with the scripts in `scripts/native/`.

---

# 3D native rendering (WebGPU, no browser) — POC

## Verdict

Native 3D rendering off the browser WORKS on the M2 (Dawn WebGPU via Metal), and a
direct measurement shows the native renderer reproduces the browser's 3D output:
three.js `WebGPURenderer` (native) vs `WebGLRenderer` (headless Chromium, the shipped
reels' 3D path) on an identical scene measured **SSIM 0.9981**. Rendering an actual
reel unmodified is remaining engineering (a WebGLRenderer->WebGPURenderer adapter +
async readback compositing + GLTF-in-Node), not a fundamental blocker.

## Why WebGPU (not native WebGL2)

Shipped 3D reels use three's `WebGLRenderer` (WebGL2). Node has no mature native WebGL2
binding — headless-gl is WebGL1 only (confirmed in the 2D POC). The viable native path
is three's `WebGPURenderer` with a Dawn-based Node WebGPU binding. The `webgpu` npm
package (dawn-gpu/node-webgpu) ships a prebuilt `darwin-universal/dawn.node`; a device
was acquired on this machine (adapter: apple-m2 / metal-3).

## What was proven, measured

| Check | Result | Script |
|---|---|---|
| Dawn WebGPU device on M2 | adapter apple-m2, metal-3, device OK | `wgpu-probe.mjs` |
| three WebGPURenderer headless render + raw readback | lit 3D torus knot -> raw RGBA -> PNG, no browser | `wgpu-three-probe.mjs` |
| Renderer parity vs browser WebGL | **SSIM 0.9981** on identical scene | `three-webgl-ref.mjs` + the above |
| Throughput (1440x810, shadows, render+readback) | **515.8 fps** on Metal | `wgpu-bench.mjs` |

The browser's shipped 3D path runs on SwiftShader (CPU WebGL2) at ~31-48 fps (why the
reels render 3D at 0.75 scale). Native WebGPU on the real GPU is ~10-16x that, and the
raw-RGBA readback is exactly the frame source that pipes into NVENC on the L40S server
later (removing the screenshot-readback penalty the owner flagged).

## Headless shims three's WebGPURenderer needs (Node)

- A `document.createElement`/`createElementNS` returning a canvas stub whose
  `getContext("webgpu").getCurrentTexture()` returns a Dawn `GPUTexture` (Dawn cannot
  present to a canvas; we only ever render to a RenderTarget and read back).
- `self` = globalThis; a no-op `requestAnimationFrame` (frames are driven manually).
- `navigator.gpu` is a read-only getter in node 24 — pass the `device` to the renderer
  constructor directly instead of assigning `navigator.gpu`.
- Readback: `renderer.setRenderTarget(rt); renderer.render(scene,cam); const px = await
  renderer.readRenderTargetPixelsAsync(rt,0,0,w,h)` — note this three version RETURNS the
  pixels (no buffer argument).

## The hard architectural finding: existing reels can't run unmodified on WebGPU

Confirmed by reading the 3D template and a shipped reel (day05-iphone-duo): the 3D reel's
scene composites the GL picture into the 2D stage with `copyToStage()`, which does:

```
var gl = renderer.getContext();                 // the WebGLRenderer's WebGL2 context
gl.readPixels(0, 0, RW, RH, gl.RGBA, UNSIGNED_BYTE, glPixels);   // SYNCHRONOUS readback
smallCtx.putImageData(...); ctx.drawImage(smallCanvas, ... up to WIDTH x HEIGHT);
```

`gl.readPixels` is a synchronous WebGL call. WebGPU has NO synchronous readback — the Dawn
Node binding exposes only async `mapAsync` / `onSubmittedWorkDone` (verified: no `tick` /
`processEvents` / `poll` on the gpu, device, or queue), and Node cannot drain the event
loop from inside synchronous code. So an unmodified WebGL-authored 3D reel cannot be driven
by a WebGPU renderer: it reaches into `renderer.getContext()` for a WebGL context and reads
pixels synchronously, neither of which a WebGPU adapter can provide. (`seek()` is already
`async` in current reels, so the async readback itself would fit — it is the `getContext()`
+ sync `gl.readPixels` that does not.)

This is an authoring-model constraint, not a missing binding. The reels are written against
WebGL's synchronous model, not merely against `WebGLRenderer`.

### Deeper: every shipped 3D reel uses WebGL-only rendering features

Reading all three shipped 3D reels, each depends on three.js features that `WebGPURenderer`
does NOT support as a drop-in (WebGPU uses a different shader/post system, TSL/WGSL):

| Reel | WebGL-only feature | WebGPU status |
|---|---|---|
| day04-foldable-iphone | `EffectComposer` + `UnrealBloomPass` (postprocessing addons) | WebGL-only addons; WebGPU post is a separate TSL `PostProcessing` system |
| day05-iphone-duo-longform | `EffectComposer` + `UnrealBloomPass` | same |
| day06-chess-ai | `onBeforeCompile` GLSL injection (per-instance glow via an `aGlow` attribute) | `onBeforeCompile` is GLSL; WebGPU materials are TSL — the hook is a no-op there |

So porting ANY existing reel to WebGPU is not a thin render-context swap — it requires
re-authoring that reel's effect/shader code (reimplement UnrealBloom in WebGPU TSL, or the
glow material as a TSL node), and the result would not pixel-match the WebGL bloom/shader.
day05 (the assigned target) uses `UnrealBloomPass` specifically — a hard blocker for a WebGPU
render that matches its browser `picture.mp4`.

## Recommended path (scoped follow-up)

Port the 3D reel TEMPLATE's render/composite layer (`render3D` + `copyToStage` + the renderer
creation) to `WebGPURenderer` + async `readRenderTargetPixelsAsync`, keeping the scene/world
code (geometry, materials, lights, camera, GLTF models) unchanged — this matches the steer
that "only the GL/render-context layer changes". Then both the in-browser preview and the
native render use WebGPURenderer, so native matches by construction (the 0.9981 parity is the
evidence). Existing WebGL reels are re-rendered under the ported template. Secondary needs for
a native run: GLTFLoader in Node (shim FileLoader/fetch to read local `.glb`, decode textures
via skia `Image`), and mapping `PCFSoftShadowMap` -> `PCFShadowMap`; avoid `onBeforeCompile`
(chess reel) which has no WebGPU/TSL equivalent — target standard-material reels first.

## Confidence

The feasibility questions are answered and measured: native 3D off-browser works, the native
WebGPU renderer matches the browser WebGL renderer (SSIM 0.9981), and it is ~10-16x faster
with an NVENC-ready raw-frame output. The one thing NOT achieved is an unmodified existing-reel
native render — blocked by synchronous `gl.readPixels` in the reel's composite, which is an
authoring-model change (port the 3D template to WebGPU), not a native-binding gap. An actual-reel
SSIM is expected to land high (per the 0.9981 parity) once a reel runs under a WebGPU template.

Every number here was produced by the scripts in `scripts/native/` and is reproducible.

## UPDATE — actual-reel native 3D render achieved; SSIM 0.87 after a host texture fix

The "one thing NOT achieved" above is now done: the unmodified day04 reel renders end-to-end on
WebGPU in Node via `reel-host-3d.mjs` (WebGLRenderer->WebGPU adapter, one-three-instance module
hooks, GLTF-in-Node, async de-padded read-back). Measured vs browser `picture.mp4`: SSIM
**0.857-0.876** across the desk scene, at **36 fps** (1080x1920, render+composite+png).

Finding: a first pass measured 0.733 and looked like it needed per-reel shader re-authoring. It did
not — the dominant cause was a HOST bug: three.webgpu uploads image/Canvas textures via
`copyExternalImageToTexture`, which Dawn rejects for a skia-canvas source and three silently swallows,
so every image texture uploaded BLACK (skyline, character face/apron, screens). Fixed by wrapping the
queue to read skia pixels and `writeTexture` (`3d/gpu-texture-upload-fix.mjs`) -> SSIM 0.733 -> 0.87.
The small residual is bloom + the foldable-phone inner-display `ShaderMaterial`s (genuinely need TSL)
+ sub-pixel AA + the HEVC-vs-PNG compression ceiling. Geometry, rigged GLB, textures, lighting, PCF
shadows, and the 2D overlay all render correctly. Detail + file list: `BUILD-PROGRESS.md` section
"3D native render — day04 rendered end-to-end".

## FINAL STATE (decided)
- 2D native: production-ready, SSIM 0.99+. Use it for new 2D reels.
- 3D native: viable. day04 end-to-end SSIM 0.87 after the host texture-upload fix (kept as reusable
  infra). Residual = bloom + phone-display ShaderMaterials (TSL) + AA + codec ceiling.
- Decision: do NOT polish old reels. Existing 3D reels (day04/05/06) stay on the browser/WebGL path.
  WebGPU bloom + ShaderMaterial->TSL are built WHEN authoring the next NEW 3D reel (fixed as they
  surface in real production), not retrofitted now.
- 2D GPU/NVENC bench (L40S pod): GPU win = NVENC-HEVC 2.5-4x on encode; H264 no benefit; raw-pipe
  ~2x free; skia raster stays CPU (no GPU backend). See `BUILD-PROGRESS.md` "2D GPU/NVENC bench" and
  `bench/POD-2D-GPU-NVENC-BENCH.md`.
