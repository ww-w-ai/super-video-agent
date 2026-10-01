# Pipeline — the page contract the bundled scripts drive

Use this only if you build on the bundled scripts. If you write your own renderer (Python,
another JS stack), keep the same two properties and skip the rest: every frame is a pure function
of time, and the audio length is measured, not guessed.

For a WebGL/three.js film, the same contract applies to a second, detached canvas copied onto the
stage canvas each frame — see `references/3d.md` for the capture path and why it must use
`gl.readPixels` + `putImageData`, never `drawImage`, on that copy.

## Page contract

```js
window.__reel = {
  width, height, fps, duration,   // numbers
  ready,                          // Promise: fonts, images, timings loaded
  seek(t),                        // draw exactly time t; pure — same t, same pixels, any order
  shots,                          // [{id, start, end, readAt}] for stills and the contact sheet
  issues(),                       // [] or layout problems your code recorded (e.g. text overflow)
  audio: { narration, renderSfx },// narration wav path; optional renderSfx(sampleRate) → [L, R]
                                   // as Float32Arrays (plain arrays still accepted; render.mjs
                                   // pulls them in ~22 s chunks, so a 10-minute bed fits)
  sfxStems,                       // optional sfxStems(sampleRate) → Promise<[{id, at, L, R}]>,
                                   // each kit/custom cue rendered alone — scripts/sfx-cards.mjs
                                   // "measure" (references/sound.md "Sound cards")
  marks,                          // optional [{at, kind}] sound events for the sync check
};
```

Why pure `seek(t)`: the renderer seeks frames out of order and in parallel. `Math.random`,
`Date`, `performance.now`, timers and `requestAnimationFrame` in scene code break that;
`verify.mjs` scans for them and compares shuffled-order renders against in-order renders.
Randomness goes through keyed RNG (`Reel.rng(key)`), and time-varying jitter through
`floor(t * hz)` buckets in the key.

`ready` must settle. The scripts wait for it up to 120 s (`SVA_READY_TIMEOUT_MS` changes the
limit) and then stop with an error that names the step and lists the page's errors, so a page
that never finishes loading fails instead of hanging.

## Timeline

`voice.mjs` writes `voice/timings.json`: each line's measured start/end, and word times (from
the engine when it reports them, otherwise from the speech-to-text check; always the caption's
words). Each caption word is matched to the heard words by its letters (numbers read out,
spacing ignored), so a word keyed to a beat lands when it was said; words the voice did not say
are interpolated between measured neighbours, and `wordsMeasured` on each line counts the
measured ones (0 = even spread, no speech-to-text; `references/voice.md` "Timing model").
Derive every scene's timing from it; the scaffold's `Reel.timeline(timings)` gives
`line(i) → {start, end, u(t)}`, `word(i, j) → {start, end}`, and
`phrase(i, str) → {start, end} | null` (matches the caption `text`, not `say`).

Each `timings.json` line also records who spoke it: `voice: {provider, voiceId}`. A `plan.json`
line's own `voice` (any `meta.voice` keys, merged over `meta.voice` for that line) gives a film
several speakers (`references/voice.md` "Several speakers in one film").

A picture-only probe made before any voice
(a hard shot, a look test) has no `voice/timings.json`: `still.mjs`, `verify.mjs` and
`render.mjs` accept `--stub <sec>` and use one silent line of that length instead. Nothing is
written to disk.

## Optional helpers (`scripts/engine/reel-engine.js` → `globalThis.Reel`)

A small hand-drawn kit that earlier films used. Use it, change it, or ignore it; your film's look
rules come first.

| Helper | Use |
|---|---|
| `boil(key, t, {hz, amp, rot, moving})` | per-element stepped jitter → `{dx, dy, rot}`; `moving` (0..1, default 0) scales jitter toward zero |
| `moving(t, intervals, {settleSec})` | 0..1: 1 while `t` is inside a `{start, end}` move interval, ramping to 0 over `settleSec` (default 0.15s) on either side — feed into `boil`'s `moving` opt |
| `wobblePath(points, key, t, opts)` | hand-drawn shape jitter. `points` are `{x, y}` objects (not `[x, y]` arrays); returns a denser `{x, y}` array — draw it with `p.x`, `p.y` |
| `hold(t, step)` | quantise time (animate on twos) |
| `rng(key)` / `hash(str)` | the only randomness |
| `drawOn(ctx, path, u, key, t, opts)` | reveal a stroke in point order. `path` is `{x, y}` objects; stroke colour and width come from `opts.color` / `opts.width` (default `#111`, 3), not from `ctx.strokeStyle` |
| `imageCover(ctx, img, x, y, w, h)` | cover-fit an image into a box |
| `textBlock(ctx, text, x, y, w, h, opts)` | wrapped text; a `\n` in the text forces a break where the automatic wrap splits badly; overflow and text outside the safe area recorded to `issues()` |
| `caption(ctx, line, t, opts)` | a narration caption box, at the bottom of the safe area, centred on the frame |
| `safeArea(w, h)` / `setSafeArea("shorts" \| "ads" \| "none" \| {top, bottom, left, right})` | the box text must stay inside; `"none"` = the whole frame, an object = the film's own margins in canvas px |
| `centeredSafeArea(w, h)` | the part of that box centred on the frame — for centred titles and captions |
| `checkSafe(ctx, label, left, top, right, bottom)` | for anything you draw by hand (a sticker, a card, a badge): the box, in the current transform's space, is mapped to canvas space and recorded to `issues()` if it leaves the safe area |
| `easeOutCubic` `easeOutBack` `settle` | arrival curves |

### Safe area

The safe area follows where the film is shown; it is not a rule of the frame size. A film for a
messenger, a TV or a site player has no buttons over it: call `Reel.setSafeArea("none")` at page
load (the whole frame is usable) or pass the film's own margins
(`Reel.setSafeArea({top: 60, bottom: 100, left: 40, right: 40})`). The presets below are for
platforms that draw over the video.

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

The safe box keeps important things out of the button column; it does not move the middle of
the picture. The 9:16 box is off-centre (its middle is x 484, the frame's is 540), and centring
on it pushes the whole film visibly left. Centre everything on the frame, x 540: titles,
captions, illustrations, cards and charts. Centred text uses `centeredSafeArea` (x 192–888). A
wide picture may run under the button column; only what the viewer must read or see stays out
of it.

`textBlock` records `text-outside-safe-area` in `issues()` (so `review.mjs` reports it) unless
the call passes `outsideSafeOk: true` — for decorative lettering that may be covered. Text you
draw yourself goes through `Reel.checkSafe` the same way.

An animated overlay stays inside the safe area on every frame, not only at rest. A pop that
overshoots its full size, a caption that rises into place, a card that slides in: each can
leave the box for a few frames while it moves. Let a pop stop at full size when the element
spans the safe width, and scan every frame rather than one per shot
(`review.mjs --scan`, and `--layer captions` on a slow 3D picture — "Picture first" below).

## Sound (`scripts/engine/reel-audio.js` → `globalThis.ReelAudio`)

Seeded synthesized effects (`click type thud whoosh pop tick alert ding pluck`), an optional
music bed, `duck`, and `master`. The scaffold wires `SFX_CUES` into `renderSfx`, `sfxStems` and
`marks`, and calls `ReelAudio.setFilmKey(plan.meta.filmKey || plan.meta.title || plan.meta.id)`
once at load, so this film's kit sfx carry a character of their own (`sound.md` "Kit"). See
`sound.md`.

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
drawn pixels changed). The joined track (picture, preview or final) is re-stamped onto the exact
1/fps grid without re-encoding: PTS rounded to the grid, DTS one frame per packet, every frame one
tick of a track timescale equal to the frame rate. Frame hashes are unchanged. A plain `-c copy`
join leaves timestamps a few ticks off at segment joins and the last frame held long, and a later
filter (`dub.mjs`'s caption overlay) then makes one frame more than the picture has. A drift of
half a frame or more is refused instead of guessed. After joining, render.mjs checks the A/V duration delta (≤ 50ms) and
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

### Putting an approved clip in as a shot

A hard shot proved and approved in a probe goes into the film as it is, not rebuilt:

```
render.mjs <dir> --no-captions --insert <clip.mp4>@<start-sec> [--insert-stills <dir>]
```

After the picture render, the frames from `<start-sec>` for the clip's frame count are replaced
by the clip. The result is re-stamped onto the 1/fps grid like every join, the frame count and
the inserted span's frame hashes (framemd5) are checked against the clip, and
`picture.timings.json` is kept.

Stills and previews render the page, not the clip. For them to show the shot, the page draws
JPEG stills of the clip for that span: `--insert-stills <dir>` writes them at the page's fps.

## Picture first and language versions

When the picture is slow to render (WebGL/3D on CPU, heavy particles) or several languages share
one picture, render the picture once and lay captions + voice over it per language instead of
re-rendering the picture for every caption or language change:

```
render.mjs <dir> --no-captions      # out/picture.mp4 (video only) + out/picture.bed.wav
                                     # (page renderSfx + library cues, no narration) +
                                     # out/picture.timings.json (the clock it was built on)
dub.mjs <dir> --lang <code>         # out/final-<code>.mp4 — that language's caption + voice
                                     # laid over out/picture.mp4
```

The picture's own clock comes from the base language's voice — the user's language — built first
as always (`voice.mjs <dir>`); other languages follow as variations over that picture; `--no-captions` loads the page with `?captions=0` so `Reel.caption()` (and
any scene code that checks `Reel.captionsOn()`) draws nothing, and the segments go to
`out/segments/<final|preview>-nocap/` — separate from a captioned render's, so the two never mix.

Each language, including the first one, lives in its own folder:

```
<reel-dir>/dub/<code>/
  plan.json     # same line ids as the base plan, text/say in <code>, meta.voice, meta.lang,
                #   and each line's own voice where that language needs one
  voice/        # voice.mjs <reel-dir>/dub/<code>  ->  line-<id>.wav + timings.json
```

`dub.mjs` first trims each take's own leading/trailing silence (an RMS scan at ~-45dBFS, keeping
~40ms of pad on each side; an internal pause is never touched) — a take's edge silence, not its
speech, should never be what decides whether it fits its slot. It then places each dub line's own
(trimmed) audio at its base line's slot (that base line's start to the next base line's start; the
last line's slot runs to the film's end), speeding a too-long line up (atempo) by up to 1.2× to fit
— never cutting audio, never moving the picture — and refuses (naming the line and by how much) if
even that is not enough, so the script gets shortened for that language rather than the render
silently drifting. The base language is dubbed the same way: `dub/<base-lang>/` may simply copy the
base `plan.json` and `voice/`.

The mix is stereo and runs the picture's full length. The bed (`picture.bed.wav`) keeps its own
channels, so each cue's pan survives; the voice sits centred at full level in both channels. Both
are padded to the picture, so the bed after the last line (the ending's sounds, the music fade)
stays in. Before the caption overlay, `dub.mjs` re-stamps `picture.mp4` onto the 1/fps grid
(lossless, as render.mjs does), so a picture from an older render does not gain a frame.

`dub.mjs` first writes `dub/<code>/timings.placed.json` (the fitted lines above, on the base
clock, same shape as `voice/timings.json`). It then tries the reel's own caption layer before
falling back to the engine's default `Reel.caption()` look: it opens `reel.html` with
`?layer=captions&dub=<code>` and checks `__reel.layers` for `"captions"`. A page that declares it
loads `dub/<code>/timings.placed.json` and `dub/<code>/plan.json` instead of its own, skips the
picture, clears to transparent, and draws only its own captions (`Reel.layer()`,
`Reel.dubCode()`) — a word-by-word highlight, emphasis colours, whatever the film's own look is,
so every language matches the film instead of the engine's default box. The scaffold's
`drawCaptions(t)` in `reel.html` is the reference implementation to replace with that look; what
per-language fields it reads from `dub/<code>/plan.json` (e.g. an `emphasis` word list keyed to
that language's words) is the film author's own job. A page that doesn't declare `"captions"`
falls back silently to the default look, with a note in `dub.mjs`'s output. A caption row never
holds one short word alone (craft.md "One picture per line" applies to rows too); a custom
`drawCaptions(t)` that lays words out itself should wrap them with `Reel.balanceRows(widths,
spaceW, maxW)` rather than a plain greedy fill, the same rule `Reel.caption()` uses internally.
A page that instead reveals a line chunk by chunk (a running word count rather than a wrapped
box) should pick chunk boundaries with `Reel.captionChunks(words, maxChars, opts)` — it splits at
phrase punctuation first and only breaks a long phrase into evenly-sized chunks, so the last
chunk of a line is never a single stranded word. A plan line's own `|` (a standalone token —
`validate-plan.mjs` rejects `||` or a leading/trailing `|`) forces a break there too: derive
`opts.breaks` with `Reel.captionBreaksFromText(line.text)` and pass it through — the marker is
never spoken (`pronounce.mjs`'s `stripCaptionBreaks`) and never shown. Every custom caption
drawer honours the plan's forced breaks, the `\n` in `text` as well as `|`: `Reel.caption()`
does, and a `drawCaptions(t)` that balances all of a line's words as one run silently drops
them. A caption row never breaks inside a name.

Overlay text other than captions (stickers, a price card, the end card) is per language too.
Put it in the dub plan's `meta.overlay`, a free-form object the page reads in layer mode
(`Reel.dubCode()` names the language), with the base language's strings in the page as the
fallback. A translated string runs a different length, so re-check every overlay against the
safe area in every language (`review.mjs --scan --layer captions --dub <code>`, below) and
shorten what runs out.

Write each dub line so the word that drives a picture beat falls near the base language's time
for that beat. The picture was built to the base timings and does not move: a keyword that
arrives a second late lands after its picture.

### Judging a dub line: the silence after it

Judge each dub line by the silence after it, not by how much of its slot it fills. A line that
fills its slot runs straight into the next one, and a run of such lines sounds rushed even when
every fill looks healthy. About 0.5 s after each line, or the base line's own pause if that is
longer, is a starting point, not a limit — a language, a voice or a scene may want more.

`dub.mjs` reports every line's fill (clip length after atempo / slot length) and `gapAfter`, the
silence between the placed line and the next line's start, next to the base line's own gap. It
prints a `WARN` list for a gap under about 0.4 s (the message suggests `--min-gap`),
a fill below ~0.75 (the scene sits in silence) and a line that needed atempo. It still writes the
film either way. The last line has no gap and no low-fill warning: its slot runs on under the end
card to the film's end.

On a warning, rewrite that line's wording (shorter for a tight gap, longer for a scene left in
silence) and re-make only that line (`voice.mjs <dir>/dub/<code> --lines <id>`), up to 3 rounds,
without asking. The same wording can come out at quite different lengths on a hosted voice;
`--takes N` with `--pick-by length:<sec>` picks the take closest to a target
(`references/voice.md` "Comparing takes").

When the wording cannot get shorter, widen the slots instead:

```
dub.mjs <dir> --lang <code> --min-gap <sec>
```

For every slot except the last whose gap after the placed line is under `<sec>`, that slot's
picture (setpts) and bed (atempo) are slowed piecewise until the gap reaches `<sec>`; the voice
keeps its speed. It writes `dub/<code>/spaced/picture.mp4`, `picture.bed.wav` and
`picture.timings.json` (lines and words remapped) and builds that language's final from them.
It prints each slot's delta and factor and the old → new length; the first and last frames are
unchanged. Only that language's film gets longer; the other languages keep the base picture.
Without the flag nothing changes.

Check the overlays of each dub on its own. On a slow 3D picture, `review.mjs --scan` would
re-render the whole page at every step; `--layer captions` loads the page with
`?layer=captions&dub=<code>`, which draws only the overlays, so every frame scans in a
fraction of the time:

```
review.mjs <dir> --scan [stepSec] --layer captions [--dub <code>]
```

For the base language, which has no `dub/<base>/timings.placed.json` outside a dub run, the scan
falls back to `voice/timings.json`.

## Asset library

Recorded sound effects and reaction clips ("짤") live outside the repo, in `library/` next to
`scripts/` (auto-found; `SVA_ASSET_LIB` overrides the location). `library/` is git-ignored:
nothing in it ships, because most such files carry third-party rights, so an installed copy of
the skill has none. Without a library, everything works as before — synthesized effects only
(`sound.md`) — and `assets.mjs search`/`fetch` say the library is not bundled and that
`SVA_ASSET_LIB=<folder with catalog.json>` points them at one.

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
- Every cue dips by `meta.sound.sfxDuckDb` (default -6dB, ~80ms ramps) while a narration line
  speaks, untouched in the gaps (`scripts/lib/duck.mjs`, shared with `dub.mjs`); the music bed
  keeps its own, deeper -10dB duck. `references/sound.md` "Mix".

## Fonts

`new-reel.mjs` copies Pretendard into `assets/fonts/`. For another face, drop a licensed font
file there and register it in the page's `@font-face`.

- **Symbols the font lacks show as boxes.** Pretendard covers Korean and Latin. Phonetic symbols
  (ˈ ʊ ə), arrows, math signs or another script may fall back or render as □. Look at a still of
  every frame that shows one before the final render.
- **Emoji come from the operating system.** An emoji in overlay text is drawn with the render
  machine's own emoji font, and a render on another OS may fall back or show boxes. Leave emoji
  out, or bundle an emoji font with a licence that allows it and register it like any other.
- **Draw text after the fonts load.** A canvas drawn and cached before the web font is attached
  (an offscreen stamp, a pre-rendered label) keeps the fallback face for the whole film. Draw
  such text every frame, or cache it only after `document.fonts.ready`. List loaded faces with
  `Array.from(document.fonts)`.
