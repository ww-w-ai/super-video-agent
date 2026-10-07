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

### Optional page fields

Each is optional; the scripts read it when present. A field of the wrong shape throws when read
(`Reel.checkRegions`, `checkHolds`, `checkLangSpans` name the entry), because a wrong declaration
is definitely wrong.

| Field | Shape | Read by |
|---|---|---|
| `preload` | a Promise, or a function returning one (decoded bitmaps, textures built lazily) | every script that opens the page awaits it after `ready`, before the first seek, the cold page in `verify.mjs` included; a rejection or timeout fails the open and names the step |
| `regions` | `[{id, kind: "key"\|"label"\|"overlay"\|"reserve", box: [x0,y0,x1,y1], outline?, text?, from?, to?}]` in canvas px, or a function returning it; no `from`/`to` = the whole film; `reserve` = a corner box kept clear for a label or logo, `text` = that label's own text (below, "Corner reserve") | `state-checks.mjs --only covers,reserve` |
| `holds` | `[{from, to, id?, reason?}]` seconds where the film holds or moves slowly on purpose | `review.mjs`: a freeze inside a hold is listed as intended, not flagged |
| `captionFonts` | `{"<lang>": "<css font-family list>", "*": "<fallback list>"}` | the caption layer; `state-checks.mjs --only langglyphs`. Without it, `plan.json` `style.fonts` (`<lang>`, `caption`, `body` or `default`) |
| `langSpans` | `[{start, end, in?: "layer"\|"scene"}]` seconds | `dub.mjs` ("Shared language-neutral spans") |
| `visibleAt` | `function(t)` returning `[{id, opacity?: 0..1}]` | `state-checks.mjs` flicker |
| `segments` | `[{from, to, key}]`, one entry per world | `verify.mjs --world <key>` |
| `parallaxReport` | `function()` returning `Reel.parallaxCoverage(spec, width, height)` | `render.mjs` and `verify.mjs` print each layer with a bare edge; reports only (`references/parallax.md`) |

A line's `notes` in `plan.json` (`[{at: "start" | "word:<text>", text, corner?: "tl"|"tr"|"bl"|"br",
holdSec?}]`) are corner notes: the caption step draws them (`Reel.cornerNotes`, `Reel.drawCornerNotes`),
the wording from that language's plan line, the time from that language's word times. A note whose word
is not found starts at the line start and records `note-word-not-found`.

The page's top-level script may use `await`; the scripts wait for `window.__reel` to appear before
they read it.

## Timeline

`voice.mjs` writes `voice/timings.json`: each line's measured start/end, and word times (from
the engine when it reports them, otherwise from the speech-to-text check; always the caption's
words). A line's `words` array holds `{w, start, end}` objects: the caption word is under the key
`w` (not `text` or `word`), times in seconds. Each caption word is matched to the heard words by its letters (numbers read out,
spacing ignored), so a word keyed to a beat lands when it was said; words the voice did not say
are interpolated between measured neighbours, and `wordsMeasured` on each line counts the
measured ones (0 = even spread, no speech-to-text; `references/voice.md` "Timing model").
Derive every scene's timing from it; the scaffold's `Reel.timeline(timings)` gives
`line(i) → {start, end, u(t)}`, `word(i, j) → {start, end}`, and
`phrase(i, str) → {start, end} | null` (matches the caption `text`, not `say`).

**Lead.** `meta.lead` (a number of seconds, or `true` for 3 s; absent = no lead) puts an opening
before the first story line. Every story line's time shifts by the lead, `timings.json` records it
(`lead`, seconds), and render, dub, captions, sfx cues and fit all read that one clock; scene code
gets `t` from 0, so the picture draws the lead span too. Dubs inherit the same lead length — one
timing for all languages. The lead must carry sound (`references/sound.md` "Lead sound"); a line
marked `lead: true` is the opening line spoken inside it.

Each `timings.json` line also records who spoke it: `voice: {provider, voiceId}`. A `plan.json`
line's own `voice` (any `meta.voice` keys, merged over `meta.voice` for that line) gives a film
several speakers (`references/voice.md` "Several speakers in one film").

A picture-only probe made before any voice
(a hard shot, a look test) has no `voice/timings.json`: `still.mjs`, `verify.mjs` and
`render.mjs` accept `--stub <sec>` and use one silent line of that length instead. Nothing is
written to disk. `render.mjs --stub` runs with or without captions: with captions on, the stub's
lines are empty so no caption is drawn, the page's own sound is the audio, and the file is
`out/<final|preview>-stub.mp4`. Use that when a preview with the film's caption layer helps;
otherwise `--no-captions` as usual.

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
| `checkSafe(ctx, label, left, top, right, bottom, w?, h?, {outline}?)` | for anything you draw by hand (a sticker, a card, a badge): the box, in the current transform's space, is mapped to canvas space and recorded to `issues()` if it leaves the safe area; `outline` (px) adds a stroke's half-width on each side |
| `cornerRegions(plan.meta.corners)` | the corners a film reserves for persistent labels, as `regions` of kind `reserve` ("Corner reserve") |
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

### Children, highlights and corners

`textBlock` and `checkSafe` compare text with the safe area and with other text; they do not know
which box a chip or a tag belongs to. The optional helper `scripts/engine/reel-layout.js` (copy it
into the reel's `src/`, load it with `<script src="src/reel-layout.js">`; it adds
`globalThis.ReelLayout`, no dependencies) records what crosses its container, and `review.mjs`
counts those issues in the layout gate like any other `issues()` entry.

- **A child inside its container.** `ReelLayout.layoutChips(measure, labels, box, opts)` packs chips
  into rows by measured width (`measure = (s) => ctx.measureText(s).width`, with `ctx.font` set),
  centres each row and the block in `box` (`opts.align: "left"` for left-aligned rows; `padX`, `height`,
  `gapX`, `gapY`, `margin`), and returns `{chips: [{text, x, y, w, h, row}], rows, fits, overflow}`; draw
  each chip at its `x, y, w, h`. A chip that cannot fit records `child-outside-box` with its text.
  `ReelLayout.checkInside(id, child, box)` does the same for any box you place by hand (`{x, y, w, h}`,
  `{left, top, right, bottom}` or `[x0, y0, x1, y1]`, canvas px).
- **A highlight on its target.** A frame, bracket or arrow marks a target rect; the label next to it
  can drift away from it with nothing to say so. Make a log per seek, `const log = ReelLayout.drawLog()`;
  call `log.target(id, rect)` right after drawing the target and `log.highlight(id, targetId, rect,
  {kind: "frame" | "bracket" | "arrow", mode?, reach?})` right after drawing the highlight; call
  `log.check()` at the end of the seek. It records `highlight-misses-target` when the highlight's rect
  does not do what `mode` declares (`enclose`, the default for a frame: the rect contains the target;
  `overlap`: they share area; `near`, the default for a bracket or arrow: within `reach` px, default
  24), `highlight-under-target` when the target was drawn after the highlight (it covers it), and
  `highlight-target-missing` when no such target was drawn. `ReelLayout.checkHighlight({id, kind,
  rect, target, mode})` is the geometry check alone.

### Corner reserve

Only when the film carries persistent labels or logos in one or more of the four corners (top-left
`tl`, top-right `tr`, bottom-left `bl`, bottom-right `br`; a film uses N of them). Text and objects
put in after the labels move or are redrawn when a label lands on them, so decide the corners in
the script stage: write each corner used and its box (canvas px) in `FILM.md`, and in `plan.json`
`meta.corners` (`{"tl": {"box": [x0, y0, x1, y1], "label": "<its text>"}}`, `label` omitted for a
logo). The film stage keeps those boxes clear from the first build. The page declares them as
`window.__reel.regions = [...Reel.cornerRegions(plan.meta.corners), ...]` (kind `reserve`), and
`state-checks.mjs --only reserve` lists picture text drawn inside a reserved box (the label's own
text excepted, with the times) and, through `covers`, any declared key region that overlaps one.
A film with no corner labels declares none, and the check stays silent.

## Sound (`scripts/engine/reel-audio.js` → `globalThis.ReelAudio`)

Seeded synthesized effects (`click type thud whoosh pop tick alert ding pluck`), an optional
music bed, `duck`, and `master`. The scaffold wires `SFX_CUES` into `renderSfx`, `sfxStems` and
`marks`, and calls `ReelAudio.setFilmKey(plan.meta.filmKey || plan.meta.title || plan.meta.id)`
once at load, so this film's kit sfx carry a character of their own (`sound.md` "Kit").
`ReelAudio.sfxPool` gives a kind that returns many times several sounds, and `master` has a fixed
drive. See `sound.md`.

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

Shot ids need not equal line ids: a film may tile its own shots (for example split one line's span in
two so only the part that shows a language's text re-renders per language). The tools that use a shot
id only as a name: `render.mjs` (segment files and `--only` are named by shot id) and `verify.mjs
--only`. `review.mjs` and `still.mjs` read the shots' times, `changed-spans.mjs` reads `shots` when a
timeline has them, and `dub.mjs` reads the lines' times, so none of them needs a shot id to equal a
line id. A line id is what `plan.json`, `voice/timings.json` and every dub match on.

```
render.mjs <dir> [--preview]           # normal render: probes every segment, reuses what matches
render.mjs <dir> [--preview] --plan    # print REUSE/RENDER per segment, render nothing; the answer is
                                       # cached in out/plan-cache.json (--no-plan-cache probes again)
render.mjs <dir> [--preview] --only id,id   # force-render exactly these segments, skip
                                             # probing everything else (fast path for "fix
                                             # scene X"); refuses if a segment outside --only
                                             # no longer matches its stored frame range
render.mjs <dir> --span 12.5-15,40-44        # only these seconds (+0.5 s each side); see below
```

A first render can go part by part, so no single call has to hold the whole film: `--only a,b`
renders those segments and marks every segment never rendered before `PENDING` (skipped, not
probed); the next call with `--only c,d` adds more. The film is joined, gated and muxed on the call
that leaves no segment pending. A picture-only probe with no voice yet splits its silent clock with
`--stub <sec> --segments N` (ids `stub-1`..`stub-N`), so it can go part by part too.

One render opens the page once (once per `--workers` worker) and uses that session for the shot
list, the probes, the frames, the page sound and the sound cues. Its warm-up seeks only the shots it
will capture, so a page that builds a scene on first seek builds only the scenes those shots need.
The last line of the output is `page opens: N`.

With `--only`, the segment right before and right after each named one is also probed (not
forced). A neighbour whose probe hashes differ from its stored ones renders too and prints
`--only: also rendering <id> (its frames changed)`: its last or first frames can already show the
changed state. An unchanged neighbour stays REUSE.

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
regenerated lines keep their own length. In a dub folder (`dub/<code>/`) this slot fit is off:
the picture's base-language slot is the limit, `dub.mjs` fits each line to it, so regenerated
lines keep their own length without `--retime`.

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

### Drafts with handles

```
render.mjs <dir> --only id,id --handle 0.5   # out/drafts/<id>.mp4 + <id>.json per shot
render.mjs <dir> --no-captions --use-draft <id>
```

A draft covers the shot's slot plus `--handle` seconds each side, clamped at the film's first and
last frame; the film is not joined and `out/segments/` is untouched. `<id>.json` holds the slot
start/end (seconds and frames), the handle, and the frames gained on each side. `--use-draft`
cuts exactly the slot frames out of the clip (re-encoded, no page render) and splices them in at
the slot start through the `--insert` path, with the same frame-count and framemd5 checks. Use
the same `--preview` setting for the draft and for `--use-draft`.

`<id>.json` also records a stamp of what the page was made from (a hash over every file of the
reel folder outside `out/`: path, size and content up to 8 MB per file, no modified time) and the
hashes of the slot's first, middle and last frame. `scripts/draft-check.mjs <dir>` compares each
draft with the page now and prints one state per draft:

| state | meaning |
|---|---|
| `current` | the stamp is the same; the page is as it was |
| `slot-unchanged` | the stamp moved, the page still draws the slot's frames the same; the draft is usable |
| `stale` | the page draws the slot differently now; draw the draft again |
| `unstamped` | the draft has no stamp; draw it again to record one |

The page is opened only when a stamp moved. `--use-draft` warns, without stopping, when the stamp
moved. Whether to use a stale draft is your decision.

### Render reuse

Render reuse is the base principle of this stage: render and encode only what changed, stream-copy
the rest, and build what several versions share once. The tools below follow it; use the smallest
one that covers the change.

Every segment is encoded with a keyframe every `round(fps)` frames (one second), so a later cut
copies whole GOPs and re-encodes only the frames up to the next keyframe. A segment from an older
render has keyframes further apart: a splice still works, and prints one note.

An encode goes to a temporary name (`<name>-<microseconds>-<pid>`) and is renamed on success, so an
interrupted encode never leaves a truncated mp4 under a cached name. At the start of a render the
temporary names whose pid is no longer running are removed and listed. A GL error (`GL_INVALID_*`,
lost context) while a segment draws fails that segment before it is published; other GL messages are
printed once.

`--plan` caches its answer in `out/plan-cache.json`, keyed by the options, every file of the reel
folder outside `out/` (size and modified time), the segment cache folders, the skill version and
`render.mjs`'s modified time. Asking again with nothing changed prints the same lines with
`page opens: 0`. A real render never reads the cache. `--no-plan-cache` probes again.

### Re-rendering only some seconds

`--span <from>-<to>[,<from>-<to>...]` (seconds) renders only the frames between them, widened by
0.5 s on each side and snapped to the frame grid, and splices them into the cached segments at exact
frame cuts. Everything else is reused from the cache without probing. Use it when a few seconds
changed; it never re-renders a whole shot. Each touched segment's cache (mp4 and probe hashes) is
updated, so a later full render reuses it.

- It needs every segment rendered once, with its stored frame range unchanged; otherwise it stops
  and names the segments and the command that fixes it.
- Not with `--only`, `--insert`, `--use-draft`, `--handle` or `--probe-all`.
- With `--no-captions --lang <code>` it redraws spans of that language's picture
  (`out/segments-<code>/`, which must hold every segment once: render `--lang` first). Use it for
  text drawn inside the scene (`langSpans` entries with `in: "scene"`): only those seconds are drawn
  again, and a rebuilt segment keeps the strings its cached frames read and adds the ones the new
  frames read.
- `--plan --span` prints the span plan and exits.

**Finding the changed spans.** Keep the old `voice/timings.json` (or a dump of the page's shots,
`{duration, fps, shots: [{id, start, end}]}`) before the voice or the page changes. Then:

```
changed-spans.mjs <old-timeline.json> <new-timeline.json> [--fps <n>] [--out <json>]
```

Each timeline item owns the frames from its start to the next item's start. An item is kept when
the other timeline has the same id with the same text, hash, word times and owned length, even if it
moved; every other item is a changed or added span. The tool prints the spans to draw, the runs to
copy with their old and new frames and the shift, the ids only the old timeline has, and a
`--span <from>-<to>,...` value. When none of the kept frames moved, pass that value to `--span`.
When some moved (a line got longer), `--span` stops on the moved ranges: build the film with
`--assemble`. `--edl-out <edl.json> --old-film <mp4> --new-film <mp4>[,<mp4>...]` writes that EDL: kept
runs come from the old film at their old frames, new runs from the new film. `--new-film` is either an
mp4 whose frame n is the new film's frame n, or draft clips (`render.mjs --only <id> --handle <sec>`,
`out/drafts/<id>.mp4`, several separated by commas). A draft's first frame is not the film's frame 0:
its sidecar `out/drafts/<id>.json` records `frameStart`, the film frame its first frame is, so a new run
`[a, b)` becomes the clip's frames `[a - frameStart, b - frameStart)`. The tool reads the sidecar next
to each clip, takes a run that crosses two drafts from both, and stops when a new run is held by no
clip. A clip with no sidecar is read as the new film itself. Entries that name segments instead can be
edited into the EDL. The tool reports; whether to draw or copy is your decision.

### Cuts and joins without re-encoding

A cut of frames `[from, to)` packet-copies the whole closed GOPs between clean keyframes and
re-encodes only the frames from `from` to the next clean keyframe and from the last clean keyframe to
`to`. When a re-encoded piece's encoder headers differ from the copied piece's, the whole range is
re-encoded: a join that does not decode is never made. Parts on different time bases are re-labelled
before the join. `--span`, `--insert`, `--use-draft` and `--assemble` all cut this way. Frame counts
are read from packets, and only the changed span and the seams are hashed (framemd5), never the whole
film. `join.mjs` keeps the video stream by packet copy when the parts share codec, size and fps, and
says why when it re-encodes (a variable frame rate, a rate the grid cannot hold).

### Assembling a film from existing runs

```
render.mjs <dir> --assemble <edl.json> [--no-captions] [--plan]
```

`{"entries": [...]}` in film order; an entry is `{"segment": "<id>"}` (a cached segment of this
quality) or `{"src": "<clip.mp4>"}` (relative to the reel dir), optionally with `"from"`/`"to"`
(frames of that clip) and `"new": true` for frames that did not exist before (default for a clip under
`out/drafts/`). The entries must add up to the page's timeline, else the run stops and prints both
lengths. Use it when the timeline shifted: old segments are copied to their new place and new drafts
are put in, with no page frame rendered. The gate hashes only new frames, re-encoded frames and the
first and last two frames of every copied run. Afterwards the segment cache is rewritten at the new
places (the page is opened once, three frames per segment), so the next render, `--span` or `--only`
sees every segment current. Before a segment is recorded, its first, middle and last frame are
decoded from the copied clip and compared, in greyscale at a small size, with what the page draws
at that frame now. A segment whose frames differ (more than 3% of pixels) is reported on stderr
with the share of pixels and is left out of the cache, so the next render draws it again; a probe
hash alone cannot say the copied frames are the page's. The film itself is written. A missing clip, an fps mismatch, a range past the clip, an EDL that does
not tile, or a count or hash mismatch stops the run and publishes nothing. Not with `--only`,
`--insert`, `--use-draft`, `--handle`, `--span`, `--lang` or `--stub`.

### Splitting a film into short scenes from the start

Split even a film with no narration into short scenes from the start: give `shots` one entry per
scene, render each scene with `--only` and mark it done (a done marker per scene, `references/unattended.md`)
before the next. A first render can go part by part this way ("A first render can go part by part"
above). Then an error in a long render costs one scene, not the whole film.

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

### The picture, its bed and its timings are one set

`out/picture.mp4`, `out/picture.bed.wav` and `out/picture.timings.json` (the `picture-<code>` trio
for a language picture) must come from one render and share one length. Each render writes the trio
under one stamp, checks it, and only then points the plain names at it; a mismatch throws and nothing
is pointed. The timings file is written atomically (temporary name, then rename).

```
render.mjs <dir> --check-pair [--lang <code>]   # exits non-zero on a mismatch; dub.mjs runs the same check first
render.mjs <dir> --no-captions --fix-picture-duration
render.mjs <dir> --no-captions [--lang <code>] --bed-only
```

- `--check-pair` compares the stamps, the picture and bed durations, and the picture and timings
  durations (50 ms). An interrupted render can leave a mismatched set: render again before laying a
  dub over it.
- A picture render compares the picture's length (frames / fps, the page's clock) with the timings
  `duration`. More than 50 ms apart stops the render and says which value is right (the picture
  length). `--fix-picture-duration` writes the picture length into `out/picture.timings.json` and
  continues; it needs `--no-captions` and is refused with `--stub`. The captioned A/V gate names the
  page length as the right value in the same way.
- `--bed-only` (with `--no-captions`) rebuilds only the sound bed: the page opens once for `renderSfx`
  and the sound cues, no frame is captured, the picture file is linked under a fresh stamp, and its
  video stream md5 must equal the old one's (else the render stops). Use it when only sound changed.
  It stops when the picture's frame count is not the page's timeline, and refuses a voiced film
  (`dub.mjs` owns that mix).

### Strings drawn into the picture

Captions change per language by themselves. A string drawn into the picture does not: a brand on a
wall, a quoted post. Mark each one with `Reel.pictureText(key, fallback)` in `reel.html`:

```js
ctx.fillText(Reel.pictureText("brand", "Morning Brief"), x, y);
```

The fallback is the base language's text. A base render always draws the fallback. Put each
language's text in `dub/<code>/plan.json` under `meta.overlay.picture`:

```json
{ "meta": { "lang": "es", "overlay": { "picture": { "brand": "Resumen de la mañana" } } } }
```

Render that language's picture, then dub it:

```
render.mjs <dir> --no-captions --lang <code>   # out/picture-<code>.mp4 + .bed.wav + .timings.json
dub.mjs <dir> --lang <code>                    # uses out/picture-<code>.mp4 when it exists
```

The page gets `Reel.lang` (the code; the plan's own language in a base render) and the strings
before `ready`. A key missing from `meta.overlay.picture` draws its fallback and, when the language
supplied other strings, records `picture-string-missing` (a fact: the fallback may be intended).
`Reel.overlayText(overlay, key, fallback, {dub, base})` does the same for 2D layer labels
(`overlay-text-missing`), silent for the base language. `validate-plan.mjs <dir>/dub/<code>` lists the
keys that `reel.html` and `src/` read and the dub's `meta.overlay` lacks. Segments go to
`out/segments-<code>/`, so the base picture's cache is never touched. A segment whose three probe
hashes equal the base segment's is copied from it, so only shots that draw a changed string render.
The probe sees three frames: a string that shows only between them is not noticed, so name such a
shot with `--only <id>`.

Every render records, with each segment (`picture` in the segment's `.json`), every picture
string its page read up to the end of that segment — while loading, warming up, probing and
drawing earlier segments too, since a page may read a string once and keep it. A language render
copies a base segment without probing it when none of those reads is a key that language sets and
none read `Reel.lang`; the other segments are probed as usual.
This trusts the base picture's cache: after changing the page, render the base picture again
first, or pass `--probe-all` to probe every segment.

Each language, including the first one, lives in its own folder:

```
<reel-dir>/dub/<code>/
  plan.json     # same line ids as the base plan, text/say in <code>, meta.voice, meta.lang,
                #   and each line's own voice where that language needs one
  voice/        # voice.mjs <reel-dir>/dub/<code>  ->  line-<id>.wav + timings.json
```

`dub.mjs <reel-dir> --lang <code> --init-plan [--copy]` writes `dub/<code>/plan.json` from the base
plan: each line keeps its id, `pauseBeforeMs`, `pauseAfterMs`, `lead` and `rate`; `meta.lang` is
`<code>`; each line's `text` is empty (a plan line needs a non-empty `text`, so the empty ones are
the translation still to write), and `meta.pronounce`, the `meta.overlay` strings and the speaker
fields of `meta.voice` (`voiceId`, `refAudio`, `refText`, `refTokens`) are left empty or out. With
`--copy` the base text, `say`, notes, pronounce, overlay and voice are kept as they are (a dub in
the base language, or a copy to translate in place). It never overwrites an existing plan. After it:
translate each line's `text` and `say`, and set `meta.voice` for the language.

The picture's time is the reference. `dub.mjs` fits each line in four steps, in this order:

1. **Trim.** Each take is cut to its voiced span plus 0.05 s head and 0.3 s tail (an RMS scan at
   −50 dBFS; an internal pause is never touched) — a take's edge silence, not its speech, should
   never be what decides whether it fits its slot. The trimmed lead is not lost: the clip is
   placed that long (after the speed change) after the slot start, so the first sound lands where
   the voice's own `timings.json` puts it (at most the room the slot has left).
2. **Speed.** The trimmed audio is placed at its base line's slot (that base line's start to the
   next base line's start; the last line's slot runs to the film's end). A line longer than its
   slot is sped up (atempo, pitch kept) by at most 10% (`--max-speed`, default 1.1). Widening the
   flag is the user's call.
3. **Breath.** When the slot has room, at least 0.5 s of silence (`MIN_BREATH_SEC`) stays after
   the line; a line that would leave less is sped up within `--max-speed` to make it. A line
   that keeps less even then shows up in the gap report below ("Judging a dub line").
4. **Gap.** Whatever remains of the slot stays voice-free, up to 1.0 s (`MAX_BREATH_SEC`, the
   silence gate's limit). A line that leaves more is slowed (atempo, pitch kept) down to 0.95x to
   close the rest. A pause the plan declared (`pauseAfterMs`, `pauseBeforeMs`) or the picture
   itself has over 1 s is planned silence: the line is not slowed to shrink it, so a base-language
   dub keeps the base voice's timing, and the gap report does not list it as sparse.
   `validate-plan.mjs` lists a planned pause longer than this rule as a fact once the voice exists. What gap is left is judged per scene ("Judging a dub line"). The last line's tail is not
   limited. The picture is never stretched and audio is never cut.

A line that still does not fit within 10% fails the run, naming the line and the factor it needs
(for example `needs 1.120x, max is 1.1x`), so the script is reworded and re-made for that
language rather than sped further. After placing, the silence gate lists every pause over 1 s in
the placed narration with the line ids around it; the picture's own pause (a base line's end to
the next line's start, when over 1 s) and a line's `pauseAfterMs` are listed as planned.
The base language is dubbed the same way: `dub/<base-lang>/` may simply copy the base `plan.json`
and `voice/`.

**Fit a track to an existing video.** `scripts/fit-track.mjs --timings <picture.timings.json>
--voice <voice-dir> --out <track.wav> [--video <picture.mp4>] [--plan <plan.json>] [--max-speed <x>]`
runs the same four steps for a language's voice lines against a video's timing reference and
writes one mono 48 kHz track of exactly the video's length (the length of `--video` when given,
else the timings' `duration`). It prints the same fill and gap warnings and the silence gate, and
writes no track when a line needs more than `--max-speed`. With `--draft` it writes the track anyway:
a line that needs more than `--max-speed` is placed at `--max-speed`, runs past its slot, and is
listed as `DRAFT: <id> needs <x>x`. A draft is for listening to; reword the listed lines before the
final. A failure with no factor (a missing clip or line) still stops.

The mix is stereo and runs the picture's full length. The bed (`picture.bed.wav`) keeps its own
channels, so each cue's pan survives; the voice sits centred at full level in both channels. Both
are padded to the picture, so the bed after the last line (the ending's sounds, the music fade)
stays in. Before the caption overlay, `dub.mjs` re-stamps `picture.mp4` onto the 1/fps grid
(lossless, as render.mjs does), so a picture from an older render does not gain a frame.

`dub.mjs` first writes `dub/<code>/timings.placed.json` (the fitted lines above, on the base
clock, same shape as `voice/timings.json`). It then tries the reel's own caption layer before
falling back to the engine's default `Reel.caption()` look (white text on a dark translucent band, so it reads on any picture; an explicit `color` option draws no band): it opens `reel.html` with
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

Without a `|` the engine breaks by an automatic fallback (one rule set, `Reel.captionGlue`, used by
`Reel.caption()`, `captionRows` and `captionChunks`; pass `lang`, a BCP 47 code, or it guesses from
the script): a line that fits one row is not cut at a comma; a number stays with its unit (`10 kg`,
`3 개`, `30分`); a short article or preposition never ends a row (en, fr, es, pt, it, de lists);
a Korean dependent noun or particle token (`수`, `것`, `밖에`, `은`) stays with the word before it;
a Korean determiner or numeral (`몇`, `한`, `그`, `열두`) never ends a row, and a counter after one
(`열두 개`) keeps the noun that follows (the lists are per-language data in `reel-engine.js`);
nothing breaks inside a short parenthesis or quote span; Japanese and Chinese wrap by character
but keep a number+unit, a Latin word and closing/opening marks whole. A `|` always wins.

A film that draws an outline around its caption can say so, if it wants:
`Reel.captionRows(ctx, text, maxW, {lang, stroke: 3})` fits the rows so the outline stays inside
`maxW`, and `Reel.checkSafe(..., {outline: 3})` counts the outline's half-width when it tests the
safe area. Both are optional; without them nothing changes.

Caption breaks differ per language, so it helps to check a translation for them, e.g. once after the
language's lines are written and before the final render: run `validate-plan.mjs <reel-dir>
--breaks --dub <code>` and read the whole table, looking at where each caption breaks (when every line
is one piece it prints "checked nothing"). A break inside a phrase (a word cut from its particle, auxiliary or
bound noun; an article from its noun; `can / not`; a Vietnamese two-syllable word) is fixed by
putting a standalone `|` in that line of `dub/<code>/plan.json` — a Korean line `이렇게 할 | 수
밖에 없다` becomes `이렇게 | 할 수 밖에 없다`, an English one `We can | not` becomes `We cannot |
do it`. The break is never spoken or shown.

Overlay text other than captions (stickers, a price card, the end card) is per language too.
Put it in the dub plan's `meta.overlay`, a free-form object the page reads in layer mode
(`Reel.dubCode()` names the language), with the base language's strings in the page as the
fallback. A translated string runs a different length, so re-check every overlay against the
safe area in every language (`review.mjs --scan --layer captions --dub <code>`, below) and
shorten what runs out.

Write each dub line so the word that drives a picture beat falls near the base language's time
for that beat. The picture was built to the base timings and does not move: a keyword that
arrives a second late lands after its picture.

**Two clocks in a dub.** Captions follow that language's voice (`dub/<code>/timings.placed.json`).
Every other layer — sound cues, on-screen labels and stickers, beats, animations keyed to a word —
reads the base language's clock (`voice/timings.json`), unchanged from the original film, so it
lands where it did there. In the caption layer (`?layer=captions&dub=<code>`) the scaffold loads
both: `tl` and `timings` are the dub's clock, `clk = Reel.clocks(timings, baseTimings)` adds the
base one. Captions read `tl`; a label or word-keyed animation drawn in that layer reads
`clk.base.line(i)`, `clk.word(lineId, "<base-language word>")` ({start, end} on the base clock) or
`clk.cueTime(cue, lineId)`, never `tl`. Line ids are the same in both clocks. In a render with no
dub there is one clock and `clk.base` equals `tl`. The picture render itself (`--no-captions`)
always runs on the base clock. A string that must change per language is a picture string
(`Reel.pictureText`), not a caption.

### Shared language-neutral spans

The picture is cut into language spans and language-neutral spans. A language span is each placed
caption line's `[start, end]` (the last line holds to the film's end, as the caption layer does), plus
every `{start, end}` the page lists in `window.__reel.langSpans`; neutral gaps under 1 s fold into the
language span. A neutral span is encoded once into `out/shared-spans/<key>-<a>-<b>.mp4` and reused by
every later language (the key covers the picture's path, size and modified time, the fps and the
encoder arguments); only the language spans are captured and encoded per language, and everything is
joined by stream copy with the frame count gated. A film with no neutral span of 1 s or more encodes
whole.

Each neutral span is probed for pixels the caption layer drew (every frame in a span under 10 s, else
every 0.25 s); a span that has some becomes a language span and is reported. The run prints how many
frames were probed. Where the page draws a label that is not a caption, list it in `langSpans` so it
never depends on the probe; the run prints one advice line when a probe promoted a span and the page
declares none. A page's own caption window must stay inside the line's `[start, end]` (a caption that
fades in before the line or holds after it draws outside the language span), or be listed as
`{start, end, in: "layer"}` spans; when a promoted span touches a caption line the advice line names
that caption fade or hold as the likely cause.

`langSpans` entries are `{start, end, in: "layer" | "scene"}` (default `"layer"`). Text drawn inside
the scene (a sign or screen in a 3D world) cannot come from the caption layer: list it as
`in: "scene"`. For a language other than the base one, `dub.mjs` then needs that language's own
picture (`render.mjs <dir> --no-captions --lang <code>`, and `--span` for only those seconds); with
the base picture it stops, because the base language's text would stay in the picture. The check
compares language and script (`zh-Hans` against `zh-Hant` stops; a region-only difference does not;
`zh` against `zh-Hant`, or an unreadable base language, is not stopped and the note says so).

### Judging a dub line: the silence after it

Judge each dub line by the silence after it, and judge that silence against the line's own scene,
whatever the language — not against the base language's gap. Not so full that the line runs
straight into the next one, not so empty that the scene sits in silence: anywhere inside the
scene's allowed range is fine.

The range, per slot (`scripts/lib/dub-fill.mjs`): at least 0.4 s (about the 0.5 s breath the
fitter keeps when it has room), at most a quarter of the slot, and never less than 1.0 s as the
top of the range. A quarter is where a viewer notices the voice has stopped; the 1.0 s floor keeps
a short scene from flagging an ordinary pause. The range is global: the plan has no per-scene
timing field to override it, and the base line's own gap is shown for reference only.

`dub.mjs` prints a `WARN` list for a line under the range (crammed — the message suggests
`--min-gap`), over it (sparse), and for a line that needed atempo or runs past its slot.
`dub.mjs --table` prints every line's fill (clip length after atempo / slot length), `gapAfter`
(the silence between the placed line and the next line's start), the allowed range and the state.
It still writes the film either way. The last line has no gap and no gap warning: its slot runs on
under the end card to the film's end.

On a warning, first try the free local fixes: a pause edit or a tempo change within the limits
(`guides/audio-editing.md`). A flag alone, with no measured failure, never triggers a paid
re-synthesis. When local editing cannot fix a measured failure, rewrite that line's wording (shorter
for a tight gap, longer for a scene left in silence) and re-make only that line
(`voice.mjs <dir>/dub/<code> --lines <id>`), up to 3 rounds, without asking the user. The same wording can come out at quite different lengths on a hosted voice;
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
falls back to `voice/timings.json`. The scan runs to the language's own length, the `duration` in
`dub/<code>/timings.placed.json`, so the tail that `--min-gap` added is scanned too.

### More dub reports and operations

All reports below print facts and never stop the run; a stop is only for a definite wrong.

- **Bed duck.** Library cue sounds dip under narration by -2.5 dB by default, with 0.8 s ramps and
  gaps under 1.5 s merged into one dip (`scripts/lib/duck.mjs`, shared by `render.mjs` and `dub.mjs`;
  `meta.sound.sfxDuckDb` overrides it, `0` turns it off). The page's own music bed keeps its deeper
  duck (assumed -10 dB, 0.12 s ramps). `dub.mjs` prints the summed swing of the two ducks where they
  overlap, so a stacked dip is visible; it is a report.
- **Silence and short translations.** `dub.mjs` and `fit-track.mjs` pass `meta.gapMs` and each
  line's `pauseAfterMs` to the silence gate, so planned pauses are listed as planned. After an
  unplanned gap or a sparse line, `dub.mjs` prints how to judge a short translation (see "Judging a
  dub line").
- **Waveform cut check.** The placed narration is checked at each line's start and end: a span's first
  or last 5 ms still within 20 dB of the span's loudest 10 ms is listed as an abrupt cut. `dub.mjs`
  and `fit-track.mjs` print it.
- **Caption contrast.** For up to three frames per line, the caption layer's drawn colour is compared
  with the picture behind the text as a WCAG contrast ratio, in both directions (light text on a
  bright picture, dark text on a dark one); a note panel is composited over the picture first. Under
  3:1 is `LOW`, under 4.5:1 `marginal`, per line id, time and region. The rows go to
  `dub/<code>/contrast.json`. `--no-contrast` skips it. A voice-first render (`render.mjs` with
  captions on) measures the same way for the frames it draws, by drawing each sampled instant once
  more with captions off (`Reel.setCaptionsOn(false)`) and taking the pixels that differ as the
  caption; rows go to `out/contrast.json`. Segments reused from the cache are not drawn again.
- **Audio only.** `dub.mjs <dir> --lang <code> --audio-only [--audio-format m4a|wav]` writes only that
  language's track (`out/audio-<code>-<stamp>.m4a`, AAC 192k, or 48 kHz PCM wav, plus
  `out/audio-<code>.<ext>` pointing at the newest): the same trim, fit, place and mix, no caption
  capture, no video. Its length is checked against the picture timings' `duration`; when the picture
  file exists, the picture, bed and timings pair check runs too. Use it to add a language to a video
  that is already uploaded. `--replace-audio` cannot (it needs the frozen caption text to equal the
  dub's); `--audio-only` does not combine with `--min-gap`.
- **Time insert.** `dub.mjs <dir> --insert-time <sec> --seconds <n>` (a title-card hold, say) shifts
  every `dub/<code>/timings.placed.json` and every `.srt` under `out/` and `dub/<code>/` by `<n>`
  after `<sec>`, all computed before any write. A line or cue that straddles `<sec>` stops the run
  with nothing written. It prints each language's old and new length and whether all languages are
  the same length. It touches no picture, bed or audio: re-render the picture with the hold, then dub
  each language again. Use it before upload only; a track already attached to a published video would
  stop matching.
- **Fresh outputs.** Every dub output is written under a unique hidden temporary name
  (the name plus a timestamp and the pid), checked (exists, non-empty, modified in this run, length within
  tolerance; else deleted and the step throws), then renamed to its stamped name. An existing name
  gets a `-2` suffix instead of being overwritten.
- **Termination.** SIGTERM and SIGINT stop `dub.mjs`: child processes end, this run's temporary files
  are removed, and the exit code is 143 or 130.
- **Splicing audio.** `scripts/audio-edit.mjs in.wav --splice take.wav --at <sec> --out new.wav`
  replaces a span of a track with a mono take of exactly the span's length; the output length equals the
  input's, samples outside the span are untouched, and each edge has a 20 ms equal-power crossfade.

## Checks and reports

Each script below reports facts and exits 0 unless its line says otherwise. A check that looked at
nothing prints `checked nothing` and the reason; that is never a pass.

### Looking at frames: `still.mjs`

```
still.mjs <dir> --at <t|shotId>[,...] [--out <png> | --out-dir <dir>] [--no-captions] [--no-warm]
still.mjs <dir> --at <t> --dub <code>
```

`still.mjs` warms only the shots the `--at` times fall in (`--no-warm` skips even that). `--out-dir`
writes the files elsewhere. A GL error in the page (`GL_INVALID_*`, lost context) means the frames
are wrong: the files are still written, the error is printed and the exit code is 1; other GL
warnings do not change it.

`--dub <code>` previews that language's caption layer (`?layer=captions&dub=<code>`: captions, labels
and corner notes from `dub/<code>/plan.json`) over the picture at that second (`out/picture-<code>.mp4`,
else `out/picture.mp4`, else flat grey) and writes `still-<at>-dub-<code>.png`. Before the language is
dubbed, the base clock serves that plan's text with proportional word times, and the output says so;
nothing is written into the reel. Not with `--no-captions` or `--stub`.

### Determinism: `verify.mjs`

`verify.mjs <dir> [--range <t0>-<t1> | --only <shotIds> | --world <key>] [--no-cue-check]` runs the
static scan, the warm determinism probe and the cold probe. `--no-cue-check` turns off the warning
that `assets/lib/cues.json` is out of date (`assets.mjs fetch` has not run since the cues changed),
for a session that cannot run `assets.mjs`. `--only a,b` warms and probes exactly those shots (an
unknown id fails and lists the page's ids); `--range` and `--world` narrow it by time or by world
(`window.__reel.segments`); give at most one. The scan covers `reel.html` and every script under
`src/`, skips bundled libraries (`src/vendor/`, `src/lib/three*`, `*.min.js`, `node_modules`) and lists
what it skipped; with nothing to scan it prints `checked nothing`. A definite WebGL error fails the
step with a DIAGNOSIS line (warnings print only). It also prints `Reel.safeAreaNote()` when there is
one (for example "checked nothing" under `setSafeArea("none")`) and the engine's facts
(`note-*`, `picture-string-missing`, `overlay-text-missing`) as `note:` and `fact:` lines.

### Text, glyphs, flicker, regions: `state-checks.mjs`

`state-checks.mjs <dir> [--only overlap,glyphs,flicker,covers,langglyphs] [--range <t0>-<t1>] [--step <frames>] [--outline-em <n>]`

- `--range <t0>-<t1>` reads the frame checks (overlap, glyphs, flicker) only between those seconds;
  progress goes to stderr about every 10 s.
- `covers` checks only the regions the page declares (`regions` above); a label or overlay over key
  content is a judgement for the reviewer.
- `reserve` lists picture text drawn inside a `reserve` region while it is active, with the times
  (the region's own `text` excepted); it says nothing when the page declares no reserve, unless
  `--only` names it (`Corner reserve`).
- `langglyphs` checks every character of every language's captions (`plan.json` and each
  `dub/<code>/plan.json`) against the font that language uses (`captionFonts`, else
  `style.fonts`), in the page. A missing glyph is definitely wrong for that language: it is listed with
  code points and line ids, and this is the one check that exits 1. `--outline-em <n>` compares glyph
  shapes after growing them by half the outline width (n times the font size). When the font did not
  load or cannot be told from a generic family, it prints `not checked: font not loaded`.
- The overlap, glyph and flicker checks see only text drawn while the page seeks: each `fillText` /
  `strokeText` call during `seek(t)` on a canvas attached to the document is recorded with its box.
  Text drawn once at load into an offscreen canvas and copied each frame is not seen, and the report says `checked nothing` for
  those checks (the glyph line names this cause). To expose it, call `fillText` during `seek()`
  (draw the label into the canvas the frame is made on), or report the layers through the
  `visibleAt` hook for the flicker check, and `regions` for `covers`. `langglyphs` reads the plan's
  text, not the drawn text, so it is not affected. Check text that stays hidden from the checks by eye
  on a still.
- Flicker is read in the source first (show/hide windows under 2 frames, one-frame gaps, two clocks),
  with file:line; `--source-only` and `--no-source` choose.
- Writes `out/state-checks.json`.

### Punctuation and script table: `punct-check.mjs`

`punct-check.mjs <dir> [--lang <code>,...]` reads the caption text of `plan.json` and of each
`dub/<code>/plan.json` (the languages come from the film, not from this table) and checks each line
against its language's row. Findings print as `<lang> <line id>: <rule> [wrong|check]`; `wrong` exits
1 for that step, `check` is for the language's editor session to judge (see `SKILL.md` on languages you
cannot read). It writes `out/punct-check.json`. A language with no row prints `checked nothing`; add a
row to `scripts/lib/punct-rules.mjs` and to this table.

| Code | Letters expected | Wrong (exit 1) | Check (reported) | Quotes written |
|---|---|---|---|---|
| en | Latin | full-width marks, `¿ ¡` | space before `, .`, straight and curly quotes mixed | curly or straight, not mixed |
| de | Latin | full-width marks, `¿ ¡` | space before `, .`, straight quote | „…“ |
| es | Latin | full-width marks, a `?` or `!` without its `¿` or `¡` | space before `, .`, straight quote | «…» or “…” |
| fr | Latin | full-width marks, `¿ ¡` | no space before `? ! ; :`, straight quote | «…» |
| it | Latin | full-width marks, `¿ ¡` | space before `, .`, straight quote | «…» or “…” |
| pt | Latin | full-width marks, `¿ ¡` | space before `, .`, straight quote | “…” or «…» |
| ru | Cyrillic, Latin | full-width marks, `¿ ¡` | space before `, .`, straight quote | «…» |
| ko | Hangul, Latin | full-width marks, `¿ ¡` | space before `, .`; Han, Kana or Cyrillic letters | “…” or '…' |
| ja | Hiragana, Katakana, Han, Latin | half-width `, . ! ? : ;` straight after a CJK character, `¿ ¡` | space between CJK characters; Hangul or Cyrillic letters; straight quote | 「…」 |
| zh | Han, Latin | half-width `, . ! ? : ;` straight after a CJK character, `¿ ¡` | space between CJK characters; Kana, Hangul or Cyrillic letters; straight quote | “…” or 「…」 |

Every row also reports two or more spaces in a row, and letters of a script the row does not list. The
table is a starting point: a rule that does not fit a film (a brand spelled in another script, a
quoted name) is the editor's call, and a language or rule the table lacks may be added. `zh` covers
both `zh-Hans` and `zh-Hant`; the script of a Han text is not told apart by this check.

### Reviewing: `review.mjs`

`review.mjs <dir>` builds the contact sheet and reports dead air, A/V sync, loudness and layout
facts. Intended slow spans declared in `holds` are listed as intended holds; `review.mjs --file
<mp4> --holds a-b,c-d` takes them by hand, and its freeze test reads 320-px frames. Facts from the
engine (`note-*`, `picture-string-missing`, `overlay-text-missing`, the safe-area note) are listed
under `facts` apart from the layout hits and never change a verdict. A check with nothing to look at
(no audio stream, no shots, too few samples) prints `checked nothing` instead of 0.

`review.mjs <dir> --copy [--lang a,b] [--out <dir>]` makes a review copy for a human reviewer: for
each language layer (the base language, and each `dub/<code>/` that has `out/final-<code>.mp4`) the
existing encode is stream-copied, with its picture, voice and bed, into
`out/review-copy-<code>.mp4`, and one subtitle track is muxed whose cues read `<line id> <text>`
(the text from that language's plan, `|` marks removed). Nothing is rendered or re-encoded. A layer
with no encode or no timings is skipped with the reason; exit 1 only when no copy could be built.
In the voice stage, before any picture exists, the base layer is built from `voice/narration.wav` under a
black 640x360 picture whose length is the narration's length (not cut at the last cue), with the same
`<line id> <text>` subtitle track, so the owner can listen and name a line.

### Subtitles: `srt.mjs`

```
srt.mjs build <dir> [--base | --dub <code>] [--line-chars <n>] [--max-lines <n>] [--out-dir <dir>]
srt.mjs align <media> --script <file> --lang <code> [--out <file.srt>] [--timings-out <json>]
srt.mjs compare <a.srt> <b.srt> [...] [--tolerance <ms>]
```

- `build` writes one SRT per language to `out/srt/<code>.srt` from `voice/timings.json` and every
  `dub/<code>/timings.placed.json`. Cues break where the on-screen caption breaks (a `|` or a newline
  wins, a number stays with its unit, no row ends on an article, nothing breaks inside a parenthesis or
  quote). At most `--max-lines` rows per cue (default 2); `--line-chars` sets the row length (default
  by language: Japanese and Chinese 16, Korean 22, others 42). With two or more languages it reports
  cue count and time equality per line and writes `srt-report.json`. Findings: too many rows, row too
  long, glued break, overlap, no duration, proportional times.
- Which SRT goes with which file: the base track is named by the base plan's `meta.lang` (for example
  `ko-KR.srt`) and carries `voice/timings.json`'s times, so it matches the film made from the base voice.
  A dub track is named by its folder (`<code>.srt`, from `dub/<code>/timings.placed.json`) and matches
  `out/final-<code>.mp4`. When the base language is also dubbed (`dub/<code>/` in the base language),
  both files exist and their times can differ by the dub fit's speed changes: `<code>.srt` goes with
  `out/final-<code>.mp4`, the `meta.lang`-named one with the base-voice film. `--base` writes only the
  base track and `--dub <code>` only that dub.
- `align` makes an SRT for a video that already exists: speech-to-text times the words, the text is your
  script (`plan.json` / `timings.json` `lines[].text`, or plain text one line per row). A script line
  with under half its words found gets no cue and is listed as `low match`. It uses the same engine as
  `voice.mjs` (`SVA_STT_ENGINE`, `SVA_STT_MODEL`; `references/voice.md`). `--timings-out <json>`
  also writes the aligned lines as a `timings.json`-shaped file (`duration`, `lang`, `lines`).
- `compare` reports cue count and time equality across SRT files; the first file is the reference.
- Exit is non-zero only when an input cannot be read or the speech-to-text step cannot run.

### A cover or thumbnail per language

When the user asks for a cover or thumbnail per language, make one still per language from the
film's own frames: `still.mjs <dir> --at <t|shotId> --dub <code> --out-dir <dir>` draws that
language's title, labels and corner notes over the picture. Choose one frame that reads at thumbnail
size and use it for every language, so the set matches; give each language its own title text and
check that its script fits the frame (`state-checks.mjs --only langglyphs`). Record the frame and
each title in `FILM.md`.

### Setup: `setup.mjs`

`setup.mjs [--check] [--dir <reel>] [--stt-models]`. Both modes report the Playwright browser cache
folder (`PLAYWRIGHT_BROWSERS_PATH` or the OS default), its free disk, and the free disk where renders
write: under 0.8 GB at the cache blocks the Chromium install, under 5 GB where renders write warns.
`--dir <reel>` measures `<reel>/out`; without it the current folder is measured and the output says
so. `SVA_MIN_CACHE_GB` and `SVA_MIN_WORK_GB` (GB) change the two limits; a bad value stops setup and
names the variable. It also reports whether rendering uses a real GPU or a software renderer
(SwiftShader), from a WebGL probe in the render browser: `SVA_GPU=default|gpu|swiftshader` picks the
mode and `SVA_CHROME_ARGS` adds raw Chromium flags (a value starting with `[` is a JSON array of
strings). `--check` installs nothing. `--stt-models` downloads the speech-to-text models into the
local cache with the Python in `SVA_STT_PYTHON` and is the only step that fetches them (several
hundred MB to a few GB); it is ignored with `--check`. Both modes list the speech-to-text engines and
which models are present, and report an API key as set or not set, never printing it.

## Asset library

Recorded sound effects and reaction clips ("짤") live outside the skill, in one folder per user:
`SVA_ASSET_LIB` when it is set, else `~/.super-video-agent/library` (the same folder under the
home folder on every OS). Nothing in it ships with the skill, because most such files carry
third-party rights, and it is kept outside the skill folder so an update never touches it.
Without a library, everything works with synthesized effects only (`sound.md`), and
`assets.mjs search`/`fetch`/`model` say where they looked and that
`SVA_ASSET_LIB=<folder with catalog.json>` points them at another folder. The folder is never
created for you.

A library is a folder with `catalog.json` and the files it describes:

```
{ version: 1, assets: [
  { id, role: "sfx" | "reaction", kind: "audio" | "video", path,   // relative to the library folder
    description, tags: [...], durationSec, width?, height?, hasAudio,
    license: { kind, commercialSafe } }
] }
```

A line picks clips in `plan.json` via `cues`: `[{asset, at, offsetMs?, gainDb?, maxSec?, play?, fadeInSec?, fadeOutSec?, endsAtCut?, track?, crossfadeSec?}]`
(the fade fields: `references/sound.md` "Fades").
`at` is `"start"`, `"end"`, or `"word:<text>"` (the first word of the line's caption containing
`<text>`). `play` is `"sound"`, `"picture"`, or `"both"` — default `"sound"` for role `sfx`,
`"both"` for role `reaction`.

Two commands (`scripts/assets.mjs`):

```
assets.mjs search <query> [--role sfx|reaction|character|prop|set|character-ref] [--limit N]   # keyword search over description+tags: every-word matches first, then partial ones
assets.mjs model <id> <reel-dir> [--allow-personal-scope]      # copies a model/image into the reel (see below)
assets.mjs fetch <reel-dir> [--allow-personal-scope]           # copies every cued asset into
                                                                 # <reel-dir>/assets/lib/
```

`fetch` copies audio as-is and turns video into JPEG frames at the plan's fps (plus a wav of its
own audio, if any), and writes `assets/lib/manifest.json` and `assets/lib/cues.json`. It refuses
an asset whose `license.commercialSafe` is `false` unless `plan.meta.distribution` is `"personal"`
or `--allow-personal-scope` is passed — either way it prints every fetched asset's license.
`verify.mjs` warns (does not fail) when `plan.json`'s cues have drifted from `assets/lib/cues.json`.

The same library also holds 3D models for the cast stage: roles `character`, `prop` and `set`
(kind `model`, or `code` for a model a script builds), and `character-ref` (kind `image`, an
avatar or reference picture). A model entry adds `format`, `rigged`, `clips: [{name, sec}]`,
`triangles`, `heightM`, `origin` (film and original path) and an optional `preview` PNG; its
`license` is read the same way as a clip's. Search them with `assets.mjs search --role character <words>`,
which prints rigged, clip names and the licence, and copy one into a reel with
`assets.mjs model <id> <reel-dir>`: models and code land in `assets/models/<id>/`, images in
`assets/refs/<id>/`, a glTF with its `.bin` and textures. Each asset gets its own `<id>` folder,
so two glTF exports that share file names do not overwrite each other. `model` applies the `commercialSafe` rule
exactly as `fetch` does. A model id in a line's `cues` is refused; cues take clips only.

To add your own clip or effect: put the file in the library folder and add one entry to
`catalog.json` with a new `id`, its `role`, `kind` and `path`, a `description` and `tags` a
search will hit, its measured `durationSec` (and `width`/`height`, `hasAudio` for video), and
`license: {kind: "user", commercialSafe: true}` for material you made yourself.

`search` matches words as written, so a Korean-only label is not found by an English query. Give
each entry English tags as well as its own language's (e.g. `["문", "삐걱", "door", "creak",
"wood"]`). A search shows the entries matching every word first, then those matching some of
them, marked `(k/n words)`.

### Drawing and mixing cues

| Helper | Use |
|---|---|
| `Reel.cueTime(cue, line, timings)` | the cue's time in seconds; the page and `render.mjs` share it |
| `Reel.registerClip(id, frames, fps)` / `Reel.clipFrame(id, tLocal)` | the clip frame at `tLocal` seconds into the clip. Past the end it keeps returning the last frame, so stop drawing at `cueTime + durationSec` yourself |
| `__reel.soundCues()` | the page tells `render.mjs` which cue sounds to mix; the scaffold provides it |

- The scaffold's `drawLibCues` cover-fits a clip to the whole frame. A landscape clip on a 9:16
  frame then keeps only its middle third. For faces, draw the clip yourself into a box inside the
  safe area.
- Draw clip frames and still images into the 2D canvas from an `ImageBitmap` (`createImageBitmap`), not
  an `<img>` element. A small draw of an `<img>` can differ by a few levels depending on which seeks
  drew before it (the browser re-decodes at a smaller scale); an `ImageBitmap` does not.
- `render.mjs` places cue sounds on their cue time itself. Do not add library cues to `marks`: a
  cue on a spoken word measures the narration's onset, not the effect's.
- A sound-only file's head silence (up to 0.3 s) is skipped, so the effect is heard on the cue.
  A clip keeps its own lead so its sound stays on its picture.
- Every cue dips by `meta.sound.sfxDuckDb` (default -2.5dB, 0.8 s ramps) while a narration line
  speaks; gaps under 1.5 s stay ducked, longer gaps return to full level (`scripts/lib/duck.mjs`,
shared with `dub.mjs`); the music bed
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

## Reusable cast voices

For recurring speakers, consider a shared `meta.cast` file and per-line `speaker` IDs.
See `cast-voices.md` for language mappings read by synthesis and preserved by dub scaffolding.

### Copied dub narration

Before caption placement, dub checks its voice timing text against its plan and
current base `voice/timings.json`. Same-language copies also report base text
changes. Translated lines are compared with their own plan, using each line's
language override. Warnings do not stop output or rewrite files. Refresh copied
timings and matching audio before shipping. A missing base timing file is reported.

### Retain base picture text deliberately

Use `dub.mjs <reel-dir> --lang <code> --keep-base-picture-text` only when the
base-language text inside the picture should stay visible. This explicitly picks
the base picture, bed and timing pair, even when a language picture exists.
Translated captions still come from the dub. The command reports the retained
picture text. Without the flag, cross-language `in:"scene"` spans still require a
language picture. Pair checks remain mandatory.

## Keeping assembled copies for a later span edit

When an assembled clip intentionally differs from the current page, consider
`render.mjs <reel-dir> --assemble <edl.json> --keep-assembled-copies`.
It reports the copied probe differences and keeps the frame ranges in the segment
cache. A later `--span` can draw changed seconds and copy the rest. Without this
option, a mismatched segment stays outside the cache and needs a render first.

Retained metadata records that the copy differs from the page. It is not proof of
page equivalence. Normal probed renders redraw it. A partial span keeps this
provenance while any old frames remain. A whole-segment replacement clears it.
Keep the same timeline, frame rate, size and render quality for the later span.
