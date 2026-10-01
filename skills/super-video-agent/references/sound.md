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
- **Best is to write the script so effects and narration don't overlap at all.** Give a signature
  effect (a whoosh on a big transition, an impact, a reveal) its own beat: end the line before it
  and set that line's `pauseAfterMs` to about 300–600 ms, or cue it at the line's `"start"` or
  `"end"` rather than mid-sentence. Small ticks and texture under the voice are fine; ducking
  (below) is the safety net for those, not the plan for a signature hit.

## 2. Kit (`ReelAudio`, `scripts/engine/reel-audio.js`)

Look in the asset library first (`assets.mjs search`; the library is not bundled with the
skill — without one the command says so, and `SVA_ASSET_LIB` points it at a folder you have). Use a library or kit sound only if it
scores fit 8 or more for this event and this film's world (below, "Sound cards") — otherwise
design a new one for this film: pitch, envelope, length and layers, or a new synth voice written
in the page, shaped from what is on screen (the object's size and material, how fast it moves,
the film's music key). The fit check includes the film's world because the kit's effects and the
library are starting points, not a palette to repeat: measured, one library pop sat in 27 cues
across recent films, and every film's kit sfx sounded like the first film made (a basketball
promo, because every kind's default seed was the literal kind name). `reel-audio.js` now gives
each kind's default seed a film key, so the same kind carries a character of its own per film —
but that alone does not make a sound fit a *different* film's world, which is what the fit check
catches.

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

- Master to **-16 LUFS integrated**, true peak ≤ -1 dBTP (render does this) with one static gain
  measured over the whole mix, never a single-pass `loudnorm`: it ramps its gain as it reads, so
  the start comes out quiet.
- If you mix with ffmpeg yourself, every `amix` sets `normalize=0`. Its default divides the sum by
  the inputs still playing, so the voice gets louder each time a line or an effect ends.
  `tests/amix-normalize.test.mjs` fails on any bundled `amix` without it.
- Narration is the loudest element; effects sit clearly under it; the bed lower still. The
  scaffold's `renderSfx` masters its own (bed + cues) mix to **-15 dBFS peak** by default, so with
  no cues the ducked bed alone sits around **-28 LUFS short-term during narration windows** —
  well under a -16 LUFS voice.
- **Ducked under the voice**: library cue sounds dip by `meta.sound.sfxDuckDb` (default **-6dB**)
  while a narration line speaks, ~80ms ramps in and out, untouched in the gaps
  (`scripts/lib/duck.mjs`, shared by `render.mjs` and `dub.mjs`) — set it to `0` to turn ducking
  off. The music bed keeps its own, deeper **-10dB** duck (`reel-audio.js` `duck()`, unchanged):
  words stay clear, effects stay audible, the bed all but disappears under speech.
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

## 7. Sound cards

A card is one designed effect, written down before it's judged: `<reel>/sound-cards.json` = an
array of `{id, at, event, intent, world, recipe, measured}`. The film agent writes `id` (matches
the cue's own id when there is one), `at` (seconds), `event` (what happens on screen), `intent`
(the content and mood the sound should carry) and `world` (this film's setting/topic in a few
words — e.g. "a kitchen promo, warm and bouncy" — the same phrase for every card in the film) and
`recipe` (`{kind: "kit", kit, params?}`, `{kind: "asset", assetId}`, or `{kind: "custom", custom:
"<free text>"}`). `scripts/sfx-cards.mjs measure <reel-dir>` fills `measured` — duration, peak dB,
LUFS (when the clip is long enough), attack time, spectral brightness, pitch trend and noisiness —
from `window.__reel.sfxStems()` (a kit/custom cue rendered alone, no bed, no other cues) or, for
an `asset` recipe, from the library file itself.

`scripts/sfx-cards.mjs judge <reel-dir>` scores each card's fit: does the sound match the event's
size, material and speed, and does it belong to this film's world (§2, above — this is the same
check that decides whether a library or kit sound may be reused as-is). With `TYPESAFE_API_KEY`
set it asks Jev (TypeSafe AI's typed-judgment model) a two-level 0..1 question and passes at 0.8
(equal to fit 8 on the 1-10 scale below); with only `OPENROUTER_API_KEY` set it asks Jev through
OpenRouter's `typesafe/jev-1.13`, which scores 1-10 and passes at 8; with neither set — the normal
case now — it writes `<reel>/sound-judge.md`, a self-contained scoring sheet, for the current
model to score 1-10 by hand (pass at 8), plus a `sound-scores.json` template to fill in. Cards
that fail get a new sound made for this film instead — it only costs time.

A model judge does not give the same score twice: an unchanged sound can land on either side of
the pass mark from one run to the next. `judge --repeat <n>` scores each card `n` more times;
without it, a card whose score is within 0.5 of the pass mark gets 2 more runs. The report shows
the mean and the spread and marks a card whose runs straddle the mark as "near the line": one
run could have passed or failed it, so it is worth another design round or an owner listen.

`scripts/sfx-cards.mjs report <reel-dir>` prints every card's fit and warns on fit under 8: redesign
that sound (a new synth voice, different pitch/envelope/layers, a better library sound, or a new
one made for this film), re-measure, re-judge — up to 3 rounds, without asking. This tool reports;
it never blocks a render.
