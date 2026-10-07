# Craft — what made earlier code films work, and what viewers rejected

Contents: Aliveness · Marks are made · One picture per line · Fill the frame with the subject · Rhythm (fit the words to the picture, lists, captions) · A promo makes the viewer want to go · A character holding the camera · Named 2D techniques · Failures real viewers called out

These are observations, not settings. The user's direction comes first. The user may give exact numbers (sizes, layout, line length, coordinates); when they
do, use them. When they do not, decide from the content and the look you chose.

**Every example in this file is an illustration, never a menu.** Examples show what a principle
means; they are not recommended techniques. A film that reuses the examples verbatim has
missed the point — invent what fits this film.

## Aliveness

Viewers read a frame as alive when something keeps changing, and as broken when it freezes.
How it stays alive is yours to choose: ink bleeding, a pen still moving, film grain, a slow
push, a counter ticking. One way that has worked: each drawn element shifts a little on its own
stepped rhythm (a "boil"). In the reference shorts, components and lines
shaking slightly made the video look natural instead of paused. Keep it subtle enough that it reads as hand-made, not shaking —
viewers complained about motion sickness when everything moved a lot. Text the viewer must read
stays still.

Elements at rest boil; while an element moves it does not; boil returns once it arrives (`Reel.moving`).
A moving element may also step its angle on the beat (a stop-motion feel). That is a motion choice, not boil; use it where it suits the film.

## Marks are made

Things arrive the way this film's look would make them: a pen draws the circle, a note is slapped on,
a stamp hits, ink spreads, a card slides and settles. The order the marks appear is the order
the eye reads. Everything fading or zooming in together reads as a template.

## One picture per line

A new line of narration brings a new picture: a new object, a closer look at a detail, the next
item marked, a different layout. When two lines share one composition and only the caption
changes, viewers say "the same video keeps repeating". Long source sentences are the usual
cause — rewrite them into shorter lines rather than holding one shot.

## Fill the frame with the subject

The main visual should be big enough to be the subject. Small icons floating in a large empty
field read as unfinished. A wide frame makes this easier to get wrong.

Judge fill on the state a scene is building toward, not on the frames of the build: a frame
caught while something is still arriving counts as filled, however it arrives. (Only examples
of what "arriving" can look like, not suggestions and not a list to pick from: sliding in from
an edge, fading in, several cards appearing in turn. The entrance itself is yours to invent.)

## Rhythm

Land a line's key visual on the word it belongs to (word times in `voice/timings.json`), not
at the line start.

End on a held last screen: after the last line, keep the final picture still for 1–2 s
(`plan.json` `meta.tailSec` 1–2), with no fade to black. The viewer gets time to read the closing
card before the Short loops. Most popular Shorts cut on the last sound, but a closing card or
caption on the last frame was the norm in the viral code-drawn demos.

A starting point for a cut's first frame: show what the shot is before moving into detail; an
ambiguous close-up as the first frame read as noise in one film. As one example, open a scene
wide to give the viewer the context first (where we are, what the subject is), then move in to
the detail the line is about. A film that opens every scene wide reads as one repeated move; a
scene whose context is already clear can start close.

### Fit the words to the picture

The picture sets the pace; the words fit it. When a line lands before the viewer could read the
frame, slow the line down: give it a pause before (`pauseBeforeMs` on the line), a shorter text, or
a longer shot. Do not speed the voice up to fit the picture in. Rushing is the most common reason
viewers say the pacing is too fast.

Silence is a technique. A pause after a punchline lets it land: hold the picture with no voice for
a beat (a few tenths of a second to a couple of seconds, set per line with `pauseBeforeMs` on the
next line, or with a hold in the picture). The same holds for the frame: empty space around one
element is a placement choice, as a pause is for sound. Length depends on the medium: a talk or
a presentation can hold a long pause; a short vertical film or a TV-style piece feels
awkward when a pause runs long. The film chooses; these are not rules.

Declare a deliberate slow movement or hold so the review does not flag it as dead air:
`window.__reel.holds = [{from, to, id?, reason?}]`, or `review.mjs --file <mp4> --holds a-b,c-d`.
A flagged span is judged from the code and the intent, not from the frame alone. A slow hold can
carry a small push-in (about 3 % scale across the span) so the frame is not frozen; this is one
way, not a requirement.

### Lists: one picture per item

One technique for a line that lists several things: each listed item gets its own picture, landing
on the word that names it (word times in `voice/timings.json`), one after another. The viewer
sees each item arrive as it is spoken. This is one technique among many. Before using it, ask
whether it suits this line: three short items fit it; a list of twelve, or items with nothing to
show, do not. You may use a different technique, or invent one, if it serves the content better
(a single picture that fills as items are named, a row that scrolls, one image for the whole
group). Do not pick this one only because it is written here.

### Captions

- **No single-word captions.** A caption piece of one word reads as a flash. An automatic cut that
  leaves one word alone joins it to its neighbour whenever the joined piece fits the row.
- **A forced break `|` is kept.** Write `|` in a line's `text` where a caption must break (never
  mid-phrase); it is removed before the voice reads the text. A piece cut by `|` is never merged
  with its neighbour, even when it is one word, so choose breaks that leave whole phrases.
- **The comma rule runs per `|` piece.** When a piece fits one row, its comma stays in the row;
  a comma splits a piece only when that piece does not fit. The test is on each `|` piece, not on
  the whole line.
- Never split a phrase across pieces, in any language. `validate-plan.mjs <dir> --breaks` lists
  every caption break of the film so you can read them.

## A promo makes the viewer want to go

A promo is not an explainer. Open on the subject at its most appealing, on frame 0 — the dish,
the product in use, the place at its best light — not on a title or a narrator. Then frame every
fact as a reason for this viewer to act: a location becomes how easy it is to get there, opening
hours become when to come, a price becomes what they get for it. A narrator walking through the
subject's features reads as an explainer, however bright the voice. Write the listener into
`FILM.md` first (who watches, and what they should want to do when it ends) and check each line
against that want.

## A character holding the camera

When the film is framed as shot by a character on their own phone, the picture reads true when
the camera behaves like one: a small handheld drift (keyed, smooth noise, not random per frame),
a selfie flip as a fast whip-pan, cuts or whips placed in the longer pauses between lines, and
key beats landed on the word times. Whether a film uses this framing at all is a choice for that
film.

## Named 2D techniques

Users often describe a look by a technique seen on TV. These names mean different things; use
the right one when you talk with the user and in `FILM.md`. These are examples, not a menu: pick
one that fits the content, or use or invent another technique that suits this film better.

| Name | What it is | Known examples |
|---|---|---|
| Cut-out animation (paper-puppet animation) | a figure cut into parts (head, torso, upper and lower limbs) that rotate at overlapping joints | early *South Park*; many current TV cartoons |
| Collage animation | scraps of magazines or photos pasted together, the cut-and-paste texture shown on purpose | Terry Gilliam's *Monty Python* animation |
| Photo animation | a real person's photo cut out; only the head or arms move | documentary, news and explainer videos |
| 2.5D parallax | a still split into near and far layers; a camera move gives depth | the "living photo" shot in documentaries; the engine helper `Reel.parallax` and its edge check are in `references/parallax.md` |

Studio tools for these are Toon Boom Harmony, Moho and Adobe Character Animator; setting up the
joints is called cut-out rigging. A cut-out figure moves well when its parts share one fabric and
shade at every overlap, and when motion is eased with follow-through (a forearm trailing its
shoulder) rather than switched pose to pose. A drawn figure that looks crude next to the rest of
the frame can often be replaced by generated images cut into such parts. Name the technique for
each scene in `FILM.md` and why it fits that scene, in films without characters too (a chart, a
page, a camera interior); the rigs and the 3D route for characters are in
`references/characters.md`.

## Broadcast and news-desk screens

When the user asks for a news desk, a broadcast graphic or a live-score look, draw that screen
language in code; no footage or logo is needed. Parts that read as broadcast: an anchor desk shot
that cuts to a field-report picture and back, a lower third (name and role) that slides in on the
speaker's first word, a ticker, a score or progress bar that updates with the facts, a corner bug.
A bar that shows a standing or a balance (which side leads) is a number drawn from the source, with
no point the source does not give. Do not copy a real channel's name, logo or palette; describe the
look in your own words in `FILM.md`.

## Failures real viewers called out on Opus-made films

| Viewer reaction | What went wrong |
|---|---|
| "Pacing is too fast" | lines landed before the picture could be read |
| "So much movement it's obfuscating that nothing happens" | motion without meaning; several things leading at once |
| "Looks like two different companies" | the film ignored the brand's own design |
| "Can't understand the voice" | unclear synthetic voice, mispronounced names |
| "Looks like moving web code" | flat UI boxes with no made marks |
| "The same video keeps repeating" | one composition held over several lines |
| Half-empty frames | small visuals in a large blank frame |
| "It'll become the new slop animation template" | a look that any subject would get; no look chosen for this film |
| "SFX is a joke, literal overproduced garbage" | effects stacked everywhere instead of on a few real events |

## Photo sources

For any photo scene, check reuse rights and keep the source credit visible while
the photo is on screen. See `parallax.md` for source choice and preparation.
For photo animation or composition, see its optional alpha-mask and masked
key-photo guidance. Use its depth maps when a background photo or depth blur needs them.
