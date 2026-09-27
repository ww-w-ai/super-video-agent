# Pipeline — the page contract the bundled scripts drive

Use this only if you build on the bundled scripts. If you write your own renderer (Python,
another JS stack), keep the same two properties and skip the rest: every frame is a pure function
of time, and the audio length is measured, not guessed.

## Page contract

```js
window.__reel = {
  width, height, fps, duration,   // numbers
  ready,                          // Promise: fonts, images, timings loaded
  seek(t),                        // draw exactly time t; pure — same t, same pixels, any order
  shots,                          // [{id, start, end, readAt}] for stills and the contact sheet
  issues(),                       // [] or layout problems your code recorded (e.g. text overflow)
  audio: { narration, renderSfx },// narration wav path; optional renderSfx(sampleRate) → [L, R]
  marks,                          // optional [{at, kind}] sound events for the sync check
};
```

Why pure `seek(t)`: the renderer seeks frames out of order and in parallel. `Math.random`,
`Date`, `performance.now`, timers and `requestAnimationFrame` in scene code break that;
`verify.mjs` scans for them and compares shuffled-order renders against in-order renders.
Randomness goes through keyed RNG (`Reel.rng(key)`), and time-varying jitter through
`floor(t * hz)` buckets in the key.

## Timeline

`voice.mjs` writes `voice/timings.json`: each line's measured start/end, and word times (from
the provider when it gives them, otherwise spread across the measured line). Derive every
scene's timing from it; the scaffold's `Reel.timeline(timings)` gives
`line(i) → {start, end, u(t)}`, `word(i, j) → {start, end}`, and
`phrase(i, str) → {start, end} | null` (matches the caption `text`, not `say`).

## Optional helpers (`scripts/engine/reel-engine.js` → `globalThis.Reel`)

A small hand-drawn kit that earlier films used. Use it, change it, or ignore it; your film's look
rules come first.

| Helper | Use |
|---|---|
| `boil(key, t, {hz, amp, rot})` | per-element stepped jitter → `{dx, dy, rot}` |
| `wobblePath(points, key, t, opts)` | hand-drawn shape jitter |
| `hold(t, step)` | quantise time (animate on twos) |
| `rng(key)` / `hash(str)` | the only randomness |
| `drawOn(ctx, path, u, key, t, opts)` | reveal a stroke in point order |
| `imageCover(ctx, img, x, y, w, h)` | cover-fit an image into a box |
| `textBlock(ctx, text, x, y, w, h, opts)` | wrapped text; a `\n` in the text forces a break where the automatic wrap splits badly; overflow and text outside the safe area recorded to `issues()` |
| `caption(ctx, line, t, opts)` | a narration caption box, at the bottom of the safe area |
| `safeArea(w, h)` / `setSafeArea("shorts" \| "ads")` | the box text must stay inside |
| `easeOutCubic` `easeOutBack` `settle` | arrival curves |

### Safe area

Shorts, TikTok and Reels draw their own buttons over the video. Pictures, backgrounds and motion
may fill the whole frame — an empty edge looks unfinished. Text, and anything the viewer must
read or see, stays inside the safe box (1080×1920):

| `setSafeArea` | Top | Bottom | Left | Right | Box | Use |
|---|---|---|---|---|---|---|
| `shorts` (default) | 200 | 450 | 80 | 192 | x 80–888, y 200–1470 | organic Shorts and TikTok |
| `ads` | 288 | 672 | 80 | 192 | x 80–888, y 288–1248 | paid vertical ads |

What each edge avoids: top — TikTok's Following/For You tabs and the Shorts search and menu
icons; bottom — channel name, title, music label and progress bar (and an ad's button); right —
the like/comment/share column. The `ads` top, bottom and right are measured from YouTube's
official vertical-ad overlay; the rest comes from published TikTok creative guides, taking the
stricter value where they differ. Other ratios use 5% on every side.

`textBlock` records `text-outside-safe-area` in `issues()` (so `review.mjs` reports it) unless
the call passes `outsideSafeOk: true` — for decorative lettering that may be covered.

## Sound (`scripts/engine/reel-audio.js` → `globalThis.ReelAudio`)

Seeded synthesized effects (`click type thud whoosh pop tick alert ding pluck`), an optional
music bed, `duck`, and `master`. The scaffold wires `SFX_CUES` into `renderSfx` and `marks`.
See `sound.md`.

## Re-rendering part of a film

`render.mjs` never renders the whole film as one pass. It tiles `window.__reel.shots` into
frame-range segments, encodes each to `out/segments/<preview|final>/<shotId>.mp4`, and joins
them with the ffmpeg concat demuxer (`-c copy`) into the video track. A segment is reused
instead of re-encoded when its stored frame range, fps, size and three probe-frame hashes
(sha256 of the captured PNG at the segment's first/middle/last frame) all match the current
timeline and its `.mp4` still exists — no manual bookkeeping, the check is automatic on every
render. The scaffold's `shots` always tile end-to-end: shot *i* spans from line *i*'s start
(the first shot from 0) to line *i+1*'s start (the last shot to the film's duration), so any
`gapMs` silence between lines belongs to the shot before it rather than being an un-owned gap.
A custom scene that reports its own `shots` differently can still leave gaps or overlaps —
those non-tiling shots merge into one bigger segment with a warning.

```
render.mjs <dir> [--preview]           # normal render: probes every segment, reuses what matches
render.mjs <dir> [--preview] --plan    # print REUSE/RENDER per segment, render nothing
render.mjs <dir> [--preview] --only id,id   # force-render exactly these segments, skip
                                             # probing everything else (fast path for "fix
                                             # scene X"); refuses if a segment outside --only
                                             # no longer matches its stored frame range
```

A segment re-renders when: its `.mp4` is missing, its frame range moved (the shot before it
changed duration), fps or output size changed, or any of its three probe hashes changed (the
drawn pixels changed). After joining, render.mjs checks the A/V duration delta (≤ 50ms) and
that the joined video's frame count equals `round(duration*fps)`, and fails loudly otherwise.
The audio is padded with silence and cut at the video's end, so the delivered file keeps every
frame of the still tail.

To regenerate only some narration lines: `voice.mjs <dir> --lines id,id` re-synthesizes those
lines, reuses the other lines' existing `voice/line-<id>.wav`, and always rebuilds
`narration.wav` and `timings.json` in full. A regenerated line keeps its old time slot: a
shorter take is padded with silence, a longer one sped up by up to 10%. Nothing moves, so
`render.mjs` reuses every shot and only remixes the audio — the usual case for a pronunciation
fix. A take more than 10% longer keeps its own length; `voice.mjs` prints which later lines'
start times shifted, and those shots re-render. After a wording change, pass `--retime` to let
regenerated lines keep their own length.

## Asset library

Recorded sound effects and reaction clips ("짤") live outside the repo, in `library/` next to
`scripts/` (auto-found; `SVA_ASSET_LIB` overrides the location). `library/` is git-ignored:
nothing in it ships, because most such files carry third-party rights. Without a library,
everything works as before — synthesized effects only (`sound.md`).

A library is a folder with `catalog.json` and the files it describes:

```
{ version: 1, assets: [
  { id, role: "sfx" | "reaction", kind: "audio" | "video", path,   // relative to library/
    description, tags: [...], durationSec, width?, height?, hasAudio,
    license: { kind, commercialSafe } }
] }
```

A line picks clips in `plan.json` via `cues`: `[{asset, at, offsetMs?, gainDb?, maxSec?, play?}]`.
`at` is `"start"`, `"end"`, or `"word:<text>"` (the first word of the line's caption containing
`<text>`). `play` is `"sound"`, `"picture"`, or `"both"` — default `"sound"` for role `sfx`,
`"both"` for role `reaction`.

Two commands (`scripts/assets.mjs`):

```
assets.mjs search <query> [--role sfx|reaction] [--limit N]   # keyword search over description+tags
assets.mjs fetch <reel-dir> [--allow-personal-scope]           # copies every cued asset into
                                                                 # <reel-dir>/assets/lib/
```

`fetch` copies audio as-is and turns video into JPEG frames at the plan's fps (plus a wav of its
own audio, if any), and writes `assets/lib/manifest.json` and `assets/lib/cues.json`. It refuses
an asset whose `license.commercialSafe` is `false` unless `plan.meta.distribution` is `"personal"`
or `--allow-personal-scope` is passed — either way it prints every fetched asset's license.
`verify.mjs` warns (does not fail) when `plan.json`'s cues have drifted from `assets/lib/cues.json`.

To add your own clip or effect: put the file under `library/` and add one entry to
`catalog.json` with a new `id`, its `role`, `kind` and `path`, a `description` and `tags` a
search will hit, its measured `durationSec` (and `width`/`height`, `hasAudio` for video), and
`license: {kind: "user", commercialSafe: true}` for material you made yourself.

### Drawing and mixing cues

| Helper | Use |
|---|---|
| `Reel.cueTime(cue, line, timings)` | the cue's time in seconds; the page and `render.mjs` share it |
| `Reel.registerClip(id, frames, fps)` / `Reel.clipFrame(id, tLocal)` | the clip frame at `tLocal` seconds into the clip. Past the end it keeps returning the last frame, so stop drawing at `cueTime + durationSec` yourself |
| `__reel.soundCues()` | the page tells `render.mjs` which cue sounds to mix; the scaffold provides it |

- The scaffold's `drawLibCues` cover-fits a clip to the whole frame. A landscape clip on a 9:16
  frame then keeps only its middle third. For faces, draw the clip yourself into a box inside the
  safe area.
- `render.mjs` places cue sounds on their cue time itself. Do not add library cues to `marks`: a
  cue on a spoken word measures the narration's onset, not the effect's.
- A sound-only file's head silence (up to 0.3 s) is skipped, so the effect is heard on the cue.
  A clip keeps its own lead so its sound stays on its picture.

## Fonts

`new-reel.mjs` copies Pretendard into `assets/fonts/`. For another face, drop a licensed font
file there and register it in the page's `@font-face`.

- **Symbols the font lacks show as boxes.** Pretendard covers Korean and Latin. Phonetic symbols
  (ˈ ʊ ə), arrows, math signs or another script may fall back or render as □. Look at a still of
  every frame that shows one before the final render.
- **Draw text after the fonts load.** A canvas drawn and cached before the web font is attached
  (an offscreen stamp, a pre-rendered label) keeps the fallback face for the whole film. Draw
  such text every frame, or cache it only after `document.fonts.ready`. List loaded faces with
  `Array.from(document.fonts)`.
