# Question intonation and read-out accuracy in four TTS models: a Korean narration test (September 2026)

[한국어](tts-models.ko.md)

## Summary

We tested four text-to-speech (TTS) setups on the same two Korean questions and measured whether
the last syllable rises more than +2 semitones (st) over the syllable before it. ElevenLabs
`eleven_v3` rose most often (5 of 10 takes), ElevenLabs `eleven_multilingual_v2` rose 4 of 10,
Fish Audio `s2.1-pro-free` rose 3 of 23 measurable takes (7 of its 30 takes had no detectable
syllable break and could not be scored), and Qwen3-TTS 1.7B (a clone of the user's own voice)
never rose (one take landed exactly at +2.0 st, the cutoff). A speech-to-text (STT) check found
that all four models were heard as "토크는" instead of "토큰은" on every take of one question — a
mishearing shared across models, not a defect of any single one. Numbers are from our
own runs, not vendor claims; plans and prices change, so check each vendor's current terms.

## Setup

| Model | Version / id | Voice | Rate |
|---|---|---|---|
| Fish Audio | `s2.1-pro-free`, voice `f030884c7c5d4892a7f991d98cf67d63` | Fish Audio stock voice | 1.1× |
| ElevenLabs | `eleven_multilingual_v2`, voice `EXAVITQu4vr4xnSDxMaL` ("Sarah", an English stock voice) | same | 1.1× |
| ElevenLabs | `eleven_v3`, same voice id | same | 1.1× |
| Qwen3-TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | clone of the user's own voice, from a 5–15 s reference clip with a matching transcript | 1.1× in this test (1.3× in our approved Korean film) |

- **Sentences.** Two Korean questions: "다음 토큰은 뭘까?" ("what comes next," a wh-question) and
  "여기가 엔비디아 세상인가?" ("is this an NVIDIA world," a yes/no question).
- **Takes per line.** Fish Audio: 5 phrasing variants × 3 takes = 15 takes per sentence (30
  total). ElevenLabs and Qwen3-TTS: 5 takes per sentence, no phrasing variants (10 total each).
- **Tags tried (Fish Audio only).** Plain text with `{confident}`; `{curious}`; `{confident}
  [asking a question]`; `{confident} [questioning tone, rising at the end]`; `{confident}` with
  the line ended `??` instead of `?`.
- **Date.** September 2026.
- **Hardware (Qwen3-TTS only, local).** Apple Silicon Mac, `mps` backend.

## Method

- **Pitch extraction.** Praat, through `praat-parselmouth`, sampled every 10 ms (pitch floor 90
  Hz, ceiling 500 Hz).
- **Syllable segmentation.** A voiced stretch of at least 50 ms (5 samples at the 10 ms step)
  counts as one syllable nucleus. The last two nuclei in a take are read as the last syllable and
  the syllable before it.
- **Rise threshold.** Delta in semitones = 12 × log2(median f0 of the last nucleus ÷ median f0 of
  the previous nucleus). More than +2 st counts as a rise.
- **Why not a fixed window.** Comparing the last 0.2 s with the preceding 0.5 s lets
  higher-pitched syllables earlier in the sentence into that 0.5 s reference, so a take that
  genuinely rose at the end can read as flat. Comparing only the two adjacent syllable nuclei
  avoids that.
- **Unmeasurable takes.** Some takes have no gap between the last two syllables — the voicing runs
  together and fewer than two nuclei are found. These are counted separately as unmeasurable, not
  folded into "did not rise," because they were never scored.
- **STT check and CER.** Each take is transcribed back by speech-to-text and compared with the
  script line. Character error rate (CER) is the fraction of characters that differ from the
  reference text. The narration pipeline only flags lines whose CER is high enough to sound badly
  wrong; a small CER like the one below is not flagged.

## Results

### Rise counts by model

| Model and voice | Takes that rose |
|---|---|
| Fish `s2.1-pro-free`, 5 phrasing variants | 3 of 23 measurable takes (7 of 30 total takes unmeasurable) |
| ElevenLabs `eleven_multilingual_v2`, "Sarah" | 4 of 10 ("세상인가?" 4/5, "뭘까?" 0/5) |
| ElevenLabs `eleven_v3`, "Sarah" | 5 of 10 ("뭘까?" 3/5, "세상인가?" 2/5) |
| Qwen3-TTS 1.7B, clone of the user's voice | 0 of 10 (one take at exactly +2.0 st) |

### Fish Audio, per take (5 variants: A = plain `{confident}`, B = `{curious}`,
C = `{confident} [asking a question]`, D = `{confident} [questioning tone, rising at the end]`,
E = `{confident}` with `??`)

| Line | Sentence | Variant | Delta (st) | Rose |
|---|---|---|---|---|
| tA1 | 다음 토큰은 뭘까? | A | +1.2 | no |
| tA2 | 다음 토큰은 뭘까? | A | -2.3 | no |
| tA3 | 다음 토큰은 뭘까? | A | +4.5 | yes |
| tB1 | 다음 토큰은 뭘까? | B | +1.3 | no |
| tB2 | 다음 토큰은 뭘까? | B | -1.2 | no |
| tB3 | 다음 토큰은 뭘까? | B | -11.7 | no |
| tC1 | 다음 토큰은 뭘까? | C | — | unmeasurable |
| tC2 | 다음 토큰은 뭘까? | C | +0.6 | no |
| tC3 | 다음 토큰은 뭘까? | C | -8.9 | no |
| tD1 | 다음 토큰은 뭘까? | D | -11.8 | no |
| tD2 | 다음 토큰은 뭘까? | D | — | unmeasurable |
| tD3 | 다음 토큰은 뭘까? | D | +1.0 | no |
| tE1 | 다음 토큰은 뭘까? | E | +1.6 | no |
| tE2 | 다음 토큰은 뭘까? | E | -3.6 | no |
| tE3 | 다음 토큰은 뭘까? | E | +0.8 | no |
| nA1 | 여기가 엔비디아 세상인가? | A | +6.8 | yes |
| nA2 | 여기가 엔비디아 세상인가? | A | 0.0 | no |
| nA3 | 여기가 엔비디아 세상인가? | A | — | unmeasurable |
| nB1 | 여기가 엔비디아 세상인가? | B | — | unmeasurable |
| nB2 | 여기가 엔비디아 세상인가? | B | +0.6 | no |
| nB3 | 여기가 엔비디아 세상인가? | B | -6.5 | no |
| nC1 | 여기가 엔비디아 세상인가? | C | +10.3 | yes |
| nC2 | 여기가 엔비디아 세상인가? | C | — | unmeasurable |
| nC3 | 여기가 엔비디아 세상인가? | C | +1.8 | no |
| nD1 | 여기가 엔비디아 세상인가? | D | -2.4 | no |
| nD2 | 여기가 엔비디아 세상인가? | D | — | unmeasurable |
| nD3 | 여기가 엔비디아 세상인가? | D | -1.3 | no |
| nE1 | 여기가 엔비디아 세상인가? | E | +0.3 | no |
| nE2 | 여기가 엔비디아 세상인가? | E | — | unmeasurable |
| nE3 | 여기가 엔비디아 세상인가? | E | -4.1 | no |

No tag raised the ending reliably: 1 of 13 measurable "뭘까?" takes rose and 2 of 10 measurable
"세상인가?" takes rose, spread across four of the five variants.

### ElevenLabs `eleven_multilingual_v2`, per take

| Line | Sentence | Delta (st) | Rose |
|---|---|---|---|
| t1 | 다음 토큰은 뭘까? | -2.4 | no |
| t2 | 다음 토큰은 뭘까? | -4.7 | no |
| t3 | 다음 토큰은 뭘까? | +1.7 | no |
| t4 | 다음 토큰은 뭘까? | -7.3 | no |
| t5 | 다음 토큰은 뭘까? | -7.4 | no |
| n1 | 여기가 엔비디아 세상인가? | +2.5 | yes |
| n2 | 여기가 엔비디아 세상인가? | +4.6 | yes |
| n3 | 여기가 엔비디아 세상인가? | -2.7 | no |
| n4 | 여기가 엔비디아 세상인가? | +6.3 | yes |
| n5 | 여기가 엔비디아 세상인가? | +5.0 | yes |

### ElevenLabs `eleven_v3`, per take

| Line | Sentence | Delta (st) | Rose |
|---|---|---|---|
| t1 | 다음 토큰은 뭘까? | +1.7 | no |
| t2 | 다음 토큰은 뭘까? | +2.1 | yes |
| t3 | 다음 토큰은 뭘까? | -0.9 | no |
| t4 | 다음 토큰은 뭘까? | +4.8 | yes |
| t5 | 다음 토큰은 뭘까? | +5.7 | yes |
| n1 | 여기가 엔비디아 세상인가? | +2.0 | no |
| n2 | 여기가 엔비디아 세상인가? | -3.8 | no |
| n3 | 여기가 엔비디아 세상인가? | -2.0 | no |
| n4 | 여기가 엔비디아 세상인가? | +2.7 | yes |
| n5 | 여기가 엔비디아 세상인가? | +3.9 | yes |

### Qwen3-TTS 1.7B, per take

| Line | Sentence | Delta (st) | Rose |
|---|---|---|---|
| t1 | 다음 토큰은 뭘까? | -2.5 | no |
| t2 | 다음 토큰은 뭘까? | -3.9 | no |
| t3 | 다음 토큰은 뭘까? | -5.9 | no |
| t4 | 다음 토큰은 뭘까? | -7.5 | no |
| t5 | 다음 토큰은 뭘까? | -8.8 | no |
| n1 | 여기가 엔비디아 세상인가? | -5.6 | no |
| n2 | 여기가 엔비디아 세상인가? | -3.8 | no |
| n3 | 여기가 엔비디아 세상인가? | -3.9 | no |
| n4 | 여기가 엔비디아 세상인가? | -5.0 | no |
| n5 | 여기가 엔비디아 세상인가? | +2.0 | no (exactly at the cutoff) |

### Speech-to-text check

| Model | "다음 토큰은 뭘까?" takes | "여기가 엔비디아 세상인가?" takes |
|---|---|---|
| Fish `s2.1-pro-free` | 15 of 15 heard as "토크는" for "토큰은" (CER 0.29 or 0.43) | 13 of 15 exact; 2 of 15 CER 0.09 ("엠비디아", "엔비데아") |
| ElevenLabs `eleven_multilingual_v2` | 5 of 5 heard as "토크는" (CER 0.29) | 5 of 5 exact (CER 0.00) |
| ElevenLabs `eleven_v3` | 5 of 5 heard as "토크는" (CER 0.29) | 5 of 5 exact (CER 0.00) |
| Qwen3-TTS 1.7B | 5 of 5 heard as "토크는" (CER 0.29) | 5 of 5 exact (CER 0.00) |

All four models were heard as "토크는" instead of "토큰은" on every take of "다음 토큰은 뭘까?": the
middle word comes back the same way regardless of model, voice, or provider. That points to a
speech-to-text confusion on this specific word, not a TTS pronunciation problem.

### Local generation speed (Qwen3-TTS only)

10 short lines (20 s of speech) took 2 min 54 s on an Apple Silicon Mac (`mps`), including
loading the model and running the STT check. Hosted models (Fish Audio, ElevenLabs) return a line
in seconds.

## Discussion

ElevenLabs raised the ending most often in this test (5 of 10 on `eleven_v3`, 4 of 10 on
`eleven_multilingual_v2`), but neither model raised it on a majority of takes, and no model raised
it on every take of either sentence. Fish Audio's tags — including the two written to ask for a
question or a rising ending — did not lift its rate above what plain text scored; 3 of 23
measurable takes rose regardless of tag. Qwen3-TTS, cloning the user's own voice from a short
reference clip, did not raise the ending on any of its 10 takes in this sample (one take reached
the +2 st cutoff exactly and was not counted as a rise).

A falling ending is not automatically a defect. "다음 토큰은 뭘까?" is a wh-question ("what"), and
many languages, Korean included, commonly let wh-questions fall while raising yes/no questions.
"여기가 엔비디아 세상인가?" is a yes/no question, and it rose more often than the wh-question for
two of the three models that raised anything at all (Fish: 2 of 10 measurable "세상인가?" takes
vs. 1 of 13 measurable "뭘까?" takes; ElevenLabs `eleven_multilingual_v2`: 4 of 5 vs. 0 of 5).
`eleven_v3` went the other way (2 of 5 "세상인가?" vs. 3 of 5 "뭘까?"). With five takes per line,
this is not enough to call a rule — see Limitations.

For choosing a model: if a line must sound like a question, re-recording just that line
(`voice.mjs --lines <id>`) a few times with `eleven_v3` gave the best odds in this sample, but
still needed more than one take. No model here can be trusted to raise a question ending on the
first take.

## Limitations

- **Small sample.** 5 takes per line for ElevenLabs and Qwen3-TTS, 3 takes per line per tag for
  Fish Audio. Rates from samples this size move a lot with one more or fewer rise.
- **One language.** Korean only. Rates for other languages are not measured here.
- **One voice per model.** Fish Audio and ElevenLabs were each tested on one stock voice; Qwen3-TTS
  on one voice clone. Voice-to-voice variation within a model is not measured.
- **Stock voices, not chosen for Korean.** ElevenLabs' "Sarah" is an English stock voice; its
  Korean was not judged for accent, only measured for pitch and transcribed for CER.
- **The +2 st threshold is a cutoff, not a validated perceptual boundary.** A take at +1.9 st and
  a take at +2.1 st are treated as different categories here; a listener might not hear them as
  different.
- **Not judged by ear.** Every number in this report comes from the pitch and STT measurements
  described above. No take was rated by a human listener for whether it sounds like a question.
- **Unmeasurable takes were excluded, not scored as "no rise."** This changes the denominator, most
  visibly for Fish Audio (7 of 30 takes unmeasurable) — a model with more unmeasurable takes is
  not thereby a model that "rises less."
- **CER only flags badly wrong lines.** A CER of 0.29 on a 7-character reference is one wrong
  syllable; it is not evidence that a listener would misunderstand the line.

## Reproduce

Measure the last-syllable rise on one or more takes:

```
python tts-ending-pitch.py <wav>[@endSec] ...
```

`@endSec` trims the file to the end of the "?" word when a take has trailing content after the
question. Needs `praat-parselmouth` and `numpy` in the Python environment that runs it.

Generate fresh takes of a line to compare tags or re-record a bad ending:

```
node skills/super-video-agent/scripts/voice.mjs <reel-dir> --lines <id> --takes 5
node skills/super-video-agent/scripts/voice.mjs <reel-dir> --lines <id> --takes {confident},{curious}
```

## Qwen3-TTS (local)

- **Not bundled.** The repository holds only the code that calls it. You install the `qwen-tts`
  package yourself (see the install guide), and the weights (about 4.2 GB for 1.7B) download from
  Hugging Face on the first film.
- **The reference clip matters most.** Use 5–15 s that ends on a finished sentence. A clip cut
  mid-word leaked that syllable onto 11 of 21 generated lines; cutting it at 10.46 s, on a
  sentence end, fixed it. The skill refuses a clip outside 5–15 s.
- **1.7B over 0.6B.** The 1.7B model gave clearer words and fewer slurred endings.
- **Pace.** Our approved Korean film spoke at 1.3× (`meta.voice.rate`); Shorts default to 1.1×.

## Fish Audio

- **Free until 2026-11-30.** Fish Audio offers its pro model as `s2.1-pro-free` at no cost
  through November 30, 2026.

## ElevenLabs

- **Raised question endings most often** in our test: see the rise-count table above.
- **API key permissions.** A restricted key needs text-to-speech; listing voices also needs
  `voices_read`, which our key lacked, so we used a stock voice id directly.
- **Stock voices speak Korean.** "Sarah" (an English stock voice) read both Korean sentences; see
  the STT table above for what it was heard as.

## What we would pick

- **Everyday films, no cost:** Qwen3-TTS with your own voice (the skill's default).
- **Fast turnaround or a livelier delivery:** Fish Audio (free until 2026-11-30).
- **Lines that must sound like questions:** ElevenLabs `eleven_v3`, plus a few re-records of just
  those lines — no model in this test got it right on the first take reliably.
