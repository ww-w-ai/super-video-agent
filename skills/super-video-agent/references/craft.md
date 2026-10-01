# Craft — what made earlier code films work, and what viewers rejected

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
