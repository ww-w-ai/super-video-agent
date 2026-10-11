# Super Video Agent

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh-Hans.md) | 繁體中文

**用一份 PDF、一篇文章或一個主題，做出有旁白的影片。每一格畫面都用程式碼畫出來，不用影片生成模型。** 免費、原始碼公開可讀的 Claude Code 外掛。

<p align="center"><a href="docs/gallery/3d-flight-en.mp4"><img src="docs/gallery/demo-3d-flight.gif" width="240" alt="一鏡到底的 3D 鏡頭飛行：從手機螢幕出發，飛越夜晚的城市，全部用程式碼繪製"></a></p>

▶ [觀看用它做的影片](https://www.youtube.com/@ww-w-ai)

在 Claude Code 中**安裝**：

```
/plugin marketplace add ww-w-ai/marketplace
/plugin install super-video-agent@ww-w-ai
```

接著用平常的話請它做影片，或執行 `/super-video-agent`。其他安裝方式請見[安裝](#安裝)。

一眼看懂（實測）：

- 用三份 10 頁的 PDF 做一支 88 秒短影片：模型費用約 $22，模型用時 1 小時。這次的配音由本機模型產生。
- 一支 40 秒的 3D 飛行影片：在 CPU 上用 4 個 worker 渲染，耗時 11–20 分鐘。
- 渲染完成後，只改一句配音、一個場景或一種語言，其餘部分不必重新渲染。
- 配音：本機模型（Qwen3-TTS、Fish Speech、MeloTTS）在你自己的電腦上執行，不按字數收費；託管服務（Fish Audio、ElevenLabs、Typecast）按字元數或文字位元組數收費。

一個 skill 就能做下面這些類型的影片。每一列都附上寫明做法的檔案，安裝之前就能先讀懂它怎麼運作。

| 影片類型 | 畫面怎麼做 | 方法文件 |
|---|---|---|
| Shorts、16:9 講解影片、1:1 與 4:5 動態消息影片 | 在一個 HTML 頁面裡用 Canvas、SVG、Web Audio 依時間繪製 | [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md) |
| 3D 影片 | 已安裝的 Blender 通過測試渲染就用 Blender，否則用 Three.js/WebGL | [`references/blender.md`](skills/super-video-agent/references/blender.md), [`references/3d.md`](skills/super-video-agent/references/3d.md) |
| 2.5D 照片視差 | 把一張照片切成不同深度的圖層，配上一條鏡頭運動 | [`references/parallax.md`](skills/super-video-agent/references/parallax.md) |
| 組裝過程影片 | 從 LDraw 模型檔取得組裝順序、位置與插入方向 | [`references/assembly.md`](skills/super-video-agent/references/assembly.md) |
| 多語言版本 | 畫面只渲染一次，每種語言的配音與字幕疊在上面 | [`scripts/dub.mjs`](skills/super-video-agent/scripts/dub.mjs) |

**給 Claude Opus 5.5 一份 PDF、一篇文章或一個主題，就能拿回一支用你複製的聲音或你挑選的聲音配音的影片：
YouTube Short、16:9 講解影片、方形動態消息影片、3D 影片，或是動起來的照片。每一格畫面都用程式碼畫出來，渲染完成後，
你可以只換一句配音、一個場景或一種語言，其餘部分不動。** Super Video Agent 是一個 Claude Code 外掛，做法和
2026 年 9 月 Reddit 上流傳的那些用程式碼畫出來的影片一樣，另外加上那些影片沒有的東西：適用於任何語言的讀音規則
與發音詞典、渲染之後只改要改的部分、任意畫幅與格式、為成本調整好的四工作階段流程，以及依腳本觸發的音效庫。

在一個真實任務上實測：三份 10 頁的籃球球探報告 PDF → 一支 88 秒短影片。腳本 $4.05，腳本審閱 $1.75，
成片 $16.34，合計約 $22，模型用時 1 小時。這次的配音由本機模型產生；使用託管配音時，還要加上該服務按字元計的費用。

## 作品展示

下面每支影片都是用這個 skill 做的，並已發佈在 YouTube。點選片段即可觀看。

<table>
<tr>
<td align="center" width="33%"><a href="https://youtube.com/shorts/-Cxl0hHkjio"><img src="docs/gallery/short-iphone-duo-teardown.gif" width="200" alt="用程式碼繪製的拆解鏡頭：一支 3D 摺疊手機分解成漂浮的玻璃、主機板、轉軸圖層"></a><br>3D 產品廣告 Short：摺疊手機一層層拆開。</td>
<td align="center" width="33%"><a href="https://youtube.com/shorts/DoNDDrccoWA"><img src="docs/gallery/short-haiku-tetris-race.gif" width="200" alt="三個 AI 模型各自做的俄羅斯方塊並排執行，三個都零錯誤"></a><br>基準測試新聞 Short：三個 AI 做的俄羅斯方塊並排比賽。</td>
<td align="center" width="33%"><a href="https://youtube.com/shorts/OChlch1cUrc"><img src="docs/gallery/short-same-face-16-edits.gif" width="200" alt="兩個圖像模型把同一位女性重新畫到月球、叢林、海底和 8 位元遊戲裡"></a><br>圖像比較 Short：兩個圖像模型重畫同一張臉。</td>
</tr>
</table>

<table>
<tr>
<td align="center" width="50%"><a href="https://www.youtube.com/watch?v=tjqvLeqh79w"><img src="docs/gallery/longform-ai-news-desk.gif" width="400" alt="九月的月曆被 AI 模型發表填滿，鏡頭拉遠後出現一位 3D 小熊新聞主播"></a><br>長影片新聞節目：由 3D 主播主持的每月 AI 回顧。</td>
<td align="center" width="50%"><a href="https://youtu.be/AqV1cnGTEZY"><img src="docs/gallery/longform-tutorial-command-to-result.gif" width="400" alt="左邊逐字打出一條 Claude Code 指令，右邊出現做好的 Short"></a><br>長影片教學：左邊是指令，右邊是做好的 Short。</td>
</tr>
</table>

**3D 飛行**（本頁頂端）：一支 40 秒的 Short，一鏡到底的鏡頭從手機螢幕出發，飛越夜晚的城市，沿海底電纜而下，
進入資料中心和 GPU 晶片，最後回到顯示出答案的手機。全部用 Three.js/WebGL 程式碼繪製，沒有用影片或圖像生成模型。
▶ [英文 (MP4, 7.5 MB)](docs/gallery/3d-flight-en.mp4) · [韓文](docs/gallery/3d-flight-ko.mp4)

## 使用

先完成安裝（[安裝](#安裝)）。然後在 Claude Code 裡用 Opus 5.5 呼叫這個 skill，說出你想要什麼：

```
/super-video-agent Make a YouTube Short from this PDF. Use my voice from me.wav (transcript: "…").
```

以外掛方式安裝時，指令會顯示為 `/super-video-agent:super-video-agent`；輸入 `/super-video-agent` 後從清單中選取即可。
也可以不用指令：直接用平常的話請它做影片，skill 同樣會啟動。

skill 會先問你：照 Shorts 公式（開頭先拋出鉤子、節奏快、帶固定鉤子標題的分欄畫面）還是自由風格；推斷不出畫幅與長度
時也會問；還會問要在哪個環節停下來讓你審看，以及其他語言版本是否之後疊到同一個畫面上。如果你交給它寫好的腳本
或分鏡，它會問要照原樣用還是重新改寫。

### 3D 影片

說一句「3D」，skill 就會自己走 3D 流程：

```
/super-video-agent Show what happens after you press Enter on an AI prompt, in 3D like a video game
```

已經裝了 Blender？agent 會先跑一次小型 EEVEE 測試渲染（`scripts/probe-blender.mjs`），通過的話，新的 3D 影片就用
Blender 做。否則使用內建的 Three.js 流程。你不需要安裝 Blender，skill 也從不下載它。`SVA_BLENDER_BIN` 可以指定
要測試的那一個 Blender。Three.js 沒有隨附，走這條路時 agent 會把它裝進你的影片資料夾。你明確指定渲染器時以你的
選擇為準，修改既有影片時保留原本的渲染器。
詳見 [`references/blender.md`](skills/super-video-agent/references/blender.md), [`references/3d.md`](skills/super-video-agent/references/3d.md)。

### 照片 組裝過程 其他語言

```
/super-video-agent Make this photo move in 2.5D for the opening, with the source credited on screen
```

- **2.5D 照片視差。** 把一張照片切成三層深度圖層（預設用多邊形切割，alpha 遮罩與深度圖可選），一條鏡頭運動讓近處的
  圖層移動得多、遠處的移動得少。如果某個圖層的邊緣會在運動中露出來，引擎會回報，並提供能修正它的縮放比例。
  照片的來源、作者與授權寫進 `FILM.md`，照片出現期間畫面上一直保留清楚可讀的出處
  （[`references/parallax.md`](skills/super-video-agent/references/parallax.md)）。
- **組裝過程影片。** 交給它一個 LDraw 文字格式的模型與對應的零件資料夾。`scripts/ldraw-bake.mjs` 會取得組裝順序、
  每個零件的位置、插入方向，並做路徑檢查；缺少零件時會停下並列出零件名稱。skill 掌握的一種做法是：左邊是說明書頁面，
  右邊是 3D 模型，兩邊由同一個步驟序號驅動。沒有旁白的影片用靜音時鐘（`scripts/silent-clock.mjs`）執行
  （[`references/assembly.md`](skills/super-video-agent/references/assembly.md)）。
- **一個畫面，任何語言。** 先產生你的語言的配音，由它定下時間軸。畫面只渲染一次，不燒錄字幕，包括你的語言在內，
  每種語言都用 `dub.mjs` 疊上去。偏長的句子最多加速 10%，或列出來請你改短；畫面不動。

### 接入圖像與影片模型

預設不需要任何圖像或影片模型：每一格畫面都用程式碼畫。想在畫面上放更多東西——照片級背景、產品照、幾秒生成的動態畫面——
就在同一則訊息裡寫明用哪個工具、做哪個鏡頭。

下面的請求**只是範例**。請換成你自己用的工具和呼叫方式；skill 不隨附也不預設使用其中任何一個。

```
/super-video-agent Make a 60-second promo from this deck. Generate the opening background with
Codex image generation, and a 5-second product clip with Seedance through browser-use.
```

請說明每個工具怎麼呼叫（CLI、API key，或你已登入的瀏覽器），也可以自己產生檔案交給它。無論哪種方式，生成的媒體都是
素材：skill 圍繞素材重新構圖每個場景，並在 `FILM.md` 裡記錄每個檔案的來源與授權。

## 為什麼做它

2026 年 9 月，Reddit 上滿是 Claude Opus 5.5 完全用程式碼做出的影片，例如孔版印刷風格的火車旅行、SNES 風格的動畫對戰、
火柴人 YouTube Short。提示詞都很短，模型自己挑工具，自己檢查渲染結果。

我們在自己的頻道上試了一下，每次都撞上同樣的三道牆：

1. **時間對不上。** 依估算排的場景，一旦真實的聲音讀起腳本，就會和旁白差上好幾秒。
2. **聲音讀錯。** 數字、人名、英文單字讀錯了，要等渲染完才發現。
3. **改一處就要全部重新渲染。** 改一句話就得重新產生配音和整支影片。

所以我們做了 Super Video Agent：一個能越過這三道牆、同時讓模型自由設計每支影片的 skill。

## 主要功能

Super Video Agent 保留模型的自由（除非你自帶範本，否則外觀沒有固定框架），再加上模型自己做不到的五件事：

1. [適用於每種語言的讀音規則](#1-適用於每種語言的讀音規則)：數字、人名、英文單字第一次就讀對。
2. [渲染後只改變動的部分](#2-渲染後只改變動的部分)：只換一句、一個場景或一種語言，其餘不動。
3. [任意畫幅 任意格式 自帶範本](#3-任意畫幅-任意格式-自帶範本)：Shorts、16:9、方形、3D、照片視差、組裝過程、系列集數。
4. [四個階段 四個工作階段 依需要調整推理強度](#4-四個階段-四個工作階段-依需要調整推理強度)：一支 88 秒影片約 $22。
5. [由腳本觸發的音效](#5-由腳本觸發的音效)：落在特定的字詞上，並為是否合適打分。

### 1. 適用於每種語言的讀音規則

合成語音照著拼寫讀，而沒有哪種語言是完全照拼寫發音的。Super Video Agent 在產生任何配音之前，先把實際讀法寫進腳本。
只要語音引擎會說的語言都適用：數字、單位、人名與縮寫有一份通用檢查表，有專屬規則檔的語言還會處理拼寫裡看不出的讀音。

付費 TTS 服務也許用不著這些。但有了這些規則，低成本或本機的 TTS 函式庫也常常能讀對。

| 語言 | 寫法 | 讀法 (`say`) | 規則 |
|---|---|---|---|
| 英語 | `Opus 5.5`, `$16.34` | Opus five point five, sixteen dollars thirty-four | 版本號與金額讀成字詞 |
| 韓語 | `4.4`, `6월` | 사쩜사, 유월 | 小數點讀作 [쩜]；月份用固定讀法 |
| 日語 | `3本`, `6本` | さんぼん, ろっぽん | 量詞會改變讀音 |
| 中文 | `2个`, `27.3%` | 两个, 百分之二十七点三 | 量詞前用「两」；百分數語序顛倒 |

刻意引用的錯誤讀法（「不是 X 而是 Y」）也照發音拼寫，因為語音模型會悄悄修正常見的誤讀。

拼寫解決不了的字詞，`plan.json` 裡的發音詞典提供三種辦法：用該語言自己的文字重新拼寫；給能讀 SSML（語音合成標記語言）
`<phoneme>` 標籤的引擎提供 IPA（國際音標，字典裡用的發音符號）；或者換一個字詞。一個條目涵蓋所有用到這個字詞的句子，
字幕保留原拼寫。

```json
"pronounce": { "Nguyen": { "say": "Win", "ipa": "ˈŋwiən" } }
```

每句產生的配音都會再用語音辨識轉寫回來核對。只有明顯的錯誤才會被標記——一句話錯了一半以上，或錄音長度不到原句的
70% 或超過 140%——因為語音辨識本身在人名和同音詞上也會出錯。標記是請你去聽的依據，不會自動重做：只有你加上
`voice.mjs --retry-flagged N` 時才會重做被標記的句子。修正讀音時這句話的時間位置不變，所以影片不必重新渲染。
([`references/readout.md`](skills/super-video-agent/references/readout.md), [`scripts/lib/pronounce.mjs`](skills/super-video-agent/scripts/lib/pronounce.mjs), [`scripts/lib/stt-compare.mjs`](skills/super-video-agent/scripts/lib/stt-compare.mjs), `scripts/voice.mjs --lines`)

### 2. 渲染後只改變動的部分

渲染好的影片並沒有被鎖死。它的每一部分都能單獨替換：一句旁白、字幕、一個場景、一種語言、片頭或片尾。其餘部分不動，
你已經認可的部分保持原樣。

| 你想改的 | 執行什麼 | 保持不變的 |
|---|---|---|
| 一句旁白：一個字詞、語氣、讀錯的地方 | `voice.mjs --lines <id>` 只重錄這一句，裁到有聲的部分，放回原本的時間位置：最多加速到 1.1 倍，後面留出最短的換氣時間。仍然放不下的錄音會被拒絕，保留原本的片段 | 畫面和其他所有句子 |
| 連同前後一起聽改過的句子 | `preview-changes.mjs <reel> --lines <ids> --media <mixed.mp4>` 為每句變動截取從上一句結尾到下一句開頭的片段，畫面、旁白與背景聲一起 | 影片 |
| 字幕文字或斷行位置 | 改 `plan.json`（用 `\|` 指定斷行），先出畫面的影片再執行一次 `dub.mjs` | 畫面 |
| 一個場景 | `render.mjs --only <shot>` 只渲染這個鏡頭並接回影片；`render.mjs --span <from>-<to>` 只重新渲染這幾秒。Blender 畫面只重新渲染受影響的影格範圍 | 其他所有鏡頭 |
| 第二種語言 | `dub.mjs --lang <code>` 把這種語言的配音與字幕疊到同一個畫面上 | 只渲染一次的畫面 |
| 某種語言裡句子之間的換氣空間 | `dub.mjs --min-gap <sec>` 只在句子擠到下一句的位置，把畫面與音效一起放慢，直到間隔達到 `<sec>`；配音速度不變 | 配音、第一格與最後一格畫面、其他語言版本 |
| 重新對時或重新擺放的配音音軌 | `render.mjs --narration <wav> --timings <json>` 用這條音軌取代影片自己的配音來渲染 | `voice/narration.wav` 與 `voice/timings.json` |
| 上傳用的片頭與片尾 | `join.mjs` 接上它們，並回報每個接縫處的響度、喀噠聲風險與畫面吻合度 | 正片 |

修改分好幾輪提出時，每項要求都記在 `FILM.md` 裡的同一份清單上，並標明狀態（已完成、未完成、被後來的要求變更）。
每一輪都對照整份清單來規劃與檢查，新的修改不會把先前改好的東西改回去。

在作品展示裡的 3D 影片上實測：一次完整渲染耗時 11–20 分鐘。審閱後的八處配音與字幕修改（換一個字詞、一個結尾需要上揚的
問句、一個被單獨留在一行的字幕詞）都沒有重新渲染 3D 畫面。2D 影片只重新渲染變動的鏡頭，幾分鐘就好。
([`scripts/voice.mjs`](skills/super-video-agent/scripts/voice.mjs), [`scripts/dub.mjs`](skills/super-video-agent/scripts/dub.mjs), [`scripts/render.mjs`](skills/super-video-agent/scripts/render.mjs), [`scripts/preview-changes.mjs`](skills/super-video-agent/scripts/preview-changes.mjs), [`scripts/join.mjs`](skills/super-video-agent/scripts/join.mjs))

既有的錄音可以依照[音訊編輯指南](skills/super-video-agent/guides/audio-editing.md)在本機調整停頓與語速，再替換旁白，不必重新渲染畫面。

### 3. 任意畫幅 任意格式 自帶範本

- **任意畫幅。** 四種尺寸一個參數就能開始：9:16（Shorts、Reels、TikTok）、16:9（YouTube、簡報）、1:1 與 4:5（動態消息）。
  其他尺寸也可以，因為渲染器直接使用頁面宣告的寬與高。
- **任意外觀。** 選擇 Shorts 公式（開頭先拋出鉤子、節奏快、帶固定標題的分欄畫面）、自由風格（模型為這支影片設計外觀），
  或帶上你自己的範本：版面、品牌色彩與字型、系列標題卡。skill 會在範本裡搭建每個場景。
- **任意類型。** 用 PDF 或文章做的講解影片、用簡報做的宣傳片、用程式碼畫的新聞主播台或即時比分畫面、Blender 或 WebGL
  3D 影片、2.5D 照片視差、用模型檔做的組裝過程影片、帶片頭片尾的系列集數，以及共用一個畫面的多語言版本。
- **一直在進步。** 我們每次刻意挑一支更難的影片，再把做它所需要的東西放回 skill。作品展示裡的影片就是試驗台。

### 4. 四個階段 四個工作階段 依需要調整推理強度

每個階段只讀上一階段留下的檔案，所以每個階段都在新的工作階段裡、用各自的推理強度執行。在那支 88 秒影片上實測：

| 階段 | 產出 | 推理強度 | 費用 |
|---|---|---|---|
| 腳本 | `plan.json`, `FILM.md`（附出處的事實） | xhigh | $4.05 |
| 審閱 | 經過六輪審閱後鎖定的 `plan.json` | low | $1.75 |
| 配音 | 含實測 `timings.json` 的 `voice/` | low | $0（這次用本機模型） |
| 成片 | `reel.html`, `out/final-<timestamp>.mp4` | xhigh | $16.34 |

「推理強度」（effort）是 Claude 回答前思考多久的設定，從 `low` 到 `max`。強度越高，費用越多、耗時越長，所以只在需要的
地方調高。

為了看清它在哪裡起作用，我們用每一種強度為同一支影片寫腳本，並把腳本裡的每個數字和來源 PDF 逐一核對：

| 推理強度 | 費用 | 用時 | 與來源不符的數字 |
|---|---|---|---|
| low | $2.21 | 2m35s | 0 |
| medium | $2.13 | 1m57s | 0 |
| high | $3.40 | 6m11s | 0 |
| xhigh | $4.05 | 6m05s | 0 |
| max | $8.04 | 23m14s | 0 |

- 每種強度的事實都沒錯，所以在意成本時，腳本用較低的強度也沒問題。`max` 的費用約是 `medium` 的四倍，用時是十二倍。
- 審閱階段用 `low` 執行，仍然抓出腳本工作階段漏掉的兩處：一句可以有兩種解讀的話，以及一個配音會讀兩遍的單位。

影片完成後，skill 會輸出每個階段的用時、工作階段數、費用與 token，以及依請求記錄的語音合成用量
（`scripts/runner/cost-report.mjs`）。詳見 `SKILL.md` 的「Four stages, four sessions」一節。

### 5. 由腳本觸發的音效

清單開始時「叮」一聲，笑點上一記鼓聲：這些小聲音讓 Short 活起來，但在剪輯軟體裡一個個手動放很慢。這裡由模型在寫腳本時
一起放好。

1. **你準備一個音效庫。** 把你自己的音效檔（和簡短的反應片段）放進一個資料夾，配一個 `catalog.json`，寫明每個檔案
   是什麼、能否商用。
2. **模型為每句挑音效。** 它依關鍵字搜尋音效庫，把每個聲音釘在這句話的某個時刻：開頭、結尾，或某個特定的字詞
   （「在 *right* 這個字上」）。
3. **渲染器在那個時刻精準混入。** 每個聲音依長度裁剪、淡出，並調整音量，不讓大聲的檔案蓋過配音。短影片片段在同一條
   時間軸上逐格播放。

授權也會替你檢查：沒有標為可商用的檔案，除非你允許，否則不會進入公開發佈的影片。儲存庫裡不附任何音效檔，因為多數
音效包都有自己的使用條款。

沒有音效庫也有聲音。skill 會用程式碼自己產生音效
（[`scripts/engine/reel-audio.js`](skills/super-video-agent/scripts/engine/reel-audio.js)）：click、type、thud、whoosh、pop、tick、ding 與 pluck，在渲染時用雜訊與振盪器
合成。沒有檔案，不用查授權，同一個 cue 每次都發出同樣的聲音，所以重新渲染的結果一致。
([`scripts/assets.mjs`](skills/super-video-agent/scripts/assets.mjs), [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md), "Asset library")

之後每個音效都會依是否合適打分：它是否符合畫面上發生之事的大小、材質與速度，是否屬於這支影片的世界？先測量每個聲音
（長度、峰值、起音、亮度、音高走向），設定了 `TYPESAFE_API_KEY` 時由 TypeSafe AI 的 Jev 判定（滿分 1，0.8 通過），
否則由目前的模型依評分表判定。不合格的聲音會為這支影片重新設計，最多三輪。
([`scripts/sfx-cards.mjs`](skills/super-video-agent/scripts/sfx-cards.mjs), [`references/sound.md`](skills/super-video-agent/references/sound.md) §7)

## 其他內容

### 配音

- **先有聲音，畫面跟著聲音走。** 在任何場景出現之前，先產生並測量旁白。`voice/timings.json` 記錄每句話與每個字詞的開始
  時間，所有場景都依它定時，所以字幕永遠不會搶在聲音前面（[`scripts/voice.mjs`](skills/super-video-agent/scripts/voice.mjs)）。
- **你自己的聲音，或任何引擎。** 用 5–15 秒的錄音在自己的電腦上複製你的聲音（Qwen3-TTS 或 Fish Speech），或使用
  託管服務（Fish Audio、ElevenLabs、Typecast）、MeloTTS，或你自己錄好的檔案。Fish Audio (S2) 與 ElevenLabs (v3/v4)
  還接受寫在讀法文字裡的語氣標記，例如 `{confident}` 或 `{pause}`，會轉換成各模型自己的標籤；字幕裡不會出現。每句話可以
  有自己的聲音，所以一支影片裡可以有多位說話者。
- **一個聲音一次讀完，再逐句切開。** 每個服務都把同一個聲音的所有句子放在一次請求裡產生，再由 skill 逐句切開，整支影片
  的聲音保持同一種狀態。
- **每句話都回聽。** 配音產生後，語音辨識逐句聽寫並與腳本比對，波形檢查則尋找被切掉的開頭、被切掉的結尾或喀噠聲。
  被標記的句子會附上 id，你知道該去聽哪幾句。
- **每個句尾都要審查。** 每個放進去的片段都會和未裁剪的原始錄音比對：如果最後一個音節少了 20 ms 以上，這句話就被
  標為 `END_CUT`，修正方法是重新放入原始錄音，不需要重新合成。
- **本機複製聲音也能收尾乾淨。** 本機語音模型常常切掉最後一個音節。skill 讓聲音在每句話後再讀一個短字，就像鏡頭之間的
  場記板，然後在它之前的停頓處切開，每句話都能自然結束。
- **用耳朵挑語氣。** 在產生整段旁白之前，skill 可以把開場那句用兩到四種語氣各錄一次（`voice.mjs --takes`），並排放給你聽。
  你選中的那個（`--pick`）就成為每一句的語氣。

### 腳本

- **流暢的旁白。** 每句話都有自己的停頓：下一句延續同一個想法時短，換場時長。句子收尾時接得上，逗號只在強調時用，
  聽起來不像照著稿子念。
- **換氣長度寫在計畫裡。** `meta.minBreathMs`（預設 500 ms）是句子之間最短的停頓。運動賽事播報這類快節奏的現場話語，可以把
  `meta.gapMs` 設在 250 左右、最短換氣設在 200 ms 左右；某句話的 `pauseAfterMs` 設定的靜默會照原樣保留。
- **配音之前五輪審閱。** 對照來源的事實、故事、口語表達、讀法，以及最後通讀。腳本鎖定之後才產生一次配音。

### 畫面

- **每次都是同一格畫面。** 每個頁面只依時間繪製一格畫面（`seek(t)`），同一時刻總是得到同樣的像素。預覽、重新渲染與檢查結果都一致。
- **文字避開 App 按鈕。** 字幕避開 Shorts 與 TikTok 放按鈕和標題的區域（1080×1920 下為 x 80–888、y 200–1470）。
  畫面仍然鋪滿整個畫幅。
- **在閱讀停頓處斷開的字幕。** 字幕先在標點處斷開，再分成長度平均的行，只剩一個字詞時併入相鄰一行。在腳本裡加 `|` 可以
  手動指定斷行，配音不會讀出它。
- **測量字幕對比。** 渲染與每個語言版本都會回報每句字幕和背後畫面的對比，以 WCAG 比值表示（語言版本寫在
  `dub/<code>/contrast.json`）。

### 檢查與輸出

- **影片會自我檢查。** 渲染之後，[`scripts/review.mjs`](skills/super-video-agent/scripts/review.mjs) 產生縮圖總表，並檢查定格的畫面、超出框的文字、響度、沒踩準時刻的音效
  與無聲的空檔。你得到的是數字，外加值得去聽的時間點。
- **每次渲染都保留。** 每次渲染都有自己的帶時間戳記的檔案，`out/final.mp4` 一律指向最新的一份。正在播放這支影片的播放器
  不會被新的渲染打斷，你也能比較不同版本。

## 安裝

需要 Node 22+、`PATH` 中的 FFmpeg，以及供 Playwright 使用的 Chromium。

### skill 本體

**作為 Claude Code 外掛：**

```
/plugin marketplace add ww-w-ai/marketplace
/plugin install super-video-agent@ww-w-ai
```

第一次使用時，skill 會把它的 Node 相依套件與 Chromium 安裝到自己的資料夾裡（`node scripts/setup.mjs`），接著檢查 FFmpeg。

**作為 Codex 外掛：**

```bash
codex plugin marketplace add ww-w-ai/marketplace
codex plugin add super-video-agent@ww-w-ai
```

更新時先執行 `codex plugin marketplace upgrade ww-w-ai`，再執行一次同樣的 `add` 指令。

**作為獨立的 skill**（Claude Code 或 Codex）：

```bash
git clone https://github.com/ww-w-ai/super-video-agent /tmp/super-video-agent
cp -R /tmp/super-video-agent/skills/super-video-agent ~/.claude/skills/super-video-agent   # Codex: ~/.codex/skills/super-video-agent
node ~/.claude/skills/super-video-agent/scripts/setup.mjs
```

### 語音與語音檢查

至少設定一個語音服務；一個都沒有時，配音步驟會停下並列出需要設定什麼。本機服務在你的電腦上執行；託管服務在該服務的伺服器上
執行，需要 API key。只複製你自己的聲音，或你獲准使用的聲音。

用 Qwen3-TTS 在本機複製你的聲音：

1. 建立一個 Python 環境（Qwen3-TTS 建議 Python 3.12），安裝語音模型：

   ```bash
   python3.12 -m venv ~/.venvs/sva-voice
   ~/.venvs/sva-voice/bin/pip install -U qwen-tts
   ```

2. 第一支影片會從 Hugging Face 下載權重：1.7B 約 4.2 GB，0.6B 約 2.3 GB。
3. 錄 5–15 秒你自己的聲音，在一句話說完的地方結束，並一字不差地寫下你說了什麼。skill 把這兩者用作 `meta.voice.refAudio`
   與 `refText`。

語音檢查在 Apple silicon macOS 上用 mlx-whisper 逐句轉寫：先用 `small` 模型，只對第一次轉寫看起來可疑的句子再用 `turbo`
模型複查。

```bash
python3.11 -m venv ~/.venvs/sva-stt
~/.venvs/sva-stt/bin/pip install mlx-whisper
```

接著執行一次 `setup.mjs --stt-models`（獨立 skill 安裝時為
`node ~/.claude/skills/super-video-agent/scripts/setup.mjs --stt-models`），下載這兩個模型（幾百 MB 到幾 GB）。在其他機器上，
可以用 `SVA_STT_ENGINE=groq` 加 `GROQ_API_KEY` 呼叫託管的 Whisper API；只有這種情況下音訊才會離開你的電腦。兩者都沒有時，
檢查會略過並顯示提示。

告訴 skill 這兩個 Python 在哪裡。把下面幾行加進 `~/.zshenv`（或你所用 shell 的設定檔）：

```bash
export SVA_QWEN3_PYTHON=~/.venvs/sva-voice/bin/python
export SVA_STT_PYTHON=~/.venvs/sva-stt/bin/python
```

Qwen3-TTS 模型：

| 模型 | 下載大小 | 說明 |
|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（預設） | 約 4.2 GB | 咬字更清楚，句尾較少含糊 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 約 2.3 GB | 較輕；沒那麼清楚 |

用 `SVA_QWEN3_MODEL` 設定所有影片，或用 `meta.voice.model` 只設定一支影片。有 NVIDIA GPU 的機器請設 `SVA_QWEN3_DEVICE=cuda`。

skill 讀取的全部變數：

| 變數 | 指向 | 用於 |
|---|---|---|
| `SVA_QWEN3_PYTHON` | 能 `import qwen_tts` 的 Python（[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)） | 本機聲音複製 |
| `SVA_QWEN3_MODEL` | Qwen3-TTS 模型 id（預設 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`） | 所有影片改用其他模型；計畫裡的 `meta.voice.model` 仍然優先 |
| `SVA_FISH_DIR` | 包含 `fish-speech/`（程式碼簽出）與 `.venv-tts/`（它的 Python）的資料夾 | 本機 Fish Speech |
| `SVA_MELO_PYTHON` | 裝有 MeloTTS 的 Python | 本機 MeloTTS |
| `SVA_QWEN3_DEVICE`, `SVA_FISH_DEVICE` | `mps`（預設）、`cuda` 或 `cpu` | 非 Apple 機器 |
| `FISH_AUDIO_API_KEY`（或 `FISH_API_KEY`）, `FISH_AUDIO_VOICE_ID` | 你的 Fish Audio key 與聲音 | 託管 Fish Audio |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | 你的 ElevenLabs key 與聲音 | 託管 ElevenLabs |
| `TYPECAST_API_KEY`, `TYPECAST_VOICE_ID` | 你的 Typecast API key 與聲音（`tc_…`） | 託管 Typecast |
| `SAY_VOICE` | macOS `say` 的聲音名稱（預設 `Yuna`） | 僅限 macOS，搭配 `--provider say` |
| `SVA_STT_ENGINE` | `mlx`（預設）或 `groq` | 語音檢查 |
| `SVA_STT_PYTHON` | 裝有 `mlx-whisper` 的 Python | 語音檢查（未設定時略過並提示） |
| `SVA_STT_MODEL`, `SVA_STT_MODEL_RECHECK` | 初查與複查模型（預設 `small`、`turbo`） | 選用 |
| `GROQ_API_KEY` | 你的 Groq key | 以 `SVA_STT_ENGINE=groq` 做語音檢查時 |
| `SVA_BLENDER_BIN` | 一個 Blender 執行檔的絕對路徑；只測試這一個 | 選用，3D 影片 |
| `SVA_ASSET_LIB` | 你的音效庫資料夾（預設 `~/.super-video-agent/library`） | 選用 |

**在哪裡設定**：它們都是環境變數。請選一個適合你環境的地方：

| 環境 | 位置 |
|---|---|
| Claude Code（任何系統） | `~/.claude/settings.json` 中的 `env`：`{"env": {"ELEVENLABS_API_KEY": "..."}}` |
| macOS · Linux，zsh | 在 `~/.zshenv` 中寫 `export ELEVENLABS_API_KEY="..."` |
| Linux，bash | 在 `~/.bashrc` 中寫 `export ELEVENLABS_API_KEY="..."` |
| Windows (PowerShell) | 執行 `setx ELEVENLABS_API_KEY "..."`，然後開啟新的終端機 |

### 選哪個語音模型

不加 `--provider` 時，`voice.mjs` 會在你已設定的服務裡依下面的順序選擇，並告訴你用了哪個：你自己的錄音（`voice/in/`）、
帶參考聲音的 Qwen3-TTS、Fish Audio、ElevenLabs、Typecast、MeloTTS。Fish Speech 與 macOS `say` 只在你指定時使用。每次
合成請求都記錄在 `tts-usage.jsonl` 裡（送出的字元數、傳回的秒數、服務方回報的費用）。

| 模型 | 在哪裡執行 | 費用 | 速度 | 設定 |
|---|---|---|---|---|
| Qwen3-TTS 1.7B / 0.6B | 你的電腦 | 不按字數收費 | 這些裡最慢 | `SVA_QWEN3_PYTHON` + 5–15 秒你自己聲音的錄音 |
| Fish Speech | 你的電腦 | 不按字數收費 | 這裡沒有測量 | `SVA_FISH_DIR` |
| MeloTTS | 你的電腦 | 不按字數收費 | 快；一位韓語說話者 | `SVA_MELO_PYTHON` |
| Fish Audio | Fish Audio 伺服器 | 依文字的 UTF-8 位元組數；預設的 `s2.1-pro-free` 在 Fish Audio 提供期間免費（公布至 2026-11-30） | 每句幾秒 | `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID` |
| ElevenLabs | ElevenLabs 伺服器 | 依字元數，標籤也計入 | 每句幾秒 | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Typecast | Typecast 伺服器 | 依字元數 | 每句幾秒 | `TYPECAST_API_KEY`, `TYPECAST_VOICE_ID` |

#### Qwen3-TTS

- **它是什麼。** Qwen 團隊公開的語音模型。它從一段短錄音模仿聲音，所以影片用你的聲音說話。
- **你要安裝的。** 儲存庫裡只有呼叫它的程式碼。`qwen-tts` 套件需要你自己安裝（見上文），模型在第一支影片時從 Hugging Face 下載。
- **速度。** 10 句短句（20 秒語音）在 Apple Silicon Mac 上用了 2 分 54 秒，包括載入模型與語音辨識檢查。
- **錄音決定結果。** 用 5–15 秒、在一句話說完處結束的乾淨錄音，加上它的準確逐字稿。用一段在字詞中間切斷的錄音時，那個音節
  出現在 21 句產生結果中 11 句的開頭；改在句末切開後問題消失。
- **1.7B 與 0.6B。** 1.7B 咬字更清楚、句尾較少含糊；0.6B 較輕。
- **語氣。** 它的語氣平穩，不會演繹情緒。在我們的測試中，它從沒讓問句結尾上揚（10 次中 0 次）。

#### Fish Audio

- **它是什麼。** 一個託管語音服務。可以使用它庫裡的聲音，也可以只用 API key 複製你自己的聲音。
- **價格。** 依輸入文字的 UTF-8 位元組數計費。預設模型 `s2.1-pro-free` 免費提供（公布至 2026-11-30）；`s2.1-pro` 是同一模型
  的付費版。
- **語氣標籤。** 它會遵循 `{confident}`、`{excited}` 這類語氣標記。不加標記時 Fish 會把 Short 讀得平淡，所以在 Fish 上做的
  9:16 影片預設加上 `{confident}`。
- **問句結尾。** 它很少讓問句結尾上揚：可測量的 23 次中只有 3 次，我們試過的任何標籤都改變不了。

#### ElevenLabs

- **它是什麼。** 一個託管語音服務，有很多現成聲音，也能即時複製。預設模型是 `eleven_multilingual_v2`；`eleven_v3` 與
  `eleven_v4` 接受音訊標籤。
- **價格。** 依字元計費，音訊標籤也計入。庫裡的聲音只有付費方案才能透過 API 使用。
- **Key 權限。** 受限的 API key 需要文字轉語音權限。列出聲音還需要 `voices_read`；沒有它時，請把一個現成聲音的 id 填進
  `ELEVENLABS_VOICE_ID`。
- **字詞時間。** 它會傳回自己的字詞時間。
- **整支影片一次讀完。** 一句一句送出時，`eleven_v3` 在 18 次中有 9 次切掉了韓語句子的結尾；放在一次以 `[pause]` 結尾的請求裡
  讀，25 次中 0 次。

#### Typecast

- **它是什麼。** 一個有大量角色聲音的託管語音服務。模型是 `ssfm-v30`。
- **價格。** 依字元計費。
- **情緒。** 不用句內標籤，而是每次請求用一個情緒預設：`meta.voice.emotion`（`normal`、`happy`、`sad`、`angry`、`whisper`、
  `toneup`、`tonedown`；預設 `normal`）。句子保留 `?` 與 `!`，模型依標點決定語調。帶有自己 `emotion` 的句子會用那個預設
  單獨產生。實測：`toneup` 抬高的是整句的音高，不只是句尾。
- **字詞時間。** 它會傳回自己的字詞時間。

#### 疑問句結尾：實測結果

在英語與韓語裡，是非問句通常要最後一個音節上揚才像問句（「Is it ready?↗」）。語音模型常常把它讀平或讀降，聽起來就像直述句。
我們讓每個模型把兩個韓語問句「다음 토큰은 뭘까?」與「여기가 엔비디아 세상인가?」各錄多次，測量最後一個音節是否比前一個
音節高出 2 個半音以上。

| 模型 | 最後一個音節上揚的錄音 |
|---|---|
| ElevenLabs `eleven_v3` | 10 次中 5 次 |
| ElevenLabs `eleven_multilingual_v2` | 10 次中 4 次 |
| Fish Audio `s2.1-pro-free` | 可測量的 23 次中 3 次 |
| Qwen3-TTS 1.7B | 10 次中 0 次 |

結尾下降並不總是錯的：用什麼、哪裡、為什麼發問的句子常常是降調。所以 skill 不對此下判斷。請自己聽，只重錄那一句
（`voice.mjs --lines <id>`），直到有一條聽起來對。

完整方法、每次錄音的數據與限制（英文）：[Question intonation and read-out accuracy in four TTS models](docs/research/tts-models.md)。

### 字型

影片裡的每個字都由頁面自己繪製，所以字型作為檔案跟著影片走。每個新的影片資料夾都會把字型檔複製到 `assets/fonts/`，
預覽與最終渲染使用同一批檔案。

- **預設：[Pretendard](https://github.com/orioncactus/pretendard)。** 採用 SIL Open Font License，免費，韓文與拉丁字母在同一個
  字族裡。在電腦上裝一次，之後每個新的影片資料夾都會自動複製。如果裝了韓文手寫字型，也會一起複製，用於手寫註記。
- **任何你喜歡的字型。** 告訴模型用哪一款（「標題用 Noto Serif」、「用我的品牌字型」）。它會把那個字型檔複製進影片資料夾
  並使用。請選擇授權允許用於影片的字型。
- **沒有安裝字型時。** 文字退回系統的無襯線字型。影片照樣能渲染，但外觀取決於製作它的那台機器上的字型。

### 音效庫（選用）

把你自己的音效檔和一個 `catalog.json` 放進 `~/.super-video-agent/library`，或用 `SVA_ASSET_LIB` 指向其他資料夾；
設定了它就以它為準（格式見 [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md) 的 "Asset library"）。
沒有音效庫時，skill 用程式碼產生的音效照樣會播放。

## 致謝

Super Video Agent 源自下面這些 Reddit 貼文：它們展示了給 Claude Opus 5.5 一個主題與發揮空間時它能做到什麼。感謝它們的作者。

| 貼文 | 展示了什麼 |
|---|---|
| [Opus 5.5 is insane at making videos](https://www.reddit.com/r/singularity/comments/1worlfs/opus_55_is_insane_at_making_videos/) — u/Silver-Chipmunk7744, r/singularity | 用一頁故事提示，由程式碼渲染出完整的 SNES 風格動畫對戰 |
| [I asked Opus 5.5 to create an animation on how LLMs work](https://www.reddit.com/r/claude/comments/1wnxppc/i_asked_opus_55_to_create_an_animation_on_how/) — u/cody-fifth-door, r/claude | 用 23 個字的提示做出有旁白的惡搞講解影片 |
| [Opus 5.5 One Shot Video Generation](https://www.reddit.com/r/ClaudeAI/comments/1wnh4fn/opus_55_one_shot_video_generation/) — u/AzorAhai1TK, r/ClaudeAI | 畫面與聲音都用程式產生，工具交給模型挑 |
| [Opus 5.5 made six films, each one drawn under the rules of an old physical medium](https://www.reddit.com/r/ClaudeAI/comments/1wp6opy/opus_55_made_six_films_each_one_drawn_under_the/) — u/datathe1st, r/ClaudeAI | 每支影片一本書面筆記，在多輪之間保留 |
| [I gave Claude Opus 5.5 an MP3 and a few lines of art direction. It built a 50-shot painted music video entirely in code, with no video or image model](https://www.reddit.com/r/singularity/comments/1wp6zp8/i_gave_claude_opus_55_an_mp3_and_a_few_lines_of/) — u/DigitalDaydreamers1, r/singularity | 用簡短筆記引導的 50 個鏡頭音樂影片 |
| [Opus 5.5 creates a train journey drawn entirely in JavaScript](https://www.reddit.com/r/ClaudeAI/comments/1wnkvys/opus_55_creates_a_train_journey_drawn_entirely_in/) — u/mshort3, r/ClaudeAI | 畫面只是時間的純函式，用縮圖總表審閱 |
| [Opus 5.5 made this whole YouTube Short in one HTML file. No images, no video editor, just code](https://www.reddit.com/r/ClaudeCode/comments/1wolkjy/opus_55_made_this_whole_youtube_short_in_one_html/) — u/quitpornio, r/ClaudeCode | 聲音優先：實測的句子時間驅動畫面 |

執行階段相依套件及其授權列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

由 [DubDubDub Corp.](https://ww-w.ai) 製作 · [Super Video Agent License 1.0](LICENSE)：可以使用與修改它來製作你自己的影片，包括商業用途。不允許轉售、綁進付費課程或產品、作為託管服務提供，以及再散布。1.3.3 及更早版本仍採用 Apache-2.0。
