# Voice — providers, timing, cloning

`node scripts/voice.mjs <dir> --provider <name>` synthesizes each `plan.json` line, measures it,
and writes `voice/narration.wav` + `voice/timings.json`. The film reads only `timings.json`.

## Choosing a provider

```
if the user supplied recordings                    → file        (voice/in/<lineId>.wav|mp3|m4a)
elif local Qwen3-TTS found and a reference voice    → qwen3       (local clone)
elif FISH_AUDIO_API_KEY (or FISH_API_KEY) is set    → fish        (hosted; cloned or library voice)
elif ELEVENLABS_API_KEY is set                      → elevenlabs  (hosted; native word timestamps)
elif TYPECAST_API_KEY is set                        → typecast    (hosted; native word timestamps)
elif local MeloTTS found                            → melotts     (local, MIT, one Korean speaker, fast)
else                                                → stop and list what to set up
```

`voice.mjs` picks this order when `--provider` is omitted and prints why. Tell the user which
provider ran. `none` (silent; captions carry it) and `say` run only when asked for. `say` is
macOS only and for drafts and timing only — viewers notice robotic voices ("can't
understand the voice" is a top public complaint).

| Provider | Setup | Word timings |
|---|---|---|
| `qwen3` | `SVA_QWEN3_PYTHON` (path to a python venv with qwen3-tts installed); `meta.voice.refAudio` + `refText`; `model` 1.7B (default) or 0.6B (lighter, less clear); `SVA_QWEN3_MODEL` sets the default for every film; `SVA_QWEN3_DEVICE` sets the torch device (default `mps`) | speech-to-text |
| `fishspeech` | `SVA_FISH_DIR`; `SVA_FISH_DEVICE` sets the torch device (default `mps`); `meta.voice.refTokens` (.npy) + `refText` | speech-to-text |
| `melotts` | `SVA_MELO_PYTHON` | speech-to-text |
| `fish` | `FISH_AUDIO_API_KEY` (or `FISH_API_KEY`), `FISH_AUDIO_VOICE_ID` (reference_id = clone id) | speech-to-text |
| `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | engine alignment |
| `typecast` | `TYPECAST_API_KEY`, `TYPECAST_VOICE_ID` (`tc_…`) | engine word times |
| `say` | macOS only; `SAY_VOICE` (default `Yuna`); runs only with `--provider say` | speech-to-text |
| `file` / `none` | — | speech-to-text |

Hosted models (`meta.voice.model`):

| Provider | Default | Other models | Cost |
|---|---|---|---|
| `fish` | `s2.1-pro-free` | `s2.1-pro` (its paid twin), `s2-pro`, `s1` | billed per UTF-8 byte of input ($15 per million; Korean is 3 bytes a character). The default `s2.1-pro-free` is the same model at no cost while Fish Audio offers it (announced through 2026-11-30); its requests may be used to train their models. A private cloned voice can be created with an API key alone (POST /model); Fish's web app needs a paid plan for one |
| `elevenlabs` | `eleven_multilingual_v2` | `eleven_v3`, `eleven_v4`, `eleven_flash_v2_5` | billed per character, tags included. Library voices work through the API only on a paid plan. A restricted API key needs the text-to-speech and voice permissions |
| `typecast` | `ssfm-v30` | `ssfm-v21` (untested) | billed per character |

No provider documents a per-request minimum.

**Listing voices.** `node scripts/voice.mjs --list-voices [<reel-dir>] [--lang <code>] [--provider
typecast|elevenlabs]` prints the voices the provider's own list offers: id, name, gender, age, use,
languages. `--lang` keeps the voices whose list names that language. When the provider's list has no
language field (Typecast's does not; its model reads the language from the request), every voice is
shown with a note, and the language comes from the line's language at synthesis. The key is read
from the environment and never printed. The command lists facts; choosing a voice is the user's call.

**One read per voice, cut per line.** Every provider makes all lines of one voice in one request
(several when the text passes the provider's limit: 2,500 characters for ElevenLabs and Fish,
2,000 for Typecast) and `voice.mjs` cuts it into one clip per line, so the voice keeps one read
across the film. Cut by the timestamps the service returns (ElevenLabs characters, Typecast
words): a line runs from 0.1 s before its first spoken word (never into the previous line's cut) to
the later of two points: where the line's own decay has fallen under what a listener can hear, and
0.2 s after its last spoken word. The cut is never later than 0.6 s past the last word or 20 ms before
the next line's first word, whichever comes first. It ends in a 30 ms fade-out and the next clip starts with a 20 ms
fade-in, so a line keeps its full decay and room tone and never starts with the end of the one before.
Lines are cut late on purpose: about 0.5 s of space is left after each line in the picture anyway, so
a cut close to the last word saves nothing and is what a listener hears as a clipped ending.
`meta.voice.cut` sets the margins in seconds (`headKeepSec` 0.1, `minTailSec` 0.2, `maxTailSec` 0.6,
`guardSec` 0.02, `fadeInSec` 0.02, `fadeOutSec` 0.03);
a service that returns none (Fish), or whose words do not map onto the lines, is cut at the
silences: the longest quiet stretches inside the speech are the breaks between lines. If the
audio holds fewer breaks than lines, or a cut would split a line unevenly, the lines are sent one
request each. The word times a service returns become the line's caption words. A single line (`--lines` with one id, a take, a
retry) is sent alone.

**Edge trim and the silence gate.** Per-line synthesis leaves 0.1–0.5 s of dead air at a clip's
head and tail; summed over a film it becomes a voice gap of a second or more. Every synthesized
line is therefore cut to its voiced span plus 0.05 s at the head and 0.3 s at the tail (voiced =
above −50 dBFS in 10 ms windows, the level `review.mjs` uses; a pause inside the line is never
touched), with a 20 ms fade-in and a 30 ms fade-out at the cuts. The untrimmed take is kept at
`voice/raw/<id>.wav` and replaced only when a new take is installed; `timings.json` records its
hash per line as `rawTake`, and `voice.mjs <reel> --raw-status` reports whether each raw file is
still the take its clip was made from (stale or missing: do not rebuild that line from raw).
When the narration is placed,
`voice.mjs` measures it and lists every silence over 1 s between voiced audio with the line ids
around it. A pause the plan asks for (`pauseAfterMs` on a line, or a long `meta.gapMs`) is listed
as a planned pause, not a problem; a gap over what the plan asked for is a `WARN`. Re-make the
named line (`--lines <id>`), or add `pauseAfterMs` where the pause is meant. The same gate runs on
a dub's placed narration and on a track made by `fit-track.mjs`.

A starting point before a full run: make about four lines once and listen; then make all lines together.

To listen before any picture exists, run `review.mjs <dir> --copy`: it builds `out/review-copy-<code>.mp4`
from `voice/narration.wav` under a black 640x360 picture as long as the narration, with a subtitle track
`<line id> <text>`, so the listener can name a line.

**ElevenLabs.** On eleven_v3/v4 the request ends in a `[pause]` tag:
without it, eleven_v3 stopped a Korean line mid-sound at the end of a request in 9 of 18 takes;
with it, 0 of 25. A single line is sent as it is, so listen to it and re-make it if its end is
cut; `voice.mjs` flags such a line `TAIL`. A short click after a quiet gap at the very end is cut
as noise.

**Typecast.** Typecast reads no inline tags, so marks are dropped from the text. One request
carries one emotion preset: `meta.voice.emotion` (`normal` `happy` `sad` `angry` `whisper` `toneup`
`tonedown`), default `normal`, with `meta.voice.emotionIntensity` (0–2, default 1) its strength.
Lines keep their `?` and `!`, so the model reads the intonation from the punctuation; no line
gets a preset from its ending. Measured: Typecast `toneup` raises the pitch of the whole
sentence, not only its end.

Typecast takes the language without a region (ISO 639-3, e.g. `por`), so `pt-BR` and `pt-PT`
(likewise `en-US`/`en-GB`, `es-ES`/`es-419`) send the same code. The regional accent comes from
the chosen voice, and the script's regional spelling and words come from the plan text. The
voice's accent can be noted in `FILM.md` as checked or unchecked.

**A word or sentence that must carry a specific emotion** depends on the provider:

- Providers with inline tags that work on a span (ElevenLabs v3/v4, Fish S2; see the table
  under "Delivery marks"): put the mark on that span in `say`. It stays inside the one-read
  request; no separate request.
- Providers without inline tags (Typecast, emotion is per request): set the line's `emotion`
  (a preset above). A line whose `emotion` differs from the voice's is left out of the one-read
  request, made alone with that preset, and placed like any other line. To give only a
  sentence its own emotion, make it its own line.

**Fish.** Fish returns no word times, so its lines are cut at the silences and their caption
words come from the speech-to-text check.

`meta.voice.removeSilenceMs` optionally caps Typecast's detected pauses at 0–1000 ms.
It is the silence to **retain**, not remove; `0` removes detected silence and omission
disables the option. It only shortens pauses. Provider timestamps already include this
processing. For audio you already have, use [audio editing guide](../guides/audio-editing.md) to shorten
or lengthen pauses without a paid request or local model inference.

Record in `FILM.md` the provider, model and voice used. Every synthesis request is also appended
to `tts-usage.jsonl` in the voice folder it writes to (`voice/`, or `dub/<code>/voice/`): one JSON object per request with
`ts`, `provider`, `model`, `voiceId`, `chars` (the text sent), `audioSec` (the audio that came
back), `lineIds` and `cost` (what the provider reported, else `null`). No key and no request
body is written, a failed request records nothing, and a log that cannot be written is a note,
never a stop. `scripts/runner/cost-report.mjs <film-dir>` reads these logs and prints syntheses,
characters, seconds and known cost per provider for the final report.

Mixing engines (or voices) inside one film changes the texture of the narration from one line to
the next, and an engine's read at its own speed differs from another's. Making one film in one
engine and one voice avoids it; the model decides when a mix is wanted (a second speaker, an
aside). When some lines are re-recorded later, keep their speed the same as the rest of the film
(the film's `rate`), so the new lines do not sound faster or slower than the old ones.

## Delivery marks

Write delivery directions as our own marks in curly braces, in the line's `say`, never in
`text` (the caption). Each voice provider translates them into its model's own tags (`tagMap`
in `scripts/voice/<provider>.mjs`); a mark the model has no tag for is dropped, and an engine
that reads no tags (qwen3, MeloTTS, say, Fish s1, ElevenLabs before v3) gets the line without
any. The same plan works on every engine.

```json
{ "id": "l14", "text": "우리도 할 수 있고, 해야 합니다.",
  "say": "{confident} 우리도 할 수 있고, {pause} 해야 합니다." }
```

| Mark | Fish Audio S2 | ElevenLabs v3/v4 |
|---|---|---|
| `{pause}` / `{long-pause}` | `[break]` / `[long-break]` | `[pause]` / `[long pause]` |
| `{emphasis}` | `[emphasis]` | dropped (ElevenLabs stresses CAPITALISED words; no effect in scripts without case) |
| `{whisper}` | `[whispering]` | `[whispers]` |
| `{soft}` / `{hurry}` / `{shout}` | `[soft tone]` / `[in a hurry tone]` / `[shouting]` | `[softly]` / `[rushed]` / `[shouts]` |
| `{laugh}` / `{chuckle}` | `[laughing]` / `[chuckling]` | `[laughs]` / `[laughs]` |
| `{sigh}` / `{gasp}` | `[sighing]` / `[gasping]` | `[sighs]` / `[gasps]` |
| `{clear-throat}` | `[clear throat]` | `[clears throat]` |
| an emotion: `{confident}` `{determined}` `{excited}` `{calm}` `{proud}` `{hopeful}` `{happy}` `{sad}` `{nervous}` `{curious}` `{surprised}` `{grateful}` `{serious}` `{warm}` `{sarcastic}` `{annoyed}` | the same word in brackets | the same word in brackets |

Both engines take tags as free-form English descriptions, not a fixed list: a tag in one
model's own words (`[happily]`, `[drawn out]`) works too, and tags stack (`[happily][shouts]`).
Write tags in English whatever language the line is in; Fish documents its tags for all its
languages, and neither engine documents tags written in another language. ElevenLabs bills a
tag's characters like spoken text (measured: ` [pause]` cost 8 characters).

A mark outside this list is dropped everywhere, and `voice.mjs` names it. A square-bracket tag
in one model's own words (`[whispers sweetly]` for Fish S2) passes only to an engine that reads
tags; prefer marks so the plan stays portable. The speech-to-text check ignores marks and tags,
and ElevenLabs word timings drop them, so neither shows up as a caption word. Use a mark where
the plain read falls flat (a line that must sound sure, a beat before a turn), not on every line.

Set one delivery for the whole film with `meta.voice.delivery` (an EMOTIONS value) instead of
repeating the same `{emotion}` mark on every line's `say` — a different emotion picked per line
makes the voice jump around; a line's own emotion mark still overrides it. Keep line marks to
one or two in a film, on the lines that truly turn (an aside, a laugh); the film's delivery
carries the rest.

Fish Audio reads a Short's lines calm and flat unless tagged, so a 9:16 film on the fish provider
defaults every untagged line to `{confident}`. Tag a line with its own emotion mark to change it
for that line; set `meta.voice.delivery: "none"` to turn the default off for the whole film.

Pick the delivery for who is speaking. `confident` suits a narrator presenting something, and it
reads like an announcer from a character talking about their own thing; a friendly owner or host
proud of what they made fits `warm` better. When a character speaks, the voice (gender, age),
how the lines have them refer to themselves, and how they look on screen all agree — the
listener pass (`references/script-review.md` pass 4) fails a line that breaks the speaker.

## Several speakers in one film

A line may carry its own `voice` with any `meta.voice` keys (`provider`, `voiceId`, `model`,
`rate`, `delivery`, `refAudio`, …). For that line it is merged over `meta.voice`, and the line's
keys win; lines without one speak in `meta.voice`. A dub's `dub/<code>/plan.json` lines take
their own `voice` the same way.

```json
"meta": { "voice": { "provider": "fish", "voiceId": "<anchor-voice-id>" } },
"lines": [
  { "id": "l1", "text": "Here is tonight's top story." },
  { "id": "l2", "text": "I'm at the scene now.", "voice": { "voiceId": "<reporter-voice-id>", "delivery": "serious" } }
]
```

Every `voice.mjs` mode makes each line in its own voice: synthesis, `--takes`, `--pick`,
`--use`, `--lines`, the speech-to-text check, leveling, the 9:16 default rate and delivery marks.
`timings.json` records who spoke each line (`voice: {provider, voiceId}`), and the run ends with
one line naming each voice and its line ids. A tone picked with `--pick` goes to that speaker's
lines only. A speaker is its provider plus `voiceId`: two clones that differ only in their
reference audio need different `voiceId`s to be told apart.

Each speaker's voice must fit how that speaker looks on screen and how they refer to themselves
in the script. Record each speaker and their voice in `FILM.md`.

## Local clone (qwen3) — what can go wrong

Library notices in the qwen3 log are not errors and need no action: "flash-attn is not installed"
(it only affects speed on CUDA) and librosa/audioread deprecation warnings. The SoX banner the
`sox` package prints on import is muted by `qwen3_batch.py`; qwen3 never uses SoX.

Local clone models sometimes never stop (no end token), return a 0.3 s fragment, or cut the last
syllable. `voice.mjs` generates each line within a time budget (`meta.voice.budgetSec`, default 20),
speaks every line with a one-word slate in its own language ("<line>. 끝.", "<line>. End.",
"<line>. Fin.") and cuts in the pause before it — like a clapper between takes — so the line keeps its sentence-final tone and its last syllable decays
to silence instead of being clipped. It retries until that pause is clear and the ending has
decayed (about -54 dBFS), fades the last 15 ms, keeps the best candidate, and marks leftovers as `voiceFlag: SHORT|TAIL` in
`timings.json`. **Read the flags.** A flagged line gets rewritten shorter or re-run; do not ship it
silently. The model loads once per run (tens of seconds on Apple Silicon), so batch all lines in
one call.

## Did the voice say the line?

Duration and tail-RMS checks catch a clip that's too short or cut off, but not a clip that's the
*wrong* length and cleanly finished — a mispronounced word, a dropped clause, a misread name. After
synthesis, `voice.mjs` transcribes every synthesized line back to text (speech-to-text engines
below) and compares it against the intended line:

- **SHORT** — the qwen3 provider's own duration gate: shorter than the text could plausibly take.
- **TAIL** — a provider's own gate (still sounding in the final ~30 ms: a cut syllable) and the
  waveform check's `TAIL` (below, "What the transcript cannot hear"). A transcript with the whole
  last word does not clear it: the words can be complete and the end still cut or clicking.
  `stt.tailMatched` records whether the last characters matched, as information.
- **MISHEARD** — the STT check's own gate, for gross errors only. STT has its own error, so it
  flags a take only when most of it is wrong (error rate above 50%) or the transcript is clearly
  shorter or longer than the line (under 70% or over 140% of its length: dropped words, a cut
  take, babble or words never in the script). Error rate is taken as the *minimum* over `text`
  (caption) and `say` (spoken, if it differs).

Before the error rate, both sides are folded to one spelling, so a correct reading that is
written another way is not an error. The folded text is used only for the comparison; the diff
report shows it.

- **Numbers** (`scripts/lib/stt-numbers.mjs`, `stt-numbers-cjk.mjs`). English: number words to
  digits ("twenty-five" → 25, "five point two" → 5.2), a number before thousand/million/billion,
  "$5" → "5 dollars", "%" → "percent", long unit names after a number to the short form
  ("nanometers" → nm, also mm, cm, km, m, mg, kg, g, KB/MB/GB/TB, MHz/GHz), and no space between a
  number and its unit. Korean: Sino-Korean and native numbers before a counter, and mixed digits
  ("2억 5000만" = "이억 오천만"). Chinese and Japanese: hanzi and kanji numerals, "百分之N".
- **Scripts** (`scripts/lib/stt-script-fold.mjs`). Traditional and Simplified Chinese are folded
  to one, katakana to hiragana, and a few kanji words with one reading to kana. Names in the
  `meta.pronounce` dictionary fold to their written form.
- **Limits.** The folding is a table of common characters and words, not a converter: a
  character or word not in it stays as written and counts as a difference. A lone number
  character with no counter or place word ("이", "一") is left alone, since it is usually a
  particle or part of a word. A language without a rule table is compared exactly. Add a
  language only with rules that read one way.

Every synthesized line gets `stt: {advisory, target, against, heard, cer, diffs,
grossMismatch, tailMatched}` in `timings.json`. These measurements are evidence for the
LLM, not a quality verdict. Read the target and transcript before deciding whether to
listen, edit locally, or regenerate. Names, homophones, and numeric spellings may differ
without an audio error. A clean later check clears an earlier heuristic `MISHEARD` flag;
it does not certify the pronunciation. A flag alone must not trigger a paid or slow retry.

STT maps a rare or invented name to a common word it knows, in any language. A high error rate
on a line with such a name, while the take's length stays the same across takes, is the STT's
limit, not a misread: do not keep re-making the line. Mark it in `FILM.md` as a point for the
owner to listen to, with its timestamp. The reverse holds too: STT cannot separate homophones,
so a clean check does not prove a name or a homophone was read the intended way
(`references/readout-en.md`).

- `--retry-flagged N` (default 0) — explicitly opts into re-synthesizing lines flagged `MISHEARD`/`SHORT`/`TAIL`/`HEAD`
  after the check up to `N` more times, keeping whichever take has the lower error rate, or the one that clears a
  `HEAD`/`TAIL` flag at no worse an error rate; a take that adds such a flag is never kept. Skipped
  for deterministic providers (`say`, `file`, `none`) — regenerating gives the same result.
  Prefer selecting confirmed problem lines with `--lines` after inspecting the evidence.
- `--no-stt` — skips the check entirely (drafts, or when no engine is set up).
- `--stt-only [--lines id,id]` — re-runs just the STT check against a reel's existing
  `voice/line-*.wav` files without synthesizing anything; updates `timings.json` in place and
  does not touch `narration.wav`. Lines are compared with `plan.json`'s current text, so it
  re-verifies a reel after an edit. It transcribes in the language `timings.json` records in
  `lang` (written by every voice run), falling back to `plan.meta.lang`. With `--lines` only
  those lines are checked. The model loads once and each line is saved as soon as it is checked;
  `voice/stt-pending.json` lists the lines not yet checked. A killed run, started again with
  the same command, resumes with those lines only; delete the file to check every line. A full
  voice run (no `--lines`) deletes it.
- Missing Python or a missing model never fails the voice step — it prints `STT check skipped:
  <reason>` and continues.

**Speech-to-text engines** (facts; the tool does not rank them).

| Setting | Meaning |
|---|---|
| `SVA_STT_ENGINE` | `mlx` (default; the mlx-whisper Python package) or `groq` (a hosted Whisper API) |
| `SVA_STT_PYTHON` | the Python that has mlx-whisper installed (engine `mlx`) |
| `SVA_STT_MODEL` | the first-pass model (default `small`) |
| `SVA_STT_MODEL_RECHECK` | the second-pass model (default `turbo`), run only on lines whose first transcript is doubtful |
| `SVA_STT_DOUBT_CER` | the error rate against the plan text above which a line is doubtful (default 0.15) |
| `SVA_STT_GROQ_MODEL` | the hosted model (default `whisper-large-v3-turbo`) |
| `GROQ_API_KEY` | the key for engine `groq`; read from the environment and never printed; no key = the check is skipped |

The mlx engine needs the `mlx-whisper` package in the Python that `SVA_STT_PYTHON` names
(Apple silicon macOS). One route: `python3 -m venv <dir>`, then `<dir>/bin/pip install mlx-whisper`,
then `SVA_STT_PYTHON=<dir>/bin/python`. Python 3.11 is a verified version; any version the mlx
wheels list for the machine works. `setup.mjs --check` prints this route while the engine is not
ready, and `--stt-models` only downloads models into an existing Python.

Audio leaves the machine only when `SVA_STT_ENGINE=groq` is set. A line the second model answers
keeps the transcript with the lower error rate, and the model that gave it is recorded in the
line's `stt.model`. A model that is not downloaded skips the check with a note;
`node scripts/setup.mjs --stt-models` downloads the two mlx-whisper models into the Hugging Face
cache (several hundred MB to a few GB), and `setup.mjs` lists the engines it can use.
Compare takes at equal loudness: `--takes` and `--pick-by stt` transcribe leveled copies, the
loudness an installed line gets, because the same take scored differently before and after
leveling.

## What the transcript cannot hear

The transcript check and the waveform check answer different questions. The transcript says whether
the words came out wrong, which is all or nothing: a word is said or it is not. Clicks, cuts and
abrupt starts or ends show only on the waveform and its level, so those are judged there, and no
transcript result clears them. After each line is made, `voice.mjs` reads the line's own audio, stores
the result in `timings.json` (`clipFacts`). `review.mjs` remeasures current `voice/line-<id>.wav`
files with the same perceptual edge rules. It ignores saved facts and reports missing or unreadable
clips as unchecked. `HEAD` and `TAIL` are the gate:
the line gets that `voiceFlag`, the run prints a `WARN` naming the line, and the fix is to re-make it
(`--lines <id>`, or `--retry-flagged N`, which keeps a take only when it does not add the flag). The
rest are facts to listen to.

The edge rule follows how loud the sound is to a listener, not its sample values: a last sample that
is not zero, or a hiss tens of decibels under the voice, is not a defect. Levels are K-weighted
loudness (ITU-R BS.1770-4, the weighting behind EBU R128) in 5 ms windows, relative to the line's own
loudness. A sound counts as audible when it is above a floor of 35 LU under the line (speech at about
65–70 dB SPL against a quiet room's 30–35 dBA; the equal-loudness contours of ISO 226 put the hearing
threshold for speech frequencies in that range) and above −65 LUFS, raised to the level of the bed
that masks it where the clip is placed under one. The constants are in `scripts/lib/perceived-level.mjs`.

| Result | Means |
|---|---|
| `HEAD` (gate) | sound is already audible in the first 15 ms (within 15 LU of the line's own loudness) that is not a soft rise: a cut start, or the end of the previous line carried over |
| `TAIL` (gate) | the line ends while it still sounds: the last 20 ms is still within 5 LU of the line's own loudness (loud enough to be heard as a cut), at a level above what the bed under it masks |
| `DIP` | a 150 ms stretch 15 dB under the line's median level, with sound on both sides |
| `PAUSE` | 0.35 s or more of silence inside the voiced span |

`voice.mjs <reel> --pitch [--lines id,id] [--words]` reports where the pitch goes in each
installed line, and only reports: the voiced share, the median and range, and the end contour (a
rise, fall or level, in semitones against the voiced stretch before it). `--words` adds the shape
of each word (rising, falling, level, dipping, peaking, unvoiced; one word is one syllable in
Vietnamese and Chinese). A line whose text ends in a question mark is listed with its measured end
contour. It writes `out/pitch.json`. It measures pitch; it cannot judge whether a rise, a fall or
a tone is the right one in that language (a question's rise, a lexical tone, a Vietnamese tone
contour). That judgement is the reader's, for the language of the line.

## Comparing takes

`--takes` synthesizes more than one candidate for a line before committing to one — for a count
(`--takes N`, same text, fresh samples) or for tone (`--takes <tone>,<tone>`, one take per
delivery mark, freely chosen from `scripts/lib/tags.mjs` `EMOTIONS` for the film, e.g.
`confident` — a line's own mark is replaced by it for that take). Requires `--lines`.

The intended use is a tone comparison on the opening line only: compare 2–4 tones, the user
picks, the pick becomes `meta.voice.delivery`, and the remaining lines are made once in it —
SKILL.md's flow asks whether to compare tones before building a film; if not chosen, or
unattended, one take.

Compare → pick → restore. Each take is kept as `voice/takes/<id>-<k>.wav` with its STT CER and
duration, printed as a table. `--takes` only makes candidates: it never changes an installed
`voice/line-<id>.wav`, timings.json or narration.wav. Install one with
`--pick <id>=<k>[,<id>=<k>]` — no re-synthesis, just the copy + rebuild as `--lines` does. Picking
a take from a tone comparison also writes that mark to `meta.voice.delivery`, so every later line
is made in it. The clip a pick (or `--use`) replaces is kept first as
`voice/takes/<id>/installed-<timestamp>.wav` and its path is printed; restore it with
`--use <id>=<that file>`. A line with no installed clip yet (first synthesis through `--takes`)
gets take 1 installed so the reel is complete.

Hosted voices can read the same text at quite different lengths from take to take. When a line
has to fit a slot (a dub line, a fixed picture beat), make a few takes and let the tool pick:
`--pick-by length:<sec>` installs the take closest to that length (at the film's speed),
`--pick-by stt` the one with the lowest STT error rate. Either prints the take table first,
with the chosen take marked. With `--takes` it installs the choice at once; alone it reads the
takes already in `voice/takes/` for the `--lines` ids (default: every line in
`voice/takes/manifest.json`).

- The take installed now is a row of its own (`installed`) and wins ties, so a better existing
  take is never replaced by a worse new one; when it scores best, nothing is installed.
- The `slot` column shows each take against the line's slot. A take that runs over the slot is
  never chosen, and when no take fits, that line is refused and the run ends with an error.
- The `end` column (pitch at the line's end) and the `defects` column (`HEAD`, `DIP`, `PAUSE`)
  appear when the audio shows any. They are facts for you to weigh, not part of the choice.

A line made somewhere else — tone variants in a scratch reel, another provider, the other version
of an A/B, a recording — goes in with `--use <id>=<wav>[,<id>=<wav>]` (add `--retime` when its
length differs). The file is taken as finished: the film's speed is not applied again. Takes in
`voice/takes/` are raw and get the speed on `--pick`; a finished `voice/line-<id>.wav` already has
it, so copying one into `takes/` and picking it speeds it up twice.

Punctuation (`!`, `?`) and delivery marks do not reliably set how a line ends, and engines
without tags drop the marks. When a line needs a different tone, vary the wording as well — a
shouted name, a lead-in, a beat before the last word — make the variants in a scratch reel, let
the user listen, and install the pick with `--use`.

Never runs TTS in parallel — one request at a time, even across takes.

## When to confirm the voice before building the film

Re-voicing after the picture is cheap when the render itself is cheap to redo: a picture-first
film (`dub.mjs`) only re-dubs the audio track; a 2D film whose new take keeps its slot only
remixes the audio, and re-rendering the shots a longer take moved takes minutes. In those cases,
build the film and fix the voice after.

Voice-first films where a length change shifts every later shot — 3D chief among them — are the
expensive case: a 40 s 3D film took 11–20 min to render, so a wrong tone found only after that
render means redoing it. There, play the whole narration and confirm it before building any
scenes.

**End the reference on a finished sentence.** A clip cut mid-sentence (and its `refText`) makes
the clone continue it: the last word of the reference leaks onto the start of generated lines.
Trim the clip to its last complete sentence before using it.

**One reference = one consistent voice.** Use the same `refAudio` for every line of a film.
A reference is 5–15 s of clean speech plus its exact transcript in `refText`. `voice.mjs` refuses
to run `qwen3` or `fishspeech` with a clip outside that range. Clone only
a voice whose owner agreed to it.

## Cloning the user's voice (Fish Audio)

The user records 15–30 s of natural speech in a quiet room, no music. Create a voice model in the
Fish Audio console (or via their official skill: `npx skills add https://docs.fish.audio`) and put
its id in `FISH_AUDIO_VOICE_ID`. Sample quality decides clone quality — a noisy sample gives an
uncanny half-version. Cloning a voice needs that person's consent; do not clone anyone else.

## A line in another language

A plan line may carry `lang` (BCP 47), which replaces `meta.lang` for that line only — an English
greeting inside a Korean film:

```json
{ "meta": { "lang": "ko-KR" },
  "lines": [ { "id": "hi", "lang": "en", "text": "Hello, everyone." },
             { "id": "intro", "text": "오늘은 영상 만드는 법을 알려드릴게요." } ] }
```

For that line: the voice is made in `en` (Typecast sends its `language` code, `eng`; other providers
get the same `lang` where they take one); lines of one voice are sent in one request per language,
so the read stays one per language; the speech-to-text check transcribes it in `en`, and its
`--stt-only` and `--pick-by stt` passes do too (`timings.json` records the line's `lang`); the
built-in respellings and the read-out rules are the line's language's (`references/readout.md`
lists the page per language); the caption break rules (`validate-plan.mjs --breaks`, the engine's
fallback) use it. A voice made for one language reads another with an accent, so a voice that
reads that language natively is a good choice.

## Pronunciation

Before synthesis, rewrite the spoken text (not the caption) for names, numbers and English terms
the voice will misread: `MCP` → `엠씨피`, `2026년` stays, `D-day` → `디데이`. Keep the caption text as
written. `plan.json` lines may carry `say` (spoken) alongside `text` (caption) when they differ;
write why in the line's `sayWhy` when the difference is on purpose (never spoken or shown), or
`validate-plan.mjs` warns that a `say` above 0.3 character error rate from its `text` may be
left over from an older text (`references/script-review.md`).
A word that recurs goes in the `meta.pronounce` dictionary once (respelling, or IPA for engines
that read SSML phoneme tags). Numbers, names, the sounds the spelling hides, and the three ways
to fix a stubborn word, per language: `references/readout.md`.

**Quote marks are not sent to the voice.** In every language, quote marks (straight and curly
double quotes, guillemets, CJK corner brackets) are removed from the spoken text before synthesis,
because an engine can read one as a pause or a word. Captions keep them. A single quote that
touches a letter is an apostrophe and stays (`don't`, `dogs' bones`, `rock 'n' roll`); a single
quote goes only when it opens and closes a quoted span (`'ship it'`) or touches no letter or
digit. The same applies to a `|` caption break, which is never spoken.

## Fixing one line

When one line sounds wrong (a misread, a flat take, a clipped ending), re-record only that
line; do not regenerate the film's voice. Every line is recorded on its own and joined anyway,
so a swapped line sits as naturally as the rest, and the lines the user already liked stay.

```
edit the line's `say` in plan.json (spacing and commas steer the reading: 사 점사 vs 사점사)
node scripts/voice.mjs <reel> --lines <lineId>[,<lineId>]
```

- A re-made take is fitted to the old line's slot, in the order `dub.mjs` fits a language:
  1. trim the clip's edges to its voiced span;
  2. speed it up by at most 1.1× if it is longer than the slot (`atempo`, pitch kept);
  3. keep at least 0.5 s of breath after it;
  4. leave a voice-free gap of at most 1.0 s (a much shorter take is slowed by at most 0.95×,
     then reported);
  5. a take that still does not fit is **refused**: the old clip stays, the take is kept at
     `voice/takes/<id>/refused-<stamp>.wav`, the other lines install, and the run ends with an
     error naming the line. Make that voice again: shorten the line's `text` or `say`, or run
     `--lines <id>` again for a new take. No take moves the lines after it, so the picture
     needs no change.
  `voice.mjs` prints one line per take with its length against the slot and against the take it
  replaces, plus its STT error rate against the old one, so a padded take is not mistaken for the
  wrong one: `<id>: take 2.97s fitted to its slot 4.56s (+1.59s silence)` or `(sped up 1.04x)`.
  The same fit applies to a take installed with `--pick` or `--use`.
- A take that needs some of the breath after it keeps the next line's start; the shorter pause it
  left is recorded on its `timings.json` line (`borrowedPause: {plannedSec, laidSec}`). Every later
  rebuild that reuses the clip (`--lines`, `--lines ""`, `--retime`, a `--pick` of other lines) lays
  the same pause again, so the lines after it do not move. It holds while the plan's pause after that
  line is the one it was borrowed from: change `pauseAfterMs`, or re-make the line, and the plan's
  pause applies (a full pass lays everything out again).
- `--pick` and `--pick-by` work while the plan has new lines with no audio yet: the picked lines are
  installed, the new ones are left out of that rebuild, and one note names them. Make them next with
  `--lines <ids>` or a full pass.
- `--retime` is the opt-in to let a re-made line keep its own length: later lines move and their
  shots re-render. Use it for a wording change, not a pronunciation fix. `voice.mjs` lists the
  moved lines ("lines with shifted start").
- In a dub folder (`dub/<code>/`) a re-made take keeps its natural length (as with `--retime`, no
  flag needed). The line's real limit is the base-language slot on the picture, which `dub.mjs`
  fits by the same steps (`--min-gap`); the picture does not move, and `dub.mjs` re-places the
  lines. `voice.mjs` prints one line saying so.
- A take installed unfitted (`--retime`, or in a dub folder) prints its length against the slot the
  line has on the picture, as a ratio: `<id>: take 3.21s against slot 2.37s = 1.354x (35.4% over
  its slot); installed at its own length (--retime)`. A reel's slot is the old line's slot; in a
  dub folder it is the base reel's line slot (`voice/timings.json` two folders up). Over 1x means
  `dub.mjs` has to speed it up (limit 1.1x) or the picture needs room; read it before running
  `dub.mjs`. Nothing is refused.
- The lines you did not touch keep their measured word times (shifted with their start), with
  `--lines`, `--pick` and `--use` alike.
- A finished take that needs a breath inside it gets one without re-synthesis:
  `--insert-pause <id>@<word-index>=<ms>` inserts that much silence at the quietest 10 ms
  between that word and the next, and shifts the later word times by the same amount.
- Keep a copy of `voice/` before a larger redo, so the user can compare and go back.

## Timing model

- Every line is leveled to -16 LUFS integrated (true peak <= -1.5 dBTP), a single measured gain
  per line, before `narration.wav`/`timings.json` are built — set `meta.voice.levelLines: false`
  to turn this off. `dub.mjs` levels each dub line's clip the same way before placing it. The
  boost is capped at +12 dB so a very quiet take is not raised into noise; a line that hits the
  cap stays under -16 LUFS, and `voice.mjs` and `dub.mjs` print `WARN: line "<id>" boost capped`
  with how far under it stays.
- Head 0.4 s, gap `meta.gapMs` (default 700 ms) between lines, tail 0.4 s. A line's own
  `pauseAfterMs` replaces the gap after it: short when the next line continues the thought, long
  at a scene change (`references/script-review.md`, "Narration that flows"). Changing pauses
  needs no re-synthesis: `voice.mjs --lines ""` re-lays the existing clips. A line's
  `pauseBeforeMs` adds silence before it, after the previous line's pause: the picture plays that
  long before the line starts (a first line: after the head). It is recorded as `pauseBeforeSec`
  in `timings.json`, the silence gate lists it as planned, and a re-take is not charged for it.
- Line start/end are measured from the synthesized audio. Word times are measured too, and always
  carry the caption's words (key `w`, "MCP를"), even where the voice read a respelling ("엠씨피를"):
  ElevenLabs reports its own; for every other engine the speech-to-text check reports when each
  word was said, trimmed to where its sound starts and stops, so a pause shows as a gap between
  words.
- Caption words are matched to the heard words letter by letter, not by position: both sides
  drop spaces and punctuation and read numbers out ("3분" = "삼 분", "9:15" = "9시 15분",
  "21" = "twenty-one"), so a caption word split or merged differently by the speech-to-text
  ("대관람차" heard as "대관 람차의") still gets its own start and end. A caption word that was not
  said ("집합" when the voice says "모여") or matched under half its letters takes a share of the
  time between its measured neighbours, by letters. Each `timings.json` line records
  `wordsMeasured`: how many of its words carry measured times; the rest were interpolated.
  Words follow the spoken order: a caption word the voice says out of the caption's order is
  interpolated, not measured. Key a beat to a measured word where it matters.
- Without `SVA_STT_PYTHON` (or with `--no-stt`) word times fall back to an even spread by letters
  across the line (`wordsMeasured: 0`), which has been up to ~0.4 s off the sound and misses
  pauses. Word ends inside continuous speech are less exact than word starts; land beats on starts.
  After a pause inside a line, a caption word starts where its sound begins, not where the
  speech-to-text pass put it (`voice.mjs` snaps it to the audio after each line is made;
  `--stt-only` does the same).
- **Do not cut a line's audio at a word end.** A word end is the least exact time, and a cut there
  clips the first sound of the next word. To split speech after a word, synthesize the two parts
  as separate lines and put the pause between them (`pauseAfterMs`, or `--insert-pause` on a
  finished line); never trim one take at a word end.
- Shorts pacing: the user picks 1.0–1.2× at the start (SKILL.md Flow 1); unanswered, a Short speaks at `meta.voice.rate` 1.1 in every language (ffmpeg atempo, clamped
  0.8–1.3); a local voice at its own speed sounds slow there. On a 9:16 film with no rate set,
  `voice.mjs` fills this in and says so. If the total is still over target, cut lines rather
  than speeding further.
- A line's own `rate` (0.5–2) replaces the film's rate for that line — for a deliberately rushed
  run, such as a quick list of extras that should feel like "and much more".

## Local edits and finished-video replacement

Use [audio editing guide](../guides/audio-editing.md) to resize pauses or adjust tempo in existing
WAVs from any provider. [Audio-only replacement](../guides/audio-editing.md#replace-narration-in-a-finished-video) copies a
finished video and replaces its narration without rendering frames.
