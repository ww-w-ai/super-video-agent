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

## Blog / article / product page URL

Fetch the text (WebFetch with a precise prompt, or a browser for logged-in or JS pages) into
`source/page.md`, plus any images and brand colours the page shows.

## YouTube URL

Transcript (`yt-dlp --write-auto-subs --skip-download` if installed, or the page's transcript
in a browser) and chapter titles into `source/`.

## Topic or plain text

Nothing to extract; the look is yours to choose.

## Direction and facts

- The user's direction overrides defaults but not facts. Record it in `FILM.md` in their words.
- Numbers, names, rankings, prices and claims: only if the source states them.
- Research and news: check dates and figures against the primary official source and note the
  reference date in `FILM.md`; whether the date also appears on screen depends on the film's concept.
