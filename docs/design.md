# Super Video Agent — design

English | [한국어](design.ko.md)

## 1. What it does

Any source (card news images, article text, blog URL, YouTube URL, image bundle, topic) plus
optional user direction → a finished narrated video. Default 1080×1920, 30 fps. Every frame is
drawn by code in one HTML page; a headless browser captures frames; ffmpeg encodes and muxes.

Signature craft:
per-element **stepped boil** (pose held for N frames, then re-seeded) so the frame never
looks frozen, while reading text (captions) stays still.

## 2. Architecture

```
reels/<slug>/
  source/        inputs as received (images, fetched text, transcript)
  brief.md       facts extracted from the source, each with a source pointer
  style.md       design language: extracted from the source, or chosen and justified
  plan.json      lines (one sentence = one scene), per-line visual intent, voice settings
  voice/         line-NN.wav, narration.wav, timings.json   (measured, never guessed)
  reel.html      the film: engine + scenes; exposes window.__reel
  assets/        images and fonts the page loads (copied, never hot-linked)
  out/           frames sheets, review.json, preview.mp4, final.mp4   (disposable)
```

Data flow is one direction: `plan.json → voice.mjs → timings.json → reel.html reads timings →
render.mjs → out/*.mp4 → review.mjs → fix list`. `timings.json` is the single timeline authority;
the page derives every shot start/end from it, never from its own constants.

### 2.1 Page contract (`window.__reel`)

```
window.__reel = {
  width, height, fps, duration,      // numbers; duration from timings.json
  ready,                              // Promise: fonts + images loaded
  seek(t),                            // draw time t; pure function of t; may return a Promise
  shots: [{id, start, end, readAt}],  // derived from timings; readAt = representative moment
  issues(),                           // layout problems recorded by engine helpers (text overflow)
  audio: { narration: "voice/narration.wav", renderSfx?: (sampleRate) => Float32Array[2] }
}
```

Rules (a static scan in `verify.mjs` enforces the first four):
- No `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, timers, or `fetch` in scene code. Randomness only from `rng(key)`.
- `seek(t)` result independent of seek history (random-order seeks give identical pixels).
- One `<canvas>`; no DOM animation, no CSS transitions.
- No network at render time: assets copied into `assets/`.
- Reading text (captions, headlines) does not boil. Graphics and annotations do.

### 2.2 Engine (`scripts/engine/reel-engine.js`, inlined into each reel.html)

Deterministic helpers, each a pure function:
- `hash(str)`, `rng(key)` (mulberry32 over string hash).
- `boil(key, t, {hz=8, amp=1.2, rot=0.35})` → `{dx, dy, rot}` from `rng(key + ":" + floor(t*hz))`. Stepped, not smooth.
- `wobblePath(points, key, t, {hz, amp, step})` → densified polyline displaced by stepped noise.
- `hold(t, step)` quantise time (on-twos = 2/fps).
- Draw helpers: `drawOn(path, u)` (marks are made, in order), `imageCover`, `textBlock` (wraps, records overflow into issues), `caption(line, t)`.
- Easing: `easeOutCubic`, `easeOutBack`, `settle`.
- Timeline: `timeline(timings)` → `{line(i) -> {start,end,u(t)}, word(i,j) -> time}`; word times from provider alignment, else proportional to characters within the measured line.

### 2.3 Scripts (`scripts/*.mjs`, Node ≥ 22, Playwright + ffmpeg)

| Script | One-sentence job |
|---|---|
| `new-reel.mjs <dir> --ratio 9:16` | Scaffold a reel folder with template reel.html, engine inlined, fonts copied. |
| `validate-plan.mjs <dir>` | Check plan.json against the schema; exit non-zero with the failing path. |
| `voice.mjs <dir> [--provider qwen3\|melotts\|fishspeech\|fish\|elevenlabs\|say\|file\|none]` | Synthesize each line, measure it, write narration.wav + timings.json. |
| `still.mjs <dir> --at <t\|shotId> [--out png]` | Render one frame at full size. |
| `verify.mjs <dir>` | Static contract scan + determinism probe (in-order vs shuffled seeks, pixel hashes). |
| `render.mjs <dir> [--preview] [--workers N] [--plan] [--only ids]` | Render per-shot segments (reusing unchanged ones), join, mux whole-film audio (narration + page SFX), loudnorm. |
| `review.mjs <dir> [--mp4 path]` | Contact sheet at each shot's readAt, dead-air runs, boil cadence, A/V duration delta, engine issues → review.json. |

Voice providers share one interface (`scripts/voice/<name>.mjs`):
`synth({text, voice, lang, params}) → {wavPath, words?: [{w, start, end}]}` and optional
`clone({samplePath}) → voiceId`. Env: `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `SAY_VOICE` (default `Yuna`).

### 2.4 QA thresholds (defaults, tunable in plan.json)

- Dead air: no run ≥ 0.8 s where < 0.2 % of pixels change (64-px greyscale diff).
- Boil present: in non-transition frames, pose changes occur at the planned cadence (±1 frame).
- A/V: video and narration durations differ ≤ 50 ms; last line ends before final frame.
- Determinism: shuffled-seek hashes equal in-order hashes for ≥ 12 probe times incl. shot edges.
- Layout: `issues()` empty (no text overflow, nothing outside safe area).

### 2.5 Asset library (sound effects and reaction clips)

Recorded sound effects and short reaction clips ("짤") come from a local library the user keeps
outside the skill folder, so nothing from a library is published: most such files carry
third-party rights.

- **Library** = a folder with `catalog.json` and the files. The location is `SVA_ASSET_LIB` when
  set, else `~/.super-video-agent/library`. The folder is never created on its own. Without a library,
  everything works as before (synthesized effects only).
  `catalog.json`: `{version: 1, assets: [{id, role: "sfx"|"reaction", kind: "audio"|"video",
  path, description, tags[], durationSec, width?, height?, hasAudio, license: {kind,
  commercialSafe}}]}`. `path` is relative to the library folder.
- **Chosen in the script stage.** A line may carry `cues`: `[{asset, at, offsetMs?, gainDb?,
  maxSec?, play?}]`. `at` = `"start"` | `"end"` | `"word:<text>"` (the first word of the line's
  caption that contains `<text>`). `play` = `"sound"` | `"picture"` | `"both"`; default `sound`
  for role sfx, `both` for role reaction. A reaction with sound goes where the narration pauses:
  its line's `pauseAfterMs` covers the clip, and `at: "end"`.
- **`assets.mjs`**: `search <query> [--role] [--limit]` lists matches by keyword over
  description and tags, with duration and license. `fetch <dir>` copies every cued asset into
  `<dir>/assets/lib/`: audio as-is; video as JPEG frames at the plan's fps plus its audio track
  as wav; writes `assets/lib/manifest.json` (per asset: files, durationSec, frames, fps, size,
  license) and `assets/lib/cues.json` (the plan's cues). It refuses an asset whose
  `commercialSafe` is false unless `plan.meta.distribution` is `"personal"` or the call passes
  `--allow-personal-scope`; either way the license of every fetched asset is printed and written
  to the manifest.
- **One cue-time function** in the engine (`Reel.cueTime(cue, line, timings)`), used by the page
  to draw picture cues and by `render.mjs` (through the page) to place sound cues.
  `__reel.soundCues()` returns `[{file, at, gainDb, maxSec}]`.
- **Picture**: `Reel.clipFrame(id, tLocal)` returns the preloaded frame image for a clip's local
  time (frame = floor(tLocal × fps), held on the last frame); scenes draw it with
  `imageCover`. Deterministic: the same t always draws the same frame.
- **Sound**: `render.mjs` mixes each sound cue into the film audio: trimmed to `maxSec` (or the
  clip), 30 ms fade-out, peak-normalized to -6 dBFS then `gainDb`, delayed to its time, summed
  with narration and page effects before the final loudness pass.

## 3. Out of scope (first version)

Talking-head restyling, AI video generation models, music composition beyond simple Web Audio SFX,
automatic upload to platforms.
