# Sources — getting the material out of each input

Save what you use into `reels/<slug>/source/` so the film can be rebuilt without the network.
Note in `FILM.md` which file or URL each fact came from.

## Script, storyboard or narration

It carries the user's own words, so first ask: use the narration as written, or rework it?
(Unattended: as written, noted in `FILM.md`.) As written means split long sentences only at
clause boundaries, one picture per piece. Screen cues are ideas, not a shot list. Cautions
("주의") are constraints: record them in `FILM.md` and check the narration against them before
the final render. For a partial run ("only the first minute"), take whole scenes and note in
`FILM.md` where the next run resumes.

Extract: `.docx`/`.hwp` → a headless extractor, `.pdf` → `pdftotext -layout`, into
`source/script.md`.

## Card news / slide images

The cards are material, not the film: use them, do not copy them. Cards played back as they
are make an obvious film; every scene is composed new (SKILL.md, "What you must hold" 1).
Copy them to `source/cards/NN.png` in reading order and read each one. Take what helps:
crop card imagery into `assets/`, sample the palette from the pixels
(`ffmpeg -i card.png -vf scale=1:1 -f rawvideo -`), note the type and recurring motifs.

## Image bundle / screenshots

Copy them into `source/`. Order them by the story, not by filename.

A screen of a third-party service (an app, a site, a dashboard) is material, not a shot: draw
that screen again in the film's own design, with the same information, instead of pasting the
capture. A pasted capture carries the service's look, its interface and whatever private or
dated content was on it.

## Image sources and licences

Keep a ledger of every image the film shows that you did not draw: `source/credits.md`, or a table
in `FILM.md`. One row per image:

| Column | Holds |
|---|---|
| file | the file in `source/` or `assets/` |
| origin | the page or URL it came from |
| author | the creator named there |
| licence | its terms (attribution, derivatives, commercial use) and the version |
| change | what was done to it: cropped, recoloured, or edited by an AI model |
| credit | the line shown on screen |

- Check the licence against how the film uses the image (credit required, derivatives, commercial
  use) before the image goes in the scene. An image whose terms you cannot read is not used.
- Show the credit on screen while the image is shown: a small line at the edge of the frame for
  the length of the shot, and the credits at the end.
- Mark an image an AI model edited or generated from another work as such, in the ledger's `change`
  column and in its credit line, so a derivative never reads as the original.
- A credit roll is text that moves: measure each roll line against the frame width and the safe
  area (`review.mjs <reel-dir> --scan` reports text outside it), and split or shrink a line that
  is wider.

## Blog / article / product page URL

Fetch the text (WebFetch with a precise prompt, or a browser for logged-in or JS pages) into
`source/page.md`, plus any images and brand colours the page shows.

## YouTube URL

Transcript (`yt-dlp --write-auto-subs --skip-download` if installed, or the page's transcript
in a browser) and chapter titles into `source/`.

## Topic or plain text

Nothing to extract; the look is yours to choose.

**A data film** (the topic is a trend or a comparison in numbers): search the web for the figures
before scripting, using official or press sources. List every figure in `FILM.md` as a table: value,
unit, date, measurement basis, source URL. Never mix measurement bases (a yearly total with a
monthly one, a forecast with a count) in one series; if sources differ, pick one and say why
(see "Direction and facts"). Script only from that table. Draw the chart in code from the same
table, with a point only where the table has one: no invented points between dates, and a gap is
drawn as a gap or a straight segment labelled as such. Put "as of <date>" next to a figure that
changes.

## Direction and facts

- The user's direction overrides defaults but not facts. Record it in `FILM.md` in their words.
- Numbers, names, rankings, prices and claims: only if the source states them. Test the claims
  that carry the film before the script is final (`references/script-review.md` "Fact checks").
- One source per on-screen figure. When two sources give different values, pick one, write which
  and why in `FILM.md`, and use that value in the narration, the caption and the picture alike.
- Research and news: check dates and figures against the primary official source and note the
  reference date in `FILM.md`. Whether the date also appears on screen is the film's call; one
  option is "as of <month year>" next to a figure that changes (a price, a ranking, a count).
