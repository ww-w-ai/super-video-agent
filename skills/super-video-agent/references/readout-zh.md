# Read-out — Chinese (`zh`)

Read `references/readout.md` first. This file lists what Mandarin adds. Write `say` in the
same script as the caption: Simplified for `zh-Hans`, Traditional for `zh-Hant`.

## Sounds the spelling hides

| Case | Example | In `say` |
|---|---|---|
| 两 vs 二 | 两个, 两点 (2 o'clock), 两千; but 二月, 第二, 二楼, 二点五 (2.5) | 两 before a measure word and for 2 o'clock; 二 in dates, ordinals, floors, decimals |
| Tone change of 一 and 不 | 一个 [yí ge], 不是 [bú shì] | automatic; do not rewrite |
| 零 inside a number | 105 → 一百零五, 2005 → 两千零五 | write 零 where a place is empty |
| 1 in phone, room and bus numbers | 110 → 幺幺零 | `zh-Hans` speakers often say 幺 for 1 in digit strings; write 幺 if the line needs it |
| 万 / 亿 grouping | 12,000 → 一万两千; 3,000,000 → 三百万 | grouped by 10,000, not by the comma |

## Characters with two readings (多音字)

Pinyin written into `say` is read as Latin letters. When a take misreads one of these, rephrase
the line instead.

| Character | Readings | When a take gets it wrong |
|---|---|---|
| 行 | xíng (go, OK) / háng (row, trade, bank) | 银行, 行业 usually come out right; rephrase only if the take says xíng |
| 重 | zhòng (heavy) / chóng (again) | 重来 read zhòng → 再来一次 |
| 长 | cháng (long) / zhǎng (grow, head of) | 组长 read cháng → 负责人 |
| 还 | hái (still) / huán (give back) | 还钱 read hái → 把钱归还 |
| 得 | de / dé (get) / děi (must) | 我得走了 read de → 我必须走了 |

## Numbers

| Written | Say | Why |
|---|---|---|
| `5.5` | 五点五 | the decimal point is 点 |
| `Opus 5.5` | Opus 五点五 | keep the Latin name, read the version in Chinese |
| `27.3%` | 百分之二十七点三 | 百分之 comes first, the reverse of the written order |
| `2026年` | 二零二六年 | years are read digit by digit |
| `3月5日` | 三月五日, or 三月五号 | 号 is the usual spoken form |
| `15:20` | 十五点二十分, or 下午三点二十 | 24-hour, or 12-hour with 上午/下午 |
| `¥1,500`, `1,500元` | 一千五百元 | one number, then the unit; 块 in casual speech |
| `2个`, `2000` | 两个, 两千 | 两 before a measure word, 千 and 万 |
| `3–5` (range) | 三到五 | |
| `3-2` (score) | 三比二 | not read as a subtraction |
| `第3` | 第三 | ordinal with 第 |

## English tech names

Keep Latin letters when Chinese speakers say the term in English: `GitHub`, `API`, `AI`. Use a
Chinese name only when people actually use it (谷歌 for Google); a niche tool name stays in Latin
letters. 人工智能 fits formal lines; casual tech talk says AI.

## Quoting a wrong reading

"是两个，不是二个": with `2个` written, the voice says 两个. Write the wrong form in characters:
`say: "是两个... 不是二个"`.
