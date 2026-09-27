# Super Video Agent

English | [한국어](README.ko.md)

**Give Claude Opus 5.5 a PDF, an essay or a topic, and get back a narrated vertical short in your own
cloned voice. Every frame is drawn in code.** Super Video Agent is a Claude Code plugin that works the way
the code-drawn films Reddit shared in September 2026 were made, plus three things those films did not have:
read-out rules and a pronunciation dictionary for any language, a four-session pipeline tuned for cost, and a sound-effect library cued
from the script.

Measured on a real job, three 10-page basketball scouting PDFs → an 88-second short:
script $4.05, script review $1.75, film $16.34. That's about $22 and one hour of model time. Voice
synthesis ran locally with no API cost.

## Why

In September 2026, Reddit filled up with films Claude Opus 5.5 made entirely in code, like a train
journey in risograph style, an SNES anime battle, and a stick-man YouTube Short. The prompts were short. The model picked its own tools and checked
its own renders.

We tried it for our own channel and hit the same three walls every time:

1. **Timing drifts.** Scenes timed by estimate miss the narration by seconds once a real voice reads the script.
2. **Voices misread.** Numbers, names and English words come out wrong, and you only notice after the render.
3. **Every fix is a full re-render.** Changing one line meant regenerating the voice and the whole film.

Super Video Agent keeps the model's freedom (no templates for the look, no preset layouts) and adds what
the model cannot do by itself. Three of those carry the skill:

## 1. Read-out rules for every language

A synthetic voice reads the spelling, and no language is spoken exactly as it is spelled.
Super Video Agent writes the spoken form into the script before any voice is made. It works in
any language the voice engine speaks: a common checklist covers numbers, units, names and
acronyms everywhere, and languages with their own rule file get the sounds their spelling hides.

A paid TTS service may not need this. But with these rules, a low-cost or local TTS library
often gets it right too.

| Language | Written | Spoken (`say`) | Rule |
|---|---|---|---|
| English | `Opus 5.5`, `$16.34` | Opus five point five, sixteen dollars thirty-four | versions and money said in words |
| Korean | `4.4`, `6월` | 사쩜사, 유월 | decimal point said [쩜]; fixed month forms |
| Japanese | `3本`, `6本` | さんぼん, ろっぽん | counters change sound |
| Chinese | `2个`, `27.3%` | 两个, 百分之二十七点三 | 两 before counters; percent order flips |

A wrong reading quoted on purpose ("not X but Y") is spelled as it sounds too, because voice
models quietly correct common misreadings.

For words the spelling can't carry, a pronunciation dictionary in `plan.json` supports three
fixes: respell the word in the language's own script, give its IPA (International Phonetic Alphabet — the pronunciation symbols dictionaries use) to engines that read SSML (Speech Synthesis Markup Language)
`<phoneme>` tags, or swap the word. One entry covers every line that uses the word; captions
keep the original spelling.

```json
"pronounce": { "Nguyen": { "say": "Win", "ipa": "ˈŋwiən" } }
```

Every generated line is then transcribed back with speech-to-text. Only a gross miss is
regenerated — more than half of the line wrong, or a take under 70% or over 140% of the line's
length — because STT has its own error on names and homophones. A pronunciation fix keeps the
line's time slot, so the film does not re-render.
(`references/readout.md`, `scripts/lib/pronounce.mjs`, `scripts/lib/stt-compare.mjs`, `scripts/voice.mjs --lines`)

## 2. Four stages, four sessions, tuned effort

Each stage reads only the files the previous one left, so each runs in a fresh session with its
own effort level. Measured on the 88-second film:

| Stage | Output | Effort | Cost |
|---|---|---|---|
| Script | `plan.json`, `FILM.md` (facts with sources) | xhigh | $4.05 |
| Review | locked `plan.json` after five passes | low | $1.75 |
| Voice | `voice/` with measured `timings.json` | low | $0 (local) |
| Film | `reel.html`, `out/final-<timestamp>.mp4` | xhigh | $16.34 |

"Effort" is Claude's setting for how long the model thinks before it answers, from `low` to
`max`. More effort costs more and takes longer, so it only pays where the work needs it.

To see where it matters, we wrote the script for the same film at every effort level and checked
every number in it against the source PDFs:

| Effort | Cost | Time | Number errors vs. source |
|---|---|---|---|
| low | $2.21 | 2m35s | 0 |
| medium | $2.13 | 1m57s | 0 |
| high | $3.40 | 6m11s | 0 |
| xhigh | $4.05 | 6m05s | 0 |
| max | $8.04 | 23m14s | 0 |

- Every level got the facts right, so a cheaper level is a safe choice for the script when cost
  matters. `max` cost about four times `medium` and took twelve times as long.
- The review stage runs at `low` and still caught two things the script session missed: a line
  that could be read two ways, and a unit that the voice would have said twice.

Details: the "Four stages, four sessions" section of `SKILL.md`.

## 3. Sound effects cued from the script

A "ding" as the list starts, a drum hit on the punchline: these small sounds keep a Short alive,
and placing them by hand in an editor is slow. Here the model places them while it writes the
script.

1. **You keep a sound library.** A folder of your own effect files (and short reaction clips),
   with a `catalog.json` that says what each one is and whether you may use it commercially.
2. **The model picks the sound for each line.** It searches the library by keyword and pins each
   sound to a moment in that line: its start, its end, or a specific word ("on the word *right*").
3. **The renderer mixes it in at exactly that moment.** Each sound is trimmed to length, faded
   out, and leveled so a loud file does not drown the voice. A short video clip plays frame by
   frame on the same timeline.

Licenses are checked for you: a file not marked for commercial use is left out of a public film
unless you allow it. No sound files ship with this repo, since most sound packs carry their own
terms.

You don't need a library to have sound. The skill makes its own effects in code
(`scripts/engine/reel-audio.js`): click, type, thud, whoosh, pop, tick, ding and pluck, built
from noise and oscillators while the film renders. No files, no licenses to check, and the same
cue always makes the same sound, so a re-render matches.
(`scripts/assets.mjs`, `references/pipeline.md`, "Asset library")

## Also in the box

### Voice

- **The voice comes first, and the picture follows it.** The narration is made and measured
  before any scene exists. `voice/timings.json` records when every line and word starts, and
  every scene is timed from it, so a caption never runs ahead of the voice
  (`scripts/voice.mjs`).
- **Your own voice, or any engine.** Clone your voice from a 5–15 s recording with Qwen3-TTS on
  your own computer, at no API cost. Or use Fish Audio, ElevenLabs, MeloTTS, recordings you made
  yourself, or the macOS `say` voice for quick drafts.
- **Every line is heard back.** After the voice is made, speech-to-text listens to each line
  and compares it with the script. A line that came out wrong, cut short, or clipped at the end is
  flagged and made again.
- **Clean line endings.** Local voice models often clip the last syllable. The skill has the
  voice say a short word after each line, like a clapper between takes, and cuts in the pause
  before it, so each line ends naturally.
- **Fix one line, keep the rest.** Re-record only the line that sounds wrong
  (`voice.mjs --lines <id>`). The new take is fitted into the old slot, so the picture does not
  change and the lines you already liked stay as they are.

### Script

- **Narration that flows.** Each line gets its own pause: short when the next line continues the
  thought, long at a scene change. Sentences end so they connect, and commas are kept for
  emphasis, so the voice does not sound read off a page.
- **Five review passes before any voice.** Facts against the source, story, spoken wording,
  read-out, and a final read-through. The voice is made once, after the script is locked.

### Picture

- **Fix one scene, not the whole film.** Only the scenes that changed are rendered again and
  spliced into the existing film (`scripts/render.mjs --only`).
- **The same frame every time.** Each page draws a frame from the time alone (`seek(t)`), so the
  same moment always gives the same pixels. Previews, re-renders and checks all agree.
- **Text clear of the app buttons.** Captions stay out of the areas where Shorts and TikTok put
  their buttons and titles (x 80–888, y 200–1470 at 1080×1920). Pictures still fill the whole
  frame.
- **Shorts formula or free style.** Start with a hook and a banded frame with a fixed title, or
  use no preset at all and let the model design the look.
- **Any frame size.** 9:16, 16:9, 1:1 and 4:5.

### Checks and output

- **The film checks itself.** After rendering, `scripts/review.mjs` makes a contact sheet and
  checks for frozen frames, text that spills out of its box, loudness, sound effects that miss
  their moment, and silent gaps. You get numbers, plus the timestamps worth listening to.
- **Every render is kept.** Each render gets its own timestamped file, and `out/final.mp4`
  always points to the newest one. A player that has the film open is never broken by a new
  render, and you can compare versions.

## Install

Requires Node 22+, FFmpeg on `PATH`, and a Chromium for Playwright.

### The skill

**As a Claude Code plugin:**

```
/plugin marketplace add ww-w-ai/marketplace
/plugin install super-video-agent@ww-w-ai
```

On first use the skill installs its Node dependency and Chromium into its own folder
(`node scripts/setup.mjs`), then checks FFmpeg.

**As a standalone skill** (Claude Code or Codex):

```bash
git clone https://github.com/ww-w-ai/super-video-agent /tmp/super-video-agent
cp -R /tmp/super-video-agent/skills/super-video-agent ~/.claude/skills/super-video-agent   # Codex: ~/.codex/skills/super-video-agent
node ~/.claude/skills/super-video-agent/scripts/setup.mjs
```

### Voice and the speech check

Voice synthesis and the speech-to-text check run in Python environments you set up yourself.
Point the skill to them with these variables:

| Variable | Points to | Needed for |
|---|---|---|
| `SVA_QWEN3_PYTHON` | a Python where `import qwen_tts` works ([Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)) | voice cloning (default provider) |
| `SVA_STT_PYTHON` | a Python with `faster-whisper` installed | the voice check (skipped with a notice if unset) |
| `SVA_MELO_PYTHON` | a Python with MeloTTS | optional provider |
| `SVA_FISH_DIR` | a folder holding `fish-speech/` (the checkout) and `.venv-tts/` (its Python) | optional (Fish-Speech's model weights are licensed for non-commercial use) |
| `SVA_QWEN3_DEVICE`, `SVA_FISH_DEVICE` | `mps` (default), `cuda` or `cpu` | non-Apple machines |
| `SVA_STT_MODEL` | a faster-whisper model name (default `small`) | optional |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | your ElevenLabs key and voice | optional hosted provider |
| `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID` | your Fish Audio key and voice | optional hosted provider |

Without any of these, the macOS `say` voice works for drafts. Clone only your own voice, or one you have permission to use.

### Fonts

Every word in the film is drawn by the page itself, so the font travels with the film as a file.
Each new reel copies its font files into `assets/fonts/`, and the preview and the final render
use those same files.

- **Default: [Pretendard](https://github.com/orioncactus/pretendard).** Free under the SIL Open
  Font License, with Korean and Latin in one family. Install it once on your computer; every new
  reel then copies it in automatically. A Korean handwriting font you have installed is copied
  too, for hand-written notes.
- **Any font you like.** Tell the model which one ("titles in Noto Serif", "use my brand font").
  It copies that font file into the reel and uses it. Pick a font whose license allows use in
  videos.
- **No font installed.** Text falls back to the system sans-serif. The film still renders, but
  the look depends on the fonts of the machine it was made on.

### Sound library (optional)

Put your own effect files and a `catalog.json` in `library/` next to `scripts/`, or point
`SVA_ASSET_LIB` to a folder elsewhere (format: `references/pipeline.md`, "Asset library").
Without a library, the effects the skill makes in code still play.

## Use

In Claude Code, with Opus 5.5, run the skill and say what you want:

```
/super-video-agent Make a YouTube Short from this PDF. Use my voice from me.wav (transcript: "…").
```

Installed as a plugin, the command shows up as `/super-video-agent:super-video-agent`; type
`/super-video-agent` and pick it from the list. You can also skip the command: asking for a video
in plain words starts the skill too.

The skill first asks whether to follow the Shorts formula (hook first, fast lines, a banded frame with a fixed hook title) or free style, plus the frame size and length if it can't infer them. If you hand it a finished
script or storyboard, it asks whether to use it as written or rework it.

## Credits

Super Video Agent started from what these Reddit posts showed Claude Opus 5.5 can do when it is
given a premise and room to work. Thank you to their makers.

| Post | What it showed |
|---|---|
| [Opus 5.5 is insane at making videos](https://www.reddit.com/r/singularity/comments/1worlfs/opus_55_is_insane_at_making_videos/) — u/Silver-Chipmunk7744, r/singularity | A full SNES-style anime battle rendered from code, from a one-page story prompt |
| [I asked Opus 5.5 to create an animation on how LLMs work](https://www.reddit.com/r/claude/comments/1wnxppc/i_asked_opus_55_to_create_an_animation_on_how/) — u/cody-fifth-door, r/claude | A narrated parody explainer from a 23-word prompt |
| [Opus 5.5 One Shot Video Generation](https://www.reddit.com/r/ClaudeAI/comments/1wnh4fn/opus_55_one_shot_video_generation/) — u/AzorAhai1TK, r/ClaudeAI | Picture and sound both programmed, tools left to the model |
| [Opus 5.5 made six films, each one drawn under the rules of an old physical medium](https://www.reddit.com/r/ClaudeAI/comments/1wp6opy/opus_55_made_six_films_each_one_drawn_under_the/) — u/datathe1st, r/ClaudeAI | A written notebook per film, kept between passes |
| [I gave Claude Opus 5.5 an MP3 and a few lines of art direction. It built a 50-shot painted music video entirely in code, with no video or image model](https://www.reddit.com/r/singularity/comments/1wp6zp8/i_gave_claude_opus_55_an_mp3_and_a_few_lines_of/) — u/DigitalDaydreamers1, r/singularity | A 50-shot music video steered by short notes |
| [Opus 5.5 creates a train journey drawn entirely in JavaScript](https://www.reddit.com/r/ClaudeAI/comments/1wnkvys/opus_55_creates_a_train_journey_drawn_entirely_in/) — u/mshort3, r/ClaudeAI | A film drawn as a pure function of time, reviewed on contact sheets |
| [Opus 5.5 made this whole YouTube Short in one HTML file. No images, no video editor, just code](https://www.reddit.com/r/ClaudeCode/comments/1wolkjy/opus_55_made_this_whole_youtube_short_in_one_html/) — u/quitpornio, r/ClaudeCode | Voice first: measured line times drive the picture |

Runtime dependencies and their licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Built by [DubDubDub Corp.](https://ww-w.ai) · Licensed under [Apache-2.0](LICENSE).
