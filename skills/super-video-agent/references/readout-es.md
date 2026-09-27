# Read-out — Spanish (`es`)

Read `references/readout.md` first. This file lists what Spanish adds.

## Sounds the spelling shows, and the ones it hides

Spanish spelling is close to phonetic. Most trouble comes from a missing accent mark or an
English word the voice reads with Spanish rules.

| Point | Example | In `say` |
|---|---|---|
| The accent mark sets the stress and the word | término, termino, terminó | never drop the mark; without it the voice stresses a different syllable |
| Question words carry a mark | qué, cómo, dónde, cuándo | keep it in questions, direct or indirect: "no sé qué hacer" |
| English words read by Spanish rules | GitHub, xhigh, Google | respell by sound when a take misreads them (see Numbers) |
| seseo, yeísmo, linking between words | gracias, calle, los amigos | leave as written; this is the voice's accent, not a script choice |

## Numbers

| Written | Say | Why |
|---|---|---|
| `5,5` | cinco coma cinco | a decimal comma is said "coma" |
| `5.5` | cinco punto cinco | a decimal point is said "punto"; audiences differ in which they write, so use theirs and keep it for the film |
| `Opus 5.5` | Opus cinco punto cinco | versions always take "punto" |
| `21 usuarios` | veintiún usuarios | `uno` becomes `veintiún` before a masculine noun |
| `21 líneas` | veintiuna líneas | `una` before a feminine noun |
| `100 archivos`, `120` | cien archivos, ciento veinte | `cien` alone or before a noun, `ciento` before more digits |
| `200 líneas` | doscientas líneas | hundreds agree in gender with the noun |
| `1000` | mil | never "un mil" |
| `1 000 000 usuarios` | un millón de usuarios | `millón` takes `de` before the noun |
| `2026` (year) | dos mil veintiséis | years are one whole number, not split in pairs |
| `1 de mayo` | primero de mayo, or uno de mayo | `es-419` mostly says primero; `es-ES` says both |
| `15:20` | las quince veinte, or las tres y veinte | 24-hour or 12-hour form, as the audience expects |
| `$16,34` | dieciséis dólares con treinta y cuatro centavos | whole unit, then "con", then the cents |
| `27%` | veintisiete por ciento | never left as a symbol |
| `del 3 al 5` | del tres al cinco | ranges take "al" |
| `3-2` (score) | tres a dos | not "guion" |
| `1.º`, `1.ª` | primero, primera | ordinal word, with gender |
| `GitHub`, `xhigh` | guit jab, equis jai | English names respelled as Spanish speakers say them |
| `API` | a pe i | Spanish letter names; tech audiences also say "ei pi ai". Keep one form |
| `IA` | i a | the Spanish acronym for "inteligencia artificial" |

## Quoting a wrong reading

"Se dice kilómetro, no kilometro": the voice may treat `kilometro` as a missing-accent typo and
say kilómetro twice. Mark the wrong stress so it cannot be corrected:
`say: "Se dice kilómetro... no kilométro."`
