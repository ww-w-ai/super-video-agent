# QA — what the tools measure and what they cannot see

## Gates

| Gate | Tool | Pass |
|---|---|---|
| Contract | `verify.mjs` static scan | no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, timers, `fetch` in scene code |
| Determinism | `verify.mjs` probe | shuffled-seek PNG hashes equal in-order hashes at ≥ 12 times (shot edges, boil bucket edges) |
| Dead air | `review.mjs` | seek(t) every 0.1 s through the timeline, hash the native-resolution canvas; no run of identical hashes ≥ 0.8 s before the last line ends. The end hold after it (`meta.tailSec`) is reported as `endHoldSec`, not flagged |
| Boil call sites | `verify.mjs` | not a gate — counts `boil(` call sites in the scene code and how many pass a `moving` option, printed as one info line |
| A/V | `review.mjs` | video vs narration duration ≤ 50 ms; last line ends before the final frame |
| Layout | `review.mjs` via `__reel.issues()` | empty: no text overflow, nothing outside the safe area |
| Loudness | `review.mjs` (ebur128) | integrated -16 LUFS ± 1; true peak ≤ -1 dBTP |
| Sync marks | `review.mjs` | each `sync:true` mark's audio onset is within -20..+40 ms of its frame |
| Silence | `review.mjs` | longest silence inside the narration (first sound to last line end); FAIL above 1 s |

A failing gate prints a DIAGNOSIS line naming the time or element. Fix the cause, not the threshold.

## Reading the contact sheet

`out/sheet.png` shows each shot at its `readAt` with a timestamp. Read the tiles in order:
1. Does any composition appear on two neighbouring tiles with only the caption changed? That
   reads as "the same video repeating" — give one of those lines a new picture.
2. Is the main visual big enough to be the subject, or small in a blank field? A frame caught
   while something is still arriving counts as filled, whatever the entrance is — judge the
   state it builds toward.

Settle texture or small-text questions on a full-size `still.mjs` PNG, not the reduced sheet.

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
  step and reports issue runs with their times.
- **Taste**: a passing sheet is not an approved film. Say "technically verified" and list what a
  human should watch for.

## Round limit

Three review rounds. After the third, deliver with a remaining-issues list rather than looping.
Each round: one ranked fix list, fix all of it, one re-render — not fix-one-render-one.
