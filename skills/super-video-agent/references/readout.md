# Read-out — make the voice say each line the way a person would

A voice model reads the spelling. Numbers, units, versions, acronyms and product names are
written one way and said another, and every language has sounds its spelling hides. Script
review pass 4 (`references/script-review.md`) fixes these in the line's `say` text before
synthesis. `text` stays as written: it is the caption.

## Which file to read

Read the file for the film's language (`plan.json` `meta.lang`, primary subtag):

| `meta.lang` | File |
|---|---|
| `ko` | `references/readout-ko.md` |
| `en` | `references/readout-en.md` |
| `ja` | `references/readout-ja.md` |
| `es` | `references/readout-es.md` |
| `pt` | `references/readout-pt.md` |
| `zh` (`zh-Hans`, `zh-Hant`) | `references/readout-zh.md` |
| `de` | `references/readout-de.md` |
| `fr` | `references/readout-fr.md` |
| `ru` | `references/readout-ru.md` |
| `it` | `references/readout-it.md` |

No file for the language: apply the checklist below with what you know of the language. Listen
to the take, or accept it on the STT check when nobody can (item 7).

## Checklist (every language)

1. **Numbers** in words, as said: decimals, versions (`5.5`), years, dates, times, money,
   percentages, ranges (`3–5`), scores (`3-2`), ordinals and counters.
2. **Units and symbols** said once, in full: `%`, `$`, `km`, `x`, `→`, `/`, `#`, `@`.
3. **Acronyms and names**: spell out the ones said letter by letter (`API`, `STT`); write the
   ones said as a word the way they are said (`GitHub`, `xhigh` → x-high). Foreign names in the
   film's language as its speakers say them.
4. **URLs and commands** are not read out character by character; say a short form
   ("the link in the description").
5. **Hidden sounds**: the language file lists the sound changes the spelling does not show.
   Rewrite only those. Respelling what the spelling already marks makes the voice stumble.
6. **A wrong reading quoted on purpose** ("not X, but Y") must be spelled as it sounds, too.
   Voice models correct a common misreading on their own, and inserting commas or spaces only
   adds a break. Write the wrong form in sound spelling.
7. **Nobody can listen in this language?** Pick plain, common words the voice cannot misread:
   no rare names, words spelled alike but said differently, or numbers the language says
   several ways. Keep foreign names (brands, products, sites) in the caption and on screen, and
   say a plain word of the film's language instead ("these videos", "online"): a foreign word
   in the middle of a sentence is where both the voice and the STT check go wrong. Then accept
   a take on the STT check alone.

## When the spelling can't carry the sound

Korean Hangul spells almost any sound; most scripts can't. For a name or word the voice keeps
misreading, try these in order, and listen after each:

| # | Method | Where |
|---|---|---|
| 1 | **Respell** in the language's own script, the way its readers would sound it out | `say` on the line, or a `pronounce` entry's `say` |
| 2 | **IPA** (International Phonetic Alphabet) in an SSML `<phoneme>` tag — only engines and models that read the tags | `pronounce` entry's `ipa` + `meta.voice.phonemeTags: true` |
| 3 | **Swap the word** for one the voice says right | `text` and `say` both — the caption changes too |

Respelling hints: en `Nguyen` → "Win", `Qi` → "Chee"; ja katakana (`Nguyen` → グエン);
es/pt spell by their own letter-sound rules (`Nguyen` → "Guién" / "Guiém"); zh use a common
transliteration in characters, or pinyin with tone marks when characters mislead.

### The pronunciation dictionary

A word that recurs gets one entry instead of a `say` on every line:

```json
"meta": {
  "voice": { "provider": "elevenlabs", "model": "eleven_flash_v2", "phonemeTags": true },
  "pronounce": {
    "Nguyen": { "say": "Win", "ipa": "ˈŋwiən" },
    "API":    { "say": "A P I" }
  }
}
```

- Applied to the spoken text only (`say`, else `text`); captions never change.
- Whole-word match for Latin letters and digits (`API` not inside `RAPID`); scripts without
  spaces match anywhere. Longest entry first.
- `phonemeTags: true` sends `ipa` as `<phoneme alphabet="ipa" ph="…">word</phoneme>`; otherwise
  `say` is used and an entry with only `ipa` is left alone. Which models read phoneme tags
  depends on the engine; check its docs before turning it on. Local voices (`qwen3`,
  `melotts`, `say`) do not.
- A line's own `pronounce` overrides the film's entry for that line.

The STT check writes numbers back as digits and ignores small differences; it flags only gross
errors (`references/voice.md`). When a reading is doubtful, listen and fix only what sounds wrong.
