# Sound — effects that land on what the viewer sees

Narration carries the film. Effects and music are there to make a visible event feel physical,
not to fill silence. A film with no effects is fine; a film with effects that miss their picture
reads as cheap.

## 1. Sync points, not wallpaper

- Pick a few true sync points: a stamp slamming in, a card landing, a pipeline snapping
  shut, the final reveal. Each gets one short effect on the frame where the thing happens.
- **Every effect follows a visible event.** If you cannot name the frame it belongs to, drop it.
- **Material decides timbre**: the sound is the sound of what is on screen.
- **Timing window**: sound may trail the picture by up to 40 ms and lead it by up to 20 ms.
  The ear forgives a late sound far more than an early one.
- One effect at a time. Stacked effects on one frame turn into mush.

## 2. Kit (`ReelAudio`, `scripts/engine/reel-audio.js`)

All effects are synthesized from seeded noise and oscillators, with 1.5 ms onset ramps (no clicks)
and no reverb tails. Same seed → same samples, so re-renders match.

| Effect | Use for |
|---|---|
| `click` | a UI press, a toggle |
| `type` | a line of text typing on (burst of keys) |
| `thud` | something heavy landing: stamp, box, big type |
| `whoosh` | a card sliding or a cut between scenes; it swells in, so it has no sharp onset — never mark it `sync: true` |
| `pop` | a sticky note, a badge appearing |
| `tick` | a counter step, a checklist item |
| `ding` | done, success, the resolved state |
| `pluck` | a light accent in the music-box colour |

No sharp beeps: the synthesized kit has no siren/alarm tone; a piercing beep grates on viewers. A hit
that needs an alarm-like sound should come from the asset library instead (below).

Cues live in the page as `SFX_CUES` (`{at, kind, gain, pan, sync}`) and read their times from the same timeline the picture uses
(`tl.phrase(i, "단 한 줄")`, `tl.word(i, j)`). Each cue with `sync: true` also records a mark in
`__reel.marks`, which `review.mjs` checks against the rendered audio.

## 3. Music bed (optional)

Only when the tone wants warmth (explainers, promos). Recipe: major key, music-box pluck,
I–IV–V–I, a triplet 1-5-3-5 arpeggio, no pads, no drones, no reverb tails. Ducked under the voice
(`duck`) so every word stays clear; it rises only in gaps longer than about a second.
Skip it for serious or news-like films — silence under a voice is a style, not a gap.

## 4. Mix

- Master to **-16 LUFS integrated**, true peak ≤ -1 dBTP (render does this).
- Narration is the loudest element; effects sit clearly under it; the bed lower still.
- `master` soft-clips with tanh; if the review shows true peak over the limit, lower the effect
  gain, not the voice.

## 5. What to report

The model cannot hear. `review.mjs` measures loudness, true peak, the longest silence, and each
sync mark's onset offset. Report those numbers, then name a few timestamps for the owner to
listen to: the first effect, a scene handoff, the loudest moment, the ending.

## 6. Recorded effects and reaction clips (file effects vs synthesized)

`ReelAudio.sfx` is synthesized — no recordings, so it ships with the repo and never sounds like a
specific thing (a real siren, a real crowd laugh). When a line needs that specificity, pull a
recorded clip from the local asset library (design.md §2.5, `references/pipeline.md`) instead of
reaching for a synthesized kind that doesn't quite fit — do not synthesize an `alert`-style beep
as a substitute; there isn't one in the kit on purpose.

Pick clips in the script stage, alongside writing the line: `scripts/assets.mjs search <query>`
lists candidates with duration and license, and the chosen id becomes a `cues` entry on that line
in `plan.json`. `scripts/assets.mjs fetch <dir>` copies the cued clips into the reel; render.mjs
mixes their sound the same way as everything else in this file — trimmed, faded, peak-normalized,
then gained — before the loudness pass.
