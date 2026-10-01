# Script review — before any synthesis

The voice is made once, from a finished script. Every wording change after synthesis costs a
re-synthesis and shifts every line after it. So the script is reviewed in passes, one viewpoint
per pass, before `voice.mjs` runs.

Read every line in every pass. Fix what the pass finds, then move to the next pass.

| Pass | Look at | A line fails when |
|---|---|---|
| 1. Facts | each number, name, date and claim against the source | it cannot be traced to a page or passage of the source, or it drops a caution the source attached |
| 2. Story | the whole script read top to bottom | the opening gives no reason to keep watching, a line repeats an earlier one, the order makes a later line land flat, or the ending does not close what the opening opened |
| 3. Spoken wording | each line read aloud as a person would say it, and each line against the next; each line's `cues` | it reads like a caption, not speech; it ends on a bare noun; it has a comma that is not there for real emphasis; it packs two ideas; a word will be hard to hear; its pause does not match how it joins the next line (see below); a signature effect (`sound.md` §1) lands mid-sentence instead of in a pause |
| 4. Listener | the whole script heard as the film's listener hears it (see below) | it talks at the listener instead of to them, breaks the speaker, tires the ear, or leaves no time to take it in |
| 5. Read-out (`say`) | how the voice will pronounce each number, unit, name, abbreviation, English word and symbol | the `say` text is missing where the written form is ambiguous, or it reads a unit twice or drops one (`4.4점` → "사쩜사 점 점", `27.3%` read without "percent"), or a sound the spelling hides is left to chance (see `references/readout.md`) |
| 6. Final read | the whole script once more, as a viewer | anything above still fails |

Repeat pass 6 until a full read changes nothing. Then synthesize.

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
  over two lines, as people do when they talk.
- **Vary how lines end and are built**, as talk does, in any language — within the register the
  listener expects. Examples only: in Korean mix `~니다`, `~고요`, `~는데요`, `~거든요`, `~죠`, a
  connecting `~고`/`~면`, and among family a closing `~자!`; in English mix statements, a
  question, a line that runs on with "and"/"so", a "let's…". Pass 4 fails a run of the same
  ending or the same sentence shape.
- **The caption can be shorter than the speech.** Put the natural sentence in `say` and the
  compact version in `text` when the picture needs a short caption. Keep the key words the same
  in both, so the viewer reads what they hear.
- **Set the pause per line** (`pauseAfterMs` in `plan.json`; the default is `meta.gapMs`):

| The next line | `pauseAfterMs` |
|---|---|
| continues the same sentence or thought | about 400 |
| starts a new point in the same scene | `meta.gapMs` (default 700) |
| starts a new scene or topic, or follows a punchline | about 1000 |

A listener needs a beat to take in each line. Shorter gaps than these sound rushed, most of all
with a bright voice at 1.1× or faster.

Before and after (`/` separates two lines; the number is the pause between them):

| Choppy | Flows |
|---|---|
| Sales grew. Last quarter, twelve percent. / The fastest, in five years. | Sales grew twelve percent last quarter, / (150 ms) the fastest in five years. |
| The problem: returns. Highest of three brands, eight point two. | The problem is returns: eight point two percent, the most of the three brands. |
| Brand B, the opposite. The discount aisle, theirs. | Brand B is the opposite. They own the discount aisle. |

The same holds in every language: write each line the way a person would say it aloud, not as
notes.

## Listener (pass 4)

Before this pass, name the listener in `FILM.md`: who watches (their situation, where they meet
the film), what they want, and what they should think or do when it ends. If a character speaks,
name the speaker too: who they are, how they talk, how they refer to themselves and to the
listener, and that this matches the voice and the character on screen.

Then hear the script as that listener: one voice, at the film's speed, with its pauses, top to
bottom, twice. A line fails when:

- **it talks at the listener, not to them** — a lecture, a list of specs, a pitch they did not ask
  for, or a line whose reason to care they cannot tell;
- **it breaks the speaker** — a name, gender, age, speech level, way of referring to themselves,
  or tone that does not match the voice and the character on screen;
- **it tires the ear** — the same ending or sentence shape on consecutive lines or on more than
  about a third of the lines; exclamation marks on more than a few lines (each one is read raised and clipped, and
  a run of short exclaimed lines sounds like shouting in bursts); many very short lines in a row;
- **it leaves no time to take it in** — the pause after it is shorter than the table in pass 3
  gives for what just landed.

`validate-plan.mjs <dir> --listener` does the counting: the distribution of line endings, adjacent
lines with the same ending, and the `!` and comma counts per line. It reports and never fails;
whether a run tires the ear is still your call.

For a promo, the listener should end up wanting to go or try it: a line that only describes the
subject fails here (`references/craft.md` "A promo makes the viewer want to go").

Rewrite for the listener and keep the facts. The same holds in every language.

## Read-out (pass 5)

Follow `references/readout.md`: it names the file for the film's language and the checklist that
applies to every language.

Record in `FILM.md`: the source location of each fact (pass 1) and the lines changed in each
pass, so a later reader can see why a line reads the way it does.

## Length before synthesis

Once the script is locked, estimate the film's length before the voice is made, and record the
estimate in `FILM.md`. A script that runs long is cheap to cut now and expensive after synthesis.

```
validate-plan.mjs <dir> --estimate [--rate <units/s>] [--rate-from <timings.json>]
```

It prints the spoken units (syllables or words, by language), the total of the pauses, the head
and tail, and the estimated length. The rate is a default for the language unless you give one:
`--rate-from` measures it from an earlier `timings.json` made with the same voice and speed,
which is the closer figure. It reports only and exits 0.

This is a length check, nothing more. The measured voice still sets the clock: never time scenes
from the estimate.

After synthesis, change a line only for a real error — an STT flag, a misread name or number.
