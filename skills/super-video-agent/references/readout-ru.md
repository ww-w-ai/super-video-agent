# Read-out — Russian (`ru`)

Read `references/readout.md` first. This file lists what Russian adds.

## Sounds the spelling hides

Russian spelling does not mark stress, and stress moves the vowel sound. It also often prints ё
as е, hiding the difference between two words.

| Case | Example | In `say` |
|---|---|---|
| Stress is not marked | замок (castle) vs замо́к (lock) | if a take stresses the wrong syllable, respell with a stress mark or swap the word |
| ё printed as е | все / всё, узнаём / узнаем | if the line means the ё-word, restore ё or respell; plain е is read differently |
| Unstressed vowel reduction | молоко, хорошо | leave as written; the voice already reduces unstressed о and а on its own |
| English loanwords read with Russian rules | GitHub, xhigh | respell in Cyrillic by sound when a take misreads them (see Numbers) |
| Voicing at word end | год, друг | leave as written; the voice devoices final consonants on its own |

## Numbers

| Written | Say | Why |
|---|---|---|
| `5,5` | пять целых пять десятых | a decimal comma is read as "целых ... десятых", not "точка" |
| `Opus 5.5` | Опус пять точка пять | versions keep the dot, said "точка", unlike a plain decimal |
| `21 пользователь` | двадцать один пользователь | the noun form after the number depends on the last digit (1, 2–4, 5+) |
| `100`, `120` | сто, сто двадцать | |
| `1000` | тысяча | never "одна тысяча" in the plain count |
| `1 000 000 пользователей` | один миллион пользователей | the noun takes the genitive plural after "миллион" |
| `2026` (year) | две тысячи двадцать шестой (год) | years are read as an ordinal number, not split in pairs |
| `1 мая` | первое мая | day is ordinal; the month stays in the genitive |
| `15:20` | пятнадцать двадцать, or пятнадцать часов двадцать минут | short or full clock form, as the audience expects |
| `16,34 ₽` | шестнадцать рублей тридцать четыре копейки | whole unit, then the smaller unit, noun forms follow the same last-digit rule |
| `27%` | двадцать семь процентов | never left as a symbol |
| `3–5` (range) | от трёх до пяти | |
| `3:2` (score) | три два | scores are read as bare numbers in order, not "к" |
| `1-й`, `2-й` | первый, второй | ordinal word, agrees in gender with the noun |
| `GitHub`, `xhigh` | Гитхаб, икс-хай | English names respelled in Cyrillic as Russian speakers say them |
| `API` | эй-пи-ай | letter by letter, English letter names kept |

## Quoting a wrong reading

"Говорят звони́т, а не зво́нит": with `звонит` written in both places, the voice may read it the
same way twice. Mark the stress in the wrong form so it is not auto-corrected:
`say: "Говорят звони́т... а не зво́нит."`
