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
library are starting points, not a palette to repeat: one library pop reused across many cues
makes every film's effects sound alike. `reel-audio.js` gives
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

**A kind that returns many times.** One kind at one setting repeats the same sound at every cue.
Every kind takes an explicit `seed`; for `pop` and `ding` the seed also moves the pitch (within
±3 semitones), the decay and the upper partials (±25%), and an explicit `freq` keeps its pitch while
the seed varies the timbre. For a whole kind, `ReelAudio.sfxPool(pools, {seed})` gives each cue a
variant: `pools` maps a kind to a list of `{gen, seed?, rate?}` (a synth variant at a set pitch
`rate`) and `{file, like}` (a library file, levelled to the peak of the kit's own `like` effect), in
one list. `pool.assign(cues)` walks the cues in time order and gives each the least-used variant of its
kind that is not the one before it (same seed, same result) and sets `cue.variant` and `cue.sound`
(a cue changed after the film was heard takes `pin: {variant, holds, holdsKind?}`: it plays pool
variant `variant` and takes the place of variant `holds` in the rotation, so no other cue changes sound);
`pool.buffer(cue, sampleRate, files)` returns the samples (`files`: `{<file name>: {rate, data}}`
the page loaded). A kind without a pool keeps `ReelAudio.sfx[kind]`. Library chimes and dings come
from `assets.mjs search ding` or `search chime` (and `pop`, `whoosh`, `tick` the same way); copy the
chosen files into the reel with a `cues` entry or `assets.mjs fetch`, then list them in the pool.

`ReelAudio.master(mix, {peakDb, refPeak})` soft-clips with a fixed drive of `1 / refPeak` (default
0.35, a music-box bed's own peak): a hit's level after mastering depends on that hit only, so adding
or removing other cues leaves it alone. A sample at `refPeak` comes out at `peakDb`; louder ones are
soft-clipped up to 2.4 dB over it. For a mix with a different loudness, measure its pre-master peak
once, pass it as `refPeak`, and keep it as the cue list changes.

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

### Lead sound

A film with `meta.lead` (seconds before the first story line; `true` = 3 s) must carry sound in
the lead — at least one of: a music bed playing from t=0 (declare it with `meta.sound.bed: true`),
a sound-effect cue inside the lead (a line cue that sounds before the first story line, e.g. `at:
"start"` with a negative `offsetMs` on the first story line), or an opening line spoken in the
lead (the first plan lines, marked `lead: true`, inside the lead window), or sound the page makes itself inside the lead (its `SFX_CUES` kit or custom
cues, or its own sound path; declare it with `meta.sound.page: true`, and `cue-check.mjs --page`
lists the page's marks with their times so the claim can be checked).
`validate-plan.mjs` fails a lead with none of them, and the silence gates report a lead without
sound. One way to choose the sound is by what comes next: a bed's key or an effect's material that
leads naturally into the first scene keeps the cut from lead to story from feeling like a
different film. Example: when the first scene opens
with a spoken greeting, a second spoken line right before it in the 3 s lead sounds crowded, and
a sound effect suited the lead better there.
A bed that starts in the lead continues under the story. The lead is part of the film's clock:
sfx cue times are measured from the film's t = 0, lead included.

## 4. Mix

- Master to **-16 LUFS integrated**, true peak ≤ -1 dBTP (render does this) with one static gain
  measured over the whole mix, never a single-pass `loudnorm`: it ramps its gain as it reads, so
  the start comes out quiet. The gain is capped at **+12 dB**: a mix that measures under -28 LUFS
  stays under -16. `render.mjs` prints `master gain capped at +12 dB: ...` with the gap in dB when
  that happens, and `review.mjs` prints a `note:` under the audio line when a file sits more than
  0.5 dB under -16 LUFS. Both are facts; raise the page's own sound level (below) or accept the level.
- If you mix with ffmpeg yourself, every `amix` sets `normalize=0`. Its default divides the sum by
  the inputs still playing, so the voice gets louder each time a line or an effect ends.
  `tests/amix-normalize.test.mjs` fails on any bundled `amix` without it.
- Narration is the loudest element; effects sit clearly under it; the bed lower still. The
  scaffold's `renderSfx` masters its own (bed + cues) mix to **-15 dBFS peak** by default, so with
  no cues the ducked bed alone sits around **-28 LUFS short-term during narration windows** —
  well under a -16 LUFS voice.
- **Ducked under the voice**: library cue sounds dip by `meta.sound.sfxDuckDb` (default **-2.5 dB**)
  while a narration line speaks, with **0.8 s** ramps in and out (`scripts/lib/duck.mjs`, shared by
  `render.mjs` and `dub.mjs`) — set it to `0` to turn ducking off. Gaps between lines shorter than
  **1.5 s** stay ducked: the windows merge, so the sound rises only in a real pause, never in the
  breath between two lines (a bed that rises and drops again there is heard as pumping). The
  music bed keeps its own, deeper **-10 dB** duck inside the page (`reel-audio.js` `duck()`, 120 ms
  ramps): words stay clear, effects stay audible, the bed all but disappears under speech.
- **Fades.** Fade every decrease in sound level. Choose `fadeOutSec: 0` only for an intentional hard cut.
  `meta.sound.fadeOutSec` sets the final bed fade (default 30 ms); narration keeps its own clip fades.
  A file cue (a library file or a clip's sound) takes optional fade fields, in `plan.json`
  `cues` and in the entries `__reel.soundCues()` returns: `fadeInSec`, `fadeOutSec`, `endsAtCut`
  (the sound ends where the picture cuts) and, for cues on one `track`, `crossfadeSec`. The default
  fade-out is 30 ms; with `endsAtCut` it is 0.6 s (at most half the cue), so music or a clip's
  sound does not stop dead at a cut. A cue with `crossfadeSec` runs that long past the start of the
  next cue on its `track` and fades out over it while that cue fades in over the same span. Each
  cue is peak-normalised first and faded after, so a fade is never undone by the level; give the
  mix the unfaded source and the fade fields, not a file faded in advance. `scripts/lib/audio-mix.mjs`
  `resolveCueFades` is the rule; the filter graph shows it as `afade` after `volume`.
- **Two ducks stack on a dubbed bed.** The page's duck follows the base language's lines. `dub.mjs`
  then ducks the whole bed again against the dubbed language's own lines, so where the two
  narrations differ the bed drops by both. `dub.mjs` prints one `bed duck:` line: the dub's dB, the
  deepest combined drop and when, and how many seconds are ducked deeper than the page's duck alone.
  It reports only; the dub's depth is `meta.sound.sfxDuckDb` in that language's `plan.json`, so a
  large drop can be eased there.
- **Repeated effects sit below the main one.** A sound that returns many times (a tick, a step, a
  click) is texture; the effect that marks a scene's event is the main one. Give the repeated kind
  a lower `gain` than the main effect so it never competes with it, and settle the difference by
  comparing two short A/B clips of the same few seconds at two gains. The model cannot hear: give
  the owner both clips to listen to, and report the measured peak of each (`sfx-cards.mjs
  measure`).
- **A film with little or no narration.** `render.mjs` masters the whole mix with one static gain
  to -16 LUFS integrated, so the page's own mix sets how loud the film is. The scaffold's
  `renderSfx` masters (bed + cues) to -15 dBFS peak; in a sparse mix the master gain that reaches
  -16 LUFS rises, and the loudest event can come near or over the true-peak limit. Mix the page
  against a reference: `scripts/mix-level.mjs <dir> [--under <dB>]` measures the page's sound alone
  (`out/picture.bed.wav`) against a leveled narration line (`voice/line-<id>.wav`, -16 LUFS; the
  median of all lines by default, `--line <id>` for one, `--voice-lufs <n>` when no line exists).
  It prints the gap in dB, the page's true peak and, with `--under <dB>`, the offset to add to the
  page's level to sit that far under the voice, with a note when the peak after it passes -1 dBTP.
  The gap you want is your decision; the tool computes none without `--under`. Apply the offset in
  the page's audio code, render again, and read `review.mjs`'s integrated loudness and true peak.
- **The silence gate on a film with no narration.** `review.mjs` and `voice.mjs` count a quiet
  stretch over 1 s between two sounds (the gate) as a gap, unless the plan asks for it
  (`pauseAfterMs`, `meta.gapMs`). In a film with no narration the lines are the scenes of
  `voice/timings.json` (`references/assembly.md` "A film with no narration"), the sound is the page's
  own, and a gap is quiet between two of its sounds, usually at a scene boundary. It is closed by
  sound under the join (an air or a motion sound under each scene), or the pause is declared in the
  plan. The quiet after the last sound (an end hold) is not a gap: when the longest silence is over
  the gate and the film still passes, `review.mjs` prints a `note:` that says why (the tail after the
  last sound, or a planned pause).
- `master` soft-clips with tanh at a fixed drive (section 2, `refPeak`); if the review shows true peak
  over the limit, lower the effect gain, not the voice.

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
`recipe` (`{kind: "kit", kit, params?}`, `{kind: "asset", assetId, maxSec?}`, or `{kind: "custom",
custom: "<free text>"}`). `scripts/sfx-cards.mjs measure <reel-dir>` fills `measured` — duration,
peak dB, LUFS (when the clip is long enough), attack time, spectral brightness, pitch trend and
noisiness — from `window.__reel.sfxStems()` (a kit/custom cue rendered alone, no bed, no other
cues, at the cue's own `gain` as it plays before the bed's master gain, so a cue at gain 0.12
measures 18 dB under the same cue at 1.0; a page that writes its own `sfxStems()` returns each
stem at its cue's gain too) or, for an `asset` recipe, from the part of the library file the film plays: 0 s to the
card's `maxSec`, else to the `maxSec` every `plan.json` cue of that asset shares, else the whole
file (a cue always plays from the file's start, so there is no start offset). `measured.fileSec`
keeps the file's own length, and `measure`, `report` and the judge prompt all name the span, e.g.
"0.00-3.00s of a 10.25s file". Spectral features average frames across the whole span and read
noisiness over 60 Hz–12 kHz, so a library file's leading encoder silence or its 16 kHz low-pass
does not read as brightness 0 Hz or as a pure tone.

A film with hundreds of cues does not need a card for each. Flag the cues that get a card with
`card: true` in `SFX_CUES`: the scaffold's `sfxStems()` then renders only those (every cue when
none is flagged), so `measure` does not receive every cue's samples at once.

The judge never hears the sound. It scores a text card — event, intent, world, recipe and the
measured numbers — so a wrong number (a 10 s length for a 3 s cue) moves the score as much as a
wrong sound would.

`scripts/sfx-cards.mjs judge <reel-dir>` scores each card's fit: does the sound match the event's
size, material and speed, and does it belong to this film's world (§2, above — this is the same
check that decides whether a library or kit sound may be reused as-is). With `TYPESAFE_API_KEY`
set it asks Jev (TypeSafe AI's typed-judgment model) a two-level 0..1 question and passes at 0.8
(equal to fit 8 on the 1-10 scale below); with only `OPENROUTER_API_KEY` set it asks Jev through
OpenRouter's `typesafe/jev-1.13`, which scores 1-10 and passes at 8; with neither set (the usual
case) it writes `<reel>/sound-judge.md`, a self-contained scoring sheet, for the current
model to score 1-10 by hand (pass at 8), plus a `sound-scores.json` template to fill in. Cards
that fail get a new sound made for this film instead — it only costs time.

A hand score wins over the judge: an entry in `sound-scores.json` with `"manual": true` and a
numeric `fit` (e.g. after someone listened) is left as it is — `judge` skips that card, keeps the
entry when it rewrites the file, and leaves it off the scoring sheet. Remove `manual` to have the
card judged again.

A model judge does not give the same score twice: an unchanged sound can land on either side of
the pass mark from one run to the next. `judge --repeat <n>` scores each card `n` more times;
without it, a card whose score is within 0.5 of the pass mark gets 2 more runs. The report shows
the mean and the spread and marks a card whose runs straddle the mark as "near the line": one
run could have passed or failed it, so it is worth another design round or an owner listen.

`scripts/sfx-cards.mjs report <reel-dir>` prints every card's fit and warns on fit under 8: redesign
that sound (a new synth voice, different pitch/envelope/layers, a better library sound, or a new
one made for this film), re-measure, re-judge — up to 3 rounds, without asking. This tool reports;
it never blocks a render.
