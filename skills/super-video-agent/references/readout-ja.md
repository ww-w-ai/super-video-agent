# Read-out — Japanese (`ja`)

Read `references/readout.md` first. This file lists what Japanese adds.

## Sounds the spelling hides

Kanji and digits do not show their reading, and a counter changes the sound of the number before
it. Write the reading in kana in `say` for these cases. Leave kanji the voice already reads right.

| Case | Written | Say (kana) | Why |
|---|---|---|---|
| 本 | 1本 / 3本 / 6本 | いっぽん / さんぼん / ろっぽん | the counter's first sound changes with the number |
| 分 | 1分 / 3分 / 10分 | いっぷん / さんぷん / じゅっぷん | same |
| 回 | 6回 | ろっかい | not ろくかい |
| 個 | 1個 / 10個 | いっこ / じゅっこ | じっこ is also standard |
| 階 | 3階 | さんがい | さんかい is also heard; keep one form |
| つ | 1つ / 3つ | ひとつ / みっつ | native counting words |
| 人 | 1人 / 2人 / 4人 | ひとり / ふたり / よにん | irregular; 3人 and up follow さんにん |
| 歳 | 20歳 | はたち | the usual reading; にじゅっさい is also heard |
| 日 (date) | 4日 / 20日 | よっか / はつか | days 1–10, 14, 20 and 24 of the month are irregular |
| 日 | 1日 | ついたち (date) / いちにち (one day) | same spelling, two meanings |

## 4, 7, 9 — context picks the reading

| Written | Say | Why |
|---|---|---|
| 4月 / 7月 / 9月 | しがつ / しちがつ / くがつ | month names are fixed |
| 4時 / 7時 / 9時 | よじ / しちじ / くじ | clock hours are fixed |
| 4つ / 7つ / 9つ | よっつ / ななつ / ここのつ | native counting |
| 4個 / 7個 / 9個 | よんこ / ななこ / きゅうこ | most counters take よん・なな・きゅう |

A bare number with no counter reads よん・なな・きゅう.

## Numbers

| Written | Say | Why |
|---|---|---|
| `5.5` | ごてんご | the decimal point is てん |
| `Opus 5.5` | オーパス ごてんご | versions read like decimals |
| `27.3%` | にじゅうななてんさんパーセント | unit said once, after the number |
| `2026年` | にせんにじゅうろくねん | one whole number + ねん, not digit by digit |
| `3月15日` | さんがつじゅうごにち | |
| `300` / `600` / `800` | さんびゃく / ろっぴゃく / はっぴゃく | 百 changes its sound |
| `3,000` / `8,000` | さんぜん / はっせん | 千 changes its sound |
| `12,000` | いちまんにせん | grouped by 万 (10,000), not by the comma |
| `¥1,500` | せんごひゃくえん | the yen sign written first is said after |
| `3〜5` (range) | さんからご | |
| `3-2`, `3対2` (score) | さんたいに | not read as a subtraction |

## English and tech names in katakana

| Written | Say | Why |
|---|---|---|
| GitHub | ギットハブ | as Japanese speakers say it |
| Opus | オーパス | |
| xhigh | エックスハイ | |
| API | エーピーアイ | letter by letter, in katakana |

## Kanji with more than one reading

Write the reading in kana when the line does not make it clear. Always do this for names of
people and places: the voice cannot guess them.

| Word | Readings | Note |
|---|---|---|
| 今日 | きょう / こんにち | こんにち = "nowadays" (今日の社会) |
| 上手 | じょうず / うわて | じょうず = "skilled"; うわて = "the upper hand" |
| 生物 | せいぶつ / なまもの | "living thing" vs "raw food" |
| 人名・地名 | varies | write the intended reading in kana |

## Pitch accent

`say` text does not carry pitch accent. If a word lands with the wrong accent, respelling it in
kana will not help. Swap in a synonym.

## Quoting a wrong reading

"1本は、いちほんではなく、いっぽん": with `1本` written in both places, the voice reads いっぽん
twice. Spell the wrong form in kana:
`say: "いっぽんは... いちほんではなく、いっぽん"`.
