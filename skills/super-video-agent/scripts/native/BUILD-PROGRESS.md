# Native (no-browser) 2D render — build progress

Goal: render SVA 2D reels through skia-canvas (no headless Chrome), matching the
real browser-rendered `out/picture.mp4` at sampled timestamps (SSIM, same timings).

## Architecture mapped (reading the engine + a real reel)

A reel.html is three inlined `<script>` blocks:
1. ENGINE (`scripts/engine/reel-engine.js`) -> `globalThis.Reel` (helper library).
2. AUDIO (`scripts/engine/reel-audio.js`) -> `globalThis.ReelAudio`.
3. SCENE (IIFE) -> assigns `window.__reel = { width, height, fps, duration, ready, seek, shots, ... }`.

Browser renderer contract (`scripts/lib/browser.mjs`, `render.mjs`):
- `openReel(url)` loads the page, waits `window.__reel.ready` then `__reel.preload`.
- Per frame `frame` in `[0, round(duration*fps))`: `seek(frame/fps)` then
  `canvas.toDataURL("image/png")`; PNGs piped to ffmpeg (libx264).
- `out/picture.mp4` is rendered with `?captions=0` (pictureUrl) — captions OFF.
- Warm-up (2 throwaway seeks/shot) exists only for Chromium's font cache; skia is
  deterministic so native needs none.

Browser APIs the engine/scene touch (the whole surface — small):
- `document.getElementById("stage")`, `document.createElement("canvas")`, `document.fonts` (iterate + `.load()` + `.ready`).
- `window.__reel`, `location.search` (optional; `?captions=0`).
- `new Image()` (`.src`,`.onload`,`.onerror`,`.decode()`,`.complete`,`.width/.height`), `createImageBitmap(img)`.
- `fetch(url)` for local JSON only (plan.json, voice/timings.json, optional assets/lib/*.json).
- `OffscreenCanvas` — only via `typeof OffscreenCanvas !== "undefined"` guard; left undefined -> createElement path.
- No requestAnimationFrame / setTimeout / navigator / localStorage in the 2D path.

## Validation target
Primary: `codereel-workspace/samples/2026-10-15-muse-wonder-argon` — pure 2D (0 webgl
refs), 1920x1080, 30 fps, ~677 s / 20313 frames. Fonts: Pretendard(4), BlackHan, Anton,
Bebas, Handwriting. Images: assets/images/sva-logo.png.
Secondary: `2026-10-13-artex-korean-edition` (2D, handwriting font).

## Status — DONE (2D native render validated, high confidence)
- [x] Mapped engine + reel + capture contract.
- [x] Built native host (`reel-host.mjs`) — globals shim + font registration + runs ENGINE+AUDIO+film helper src/*.js+SCENE unmodified.
- [x] `render-native.mjs` — native -> mp4 via the project's own encoder (drop-in for out/picture.mp4).
- [x] `validate.mjs` — per-frame SSIM vs out/picture.mp4; `bench-browser.mjs` — browser baseline on the same frames.
- [x] Validated on TWO real 2D reels with NO reel changes: muse-wonder-argon, artex-korean-edition.

## Measured results (M2, single process, 1920x1080@30)

Deliverable fidelity (native.mp4 vs browser picture.mp4, BOTH HEVC via the same encoder — the fair comparison):
- clean span 170-185s:  SSIM All = 0.9942
- hardest span 80-100s (text + torn-card transition): SSIM All = 0.9883 (Y 0.984, U 0.996, V 0.997)

Per-frame drawing fidelity (native LOSSLESS png vs reference HEVC-decoded frame — pessimistic, penalizes native for the reference's own compression):
- muse: mean 0.9766, median 0.9776 (clean frames hit the ~0.994 HEVC compression ceiling = pixel-perfect)
- artex: mean 0.9785, median 0.9806

The entire residual is sub-pixel TEXT/EDGE antialiasing (Skia vs Chromium rasterizer) + the reference's HEVC loss.
Diff images (out/validate/) confirm: backgrounds/grain/textures match exactly (deterministic Reel.rng); only glyph and
shape edges differ, plus a ~1px shift on rotated stamp text from Korean glyph-width metrics. Perceptually identical.

fps (same reel, same frames, single process, draw+capture):
- heavy span: native 16.8 vs browser 13.5  (native 1.24x)
- clean span: native 24.9 vs browser 19.8  (native 1.26x)

## Ports cleanly / needed shims / can't port
- Ports unchanged: all Canvas2D drawing, the engine (globalThis.Reel), ReelAudio, the film's own src/*.js helpers (K/scenes),
  deterministic textures, plan.json/timings.json, scene timing (seek(t) pure fn of t).
- Shims (small, in reel-host.mjs): document.getElementById/createElement/fonts(FontFaceSet-like); window=globalThis;
  location.search="?captions=0"; Image (skia Image + relative-src resolve); createImageBitmap; fetch (local JSON only);
  fonts via skia FontLibrary parsed from the reel's @font-face. OffscreenCanvas left undefined -> createElement path.
  One global tweak: ctx.textRendering="optimizeLegibility" (measured closer to Chromium than the default).
- Can't port (out of scope here): 3D reels (WebGL). headless-gl is WebGL1 only; modern three needs WebGL2.

## Known gaps / not done
- Not wired into render.mjs as a capture backend; not parallelized (render.mjs runs a worker pool — native could too, per-segment).
- Caption-layer / dub (?layer=captions) and picture --lang paths not exercised (only base picture ?captions=0).
- Only 2 reels validated; full-film native render not run to completion (slow single-thread; spans measured instead).

---

# 3D native POC (WebGPU, no browser) — measured feasibility

Goal: render WebGL2 3D SVA reels without a headless browser. Blocker from the 2D
POC was headless-gl = WebGL1 only; took the native-WebGPU path.

## Proven (M2, Dawn WebGPU via Metal)
- `webgpu` npm 0.6.2 (dawn-gpu/node-webgpu) installs a prebuilt `darwin-universal/dawn.node`.
  Device acquired: adapter apple-m2 / metal-3 (`wgpu-probe.mjs`).
- three.js 0.186 `WebGPURenderer` (three/webgpu) renders a lit 3D scene HEADLESS in
  Node -> RenderTarget -> `readRenderTargetPixelsAsync` -> raw RGBA -> PNG
  (`wgpu-three-probe.mjs`). The raw readback IS the NVENC-ready frame pipe.
  Shims needed: `document.createElement(NS)` + a canvas stub whose
  `getContext("webgpu").getCurrentTexture()` returns a Dawn texture; `self`=globalThis;
  no-op `requestAnimationFrame`. `navigator.gpu` is read-only in node 24 — pass the
  device to the renderer directly.

## Renderer parity — the key measurement
Same 3D scene rendered two ways: browser `WebGLRenderer` on headless Chromium
(SwiftShader — exactly the shipped reels' 3D path) vs native `WebGPURenderer` (Dawn/Metal).
ffmpeg SSIM = **0.9981** (near pixel-identical). So the renderer difference is NOT a
blocker: native WebGPU can reproduce the browser's WebGL 3D output.
Files: `three-webgl-ref.mjs` (browser WebGL ref), `wgpu-three-probe.mjs` (native WebGPU).

## Throughput
Native WebGPU 3D at the reels' internal 1440x810 (0.75x1080p) with shadows,
render+readback = **515.8 fps** (`wgpu-bench.mjs`). The shipped browser 3D path uses
SwiftShader (CPU WebGL2) at ~31-48 fps -> native is ~10-16x, on real GPU. NVENC later
removes the readback entirely (the discrete-GPU penalty the owner called out).

## HARD FINDING: existing reels can't run unmodified on WebGPU (sync gl.readPixels)
The shipped 3D reels composite with `copyToStage()`: `gl = renderer.getContext();
gl.readPixels(0,0,RW,RH,...)` — a SYNCHRONOUS WebGL readback — then putImageData + drawImage
upscale. Confirmed in reel-3d.html template AND day05 (line 2706/2715). WebGPU has NO sync
readback; the Dawn binding exposes only async mapAsync/onSubmittedWorkDone (no tick/poll/
processEvents on gpu/device/queue — verified via `wgpu-sync-probe.mjs`), and Node can't drain
the event loop from sync code. The reel reaches into `renderer.getContext()` for a WebGL
context and reads pixels synchronously — neither a WebGPU adapter can provide. (`seek()` is
already async in current reels, so the async readback would fit; it is getContext()+sync
readPixels that does not.) This is an authoring-model constraint, not a missing binding.

## DEEPER FINDING: all 3 shipped 3D reels use WebGL-only features (no drop-in WebGPU)
- day04, day05: EffectComposer + UnrealBloomPass (WebGL postprocessing addons). WebGPU post is
  a separate TSL PostProcessing system -> must be reimplemented, won't pixel-match the WebGL bloom.
- day06-chess: onBeforeCompile GLSL injection (mograph.js glowMaterial, per-instance `aGlow`).
  onBeforeCompile is a no-op under WebGPURenderer (materials are TSL).
=> Porting any existing reel to WebGPU = re-authoring its effect/shader code, not a thin adapter.
   day05 (assigned target) uses UnrealBloomPass -> hard blocker for a matching WebGPU render.
   day06 is the closest to portable (no post; one minor glow material) but still needs GLTF-in-node
   + loses the glow + async composite.

## Recommended follow-up (scoped)
Port the 3D reel TEMPLATE's render/composite layer (render3D + copyToStage + renderer creation)
to WebGPURenderer + async readRenderTargetPixelsAsync, keeping scene/world code unchanged
("only the GL/render-context layer changes"). Both browser preview and native then use
WebGPURenderer -> native matches by construction (0.9981 parity is the evidence). Re-render
existing WebGL reels under the ported template. Secondary: GLTFLoader in Node (shim
FileLoader/fetch for local .glb + skia Image textures); PCFSoftShadowMap -> PCFShadowMap;
avoid onBeforeCompile (chess) — target standard-material reels (day04/day05) first.

## 3D files
`wgpu-probe.mjs` (device), `wgpu-three-probe.mjs` (headless render+readback), `three-webgl-ref.mjs`
(browser WebGL parity ref), `wgpu-bench.mjs` (fps).

## Next step (owner/team decision)
Core POC proven + measured. To get an actual-reel native 3D render, port the 3D reel template's
render/composite to WebGPURenderer+async readback (authoring-model change) and re-render one
standard-material reel, then SSIM vs its browser picture.mp4. This is a scoped sprint and changes
3D reel authoring — awaiting direction before building it.

# 3D native render — day04 rendered end-to-end on WebGPU (measured)

Sprint done: the unmodified day04 reel (`day04-foldable-iphone`, 1080x1920@30, 133.4s) now renders
headless on WebGPU/Dawn in Node — no browser — through `reel-host-3d.mjs`.

## How it works
- `three-webgpu-shim.mjs` — a "three" module that re-exports three/webgpu and adds a `WebGLRenderer`
  backed by WebGPURenderer (a delegating Proxy). The reel's `new THREE.WebGLRenderer` +
  `render()` + `getContext().readPixels` idiom runs unchanged. Adapter SSIM vs direct WebGPU = 1.0.
- `loader-hooks.mjs` (module.register) — forces one three instance for the reel, its scene modules,
  and three's addons (GLTFLoader etc.); maps WebGL-only addons to WebGPU shims.
- GLTF-in-Node: rigged presenter GLB + dubby + textures load (skia decode; blob:/Request shims).
- `copyToStage` patched sync->async read-back; adapter **de-pads** three.webgpu's 256-byte-aligned
  read-back rows (the fix for horizontal-shear corruption) and flips to match the reel's composite.

## Measured (M2, Dawn/Metal) — after the image-texture upload fix
- Fidelity vs browser `picture.mp4`: SSIM **0.876 / 0.862 / 0.857** at t=0.5/1.5/2.467s (desk scene).
  (Before the texture fix: 0.733. PNG-vs-HEVC comparison has a ~0.98 ceiling, so this is close.)
- Throughput: **36.0 fps** (render+composite+png-encode, 1080x1920) vs browser SwiftShader 3D ~31-48.
  (62.7 fps before the fix, when image textures were silently skipped; textures now upload per frame.)

## The key host bug found + fixed: silent-black image textures
three.webgpu uploads a non-data texture with `device.queue.copyExternalImageToTexture({source})`,
which Dawn accepts only for ImageBitmap/HTMLCanvasElement/OffscreenCanvas — NOT a skia-canvas source
— and three swallows the throw in a try/catch. So every image/CanvasTexture uploaded as BLACK. Fixed
in `3d/gpu-texture-upload-fix.mjs`: wrap the queue to read skia pixels and `writeTexture` instead.
This restored the character face/apron, the window skyline, and the monitors, and moved SSIM
0.733 -> 0.87. It was a HOST fix, not the per-reel re-authoring the first measurement implied.

## What renders / what remains (the ~0.13 residual)
Renders correctly now: geometry, rigged GLB models, lighting, PCF shadows, GLB + Canvas image
textures (skyline, face, apron, screens), and the full 2D overlay.
Remaining gap is diffuse (a difference image shows no strong localized hotspot) — i.e. global
tone/AA + the few genuinely WebGL-only bits:
- Foldable-phone inner-display `ShaderMaterial`s — rejected by three.webgpu (needs TSL). Confirmed,
  but small screen area.
- Bloom (pass-through stub), Reflector (metallic-plane stub), RectAreaLight (native, no LTC).
- Sub-pixel AA + HEVC-vs-PNG compression ceiling (unrecoverable without a fair HEVC-vs-HEVC compare).

## Conclusion
The TEMPLATE render/composite layer ports to WebGPU cleanly and a real reel renders end-to-end at
SSIM ~0.87. The large part of the earlier gap was a host texture-upload bug (now fixed), NOT per-reel
re-authoring. The small residual is bloom + phone-display ShaderMaterials + AA. Decision for
owner/team: (a) add WebGPU bloom + port the phone ShaderMaterials to push toward ~0.95, or (b) accept
~0.87 native 3D, or (c) keep 3D on the browser/WebGL path and ship native for 2D (SSIM 0.99+).

## 3D files (added this sprint)
`reel-host-3d.mjs` (orchestrator), `3d/three-webgpu-shim.mjs` (adapter), `3d/loader-hooks.mjs`
(module hooks), `3d/webgpu-post-shim.mjs` (bloom/composer stub), `3d/reflector-stub.mjs`,
`3d/rectarea-stub.mjs`, `3d/adapter-test.mjs` (SSIM 1.0 probe), `3d/gltf-test.mjs`,
`3d/smoke-3d.mjs`, `3d/bench-3d.mjs`.

# 2D GPU/NVENC bench (L40S pod, measured 2026-10-17)

Owner-approved measurement: does the 2D native path get faster on GPU / NVENC? Run on an
astrago pod (2x NVIDIA L40S, driver 550.90.12, 32 vCPU, node 22). 300 frames, 1080x1920,
ffmpeg 4.4 (`/usr/bin/ffmpeg`). Full log: pod `/root/kadap/MyDisk/BENCH-SUMMARY.md` + `encbench2.log`.

| encoder | PNG-pipe fps (real) | RAW-YUV fps (encoder-isolated) |
|---|--:|--:|
| CPU h264 (libx264 medium crf18) | 127.5 | 258.2 |
| NVENC h264 (p5 cq18) | 171.2 | 209.5 |
| CPU hevc (libx265 medium crf20) | 58.6 | 62.0 |
| NVENC hevc (p5 cq20) | 148.5 | 250.2 |

Findings:
1. NVENC wins on HEVC: 2.5x (real pipeline) to 4.0x (isolated) vs libx265. Reels encode as HEVC,
   so this is the relevant path — NVENC HEVC is the GPU win for 2D output.
2. H264: libx264 on 32 cores already beats nvenc_h264 for this content — no GPU benefit.
3. PNG decode is a big bottleneck (raw 258 vs png 127 for cpu_h264, ~2x). The native renderer pipes
   PNG; a RAW RGBA pipe would ~2x the encode side regardless of GPU. Actionable.
4. skia-canvas (npm) is CPU-only — no Graphite/Vulkan raster backend. "GPU-backed skia" is not a
   drop-in; the GPU lever for 2D is NVENC (encode), not rasterization. The 2D bottleneck is skia CPU
   raster (faster on the 32-core pod than M2, but still CPU).

Gotcha: the pod's `/usr/local/bin/ffmpeg` (and MyDisk/ffbin) is a 2026 master build requiring nvenc
API 13.1 / driver >=610 — nvenc fails on the 550 driver. Fix = `apt-get install -y ffmpeg` (4.4).
Not measured: skia CPU-raster fps on the pod — the sample reel (MyDisk/rea-render) was deleted by
another process mid-run; no reel remained. Bring-up notes for the next pod are in BENCH-SUMMARY.md.
