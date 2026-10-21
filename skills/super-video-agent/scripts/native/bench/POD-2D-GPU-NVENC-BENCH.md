# SVA 2D GPU/NVENC bench — astrago pod (2x L40S), 2026-10-17

## Env
- 2x NVIDIA L40S, driver 550.90.12 (nvenc API 12.2), 32 vCPU, node v22.23.3.
- GOTCHA: /usr/local/bin/ffmpeg (and MyDisk/ffbin) are a 2026 master build that
  REQUIRES nvenc API 13.1 / driver >=610 -> nvenc fails ("Driver does not support
  the required nvenc API version. Required 13.1 Found 12.2"). Fix: `apt-get install
  -y ffmpeg` -> /usr/bin/ffmpeg 4.4.2 (nvenc SDK 11) which works with driver 550.

## Encode bench (300 frames, 1080x1920, ffmpeg 4.4, /usr/bin/ffmpeg)
PNG-pipe = the native renderer's real pipeline (png decode + encode).
RAW-YUV  = encoder-isolated (pre-decoded raw input).

| encoder            | PNG-pipe fps | RAW-YUV fps |
|--------------------|-------------:|------------:|
| CPU  h264 (libx264 medium crf18) | 127.5 | 258.2 |
| NVENC h264 (p5 cq18)             | 171.2 | 209.5 |
| CPU  hevc (libx265 medium crf20) |  58.6 |  62.0 |
| NVENC hevc (p5 cq20)             | 148.5 | 250.2 |

## Findings
1. HEVC is where NVENC wins: 2.5x (PNG-pipe) to 4.0x (raw) vs libx265. Reels encode
   as HEVC, so this is the relevant path -> NVENC HEVC is a clear win on the pod.
2. H264: libx264 on 32 cores is already fast (258 raw); nvenc_h264 does NOT beat it
   for this content. No benefit from GPU for H264 here.
3. PNG decode is a big bottleneck: raw cpu_h264 258 vs png 127 (~2x). The native
   renderer pipes PNG (skia png-encode + ffmpeg png-decode). Switching to a RAW RGBA
   pipe would ~2x the encode-side throughput regardless of GPU. Actionable.
4. skia-canvas (npm) is CPU-only — no Graphite/Vulkan GPU raster backend exposed. So
   "GPU-backed skia" is not a drop-in; the GPU lever for the 2D native path is NVENC
   (encode), not rasterization. The 2D bottleneck is skia CPU raster, which the 32-core
   pod speeds up over M2 but stays CPU.

## NOT measured (why)
- skia CPU-raster fps on the pod: the sample reel (MyDisk/rea-render) was deleted by
  something else on the pod mid-run; no reel.html remained to render. skia GPU raster:
  not available (point 4).

## Bring-up for next pod (instant)
1. `apt-get install -y ffmpeg`  (nvenc-compatible 4.4 at /usr/bin/ffmpeg; do NOT use
   /usr/local/bin/ffmpeg with driver <610).
2. node 22 present; `npm install --prefix <dir> skia-canvas` for the native 2D host.
3. Put a real 2D reel on MyDisk (reel.html + assets + plan.json + fonts) to bench
   skia raster; encode bench needs only frames (testsrc2 ok).
4. Scripts used: /root/kadap/MyDisk/encbench2.sh (encode), /root/kadap/MyDisk/nat/
   (reel-host.mjs + render-bench.mjs for the render+encode pipeline).
