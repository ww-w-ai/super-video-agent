# QA — what the tools measure and what they cannot see

## Gates

| Gate | Tool | Pass |
|---|---|---|
| Contract | `verify.mjs` static scan | no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, timers, `fetch` in scene code |
| Determinism | `verify.mjs` probe | shuffled-seek PNG hashes equal in-order hashes at ≥ 12 times (shot edges, boil bucket edges); a cold probe — a fresh page seeking each time with no warm-up — matches the warm hash too. On a mismatch it names the earlier seek time that changes the frame and the bounding box of the pixel difference |
| Dead air | `review.mjs` | seek(t) every 0.1 s through the timeline, hash the native-resolution canvas; no run of identical hashes ≥ 0.8 s before the last line ends. The end hold after it (`meta.tailSec`) is reported as `endHoldSec`, not flagged |
| Boil call sites | `verify.mjs` | not a gate — counts `boil(` call sites in the scene code and how many pass a `moving` option, printed as one info line |
| A/V | `review.mjs` | video vs narration duration ≤ 50 ms; last line ends before the final frame |
| Layout | `review.mjs` via `__reel.issues()` | empty: no text overflow, nothing outside the safe area, no chip outside its box, no highlight missing or under its target (`references/pipeline.md` "Children, highlights and corners") |
| Loudness | `review.mjs` (ebur128) | integrated -16 LUFS ± 1; true peak ≤ -1 dBTP |
| Sync marks | `review.mjs` | each `sync:true` mark's audio onset is within -20..+40 ms of its frame |
| Silence | `review.mjs` | every silence over 1 s inside the narration (first sound to last line end) is listed with the line ids around it; FAIL unless the plan asks for it (`pauseAfterMs`, or a long `meta.gapMs`) — a planned pause is listed, not failed. Same measurement as the voice stage's silence gate (`voice.mjs`, `dub.mjs`, `fit-track.mjs`), which runs before the voice is locked |
| Caption breaks | `validate-plan.mjs --breaks [--dub <code>]` | not a gate — the table lists every break; the reviewer finds none that cuts a phrase (`script-review.md` "Caption breaks"; a dub reads it once per language) |

A failing gate prints a DIAGNOSIS line naming the time or element. Fix the cause, not the threshold.

**A check that looked at nothing has not passed.** `review.mjs` gives such a check the verdict
`CHECKED NOTHING` (in `review.json` its `pass` is `null`, listed under `checkedNothing` with the
reason): neither PASS nor FAIL. Other tools print `checked nothing: <reason>` the same way: a
`verify.mjs` scan with no scene code, `cue-check.mjs` with no word cue, `validate-plan.mjs
--breaks` when every line is one piece, a safe area set to `none`, a language with no named
font. Zero targets is a true pass only if the film really has nothing for that check to look at.
So ask whether the film needs it. If it does, make what the check looks at (a word cue, a `|`
break, a safe area, a named font) and run only that check again; if it does not, write in
`FILM.md` that it did not apply. The printed message carries the same sentence ("Confirm this
video needs this check; if it does, make … and rerun only this check").

**Show a gate fail before you trust it pass.** A check that has never failed is unproven. Before
relying on a new or changed check, run it on an old output that is known to be wrong (a render
that has the defect, a copy with the defect put back, a deliberately wrong input) and see it
fail; run it on the fixed output and see it pass. A check that passes both, or that finds no
target, says nothing. Delete the probe afterwards and rebuild anything made from it.

A frame that changes with the seek history usually carries state from an earlier frame: a
texture built lazily on the first seek, or a blur or glow drawn with soft transparent edges over
whatever the canvas held before. Draw blur and glow over an opaque copy of the frame first.

A finished or joined file has no page to seek. `review.mjs --file <mp4> [--parts t1,t2,...]`
reviews it directly: audio and video stream lengths, integrated loudness of the whole file and of
each part, dead air and black frames (`references/bookends.md`). A picture that is meant to move
slowly or hold (a deliberate still, a slow push) reads as dead air: name those spans with `--holds
12.5-15,40-44` (seconds) and they are listed as intended holds, not flagged. In a reel review the
page declares them itself: `window.__reel.holds = [{from, to}]`. The freeze test reads 320-px
frames, because 64-px frames read slow movement as frozen.

To show a film to a reviewer, `review.mjs <reel-dir> --copy [--lang <code,code>] [--out <dir>]`
writes one `review-copy-<code>.mp4` per language layer that has an `out/final-<code>.mp4`. The
existing encode (picture, voice and bed) is stream-copied, nothing is rendered, and a subtitle
track carries one cue per line as `<line id> <text>`, so a reviewer can name the line they mean.
A layer with no encode or no timings is skipped with the reason; the run exits 1 only when no
copy could be built. Before any encode exists (voice stage), the same command builds the base layer from
`voice/narration.wav` under a black 640x360 picture as long as the narration, with the same subtitle track.
Show the reviewer a copy with its voice and line ids, never a silent picture.

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

None of these fails a reel; each prints what it measured and exits 0 (one exception, `langglyphs`
below: a character the language's font lacks is definitely wrong and exits 1). Boil, motion, flicker and blink
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
  Sound events the page makes itself (`window.__reel.marks`, `{at, kind}`) are read with `--page`
  (opens the reel) or `--marks <json>`. Each is printed as a fact: the line it lands in, the
  nearest recorded word and the offset in ms. A mark that also carries `word` (and optionally
  `line`) is checked like a `word:` cue: `page-cue-moved` beyond `--threshold`,
  `page-cue-word-missing`; any mark outside 0 to the film's duration gives
  `page-cue-outside-timeline`. A film with no word cue and no page event still says `checked nothing`.
- **Text overlap, glyph fallback, one-frame flicker, covered content, language glyphs** —
  `scripts/state-checks.mjs <dir> [--only overlap,glyphs,flicker,covers,langglyphs] [--step
  <frames>] [--range <t0>-<t1>] [--outline-em <n>]`. It wraps the canvas text calls while the page
  seeks every frame, so a reel needs no change; `--range` reads the frame checks only between
  those seconds, and progress goes to stderr. *overlap*: text boxes sharing area with another text
  box (a string drawn twice, as a shadow or outline, is one element). *glyphs*: characters a font
  in use lacks, so a fallback font drew them (a script missing from the chosen font); a family
  that is not loaded shows every character. *flicker*: texts, and any layer listed by the
  optional page hook `window.__reel.visibleAt(t)` → `[{id, opacity?}]`, visible for one sampled
  frame with neither neighbour showing it. *covers*: a label or always-on overlay that covers key
  content; it checks only the regions the page declares, `window.__reel.regions = [{id, kind:
  "key"|"label"|"overlay"|"reserve", box: [x0,y0,x1,y1], outline?, from?, to?}]` (canvas px; no
  `from`/`to` = the whole film), reports the shared px² and times, and is a judgement for the
  reviewer. *reserve*: picture text drawn inside a `reserve` region (a corner kept clear for a
  persistent label or logo, `references/pipeline.md` "Corner reserve"), with the times.
  *langglyphs*: every character of every language's captions (`plan.json` and each
  `dub/<code>/plan.json`) against the font that language uses (`window.__reel.captionFonts =
  {"<lang>": "<font-family list>", "*": "…"}`, else the plan's `style.fonts`). `--outline-em <n>`
  says the captions are drawn with an outline n times the font size wide, and glyph shapes are
  compared after growing them by half of it. Exit contract: exit 1 only when `langglyphs` finds
  a character the language's font does not have (it would draw in a fallback font), and for
  unusable arguments or an unreadable reel; a font that is declared but not loaded prints `not
  checked: font not loaded` and does not exit 1; every other finding exits 0. `--only
  overlap,glyphs,flicker,covers` runs without the one check that can exit 1. Writes
  `out/state-checks.json`.
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
- **Caption contrast** — `dub.mjs` for a language layer (`--no-contrast` skips it) and `render.mjs`
  for a voice-first film's own render. For up to three frames per line it compares the caption's
  drawn colour with the picture behind the text box as a WCAG contrast ratio, from pixels already
  drawn, with no screenshot (`render.mjs` draws the same instant once more without captions and
  takes the pixels that differ). It works in both directions: light text on a bright picture, and
  dark text on a dark one. Under 3:1 is `LOW`, under 4.5:1 `marginal`, per line id and time; the
  full rows go to `dub/<code>/contrast.json` or `out/contrast.json`. The grade is a number for the
  reviewer to act on; it never stops a run. It says `checked nothing` when no sampled frame has a
  caption over a measurable picture (a render that reuses every cached segment draws none).
- **Waveform cut check** — `dub.mjs` lists each placed line whose start or end is still loud in
  the final narration, an abrupt cut the silence gate cannot see. A report, not a stop. After
  the cut is found, re-make the line or give it room (`references/voice.md` "Fixing one line").
- **Voice clip facts** — `review.mjs` prints the `HEAD`, `TAIL`, `DIP` and `PAUSE` results `voice.mjs`
  stored per line (`references/voice.md`). `HEAD` and `TAIL` come from the waveform and level (a
  click, a cut line, the previous line's leftover) and print as a `WARN` that names the line to
  re-make; the transcript check judges only whether the words came out wrong and never clears them.
  `DIP` and `PAUSE` are facts.
- **Engine notes and facts** — `review.mjs` and `verify.mjs` print `note: …` when the page's
  safe area is `none` (no text can fall outside it, so a clean layout report proves nothing), and
  `fact: …` lines for what the engine knows but cannot judge: a label with no string in the
  language (`picture-string-missing`), a corner note with no counterpart (`overlay-text-missing`,
  `note-*`). The page may mean them; read each and decide.
- **WebGL errors and warnings** — Chromium logs a failed WebGL draw as a console warning, so an
  errors-only listener passes a frame that drew nothing. `verify.mjs`, `still.mjs`, `state-checks.mjs`
  and `render.mjs` read both and print `GL error: …` for an error code, a lost context or
  out-of-memory, and `GL warning: …` for any other GL message. A GL error means the frames are
  wrong: `render.mjs` fails the segment before it is published, `verify.mjs` fails its probe and
  `still.mjs` exits 1 with a DIAGNOSIS line. A GL warning is printed for you to read and does not
  stop anything, and `state-checks.mjs` prints both without changing its exit code.

## Round limit

Three review rounds. After the third, deliver with a remaining-issues list rather than looping.
Each round: one ranked fix list, fix all of it, one re-render — not fix-one-render-one.
