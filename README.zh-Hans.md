# Super Video Agent

[English](README.md) | [한국어](README.ko.md) | 简体中文 | [繁體中文](README.zh-Hant.md)

**用一份 PDF、一篇文章或一个主题，做出带配音的视频。每一帧都用代码画出来，不用视频生成模型。** 免费、源码可见的 Claude Code 插件。

<p align="center"><a href="docs/gallery/3d-flight-en.mp4"><img src="docs/gallery/demo-3d-flight.gif" width="240" alt="一镜到底的 3D 镜头飞行：从手机屏幕出发，飞过夜晚的城市，全部用代码绘制"></a></p>

▶ [观看用它做的视频](https://www.youtube.com/@ww-w-ai)

在 Claude Code 中**安装**：

```
/plugin marketplace add ww-w-ai/marketplace
/plugin install super-video-agent@ww-w-ai
```

然后用平常的话请它做视频，或运行 `/super-video-agent`。其他安装方式见[安装](#安装)。

一眼看懂（实测）：

- 用三份 10 页的 PDF 做一支 88 秒短视频：模型费用约 $22，模型用时 1 小时。这次的配音由本地模型生成。
- 一支 40 秒的 3D 飞行视频：在 CPU 上用 4 个 worker 渲染，耗时 11–20 分钟。
- 渲染完成后，只改一句配音、一个场景或一种语言，其余部分不用重新渲染。
- 配音：本地模型（Qwen3-TTS、Fish Speech、MeloTTS）在你自己的电脑上运行，不按字数收费；托管服务（Fish Audio、ElevenLabs、Typecast）按字符数或文本字节数收费。

一个 skill 就能做下面这些类型的视频。每一行都附上写明做法的文件，安装之前就能先读懂它怎么工作。

| 视频类型 | 画面怎么做 | 方法文档 |
|---|---|---|
| Shorts、16:9 讲解视频、1:1 与 4:5 信息流视频 | 在一个 HTML 页面里用 Canvas、SVG、Web Audio 按时间绘制 | [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md) |
| 3D 视频 | 已安装的 Blender 通过测试渲染就用 Blender，否则用 Three.js/WebGL | [`references/blender.md`](skills/super-video-agent/references/blender.md), [`references/3d.md`](skills/super-video-agent/references/3d.md) |
| 2.5D 照片视差 | 把一张照片切成不同深度的图层，配一条镜头运动 | [`references/parallax.md`](skills/super-video-agent/references/parallax.md) |
| 拼装过程视频 | 从 LDraw 模型文件得出拼装顺序、位置和插入方向 | [`references/assembly.md`](skills/super-video-agent/references/assembly.md) |
| 多语言版本 | 画面只渲染一次，每种语言的配音和字幕叠加在上面 | [`scripts/dub.mjs`](skills/super-video-agent/scripts/dub.mjs) |

**给 Claude Opus 5.5 一份 PDF、一篇文章或一个主题，就能拿回一支用你克隆的声音或你选的声音配音的视频：
YouTube Short、16:9 讲解视频、方形信息流视频、3D 视频，或者动起来的照片。每一帧都用代码画出来，渲染完成后，
你可以只换一句配音、一个场景或一种语言，其余部分不动。** Super Video Agent 是一个 Claude Code 插件，
做法和 2026 年 9 月 Reddit 上流传的那些用代码画出来的视频一样，另外加上了那些视频没有的东西：适用于任何语言
的读音规则和发音词典、渲染之后只改要改的部分、任意画幅和格式、为成本调好的四会话流水线，以及按脚本触发的音效库。

在一个真实任务上实测：三份 10 页的篮球球探报告 PDF → 一支 88 秒短视频。脚本 $4.05，脚本审阅 $1.75，
成片 $16.34，合计约 $22，模型用时 1 小时。这次的配音由本地模型生成；用托管配音时，还要加上该服务按字符计的费用。

## 作品展示

下面每支视频都是用这个 skill 做的，并已发布在 YouTube。点击片段即可观看。

<table>
<tr>
<td align="center" width="33%"><a href="https://youtube.com/shorts/-Cxl0hHkjio"><img src="docs/gallery/short-iphone-duo-teardown.gif" width="200" alt="用代码绘制的拆解镜头：一部 3D 折叠手机分解成漂浮的玻璃、主板、铰链图层"></a><br>3D 产品广告 Short：折叠手机一层层拆开。</td>
<td align="center" width="33%"><a href="https://youtube.com/shorts/DoNDDrccoWA"><img src="docs/gallery/short-haiku-tetris-race.gif" width="200" alt="三个 AI 模型各自做的俄罗斯方块并排运行，三个都零错误"></a><br>基准测试新闻 Short：三个 AI 做的俄罗斯方块并排比赛。</td>
<td align="center" width="33%"><a href="https://youtube.com/shorts/OChlch1cUrc"><img src="docs/gallery/short-same-face-16-edits.gif" width="200" alt="两个图像模型把同一位女性重新画到月球、丛林、海底和 8 位游戏里"></a><br>图像对比 Short：两个图像模型重画同一张脸。</td>
</tr>
</table>

<table>
<tr>
<td align="center" width="50%"><a href="https://www.youtube.com/watch?v=tjqvLeqh79w"><img src="docs/gallery/longform-ai-news-desk.gif" width="400" alt="九月的日历被 AI 模型发布填满，镜头拉远后出现一位 3D 小熊新闻主播"></a><br>长视频新闻节目：由 3D 主播主持的月度 AI 回顾。</td>
<td align="center" width="50%"><a href="https://youtu.be/AqV1cnGTEZY"><img src="docs/gallery/longform-tutorial-command-to-result.gif" width="400" alt="左边逐字打出一条 Claude Code 命令，右边出现做好的 Short"></a><br>长视频教程：左边是命令，右边是做好的 Short。</td>
</tr>
</table>

**3D 飞行**（本页顶部）：一支 40 秒的 Short，一镜到底的镜头从手机屏幕出发，飞过夜晚的城市，沿海底光缆而下，
进入数据中心和 GPU 芯片，最后回到显示出答案的手机。全部用 Three.js/WebGL 代码绘制，没有用视频或图像生成模型。
▶ [英文 (MP4, 7.5 MB)](docs/gallery/3d-flight-en.mp4) · [韩文](docs/gallery/3d-flight-ko.mp4)

## 使用

先完成安装（[安装](#安装)）。然后在 Claude Code 里用 Opus 5.5 调用这个 skill，说出你想要什么：

```
/super-video-agent Make a YouTube Short from this PDF. Use my voice from me.wav (transcript: "…").
```

以插件方式安装时，命令显示为 `/super-video-agent:super-video-agent`；输入 `/super-video-agent` 后从列表里选择即可。
也可以不用命令：直接用平常的话请它做视频，skill 同样会启动。

skill 会先问你：按 Shorts 公式（开头先抛钩子、节奏快、带固定钩子标题的分栏画面）还是自由风格；推断不出画幅和时长
时也会问；还会问在哪个环节停下来让你审看，以及其他语言版本是否之后叠加到同一画面上。如果你交给它写好的脚本
或分镜，它会问是照原样用还是重新改写。

### 3D 视频

说一句“3D”，skill 就会自己走 3D 流程：

```
/super-video-agent Show what happens after you press Enter on an AI prompt, in 3D like a video game
```

已经装了 Blender？agent 会先跑一次小的 EEVEE 测试渲染（`scripts/probe-blender.mjs`），通过的话，新的 3D 视频就用
Blender 做。否则使用内置的 Three.js 流程。你不需要安装 Blender，skill 也从不下载它。`SVA_BLENDER_BIN` 可以指定
要测试的那一个 Blender。Three.js 没有随包附带，走这条路时 agent 会把它装进你的视频文件夹。你明确指定渲染器时
以你的选择为准，修改已有视频时保留原来的渲染器。
详见 [`references/blender.md`](skills/super-video-agent/references/blender.md), [`references/3d.md`](skills/super-video-agent/references/3d.md)。

### 照片 拼装过程 其他语言

```
/super-video-agent Make this photo move in 2.5D for the opening, with the source credited on screen
```

- **2.5D 照片视差。** 把一张照片切成三层深度图层（默认用多边形切割，alpha 遮罩和深度图可选），一条镜头运动让近处的
  图层移动得多、远处的移动得少。如果某个图层的边缘会在运动中露出来，引擎会报告出来，并给出能修正它的缩放比例。
  照片的来源、作者和许可写进 `FILM.md`，照片出现期间画面上一直保留清晰可读的出处
  （[`references/parallax.md`](skills/super-video-agent/references/parallax.md)）。
- **拼装过程视频。** 交给它一个 LDraw 文本格式的模型和对应的零件文件夹。`scripts/ldraw-bake.mjs` 会得出拼装顺序、
  每个零件的位置、插入方向，并做路径检查；缺少零件时会停下并报出零件名。skill 掌握的一种做法是：左边是说明书页面，
  右边是 3D 模型，两边由同一个步骤序号驱动。没有旁白的视频用静音时钟（`scripts/silent-clock.mjs`）运行
  （[`references/assembly.md`](skills/super-video-agent/references/assembly.md)）。
- **一个画面，任何语言。** 先生成你的语言的配音，由它定下时间轴。画面只渲染一次，不烧录字幕，包括你的语言在内，
  每种语言都用 `dub.mjs` 叠加上去。偏长的句子最多加速 10%，或者列出来请你改短；画面不动。

### 接入图像和视频模型

默认不需要任何图像或视频模型：每一帧都用代码画。想在画面上放更多东西——照片级背景、产品图、几秒生成的动态画面——
就在同一条消息里写明用哪个工具、做哪个镜头。

下面的请求**只是示例**。请换成你自己用的工具和调用方式；skill 不附带也不默认使用其中任何一个。

```
/super-video-agent Make a 60-second promo from this deck. Generate the opening background with
Codex image generation, and a 5-second product clip with Seedance through browser-use.
```

请说明每个工具怎么调用（CLI、API key，或你已登录的浏览器），也可以自己生成文件交给它。无论哪种方式，生成的媒体都是
素材：skill 围绕素材重新构图每个场景，并在 `FILM.md` 里记录每个文件的来源和许可。

## 为什么做它

2026 年 9 月，Reddit 上满是 Claude Opus 5.5 完全用代码做出的视频，比如孔版印刷风格的火车旅行、SNES 风格的动画对战、
火柴人 YouTube Short。提示词都很短，模型自己挑工具，自己检查渲染结果。

我们在自己的频道上试了一下，每次都撞上同样的三堵墙：

1. **时间对不上。** 按估算排的场景，一旦真实的声音读起脚本，就会和旁白差上好几秒。
2. **声音读错。** 数字、人名、英文单词读错了，要等渲染完才发现。
3. **改一处就要全部重渲染。** 改一句话就得重新生成配音和整支视频。

所以我们做了 Super Video Agent：一个能越过这三堵墙、同时让模型自由设计每支视频的 skill。

## 主要功能

Super Video Agent 保留模型的自由（除非你自带模板，否则外观没有固定框架），再加上模型自己做不到的五件事：

1. [适用于每种语言的读音规则](#1-适用于每种语言的读音规则)：数字、人名、英文单词第一次就读对。
2. [渲染后只改变了的部分](#2-渲染后只改变了的部分)：只换一句、一个场景或一种语言，其余不动。
3. [任意画幅 任意格式 自带模板](#3-任意画幅-任意格式-自带模板)：Shorts、16:9、方形、3D、照片视差、拼装过程、系列剧集。
4. [四个阶段 四个会话 按需调整推理强度](#4-四个阶段-四个会话-按需调整推理强度)：一支 88 秒视频约 $22。
5. [由脚本触发的音效](#5-由脚本触发的音效)：落在具体的词上，并为是否合适打分。

### 1. 适用于每种语言的读音规则

合成语音照着拼写读，而没有哪种语言是完全照拼写发音的。Super Video Agent 在生成任何配音之前，先把实际读法写进脚本。
只要语音引擎会说的语言都适用：数字、单位、人名和缩写有一份通用检查表，有专属规则文件的语言还会处理拼写里看不出的读音。

付费 TTS 服务也许用不着这些。但有了这些规则，低成本或本地的 TTS 库也常常能读对。

| 语言 | 写法 | 读法 (`say`) | 规则 |
|---|---|---|---|
| 英语 | `Opus 5.5`, `$16.34` | Opus five point five, sixteen dollars thirty-four | 版本号和金额读成词 |
| 韩语 | `4.4`, `6월` | 사쩜사, 유월 | 小数点读作 [쩜]；月份用固定读法 |
| 日语 | `3本`, `6本` | さんぼん, ろっぽん | 量词会改变读音 |
| 中文 | `2个`, `27.3%` | 两个, 百分之二十七点三 | 量词前用“两”；百分数语序颠倒 |

故意引用的错误读法（“不是 X 而是 Y”）也按发音来拼写，因为语音模型会悄悄纠正常见的误读。

拼写解决不了的词，`plan.json` 里的发音词典提供三种办法：用该语言自己的文字重新拼写；给能读 SSML（语音合成标记语言）
`<phoneme>` 标签的引擎提供 IPA（国际音标，词典里用的发音符号）；或者换一个词。一个条目覆盖所有用到这个词的句子，
字幕保留原拼写。

```json
"pronounce": { "Nguyen": { "say": "Win", "ipa": "ˈŋwiən" } }
```

每句生成的配音都会再用语音识别转写回来核对。只有明显的错误才会被标记——一句话错了一半以上，或者录音长度不到原句的
70% 或超过 140%——因为语音识别本身在人名和同音词上也会出错。标记是请你去听的依据，不会自动重做：只有你加上
`voice.mjs --retry-flagged N` 时才会重做被标记的句子。修正读音时这句话的时间位置不变，所以视频不用重新渲染。
([`references/readout.md`](skills/super-video-agent/references/readout.md), [`scripts/lib/pronounce.mjs`](skills/super-video-agent/scripts/lib/pronounce.mjs), [`scripts/lib/stt-compare.mjs`](skills/super-video-agent/scripts/lib/stt-compare.mjs), `scripts/voice.mjs --lines`)

### 2. 渲染后只改变了的部分

渲染好的视频并没有被锁死。它的每一部分都能单独替换：一句旁白、字幕、一个场景、一种语言、片头或片尾。其余部分不动，
你已经认可的部分保持原样。

| 你想改的 | 运行什么 | 保持不变的 |
|---|---|---|
| 一句旁白：一个词、语气、读错的地方 | `voice.mjs --lines <id>` 只重录这一句，裁到有声部分，放回原来的时间位置：最多加速到 1.1 倍，后面留出最短的换气时间。仍然放不下的录音会被拒绝，保留原来的片段 | 画面和其他所有句子 |
| 连同前后一起听改过的句子 | `preview-changes.mjs <reel> --lines <ids> --media <mixed.mp4>` 为每句改动截取从上一句结尾到下一句开头的片段，画面、旁白和背景声一起 | 视频 |
| 字幕文字或断行位置 | 改 `plan.json`（用 `\|` 指定断行），先出画面的视频再运行一次 `dub.mjs` | 画面 |
| 一个场景 | `render.mjs --only <shot>` 只渲染这个镜头并接回视频；`render.mjs --span <from>-<to>` 只重渲染这几秒。Blender 画面只重渲染受影响的帧范围 | 其他所有镜头 |
| 第二种语言 | `dub.mjs --lang <code>` 把这种语言的配音和字幕叠加到同一个画面上 | 只渲染一次的画面 |
| 某种语言里句子之间的换气空间 | `dub.mjs --min-gap <sec>` 只在句子挤到下一句的位置，把画面和音效一起放慢，直到间隔达到 `<sec>`；配音速度不变 | 配音、第一帧和最后一帧、其他语言版本 |
| 重新对时或重新摆放的配音音轨 | `render.mjs --narration <wav> --timings <json>` 用这条音轨代替视频自己的配音来渲染 | `voice/narration.wav` 和 `voice/timings.json` |
| 上传用的片头和片尾 | `join.mjs` 接上它们，并报告每个接缝处的响度、咔哒声风险和画面匹配 | 正片 |

修改分好几轮提出时，每条要求都记在 `FILM.md` 里的同一份清单上，并标明状态（已完成、未完成、被后来的要求改动）。
每一轮都对照整份清单来计划和检查，新的修改不会把之前改好的东西改回去。

在作品展示里的 3D 视频上实测：一次完整渲染耗时 11–20 分钟。审阅后的八处配音和字幕修改（换一个词、一个结尾需要上扬的
问句、一个被单独留在一行的字幕词）都没有重新渲染 3D 画面。2D 视频只重渲染改动的镜头，几分钟就好。
([`scripts/voice.mjs`](skills/super-video-agent/scripts/voice.mjs), [`scripts/dub.mjs`](skills/super-video-agent/scripts/dub.mjs), [`scripts/render.mjs`](skills/super-video-agent/scripts/render.mjs), [`scripts/preview-changes.mjs`](skills/super-video-agent/scripts/preview-changes.mjs), [`scripts/join.mjs`](skills/super-video-agent/scripts/join.mjs))

已有的录音可以按照[音频编辑指南](skills/super-video-agent/guides/audio-editing.md)在本地调整停顿和语速，再替换旁白，不用重新渲染画面。

### 3. 任意画幅 任意格式 自带模板

- **任意画幅。** 四种尺寸一个参数就能开始：9:16（Shorts、Reels、TikTok）、16:9（YouTube、演示）、1:1 和 4:5（信息流）。
  其他尺寸也可以，因为渲染器直接使用页面声明的宽和高。
- **任意外观。** 选择 Shorts 公式（开头先抛钩子、节奏快、带固定标题的分栏画面）、自由风格（模型为这支视频设计外观），
  或带上你自己的模板：版式、品牌颜色和字体、系列标题卡。skill 会在模板里搭建每个场景。
- **任意类型。** 用 PDF 或文章做的讲解视频、用演示文稿做的宣传片、用代码画的新闻台或实时比分画面、Blender 或 WebGL
  3D 视频、2.5D 照片视差、用模型文件做的拼装过程视频、带片头片尾的系列剧集，以及共用一个画面的多语言版本。
- **一直在变好。** 我们每次特意挑一支更难的视频，再把做它所需要的东西放回 skill。作品展示里的视频就是试验台。

### 4. 四个阶段 四个会话 按需调整推理强度

每个阶段只读上一阶段留下的文件，所以每个阶段都在新的会话里、用各自的推理强度运行。在那支 88 秒视频上实测：

| 阶段 | 产出 | 推理强度 | 费用 |
|---|---|---|---|
| 脚本 | `plan.json`, `FILM.md`（带出处的事实） | xhigh | $4.05 |
| 审阅 | 经过六轮审阅后锁定的 `plan.json` | low | $1.75 |
| 配音 | 带有实测 `timings.json` 的 `voice/` | low | $0（这次用本地模型） |
| 成片 | `reel.html`, `out/final-<timestamp>.mp4` | xhigh | $16.34 |

“推理强度”（effort）是 Claude 回答前思考多久的设置，从 `low` 到 `max`。强度越高，费用越多、耗时越长，所以只在需要的
地方调高。

为了看清它在哪里起作用，我们用每一种强度为同一支视频写脚本，并把脚本里的每个数字和来源 PDF 逐一核对：

| 推理强度 | 费用 | 用时 | 与来源不符的数字 |
|---|---|---|---|
| low | $2.21 | 2m35s | 0 |
| medium | $2.13 | 1m57s | 0 |
| high | $3.40 | 6m11s | 0 |
| xhigh | $4.05 | 6m05s | 0 |
| max | $8.04 | 23m14s | 0 |

- 每种强度事实都没错，所以在意成本时，脚本用较低的强度也没问题。`max` 的费用约是 `medium` 的四倍，用时是十二倍。
- 审阅阶段用 `low` 运行，仍然抓出了脚本会话漏掉的两处：一句可以有两种理解的话，以及一个配音会读两遍的单位。

视频完成后，skill 会输出每个阶段的用时、会话数、费用和 token，以及按请求记录的语音合成用量
（`scripts/runner/cost-report.mjs`）。详见 `SKILL.md` 的“Four stages, four sessions”一节。

### 5. 由脚本触发的音效

列表开始时“叮”一声，笑点上一记鼓点：这些小声音让 Short 活起来，可在剪辑软件里一个个手动放很慢。这里由模型在写脚本时
一起放好。

1. **你准备一个音效库。** 把你自己的音效文件（和简短的反应片段）放进一个文件夹，配一个 `catalog.json`，写明每个文件
   是什么、能否商用。
2. **模型为每句挑音效。** 它按关键词搜索音效库，把每个声音钉在这句话的某个时刻：开头、结尾，或某个具体的词
   （“在 *right* 这个词上”）。
3. **渲染器在那个时刻精确混入。** 每个声音按长度裁剪、淡出，并调整电平，不让大声的文件盖过配音。短视频片段在同一条
   时间轴上逐帧播放。

许可也会替你检查：没有标为可商用的文件，除非你允许，否则不会进入公开发布的视频。仓库里不附带任何音效文件，因为多数
音效包都有自己的使用条款。

没有音效库也有声音。skill 会用代码自己生成音效
（[`scripts/engine/reel-audio.js`](skills/super-video-agent/scripts/engine/reel-audio.js)）：click、type、thud、whoosh、pop、tick、ding 和 pluck，在渲染时用噪声和振荡器
合成。没有文件，不用查许可，同一个 cue 每次都发出同样的声音，所以重新渲染结果一致。
([`scripts/assets.mjs`](skills/super-video-agent/scripts/assets.mjs), [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md), "Asset library")

之后每个音效都会按是否合适打分：它是否符合画面上发生的事的大小、材质和速度，是否属于这支视频的世界？先测量每个声音
（长度、峰值、起音、亮度、音高走向），设置了 `TYPESAFE_API_KEY` 时由 TypeSafe AI 的 Jev 判定（满分 1，0.8 通过），
否则由当前模型按评分表判定。不合格的声音会为这支视频重新设计，最多三轮。
([`scripts/sfx-cards.mjs`](skills/super-video-agent/scripts/sfx-cards.mjs), [`references/sound.md`](skills/super-video-agent/references/sound.md) §7)

## 其他内容

### 配音

- **先有声音，画面跟着声音走。** 在任何场景出现之前，先生成并测量旁白。`voice/timings.json` 记录每句话和每个词的开始
  时间，所有场景都按它定时，所以字幕永远不会抢在声音前面（[`scripts/voice.mjs`](skills/super-video-agent/scripts/voice.mjs)）。
- **你自己的声音，或任何引擎。** 用 5–15 秒的录音在自己的电脑上克隆你的声音（Qwen3-TTS 或 Fish Speech），或者使用
  托管服务（Fish Audio、ElevenLabs、Typecast）、MeloTTS，或你自己录好的文件。Fish Audio (S2) 和 ElevenLabs (v3/v4)
  还接受写在读法文本里的语气标记，如 `{confident}` 或 `{pause}`，会转换成各模型自己的标签；字幕里不会出现。每句话可以
  有自己的声音，所以一支视频里可以有多个说话人。
- **一个声音一次读完，再按句切开。** 每个服务都把同一个声音的所有句子放在一次请求里生成，再由 skill 按句切开，整支视频
  的声音保持同一种状态。
- **每句话都回听。** 配音生成后，语音识别逐句听写并与脚本比对，波形检查则寻找被切掉的开头、被切掉的结尾或咔哒声。
  被标记的句子会附上 id，你知道该去听哪几句。
- **每个句尾都要审查。** 每个放进去的片段都会和未裁剪的原始录音比对：如果最后一个音节丢了 20 ms 或更多，这句话就被
  标为 `END_CUT`，修正方法是重新放入原始录音，不需要重新合成。
- **本地克隆也能收尾干净。** 本地语音模型常常切掉最后一个音节。skill 让声音在每句话后再读一个短词，就像镜头之间的场记板，
  然后在它之前的停顿处切开，每句话都能自然结束。
- **用耳朵选语气。** 在生成整段旁白之前，skill 可以把开场那句用两到四种语气各录一遍（`voice.mjs --takes`），并排放给你听。
  你选中的那个（`--pick`）就成为每一句的语气。

### 脚本

- **流畅的旁白。** 每句话都有自己的停顿：下一句延续同一个想法时短，换场时长。句子收尾时能接得上，逗号只在强调时用，
  听起来不像照着稿子念。
- **换气长度写在计划里。** `meta.minBreathMs`（默认 500 ms）是句子之间最短的停顿。体育解说这类快节奏的现场话语，可以把
  `meta.gapMs` 设在 250 左右、最短换气设在 200 ms 左右；某句话的 `pauseAfterMs` 设定的静默会按原样保留。
- **配音之前五轮审阅。** 对照来源的事实、故事、口语表达、读法，以及最后通读。脚本锁定之后才生成一次配音。

### 画面

- **每次都是同一帧。** 每个页面只根据时间绘制一帧（`seek(t)`），同一时刻总是得到同样的像素。预览、重新渲染和检查结果都一致。
- **文字避开应用按钮。** 字幕避开 Shorts 和 TikTok 放按钮和标题的区域（1080×1920 下为 x 80–888、y 200–1470）。
  画面仍然铺满整个画幅。
- **在阅读停顿处断开的字幕。** 字幕先在标点处断开，再分成长度均匀的行，只剩一个词时并入相邻一行。在脚本里加 `|` 可以
  手动指定断行，配音不会读出它。
- **测量字幕对比度。** 渲染和每个语言版本都会报告每句字幕与背后画面的对比度，以 WCAG 比值表示（语言版本写在
  `dub/<code>/contrast.json`）。

### 检查与输出

- **视频会自我检查。** 渲染之后，[`scripts/review.mjs`](skills/super-video-agent/scripts/review.mjs) 生成联系表，并检查定格的画面、超出框的文字、响度、没踩准时刻的音效
  和无声的空隙。你得到的是数字，外加值得去听的时间点。
- **每次渲染都保留。** 每次渲染都有自己的带时间戳的文件，`out/final.mp4` 始终指向最新的一份。正在播放这支视频的播放器
  不会被新渲染打断，你也能比较不同版本。

## 安装

需要 Node 22+、`PATH` 中的 FFmpeg，以及供 Playwright 使用的 Chromium。

### skill 本体

**作为 Claude Code 插件：**

```
/plugin marketplace add ww-w-ai/marketplace
/plugin install super-video-agent@ww-w-ai
```

第一次使用时，skill 会把它的 Node 依赖和 Chromium 安装到自己的文件夹里（`node scripts/setup.mjs`），然后检查 FFmpeg。

**作为 Codex 插件：**

```bash
codex plugin marketplace add ww-w-ai/marketplace
codex plugin add super-video-agent@ww-w-ai
```

更新时先运行 `codex plugin marketplace upgrade ww-w-ai`，再运行一次同样的 `add` 命令。

**作为独立的 skill**（Claude Code 或 Codex）：

```bash
git clone https://github.com/ww-w-ai/super-video-agent /tmp/super-video-agent
cp -R /tmp/super-video-agent/skills/super-video-agent ~/.claude/skills/super-video-agent   # Codex: ~/.codex/skills/super-video-agent
node ~/.claude/skills/super-video-agent/scripts/setup.mjs
```

### 语音与语音检查

至少设置一个语音服务；一个都没有时，配音步骤会停下并列出需要设置什么。本地服务在你的电脑上运行；托管服务在该服务的服务器上
运行，需要 API key。只克隆你自己的声音，或你获准使用的声音。

用 Qwen3-TTS 在本地克隆你的声音：

1. 建一个 Python 环境（Qwen3-TTS 推荐 Python 3.12），安装语音模型：

   ```bash
   python3.12 -m venv ~/.venvs/sva-voice
   ~/.venvs/sva-voice/bin/pip install -U qwen-tts
   ```

2. 第一支视频会从 Hugging Face 下载权重：1.7B 约 4.2 GB，0.6B 约 2.3 GB。
3. 录 5–15 秒你自己的声音，在一句话说完的地方结束，并一字不差地写下你说了什么。skill 把这两者用作 `meta.voice.refAudio`
   和 `refText`。

语音检查在 Apple silicon macOS 上用 mlx-whisper 逐句转写：先用 `small` 模型，只对第一次转写看起来可疑的句子再用 `turbo`
模型复查。

```bash
python3.11 -m venv ~/.venvs/sva-stt
~/.venvs/sva-stt/bin/pip install mlx-whisper
```

然后运行一次 `setup.mjs --stt-models`（独立 skill 安装时为
`node ~/.claude/skills/super-video-agent/scripts/setup.mjs --stt-models`），下载这两个模型（几百 MB 到几 GB）。在其他机器上，
可以用 `SVA_STT_ENGINE=groq` 加 `GROQ_API_KEY` 调用托管的 Whisper API；只有这种情况下音频才会离开你的电脑。两者都没有时，
检查会跳过并给出提示。

告诉 skill 这两个 Python 在哪里。把下面几行加进 `~/.zshenv`（或你所用 shell 的配置文件）：

```bash
export SVA_QWEN3_PYTHON=~/.venvs/sva-voice/bin/python
export SVA_STT_PYTHON=~/.venvs/sva-stt/bin/python
```

Qwen3-TTS 模型：

| 模型 | 下载大小 | 说明 |
|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（默认） | 约 4.2 GB | 吐字更清楚，句尾更少含糊 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 约 2.3 GB | 更轻；没那么清楚 |

用 `SVA_QWEN3_MODEL` 设置所有视频，或用 `meta.voice.model` 只设置一支视频。有 NVIDIA GPU 的机器请设 `SVA_QWEN3_DEVICE=cuda`。

skill 读取的全部变量：

| 变量 | 指向 | 用于 |
|---|---|---|
| `SVA_QWEN3_PYTHON` | 能 `import qwen_tts` 的 Python（[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)） | 本地声音克隆 |
| `SVA_QWEN3_MODEL` | Qwen3-TTS 模型 id（默认 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`） | 所有视频换用其他模型；计划里的 `meta.voice.model` 仍然优先 |
| `SVA_FISH_DIR` | 包含 `fish-speech/`（代码检出）和 `.venv-tts/`（它的 Python）的文件夹 | 本地 Fish Speech |
| `SVA_MELO_PYTHON` | 装有 MeloTTS 的 Python | 本地 MeloTTS |
| `SVA_QWEN3_DEVICE`, `SVA_FISH_DEVICE` | `mps`（默认）、`cuda` 或 `cpu` | 非 Apple 机器 |
| `FISH_AUDIO_API_KEY`（或 `FISH_API_KEY`）, `FISH_AUDIO_VOICE_ID` | 你的 Fish Audio key 和声音 | 托管 Fish Audio |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | 你的 ElevenLabs key 和声音 | 托管 ElevenLabs |
| `TYPECAST_API_KEY`, `TYPECAST_VOICE_ID` | 你的 Typecast API key 和声音（`tc_…`） | 托管 Typecast |
| `SAY_VOICE` | macOS `say` 的声音名称（默认 `Yuna`） | 仅 macOS，配合 `--provider say` |
| `SVA_STT_ENGINE` | `mlx`（默认）或 `groq` | 语音检查 |
| `SVA_STT_PYTHON` | 装有 `mlx-whisper` 的 Python | 语音检查（未设置时跳过并提示） |
| `SVA_STT_MODEL`, `SVA_STT_MODEL_RECHECK` | 初查和复查模型（默认 `small`、`turbo`） | 可选 |
| `GROQ_API_KEY` | 你的 Groq key | 用 `SVA_STT_ENGINE=groq` 做语音检查时 |
| `SVA_BLENDER_BIN` | 一个 Blender 可执行文件的绝对路径；只测试这一个 | 可选，3D 视频 |
| `SVA_ASSET_LIB` | 你的音效库文件夹（默认 `~/.super-video-agent/library`） | 可选 |

**在哪里设置**：它们都是环境变量。请选一个适合你环境的地方：

| 环境 | 位置 |
|---|---|
| Claude Code（任何系统） | `~/.claude/settings.json` 中的 `env`：`{"env": {"ELEVENLABS_API_KEY": "..."}}` |
| macOS · Linux，zsh | 在 `~/.zshenv` 中写 `export ELEVENLABS_API_KEY="..."` |
| Linux，bash | 在 `~/.bashrc` 中写 `export ELEVENLABS_API_KEY="..."` |
| Windows (PowerShell) | 运行 `setx ELEVENLABS_API_KEY "..."`，然后打开一个新终端 |

### 选哪个语音模型

不加 `--provider` 时，`voice.mjs` 会在你已设置的服务里按下面的顺序选择，并告诉你用了哪个：你自己的录音（`voice/in/`）、
带参考声音的 Qwen3-TTS、Fish Audio、ElevenLabs、Typecast、MeloTTS。Fish Speech 和 macOS `say` 只在你指定时使用。每次
合成请求都记录在 `tts-usage.jsonl` 里（发送的字符数、返回的秒数、服务方报告的费用）。

| 模型 | 在哪里运行 | 费用 | 速度 | 设置 |
|---|---|---|---|---|
| Qwen3-TTS 1.7B / 0.6B | 你的电脑 | 不按字数收费 | 这些里最慢 | `SVA_QWEN3_PYTHON` + 5–15 秒你自己声音的录音 |
| Fish Speech | 你的电脑 | 不按字数收费 | 这里没有测量 | `SVA_FISH_DIR` |
| MeloTTS | 你的电脑 | 不按字数收费 | 快；一个韩语说话人 | `SVA_MELO_PYTHON` |
| Fish Audio | Fish Audio 服务器 | 按文本的 UTF-8 字节数；默认的 `s2.1-pro-free` 在 Fish Audio 提供期间免费（公布至 2026-11-30） | 每句几秒 | `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID` |
| ElevenLabs | ElevenLabs 服务器 | 按字符数，标签也计入 | 每句几秒 | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Typecast | Typecast 服务器 | 按字符数 | 每句几秒 | `TYPECAST_API_KEY`, `TYPECAST_VOICE_ID` |

#### Qwen3-TTS

- **它是什么。** Qwen 团队公开的语音模型。它从一段短录音里模仿声音，所以视频用你的声音说话。
- **你要安装的。** 仓库里只有调用它的代码。`qwen-tts` 包需要你自己安装（见上文），模型在第一支视频时从 Hugging Face 下载。
- **速度。** 10 句短句（20 秒语音）在 Apple Silicon Mac 上用了 2 分 54 秒，包括加载模型和语音识别检查。
- **录音决定结果。** 用 5–15 秒、在一句话说完处结束的干净录音，加上它的准确文字稿。用一段在词中间切断的录音时，那个音节
  出现在 21 句生成结果中 11 句的开头；改在句末切开后问题消失。
- **1.7B 与 0.6B。** 1.7B 吐字更清楚、句尾更少含糊；0.6B 更轻。
- **语气。** 它的语气平稳，不会演绎情绪。在我们的测试中，它从没让问句结尾上扬（10 次中 0 次）。

#### Fish Audio

- **它是什么。** 一个托管语音服务。可以使用它库里的声音，也可以只用 API key 克隆你自己的声音。
- **价格。** 按输入文本的 UTF-8 字节数计费。默认模型 `s2.1-pro-free` 免费提供（公布至 2026-11-30）；`s2.1-pro` 是同一模型
  的付费版。
- **语气标签。** 它会遵循 `{confident}`、`{excited}` 这类语气标记。不加标记时 Fish 会把 Short 读得平淡，所以在 Fish 上做的
  9:16 视频默认加上 `{confident}`。
- **问句结尾。** 它很少让问句结尾上扬：可测量的 23 次里只有 3 次，我们试过的任何标签都改变不了。

#### ElevenLabs

- **它是什么。** 一个托管语音服务，有很多现成声音，也能即时克隆。默认模型是 `eleven_multilingual_v2`；`eleven_v3` 和
  `eleven_v4` 接受音频标签。
- **价格。** 按字符计费，音频标签也计入。库里的声音只有付费方案才能通过 API 使用。
- **Key 权限。** 受限的 API key 需要文字转语音权限。列出声音还需要 `voices_read`；没有它时，请把一个现成声音的 id 填进
  `ELEVENLABS_VOICE_ID`。
- **词级时间。** 它会返回自己的词级时间。
- **整支视频一次读完。** 一句一句发送时，`eleven_v3` 在 18 次中有 9 次切掉了韩语句子的结尾；放在一次以 `[pause]` 结尾的请求里
  读，25 次中 0 次。

#### Typecast

- **它是什么。** 一个有大量角色声音的托管语音服务。模型是 `ssfm-v30`。
- **价格。** 按字符计费。
- **情绪。** 不用句内标签，而是每次请求用一个情绪预设：`meta.voice.emotion`（`normal`、`happy`、`sad`、`angry`、`whisper`、
  `toneup`、`tonedown`；默认 `normal`）。句子保留 `?` 和 `!`，模型据标点决定语调。带有自己 `emotion` 的句子会用那个预设
  单独生成。实测：`toneup` 抬高的是整句的音高，不只是句尾。
- **词级时间。** 它会返回自己的词级时间。

#### 疑问句结尾：实测结果

在英语和韩语里，是非问句通常要最后一个音节上扬才像问句（“Is it ready?↗”）。语音模型常常把它读平或读降，听起来就像陈述句。
我们让每个模型把两个韩语问句“다음 토큰은 뭘까?”和“여기가 엔비디아 세상인가?”各录多次，测量最后一个音节是否比前一个
音节高出 2 个半音以上。

| 模型 | 最后一个音节上扬的录音 |
|---|---|
| ElevenLabs `eleven_v3` | 10 次中 5 次 |
| ElevenLabs `eleven_multilingual_v2` | 10 次中 4 次 |
| Fish Audio `s2.1-pro-free` | 可测量的 23 次中 3 次 |
| Qwen3-TTS 1.7B | 10 次中 0 次 |

结尾下降并不总是错的：用什么、哪里、为什么提问的句子常常是降调。所以 skill 不对此下判断。请自己听，只重录那一句
（`voice.mjs --lines <id>`），直到有一条听起来对。

完整方法、每次录音的数据和局限（英文）：[Question intonation and read-out accuracy in four TTS models](docs/research/tts-models.md)。

### 字体

视频里的每个字都由页面自己绘制，所以字体作为文件跟着视频走。每个新的视频文件夹都会把字体文件复制到 `assets/fonts/`，
预览和最终渲染使用同一批文件。

- **默认：[Pretendard](https://github.com/orioncactus/pretendard)。** 采用 SIL Open Font License，免费，韩文和拉丁字母在同一个
  字族里。在电脑上装一次，之后每个新视频文件夹都会自动复制。如果装了韩文手写字体，也会一起复制，用于手写批注。
- **任何你喜欢的字体。** 告诉模型用哪一款（“标题用 Noto Serif”、“用我的品牌字体”）。它会把那个字体文件复制进视频文件夹
  并使用。请选择许可允许用于视频的字体。
- **没有安装字体时。** 文字退回系统的无衬线字体。视频照样能渲染，但外观取决于制作它的那台机器上的字体。

### 音效库（可选）

把你自己的音效文件和一个 `catalog.json` 放进 `~/.super-video-agent/library`，或用 `SVA_ASSET_LIB` 指向其他文件夹；
设置了它就以它为准（格式见 [`references/pipeline.md`](skills/super-video-agent/references/pipeline.md) 的 "Asset library"）。
没有音效库时，skill 用代码生成的音效照样会播放。

## 致谢

Super Video Agent 源自下面这些 Reddit 帖子：它们展示了给 Claude Opus 5.5 一个主题和发挥空间时它能做到什么。感谢它们的作者。

| 帖子 | 展示了什么 |
|---|---|
| [Opus 5.5 is insane at making videos](https://www.reddit.com/r/singularity/comments/1worlfs/opus_55_is_insane_at_making_videos/) — u/Silver-Chipmunk7744, r/singularity | 用一页故事提示，由代码渲染出完整的 SNES 风格动画对战 |
| [I asked Opus 5.5 to create an animation on how LLMs work](https://www.reddit.com/r/claude/comments/1wnxppc/i_asked_opus_55_to_create_an_animation_on_how/) — u/cody-fifth-door, r/claude | 用 23 个词的提示做出带旁白的恶搞讲解视频 |
| [Opus 5.5 One Shot Video Generation](https://www.reddit.com/r/ClaudeAI/comments/1wnh4fn/opus_55_one_shot_video_generation/) — u/AzorAhai1TK, r/ClaudeAI | 画面和声音都用程序生成，工具交给模型选 |
| [Opus 5.5 made six films, each one drawn under the rules of an old physical medium](https://www.reddit.com/r/ClaudeAI/comments/1wp6opy/opus_55_made_six_films_each_one_drawn_under_the/) — u/datathe1st, r/ClaudeAI | 每支视频一本书面笔记，在多轮之间保留 |
| [I gave Claude Opus 5.5 an MP3 and a few lines of art direction. It built a 50-shot painted music video entirely in code, with no video or image model](https://www.reddit.com/r/singularity/comments/1wp6zp8/i_gave_claude_opus_55_an_mp3_and_a_few_lines_of/) — u/DigitalDaydreamers1, r/singularity | 用简短笔记引导的 50 个镜头的音乐视频 |
| [Opus 5.5 creates a train journey drawn entirely in JavaScript](https://www.reddit.com/r/ClaudeAI/comments/1wnkvys/opus_55_creates_a_train_journey_drawn_entirely_in/) — u/mshort3, r/ClaudeAI | 画面只是时间的纯函数，用联系表审阅 |
| [Opus 5.5 made this whole YouTube Short in one HTML file. No images, no video editor, just code](https://www.reddit.com/r/ClaudeCode/comments/1wolkjy/opus_55_made_this_whole_youtube_short_in_one_html/) — u/quitpornio, r/ClaudeCode | 声音优先：实测的句子时间驱动画面 |

运行时依赖及其许可列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

由 [DubDubDub Corp.](https://ww-w.ai) 制作 · [Super Video Agent License 1.0](LICENSE)：可以使用和修改它来制作你自己的视频，包括商业用途。不允许转售、捆绑进付费课程或产品、作为托管服务提供，以及再分发。1.3.3 及更早版本仍采用 Apache-2.0。
