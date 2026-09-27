# Shorts formula

The structure popular Korean YouTube Shorts converge on. Use it only when the user chose
"Shorts formula" at the start (SKILL.md, Style). In free style, ignore this file.

Where it comes from: the banded frame was observed in 13 popular Korean Shorts; "hook first"
comes from 2026 retention guides. It fixes the frame and the opening only. The story order,
how each picture looks and moves, and how it is drawn stay your call. The source's facts and
the hard lines in SKILL.md still win.

- **Hook first.** The first line is the hook, said once, right away. No intro, logo reveal or
  greeting — the first two seconds lose the most viewers. After the hook, order the film the
  way this story works best.
- **Fast.** Short lines, a quick voice (`meta.voice.rate` 1.2, Korean 1.3; `references/voice.md`), a brief
  breath after each line so the caption can be read. Quick cuts, no slow dissolves.
- **Ask once, if at all.** One ask (like, save, follow) on the last beat, or none. In Korean,
  say "하트" rather than "좋아요". A brand mark only small, or at the end.
- **One accent.** In the hook title, one phrase in a single strong color; the rest plain.

## The banded frame (1080×1920)

A black band on top, the picture in the middle, a band at the bottom. The hook title stays in
the top band for the whole film; only the middle changes.

| Zone | y (px) | Height | What goes there |
|---|---|---|---|
| Top band | 0–422 | 422 (22%) | band background; the hook title, 2 lines, large bold, fitted to the width, its text between y 200 and 422 |
| Picture | 422–1498 | 1075 (56%) | the film's picture, about square; the spoken caption sits inside it, near its bottom |
| Bottom band | 1498–1920 | 422 (22%) | a logo or decoration; it lies below the safe box, so the platform may cover it — text there must be marked `outsideSafeOk` and must not matter |

The picture may grow downward when a scene needs more room; the top edge stays at 422:

| Picture height | y (px) | Bottom band left |
|---|---|---|
| Square (default) | 422–1498 | 422 |
| Half down | 422–1728 | 192 |
| Full down | 422–1843 | 77 |

Bands and pictures fill the frame to its edges; text stays inside the safe box x 80–888,
y 200–1470 (`references/pipeline.md`, "Safe area"). So the hook title's text sits between
y 200 and 422, and the spoken caption stays above y 1470 even when the picture runs lower. Title,
caption and the picture in the middle all centre on x 540, not on the safe box's middle (x 484).

Record in `FILM.md` that the film follows this formula, so the later stages keep it.

