# How the viral Opus 5.5 code films were made

Read this first. These films went viral because the model was given room: a premise, a tone,
and one constraint — then it chose the tools, invented the look, and checked its own work.
Links to every post: the "Credits" section of the repository README.

## The prompts were short

| Film | What the maker gave | Words |
|---|---|---|
| SNES anime battle (Silver-Chipmunk7744) | a beat-by-beat story with quoted lines, "snes style, with HP bars", "feel like a real intense anime style fight… not realistic", "improve it and make it really cool" | 340 |
| 3Blue1Brown parody (cody-fifth-door) | "a funny 3blue1brown parody video about how LLMs work where it becomes increasingly clear the narrator doesn't know what he's talking about" + an ElevenLabs key | 23 |
| Creepy workday (AzorAhai1TK) | "a 1 minute video programmatically… using whatever tools you need… creepy/surreal… detailed and loud, the audio should also be programmed in however you see fit" | ~95 |
| Six films under old media (datathe1st) | pick an old physical medium, write its limits into code as hard rules, use it to show something from the AI future | ~20 |
| Painted music video (DigitalDaydreamers1) | an MP3, then ~15 short notes: "neon synthwave", "make it more like a storyboard", "up the clarity", "continue" | — |
| Riso bonus film (mshort3) | "a ~70s riso film of your own choosing, free range. The project docs here… are for support and examples, but you're not required to follow them" | ~40 |
| Stick-man short (quitpornio) | a voiceover, a JSON of each line's start/end, one small canvas character | — |

None of them set resolution, layouts, pixel sizes, shot lists, libraries or a QA procedure.

## What the model did on its own — keep all of it

- **Chose its tools.** Plain Node with a hand-written pixel renderer and synth; Python with
  numpy/cairo/Piper; one HTML page of Canvas and Web Audio. "Using code" was the only rule.
- **Improved on the brief.** "I almost certainly forgot certain parts… So improve it" — the
  model added scenes, jokes and references the maker had not asked for.
- **Timed picture to voice.** Word-level timing from the voice, captions synced to it,
  sound effects on events.
- **Checked its own renders unprompted.** Render → look at frames / contact sheets → fix
  overlapping text, floating poses, sync — then render again.
- **Took notes between passes.** The makers watched and gave short notes; the model fixed most
  and argued against a few.

## What this skill adds on top

Only what a production channel needs and the viral cases did not solve:
- the voice comes first and fixes the timeline; scenes are built onto its measured times (the
  way narrated shorts are produced — the stick-man short did the same, starting from a
  voiceover and a JSON of line times);
- facts stay true to the source (a promo or a case study cannot invent numbers);
- the voice can be swapped and cloned, with license checks;
- the bundled render/review scripts measure what the model cannot watch or hear (dead air,
  sync, loudness) — as help, not as rules.

## What viewers still criticized

See the failure table at the end of `craft.md`. The common thread: a look any subject would get
("the new slop animation template"), motion without meaning, too many effects, fast pacing, and
voices nobody could understand.
