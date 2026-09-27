# Read-out — Portuguese (`pt`)

Read `references/readout.md` first. This file lists what Portuguese adds, for `pt-BR` and
`pt-PT`. Pick the variant by `plan.json` `meta.lang`; where the two differ, the tables say so.

## Sounds the spelling hides

| Case | Example | In `say` |
|---|---|---|
| `x` has four sounds, with no spelling rule | exemplo [z], táxi [ks], próximo [s], xícara [ʃ] | if a take misreads it, respell by sound or swap the word |
| Open vs closed vowel with no accent mark | sede (headquarters / thirst), gosto (I like / taste), forma (shape / mould) | if the take picks the wrong word, rephrase so the meaning is clear |
| English names read by Portuguese rules | GitHub, xhigh | respell by sound when a take misreads them (see Numbers) |

Nasal vowels, `lh`, `nh`, `s` between vowels and vowel reduction show in the spelling or follow
the voice's accent. Leave them as written.

## Numbers

| Written | Say | Why |
|---|---|---|
| `5,5` | cinco vírgula cinco | decimal comma, said "vírgula" |
| `Opus 5.5` | Opus cinco ponto cinco | versions keep the dot, said "ponto" |
| `2026` | dois mil e vinte e seis | a year is one whole number |
| `123` | cento e vinte e três | "e" joins hundreds, tens and units |
| `1.000` | mil | never "um mil" |
| `1.000.000 de usuários` | um milhão de usuários | "um" before milhão, "de" before the noun |
| `2 linhas`, `200 páginas` | duas linhas, duzentas páginas | um/uma, dois/duas and the hundreds agree in gender |
| `1º de maio` | primeiro de maio | day 1 is ordinal; `5 de maio` is cinco de maio |
| `15:20` | quinze e vinte | hour, "e", minutes |
| `R$ 16,34` | dezesseis reais e trinta e quatro centavos | unit named, then "e" and the cents |
| `16,34 €` | dezasseis euros e trinta e quatro cêntimos | `pt-PT` word forms |
| `27,3%` | vinte e sete vírgula três por cento | unit said once, in full |
| `3-2` (score) | três a dois | |
| `3–5` (range) | de três a cinco | |
| `GitHub`, `xhigh` | GitHub, xis high | keep English names; respell by sound only if a take misreads them |
| `API`, `IA` | á pê i, i á | letter by letter, Portuguese letter names |

Words that differ between the variants:

| Number | `pt-BR` | `pt-PT` |
|---|---|---|
| 16 | dezesseis | dezasseis |
| 17 | dezessete | dezassete |
| 19 | dezenove | dezanove |
| 10⁹ | um bilhão | mil milhões (`pt-PT` um bilião = 10¹²) |

## Quoting a wrong reading

"Diz-se mil, não um mil": with `1.000` written in both places, the voice reads mil twice. Write the
wrong form in words:
`say: "É mil... não um mil."`
