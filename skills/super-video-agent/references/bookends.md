# Bookends — an upload version (opening + body + ending)

Use this only when the user asks for an upload version with something attached to the film: a
channel end card, a title card, a series episode. Not part of the default flow — build the body
film as usual, then read this.

When the opening is part of the film itself — a short beat of music, a sound cue or an opening
line before the story — set `meta.lead` in the plan instead of rendering a separate opening clip
and joining it in front (`references/pipeline.md` "Timeline", `references/sound.md` "Lead sound").
The lead is on the film's own clock, so voice, captions, dubs and cues stay in step. A
separate opening reel suits a channel title card or series intro that is not part of the film.
The opening types a film can choose from, and how each is built, are in `references/openings.md`.

## Order that worked

```
title card → optional goal card ("what you'll learn") → strong transition into the body
  (e.g. flip, dip to black, fade up) landing exactly on the body's first frame
→ body
→ transition out of the body's last frame
→ ending cards: where the link is, a like/subscribe ask, a comment ask, thanks
  (hold the end card ~1.5s)
```

No fixed template — design the opening and ending fresh for each film; only the order above is
carried forward.

## Build it as its own reel

Build the opening/ending as their own reel, with its own voice: same voice and delivery as the
body (`references/voice.md`). Write the lines, make the voice, build the scenes, render — same
flow as the body film, just a shorter one. Then cut and join:

```
new-reel.mjs <bookend-dir> --ratio <same as body>
...write plan.json, make the voice, build scenes, render...
scripts/join.mjs <out.mp4> <opening>/out/final.mp4 <body>/out/final.mp4 <ending>/out/final.mp4
```

Leave a short pause after a question line before the "let's start" line — the same pacing rule as
any narration line with a following action (`references/craft.md`).

## Land the transition on the body's frame

Take the body's first and last frame as still images (`scripts/still.mjs <body-dir> --at 0` and
`--at <last shot's readAt>`) and build the opening's closing transition and the ending's opening
transition around those images, so the cut lands on a frame the viewer has already seen moving —
not a jump to a different look. `join.mjs`'s report tells you whether it landed (see "Check the
join" below); it does not enforce a match, since an intended hard cut is valid too.

## Loudness

Master the opening and the ending to -16 LUFS each, same as the body (`references/sound.md`).
`join.mjs` measures each part inside the joined file and reports the spread — it flags anything
over 1 LU but never blocks, since a musical fade at a card's edge can read as a real gap.

## Check the join

`join.mjs` reports facts after joining, never blocks:

- **loudness spread** across the parts, inside the joined file
- **click risk** — the largest sample-to-sample audio jump within ±20ms of the cut against the
  parts' own typical jump; a ratio flagged well above the parts' own material is worth listening to
- **frame match** — mean pixel difference between the last frame before and the first frame after
  the cut; a low value confirms a match cut, a high one is simply an intended hard cut reported as
  what it is

Look at the numbers, decide, re-cut if the click or the frame jump surprises you.

Before joining, `join.mjs` trims each part's audio to that part's video length (and pads it with
silence if it is short). An encoded part's audio usually runs a little past its last frame; left
as it is, the join would hold the last frame for a few frames and start the next part's sound
late.

Then review the upload file itself, not only the parts: `review.mjs --file <upload.mp4>
[--parts t1,t2,...]` needs no page and reports the audio and video stream lengths, the loudness
of the whole file and of each part (split at the given times), dead air and black frames. A black
run inside a transition you built is expected; one at a join is not.

## Ending cards

- Where the link is — description and comments, if that is where it lives — and the description
  should repeat what the ending says: "in the description and comments."
- A like/subscribe ask.
- A comment ask (what to make next, what the viewer thinks).
- Thanks, held for about 1.5s after the last word.
- The channel/service brand belongs on the ending cards; the body's own credits can stay on the
  body ("made with Super Video Agent") — both on the same film is fine.
- A series badge (episode number + topic as two parameters at the top of the opening's scene
  code) only when this is part of a series; skip it for a one-off film.

## Upload text

Write alongside the file: a title, a description that repeats the link the ending names as "in
the description and comments," and a pinned comment (usually the comment ask, restated).
