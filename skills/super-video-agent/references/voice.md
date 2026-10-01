# Voice — providers, timing, cloning

`node scripts/voice.mjs <dir> --provider <name>` synthesizes each `plan.json` line, measures it,
and writes `voice/narration.wav` + `voice/timings.json`. The film reads only `timings.json`.

## Choosing a provider

```
if the user supplied recordings                    → file        (voice/in/<lineId>.wav|mp3|m4a)
elif local Qwen3-TTS found and a reference voice    → qwen3       (local clone, Apache-2.0, commercial OK)
elif FISH_AUDIO_API_KEY (or FISH_API_KEY) is set    → fish        (hosted; cloned or library voice)
elif ELEVENLABS_API_KEY is set                      → elevenlabs  (hosted; native word timestamps)
elif local MeloTTS found                            → melotts     (local, MIT, one Korean speaker, fast)
else                                                → stop and list what to set up
```

`voice.mjs` picks this order when `--provider` is omitted and prints why. Tell the user which
provider ran. `none` (silent; captions carry it) and `say` run only when asked for. `say` is
macOS only and for drafts and timing only — viewers notice robotic voices ("can't
understand the voice" is a top public complaint).

| Provider | Setup | License of output | Word timings |
|---|---|---|---|
| `qwen3` | `SVA_QWEN3_PYTHON` (path to a python venv with qwen3-tts installed); `meta.voice.refAudio` + `refText`; `model` 1.7B (default, recommended) or 0.6B (lighter, less clear); `SVA_QWEN3_MODEL` sets the default for every film | Apache-2.0 weights — commercial OK | speech-to-text |
| `fishspeech` | `SVA_FISH_DIR`; `meta.voice.refTokens` (.npy) + `refText` | **CC-BY-NC-SA-4.0 — non-commercial only**; never for promos or monetized videos | speech-to-text |
| `melotts` | `SVA_MELO_PYTHON` | MIT | speech-to-text |
| `fish` | `FISH_AUDIO_API_KEY` (or `FISH_API_KEY`), `FISH_AUDIO_VOICE_ID` (reference_id = clone id) | per Fish Audio plan | speech-to-text |
| `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | per ElevenLabs plan | engine alignment |
| `say` | macOS only; `SAY_VOICE` (default `Yuna`); runs only with `--provider say` | draft use | speech-to-text |
| `file` / `none` | — | user's own | speech-to-text |

Hosted models (`meta.voice.model`):

| Provider | Default | Other models | Cost |
|---|---|---|---|
| `fish` | `s2.1-pro-free` | `s2.1-pro` (its paid twin; set it once the free model ends), `s2-pro`, `s1` | billed per UTF-8 byte of input ($15 per million; Korean is 3 bytes a character). The default `s2.1-pro-free` is the same model at no cost while Fish Audio offers it (announced through 2026-11-30); its requests may be used to train their models. A private cloned voice can be created with an API key alone (POST /model); Fish's web app needs a paid plan for one |
| `elevenlabs` | `eleven_multilingual_v2` | `eleven_v3`, `eleven_v4`, `eleven_flash_v2_5` | billed per character; instant cloning and commercial use from the Starter plan. A restricted API key needs the text-to-speech and voice permissions |

Neither provider documents a per-request minimum, so one request per line costs the same as one
long request, and keeps each line regenerable on its own.

For a film that will be public, record in `FILM.md` the provider, model and voice used and what
their terms say about public and commercial use of the output — a free tier may use requests for
training, and a library voice has its own owner's terms. List the confirmation under "Needs from
the owner" unless the owner has already cleared it.

## Delivery marks

Write delivery directions as our own marks in curly braces, in the line's `say`, never in
`text` (the caption). Each voice provider translates them into its model's own tags (`tagMap`
in `scripts/voice/<provider>.mjs`); a mark the model has no tag for is dropped, and an engine
that reads no tags (qwen3, MeloTTS, say, Fish s1, ElevenLabs before v3) gets the line without
any. The same plan works on every engine.

```json
{ "id": "l14", "text": "텔레칩스도 할 수 있고, 해야 합니다.",
  "say": "{confident} 텔레칩스도 할 수 있고, {pause} 해야 합니다." }
```

| Mark | Fish Audio S2 | ElevenLabs v3/v4 |
|---|---|---|
| `{pause}` / `{long-pause}` | `[break]` / `[long-break]` | `[pauses]` / `[pauses]` |
| `{emphasis}` | `[emphasis]` | dropped |
| `{whisper}` | `[whispering]` | `[whispers]` |
| `{soft}` / `{hurry}` / `{shout}` | `[soft tone]` / `[in a hurry tone]` / `[shouting]` | dropped |
| `{laugh}` / `{chuckle}` | `[laughing]` / `[chuckling]` | `[laughs]` / `[laughs]` |
| `{sigh}` / `{gasp}` | `[sighing]` / `[gasping]` | `[sighs]` / `[gasps]` |
| `{clear-throat}` | `[clear throat]` | dropped |
| an emotion: `{confident}` `{determined}` `{excited}` `{calm}` `{proud}` `{hopeful}` `{happy}` `{sad}` `{nervous}` `{curious}` `{surprised}` `{grateful}` `{serious}` `{warm}` `{sarcastic}` `{annoyed}` | the same word in brackets | the same word in brackets |

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
synthesis, `voice.mjs` transcribes every synthesized line back to text (`faster-whisper`, offline,
local) and compares it against the intended line:

- **SHORT** — the qwen3 provider's own duration gate: shorter than the text could plausibly take.
- **TAIL** — the qwen3 provider's own tail-RMS gate: still sounding in the final ~30ms, a cut
  syllable. The STT check can clear this: if the transcript's last two characters match the
  intended line's, the syllable wasn't actually cut — `TAIL` is removed and `stt.tailCleared: true`
  is recorded instead.
- **MISHEARD** — the STT check's own gate, for gross errors only. STT has its own error, so it
  flags a take only when most of it is wrong (error rate above 50%) or the transcript is clearly
  shorter or longer than the line (under 70% or over 140% of its length: dropped words, a cut
  take, babble or words never in the script). Error rate is taken as the *minimum* over `text`
  (caption) and `say` (spoken, if it differs).

Every synthesized line gets an `stt: {heard, cer, diffs}` entry in `timings.json` regardless of
flag. Small differences (a name, a near-homophone, spacing) are STT noise: they are recorded but
not flagged, and need no action. A clean later check clears an earlier `MISHEARD` flag.

STT maps a rare or invented name to a common word it knows, in any language. A high error rate
on a line with such a name, while the take's length stays the same across takes, is the STT's
limit, not a misread: do not keep re-making the line. Mark it in `FILM.md` as a point for the
owner to listen to, with its timestamp. The reverse holds too: STT cannot separate homophones,
so a clean check does not prove a name or a homophone was read the intended way
(`references/readout-en.md`).

- `--retry-flagged N` (default 1) — re-synthesizes lines still flagged `MISHEARD`/`SHORT`/`TAIL`
  after the check up to `N` more times, keeping whichever take has the lower error rate. Skipped
  for deterministic providers (`say`, `file`, `none`) — regenerating gives the same result.
- `--no-stt` — skips the check entirely (drafts, or when `faster-whisper` isn't installed).
- `--stt-only` — re-runs just the STT check against a reel's existing `voice/line-*.wav` files
  without synthesizing anything; updates `timings.json` in place. Useful to re-verify a reel after
  the fact, or as a lighter-weight check inside the skill. It transcribes in the language
  `timings.json` records in `lang` (written by every voice run), falling back to
  `plan.meta.lang`.
- Missing Python or `faster-whisper` never fails the voice step — it prints `STT check skipped:
  <reason>` and continues.

## Comparing takes

`--takes` synthesizes more than one candidate for a line before committing to one — for a count
(`--takes N`, same text, fresh samples) or for tone (`--takes <tone>,<tone>`, one take per
delivery mark, freely chosen from `scripts/lib/tags.mjs` `EMOTIONS` for the film, e.g.
`confident` — a line's own mark is replaced by it for that take). Requires `--lines`.

The intended use is a tone comparison on the opening line only: compare 2–4 tones, the user
picks, the pick becomes `meta.voice.delivery`, and the remaining lines are made once in it —
SKILL.md's flow asks whether to compare tones before building a film; if not chosen, or
unattended, one take.

Each take is kept as `voice/takes/<id>-<k>.wav` with its STT CER and duration, printed as a table;
take 1 installs automatically (copied into `voice/line-<id>.wav`,
narration.wav/timings.json rebuilt as `--lines` does). Pick a different one on a later run with
`--pick <id>=<k>[,<id>=<k>]` — no re-synthesis, just the copy + rebuild. Picking a take from a
tone comparison also writes that mark to `meta.voice.delivery`, so every later line is made in it.

Hosted voices can read the same text at quite different lengths from take to take. When a line
has to fit a slot (a dub line, a fixed picture beat), make a few takes and let the tool pick:
`--pick-by length:<sec>` installs the take closest to that length, `--pick-by stt` the one with
the lowest STT error rate. Either prints the take table first.

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
to run `qwen3` or `fishspeech` with a clip outside that range. The
reference's own license and consent carry over: a clip generated by a non-commercial model, or
someone's voice without consent, cannot become a commercial narrator.

## Cloning the user's voice (Fish Audio)

The user records 15–30 s of natural speech in a quiet room, no music. Create a voice model in the
Fish Audio console (or via their official skill: `npx skills add https://docs.fish.audio`) and put
its id in `FISH_AUDIO_VOICE_ID`. Sample quality decides clone quality — a noisy sample gives an
uncanny half-version. Cloning a voice needs that person's consent; do not clone anyone else.

## Pronunciation

Before synthesis, rewrite the spoken text (not the caption) for names, numbers and English terms
the voice will misread: `MCP` → `엠씨피`, `2026년` stays, `D-day` → `디데이`. Keep the caption text as
written. `plan.json` lines may carry `say` (spoken) alongside `text` (caption) when they differ.
A word that recurs goes in the `meta.pronounce` dictionary once (respelling, or IPA for engines
that read SSML phoneme tags). Numbers, names, the sounds the spelling hides, and the three ways
to fix a stubborn word, per language: `references/readout.md`.

## Fixing one line

When one line sounds wrong (a misread, a flat take, a clipped ending), re-record only that
line; do not regenerate the film's voice. Every line is recorded on its own and joined anyway,
so a swapped line sits as naturally as the rest, and the lines the user already liked stay.

```
edit the line's `say` in plan.json (spacing and commas steer the reading: 사 점사 vs 사점사)
node scripts/voice.mjs <reel> --lines <lineId>[,<lineId>]
```

- The new take is fitted to the old slot: padded if shorter, sped up by at most 1.1× if longer.
  The picture needs no change. `voice.mjs` prints one line per fitted take, so a padded take is
  not mistaken for the wrong one: `<id>: take 2.97s fitted to its slot 4.56s (+1.59s silence)`
  or `(sped up 1.04x)`. The same applies to a take installed with `--pick` or `--use`.
- A take more than 1.1× longer keeps its own length and moves every later line; `voice.mjs`
  says so on that take's line (`keeps its own length … later lines shift +0.64s`) and lists the
  moved lines ("lines with shifted start"). Re-render those shots, or pass `--retime` on purpose. In a dub folder
  (`dub/<code>/`) nothing re-renders: the picture does not move, and `dub.mjs` re-places the
  lines; `voice.mjs` says so there.
- The lines you did not touch keep their measured word times (shifted with their start), with
  `--lines`, `--pick` and `--use` alike.
- A finished take that needs a breath inside it gets one without re-synthesis:
  `--insert-pause <id>@<word-index>=<ms>` inserts that much silence at the quietest 10 ms
  between that word and the next, and shifts the later word times by the same amount.
- Keep a copy of `voice/` before a larger redo, so the user can compare and go back.

## Timing model

- Every line is leveled to -16 LUFS integrated (true peak <= -1.5 dBTP), a single measured gain
  per line, before `narration.wav`/`timings.json` are built — set `meta.voice.levelLines: false`
  to turn this off. `dub.mjs` levels each dub line's clip the same way before placing it.
- Head 0.4 s, gap `meta.gapMs` (default 700 ms) between lines, tail 0.4 s. A line's own
  `pauseAfterMs` replaces the gap after it: short when the next line continues the thought, long
  at a scene change (`references/script-review.md`, "Narration that flows"). Changing pauses
  needs no re-synthesis: `voice.mjs --lines ""` re-lays the existing clips.
- Line start/end are measured from the synthesized audio. Word times are measured too, and always
  carry the caption's words (`text`, "MCP를"), even where the voice read a respelling ("엠씨피를"):
  ElevenLabs reports its own; for every other engine the speech-to-text check reports when each
  word was said, trimmed to where its sound starts and stops, so a pause shows as a gap between
  words. Without `SVA_STT_PYTHON` (or with `--no-stt`) word times fall back to an even spread by
  letters across the line, which has been up to ~0.4 s off the sound and misses pauses. Word ends
  inside continuous speech are less exact than word starts; land beats on starts.
- Shorts pacing: the user picks 1.0–1.2× at the start (SKILL.md Flow 1); unanswered, a Short speaks at `meta.voice.rate` 1.1 in every language (ffmpeg atempo, clamped
  0.8–1.3); a local voice at its own speed sounds slow there. On a 9:16 film with no rate set,
  `voice.mjs` fills this in and says so. If the total is still over target, cut lines rather
  than speeding further.
- A line's own `rate` (0.5–2) replaces the film's rate for that line — for a deliberately rushed
  run, such as a quick list of extras that should feel like "and much more".
