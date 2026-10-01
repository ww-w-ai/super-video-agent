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
| Silence | `review.mjs` | longest silence inside the narration (first sound to last line end); FAIL above 1 s |

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
into one image with `still.mjs --sheet <out.png> <a.png> <b.png> ...`.

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

## Round limit

Three review rounds. After the third, deliver with a remaining-issues list rather than looping.
Each round: one ranked fix list, fix all of it, one re-render — not fix-one-render-one.
