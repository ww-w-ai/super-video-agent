# Script review — before any synthesis

The voice is made once, from a finished script. Every wording change after synthesis costs a
re-synthesis and shifts every line after it. So the script is reviewed in passes, one viewpoint
per pass, before `voice.mjs` runs.

Read every line in every pass. Fix what the pass finds, then move to the next pass.

| Pass | Look at | A line fails when |
|---|---|---|
| 1. Facts | each number, name, date and claim against the source | it cannot be traced to a page or passage of the source, or it drops a caution the source attached |
| 2. Story | the whole script read top to bottom | the opening gives no reason to keep watching, a line repeats an earlier one, the order makes a later line land flat, or the ending does not close what the opening opened |
| 3. Spoken wording | each line read aloud as a person would say it, and each line against the next | it reads like a caption, not speech; it ends on a bare noun; it has a comma that is not there for real emphasis; it packs two ideas; a word will be hard to hear; its pause does not match how it joins the next line (see below) |
| 4. Read-out (`say`) | how the voice will pronounce each number, unit, name, abbreviation, English word and symbol | the `say` text is missing where the written form is ambiguous, or it reads a unit twice or drops one (`4.4점` → "사쩜사 점 점", `27.3%` read without "percent"), or a sound the spelling hides is left to chance (see `references/readout.md`) |
| 5. Final read | the whole script once more, as a viewer | anything above still fails |

Repeat pass 5 until a full read changes nothing. Then synthesize.

## Narration that flows (pass 3)

Each line is synthesized on its own, so the voice cannot hear how the line before it ended. A
script written like captions comes out choppy: every noun ending drops the pitch, every comma
becomes a pause, and every line boundary gets the same silence.

- **Write sentences, not captions.** Each line has a verb ending (`~입니다`, `~이에요`, `~거든요`).
  A bare-noun ending (`~세 배.`, `~꼴찌.`) is allowed once or twice in a film, for a punchline.
- **A comma only where the line truly needs emphasis.** The voice pauses at every comma, so a
  comma is a stress mark, not punctuation: a short hold right before the word that must land
  (`지난 분기 꼴찌였던 네 명이, 이번엔 설욕전이에요`). Most lines have none; a film has only a
  few, saved for its key reveals. Do not add commas for grammar or to break up a long line —
  shorten the line instead.
- **Join lines with connecting endings** (`~는데`, `~고`, `~지만`, `~니까`) where one thought runs
  over two lines, as people do when they talk. Keep one speech level (해요체 or 합니다체) for
  the whole film, the one the reference voice speaks in.
- **The caption can be shorter than the speech.** Put the natural sentence in `say` and the
  compact version in `text` when the picture needs a short caption. Keep the key words the same
  in both, so the viewer reads what they hear.
- **Set the pause per line** (`pauseAfterMs` in `plan.json`; the default is `meta.gapMs`):

| The next line | `pauseAfterMs` |
|---|---|
| continues the same sentence or thought | 120–200 |
| starts a new point in the same scene | `meta.gapMs` (250–400) |
| starts a new scene or topic, or follows a punchline | 500–700 |

Before and after (`/` separates two lines; the number is the pause between them):

| Choppy | Flows |
|---|---|
| Sales grew. Last quarter, twelve percent. / The fastest, in five years. | Sales grew twelve percent last quarter, / (150 ms) the fastest in five years. |
| The problem: returns. Highest of three brands, eight point two. | The problem is returns: eight point two percent, the most of the three brands. |
| Brand B, the opposite. The discount aisle, theirs. | Brand B is the opposite. They own the discount aisle. |

The same holds in every language: write each line the way a person would say it aloud, not as
notes.

## Read-out (pass 4)

Follow `references/readout.md`: it names the file for the film's language and the checklist that
applies to every language.

Record in `FILM.md`: the source location of each fact (pass 1) and the lines changed in each
pass, so a later reader can see why a line reads the way it does.

After synthesis, change a line only for a real error — an STT flag, a misread name or number.
