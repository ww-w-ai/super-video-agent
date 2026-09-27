# Voice — providers, timing, cloning

`node scripts/voice.mjs <dir> --provider <name>` synthesizes each `plan.json` line, measures it,
and writes `voice/narration.wav` + `voice/timings.json`. The film reads only `timings.json`.

## Choosing a provider

```
if the user supplied recordings                    → file        (voice/in/<lineId>.wav|mp3|m4a)
elif local Qwen3-TTS found and a reference voice    → qwen3       (local clone, Apache-2.0, commercial OK)
elif FISH_AUDIO_API_KEY is set                      → fish        (hosted; cloned or library voice)
elif ELEVENLABS_API_KEY is set                      → elevenlabs  (hosted; native word timestamps)
elif local MeloTTS found                            → melotts     (local, MIT, one Korean speaker, fast)
elif macOS                                          → say         (zero-setup draft voice)
else                                                → none        (silent; captions carry it)
```

`voice.mjs` picks this order when `--provider` is omitted and prints why. Tell the user which
provider ran. `say` is for drafts and timing only — viewers notice robotic voices ("can't
understand the voice" is a top public complaint).

| Provider | Setup | License of output | Word timings |
|---|---|---|---|
| `qwen3` | `SVA_QWEN3_PYTHON` (path to a python venv with qwen3-tts installed); `meta.voice.refAudio` + `refText`; `model` 0.6B (default) or 1.7B | Apache-2.0 weights — commercial OK | estimated |
| `fishspeech` | `SVA_FISH_DIR`; `meta.voice.refTokens` (.npy) + `refText` | **CC-BY-NC-SA-4.0 — non-commercial only**; never for promos or monetized videos | estimated |
| `melotts` | `SVA_MELO_PYTHON` | MIT | estimated |
| `fish` | `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID` (reference_id = clone id) | per Fish Audio plan | estimated |
| `elevenlabs` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | per ElevenLabs plan | provider alignment |
| `say` | `SAY_VOICE` (default `Yuna`) | draft use | estimated |
| `file` / `none` | — | user's own | estimated |

## Local clone (qwen3) — what can go wrong

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
not flagged, and need no action.

- `--retry-flagged N` (default 1) — re-synthesizes lines still flagged `MISHEARD`/`SHORT`/`TAIL`
  after the check up to `N` more times, keeping whichever take has the lower error rate. Skipped
  for deterministic providers (`say`, `file`, `none`) — regenerating gives the same result.
- `--no-stt` — skips the check entirely (drafts, or when `faster-whisper` isn't installed).
- `--stt-only` — re-runs just the STT check against a reel's existing `voice/line-*.wav` files
  without synthesizing anything; updates `timings.json` in place. Useful to re-verify a reel after
  the fact, or as a lighter-weight check inside the skill.
- Missing Python or `faster-whisper` never fails the voice step — it prints `STT check skipped:
  <reason>` and continues.


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
  The picture needs no change.
- A take more than 1.1× longer moves every later line; `voice.mjs` lists them ("lines with
  shifted start"). Re-render those shots, or pass `--retime` on purpose.
- Keep a copy of `voice/` before a larger redo, so the user can compare and go back.

## Timing model

- Head 0.4 s, gap `meta.gapMs` (default 250 ms) between lines, tail 0.4 s. A line's own
  `pauseAfterMs` replaces the gap after it: short when the next line continues the thought, long
  at a scene change (`references/script-review.md`, "Narration that flows"). Changing pauses
  needs no re-synthesis: `voice.mjs --lines ""` re-lays the existing clips.
- Line start/end are measured from the synthesized audio. Word times come from the provider when it
  gives them, otherwise proportional to characters inside the measured line — good enough to land a
  visual beat on a word within ~0.2 s, not for karaoke captions.
- Shorts pacing: `meta.voice.rate` 1.1–1.2 tightens slow local voices (ffmpeg atempo, clamped
  0.8–1.3). If the total is still over target, cut lines rather than speeding further.
- A line's own `rate` (0.5–2) replaces the film's rate for that line — for a deliberately rushed
  run, such as a quick list of extras that should feel like "and much more".
