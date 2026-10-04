# QA — what the tools measure and what they cannot see

## Gates

| Gate | Tool | Pass |
|---|---|---|
| Contract | `verify.mjs` static scan | no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, timers, `fetch` in scene code |
| Determinism | `verify.mjs` probe | shuffled-seek PNG hashes equal in-order hashes at ≥ 12 times (shot edges, boil bucket edges); a cold probe — a fresh page seeking each time with no warm-up — matches the warm hash too. On a mismatch it names the earlier seek time that changes the frame and the bounding box of the pixel difference |
| Dead air | `review.mjs` | seek(t) every 0.1 s through the timeline, hash the native-resolution canvas; no run of identical hashes ≥ 0.8 s before the last line ends. The end hold after it (`meta.tailSec`) is reported as `endHoldSec`, not flagged |
| Boil call sites | `verify.mjs` | not a gate — counts `boil(` call sites in the scene code and how many pass a `moving` option, printed as one info line |
| A/V | `review.mjs` | video vs narration duration ≤ 50 ms; last line ends before the final frame |
| Layout | `review.mjs` via `__reel.issues()` | empty: no text overflow, nothing outside the safe area |
| Loudness | `review.mjs` (ebur128) | integrated -16 LUFS ± 1; true peak ≤ -1 dBTP |
| Sync marks | `review.mjs` | each `sync:true` mark's audio onset is within -20..+40 ms of its frame |
| Silence | `review.mjs` | every silence over 1 s inside the narration (first sound to last line end) is listed with the line ids around it; FAIL unless the plan asks for it (`pauseAfterMs`, or a long `meta.gapMs`) — a planned pause is listed, not failed. Same measurement as the voice stage's silence gate (`voice.mjs`, `dub.mjs`, `fit-track.mjs`), which runs before the voice is locked |
| Caption breaks | `validate-plan.mjs --breaks [--dub <code>]` | not a gate — the table lists every break; the reviewer finds none that cuts a phrase (`script-review.md` "Caption breaks"; a dub reads it once per language) |

A failing gate prints a DIAGNOSIS line naming the time or element. Fix the cause, not the threshold.

A frame that changes with the seek history usually carries state from an earlier frame: a
texture built lazily on the first seek, or a blur or glow drawn with soft transparent edges over
whatever the canvas held before. Draw blur and glow over an opaque copy of the frame first.

A finished or joined file has no page to seek. `review.mjs --file <mp4> [--parts t1,t2,...]`
reviews it directly: audio and video stream lengths, integrated loudness of the whole file and of
each part, dead air and black frames (`references/bookends.md`).

## Reading the contact sheet

`out/sheet.png` shows each shot at its `readAt` with a timestamp. Read the tiles in order:
1. Does any composition appear on two neighbouring tiles with only the caption changed? That
   reads as "the same video repeating" — give one of those lines a new picture.
2. Is the main visual big enough to be the subject, or small in a blank field? A frame caught
   while something is still arriving counts as filled, whatever the entrance is — judge the
   state it builds toward.

Settle texture or small-text questions on a full-size `still.mjs` PNG, not the reduced sheet. To
compare stills you already made (before and after a fix, one frame in each language), tile them
into one image with `still.mjs --sheet <out.png> <a.png> <b.png> ...` (tiles 540 px wide by
default, enough to read captions on a 16:9 frame; `--cell <px>` and `--cols N` change it). To
compare a still with `out/picture.mp4`, render it with `still.mjs --no-captions`: the page loads
with `?captions=0` as in `render.mjs --no-captions`, and the file is `still-<at>-nocap.png`.

## What the tools cannot see

- **Motion feel**: whether a move is too fast, floaty, or nauseating. The dead-air number only
  says *something* moves. Boil is checked in the scene source (the `boil:` info line from
  `verify.mjs`), not in frames — whether the tremble reads as hand-made or as jitter is a taste
  call, not something a script can see. Report motion feel as unverified.
- **Audio quality and pronunciation**: numbers confirm length and sync, not whether a name is
  said right. Flag names and English terms for the user to listen to.
- **Layout between checked frames**: the Layout gate reads `__reel.issues()` at one frame per
  shot (its `readAt`). Text that overflows or leaves the safe area only mid-shot, during a move
  or a count-up, is not seen (a label sliding in from off-screen is a real example this missed).
  Run `review.mjs <dir> --scan [stepSec]` (default 0.1 s) instead: it seeks the whole film at that
  step and reports issue runs with their times. An animated overlay (a pop, a rise, a slide) can
  leave the safe area for only a few frames, so scan at one frame's step when overlays move. On a
  slow 3D picture add `--layer captions [--dub <code>]`: only the overlay layer is drawn, once
  per language (`references/pipeline.md` "Judging a dub line").
- **Taste**: a passing sheet is not an approved film. Say "technically verified" and list what a
  human should watch for.

## Check tools that report facts (a model judges)

None of these fails a reel; each prints what it measured and exits 0. Boil, motion, flicker and blink
are judged from the source and the page state, never from frames: a screenshot shows one frame, and
these defects live between frames. **Source review first, state scan second**: the source review
points at the line that causes it, the state scan confirms it in the rendered timeline.

- **Word times** — `scripts/word-times.mjs <dir> [--threshold <ms>] [--window <ms>] [--lines <ids>]`.
  Re-measures each word's start from `voice/narration.wav` (the steepest 10 ms loudness rise within
  `--window` of the recorded start, never past halfway to the next word) and lists words whose sound
  starts more than `--threshold` (default 120 ms) from `timings.json`, and words with no clear onset.
  A line with `wordsMeasured` below its word count is tagged: its other words are interpolated.
  Writes `out/word-times.json`. A word run into the next in continuous speech has no sharp onset;
  hear it before moving a beat.
- **Sound cue words** — `scripts/cue-check.mjs <dir> [--threshold <ms>]`. For each `word:<text>` cue:
  `cue-word-missing` (no word of the line holds it: the cue lands on the line start),
  `cue-word-not-heard` (the speech-to-text transcript lacks it), `cue-word-uncertain` (interpolated
  word times, or no clear onset), `cue-word-moved` (the waveform puts the word elsewhere).
  Without `narration.wav` only the text checks run. Writes `out/cue-check.json`.
- **Text overlap, glyph fallback, one-frame flicker** — `scripts/state-checks.mjs <dir> [--only
  overlap,glyphs,flicker] [--step <frames>]`. It wraps the canvas text calls while the page seeks
  every frame, so a reel needs no change. *overlap*: text boxes sharing area with another text box
  (a string drawn twice, as a shadow or outline, is one element). *glyphs*: characters a font in
  use lacks, so a fallback font drew them (a script missing from the chosen font); a family that is
  not loaded shows every character. *flicker*: texts, and any layer listed by the optional page hook
  `window.__reel.visibleAt(t)` → `[{id, opacity?}]`, visible for one sampled frame with neither
  neighbour showing it. Writes `out/state-checks.json`.
  - Flicker, source first: the same command first reads `reel.html`, its scripts and `src/*.js` for
    show/hide windows under 2 frames at the film's fps, a one-frame gap or overlap between
    neighbouring windows, one condition on two clocks (base and dub, shot-local and global), a
    boundary rounded inside the test (different rounding functions make neighbours disagree by a
    frame), and a fade of 0 or 1 frame; each is printed as `file:line`, the window and why. A hit is a
    candidate to read, not a verdict. `--source-only` stops there; the state scan then confirms or
    clears it.
- **Character blink** — `scripts/blink-check.mjs <dir> [--glb <file>] [--morph <regex>] [--step <frames>]`.
  Per character: blink count, start-to-start intervals, closing and opening times. Flags
  `fast-blink` (closes and opens in under ~100 ms; a human blink is ~100–400 ms), `close-blinks` (under
  1.5 s apart; people blink about every 2–10 s) and `flutter` (3 blinks within 1 s); thresholds are
  named constants in `scripts/lib/blink.mjs`. Source first: it reads the code for blink intervals,
  durations, per-minute rates, `t % period` loops, keyframe arrays and random or timer drives
  (a random draw can also break determinism). Second, the page hook `window.__reel.blink(t)` →
  `[{character, closed: 0..1}]` is sampled every frame (`references/3d.md`). `--glb` reads a clip's
  own morph-weight keyframes for the blink targets, with no page. A screenshot cannot catch a
  blink that lasts two frames; this does.

## Round limit

Three review rounds. After the third, deliver with a remaining-issues list rather than looping.
Each round: one ranked fix list, fix all of it, one re-render — not fix-one-render-one.
