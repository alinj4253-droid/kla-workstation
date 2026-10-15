---
version: "0.1"
name: sunrise-haze-terracotta
description: "日出渐变（金黄→雾灰蓝）+ 砖红 Canela 衬线大字 + 圆形落日装饰 + 灰调海岸照片，带有静谧、克制、海风式的散文气质。"
audience: "文学社/写作社团成员、个人作品集读者；预期读者会逐字读完一首诗或一段散文，而非快速翻阅。"
locale: zh-CN

canvas:
  aspectRatio: "16:9"           # 🟢 from presentation.xml/sldSz
  width: 1920.0                 # 🟢
  height: 1080.0                # 🟢
  safeArea:                     # 🟡 视觉估计 — 此模板水平边距明显大于垂直，留给落日装饰呼吸
    top: 56
    right: 96
    bottom: 80
    left: 96
  printSafe: false              # 🔴 默认值

# grid 未在原 deck 中显式声明, 以下为视觉估计           # 🟡
grid:
  columns: 12
  gutter: 24
  margin: 96
  baseline: 8

colors:
  # ── 主色系 (砖红 / 落日红土色相桶) ──
  primary: "#9B461C"            # 🟢 XML srgbClr (52x) — 主衬线大字色
  primary-deep: "#9B451C"       # 🟢 XML srgbClr (42x) — 几乎同色，做正文与小字
  primary-darkest: "#9B471B"    # 🟢 XML srgbClr (2x)  — 极小段强调

  # ── 渐变色 (日出/日落天空) ──
  sky-yellow: "#EDD077"         # 🟢 XML srgbClr — 渐变顶部金黄
  sky-amber: "#EDCA84"          # 🟢 XML srgbClr — 渐变中段琥珀
  sky-peach: "#ECC491"          # 🟢 XML srgbClr — 渐变低段桃色
  sky-haze: "#ADB6BF"           # 🟢 XML srgbClr — 渐变底雾灰蓝（最关键）
  sun-disc: "#EDCF77"           # 🟢 XML srgbClr — 圆形落日色，半透叠加渐变之上

  # ── 强调色 ──
  # 本 deck 全程单色相设计 (砖红 + 日出渐变), 未检测到独立 accent 色相;
  # 强调用主色 primary 自身完成 (大字号 + 衬线感), 不引入额外色彩.

  # ── 中性色 ──
  surface: "#FFFFFF"            # 🟡 — 仅在小卡片描边上偶现
  surface-muted: "#F1EEEA"      # 🟢 XML srgbClr (1x) — 卡片底淡米色
  on-surface: "#000000"         # 🟢 XML srgbClr — 极少使用
  on-surface-secondary: "#5E5E5E"  # 🟢 master srgbClr — 次级灰
  on-primary: "#FFFFFF"         # 🔴 默认 — 主砖红落白字时使用

typography:
  # 主字体: Canela Bold (衬线 display) → 中文 fallback 思源宋/苹方
  display:
    fontFamily: '"Canela", "Canela Bold", "Playfair Display", "Source Han Serif SC", "Songti SC", "PingFang SC", serif'
    fontWeight: 700
    fontSize: 150               # 🟢 (最大字号, 用于 Sunrise / THANKS / Part 大字)
    lineHeight: 1.05            # 🟡 — 衬线大字常压紧
    minProjectedSize: 96        # 🔴 投影底线
  title:
    fontFamily: '"Canela", "Playfair Display", "Source Han Serif SC", "PingFang SC", serif'
    fontWeight: 700
    fontSize: 80                # 🟢 中型大字 (Part ONE 等)
    lineHeight: 1.1
    minProjectedSize: 56
  subtitle:
    fontFamily: '"Canela", "Playfair Display", "Source Han Serif SC", "PingFang SC", serif'
    fontWeight: 700
    fontSize: 50                # 🟢
    lineHeight: 1.2
  body:
    fontFamily: '"PingFang SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif'
    fontWeight: 400
    fontSize: 21                # 🟢 基准正文 (英文 lorem 段也用此)
    lineHeight: 1.6
    minProjectedSize: 16
  body-small:
    fontFamily: '"PingFang SC", "Source Han Sans SC", system-ui, sans-serif'
    fontWeight: 400
    fontSize: 20                # 🟢
    lineHeight: 1.5
  caption:
    fontFamily: '"PingFang SC", "Source Han Sans SC", system-ui, sans-serif'
    fontWeight: 600
    fontSize: 22                # 🟢 装饰小标题（CREATED AND DESIGNED BY...）字距加大
    lineHeight: 1.3
    letterSpacing: 0.08

# spacing 全部为视觉估计                                 # 🔴
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 32
  xl: 64
  xxl: 120

rounded:                        # 🟡 视觉估计
  none: 0
  sm: 8
  md: 16
  lg: 32
  pill: 9999

imagery:
  style: "实拍黑白/低饱和写真 + CSS 线性渐变天空"
  treatment: "海岸/海鸥/水浪类素材统一脱色至冷灰，与日出渐变形成温度对照；落日为半透明圆盘叠加在渐变之上"
  cornerRadius: 0
  aspectRatio: "横幅 16:5（海岸带）/ 圆形 1:1（落日）"
  usage:
    - "海岸 / 海鸥 / 水面纹理：作为正文页底部贯穿装饰带，宽度可贴边但绝不超出画布"
    - "落日圆盘：作为封面/章节扉页/尾页右下区的安静焦点，半径 240-360px，色 #EDCF77 透明度 0.7"
    - "整页渐变背景：金黄 → 雾灰蓝，从上至下自然过渡，作为 deck 主旋律"
  doNotUse:
    - "禁止使用高饱和真彩色照片（破坏整体雾感）"
    - "禁止给海岸照片加圆角（与本系统粗粝、现实主义的海风感冲突）"
    - "落日圆盘不得超出画布或被文字分割"

iconography:
  style: "几乎不用图标"
  metaphors: []
  color: "#9B461C"
  size: 20
  doNotUse:
    - "禁止 Material/Feather 等几何线性图标 — 与衬线散文气质冲突"
    - "禁止使用品牌彩色 emoji"
  rationale: "本系统的视觉重音全部由 Canela 衬线大字 + 落日圆盘承担，图标会稀释这种'文学性'。"

layouts:
  cover:
    structure: |
      - 整页日出渐变背景 (金黄 → 雾灰蓝, 从上到下)
      - 左下偏中: 砖红衬线巨字 (主标题, 字号 ~150)
      - 右下: 半透落日圆盘 + 砖红小标 'CREATED AND DESIGNED BY...' + 一段引言式 lorem
      - 底部居中: 'CREATED AND DESIGNED BY ...' (caption, 字距加大)
    requiredFields: [topic, mainTitle, presenter, organization]
    rationale: "封面与尾页 (closing) 必须完全同构 — 它们是这本作品集的扉页与封底，同构=仪式感"

  toc-grid-2x2:
    structure: |
      - 整页日出渐变背景
      - 中央 2×2 卡片网格: 每格含 'Part 0X' 砖红小字 + 章节短引言 (lorem)
      - 中心区可放本期主标 (例如 CONTENT, 砖红巨字)
    requiredFields: [chapters[4]]
    note: "目录页固定 4 章 (Part 01–04), 这是模板的结构假设, 不要尝试 3/5/6 章变体"

  section-divider:
    structure: |
      - 整页日出渐变背景
      - 左侧或居中: 砖红衬线巨字 'Part ONE / TWO / THREE / FOUR' (字号 ~150)
      - 右侧: 一段 3-4 行的章节引言 (砖红小字, 字号 ~21)
      - 底部居中: 'CREATED AND DESIGNED BY ...'
    requiredFields: [partLabel, partTitle, intro]
    rationale: "四章式结构是这套系统的骨架, section-divider 不可省略"

  content-bullets-card:
    structure: |
      - 整页日出渐变背景
      - 左侧: 一个砖红装饰大字 (单字 'T' / 'S' / '春' 之类) 作锚点
      - 右侧: 米色描边圆角矩形卡片, 内含 1-4 编号短段
      - 底部居中: footer
    requiredFields: [anchorChar, bullets[1..4]]
    densityNote: "每段不超过 2 行; 多于 4 段时切换为多页或 photo-bullets-band"

  content-photo-band:
    structure: |
      - 顶部 1/2: 渐变 + 砖红衬线大字 'Sunrise' (字号 ~150)
      - 底部 1/2: 横向贯穿的灰调海岸照片 (高度约 320-400px, 宽度贴左右安全区)
      - 砖红小段引言放右上 / 右下
    requiredFields: [chapterTitle, photoAsset, intro]
    rule: "海岸带必须横贯; 不要做两张并排照片 — 一张就够"

  content-three-up:
    structure: |
      - 顶部: 砖红衬线大字 'Sunrise'
      - 中段: 三 ~ 五个落日圆盘等距排列 (像音轨上的节拍)
      - 下段: 三段并列短文 (每段约 3 行 lorem)
    requiredFields: [chapterTitle, paragraphs[3..5]]
    rationale: "落日圆盘是这套系统的'心跳节拍器', 用作分隔符比图标更克制"

  big-quote-disc:
    structure: |
      - 左侧: 大号半透落日圆盘 (~半径 280px)
      - 圆盘内: 一句砖红短引言 (居中, 字号 ~32)
      - 右侧: 砖红衬线大字 'Sunrise' + 一段 3-4 行 lorem
    requiredFields: [quote, chapterTitle, intro]

  closing:
    inheritsFrom: cover
    structure: |
      - 与封面同构, 主标改为 'THANKS' (砖红衬线巨字, 字号 ~150)
      - 落日圆盘从右下移到正中, 与 THANKS 文字微叠
      - 下方: 一段感谢式 lorem
    rationale: "首尾同构是这套系统的庄重感来源 — 封面承诺一段海岸日出, 尾页归还它"

patterns:
  decorations:
    sunriseGradient:
      type: "整页线性渐变背景"
      from: "#EDD077 (top)"
      via: "#ECC491 (mid)"
      to: "#ADB6BF (bottom)"
      usage: "100% 页面采用, 是这套 deck 的'地基'; 永不省略"
    sunDisc:
      type: "半透落日圆盘"
      color: "#EDCF77"
      opacity: 0.7
      usage: "封面/扉页/尾页/quote 页 — 每页最多 1 个 (节拍页例外可有 3-5 个小盘)"
    bottomFooter:
      type: "底部小字脚标"
      text: "CREATED AND DESIGNED BY <ORGANIZATION>."
      style: "砖红 caption, 字距加大, letterSpacing 0.08"
      usage: "全 deck 每页底部居中, 是品牌识别"
    coastalBand:
      type: "横贯的灰调海岸照片"
      usage: "仅 content-photo-band 版式使用; 其余页面不得出现照片"
  supported:
    - cover
    - toc-grid-2x2
    - section-divider
    - content-bullets-card
    - content-photo-band
    - content-three-up
    - big-quote-disc
    - closing

motion:
  enabled: false                # 🟢 XML 未声明动画
  fallback:
    transition: "fade"
    durationMs: 400
  rationale: "这是一本'纸本作品集'气质的 deck, 任何切换动画都会破坏阅读的克制感"

meta:
  source: "文学社素材025.pptx"
  totalSlides: 15               # 🟢 from measurements
  layoutCount: 15               # 🟢 from measurements (PPT slideLayouts)
  sectionCount: 4               # 🔴 推断 — Part ONE/TWO/THREE/FOUR
  sectionMap:
    - { id: "cover",   slides: [1] }
    - { id: "toc",     slides: [2] }
    - { id: "part-1",  slides: [3, 4, 5] }
    - { id: "part-2",  slides: [6, 7, 8] }
    - { id: "part-3",  slides: [9, 10, 11] }
    - { id: "part-4",  slides: [12, 13, 14] }
    - { id: "closing", slides: [15] }
  brandMark: "CREATED AND DESIGNED BY <ORG>."
  watermark: false

doAndDont:
  do:
    - "✅ 整页日出渐变背景必须保留 (金黄 → 雾灰蓝), 它是 deck 的地基"
    - "✅ 主衬线大字必须使用 #9B461C 砖红 + Canela / Playfair / 思源宋 fallback"
    - "✅ 落日圆盘半透 (opacity 0.65–0.75), 不要画实心橙球"
    - "✅ 章节扉页 (Part ONE–FOUR) 不可省略, 四章式是结构骨架"
    - "✅ 封面与尾页 (THANKS) 完全同构, 共享同一个版式骨架"
    - "✅ 海岸照片必须脱色到冷灰, 与暖色渐变形成温度对照"
    - "✅ 底部 'CREATED AND DESIGNED BY...' 脚标全 deck 每页保留"
  dont:
    - "❌ 禁止改变渐变方向 (永远从顶部金黄到底部雾灰蓝)"
    - "❌ 禁止使用任何非砖红色相的彩色装饰 (绿/紫/蓝/红玫瑰…)"
    - "❌ 禁止用无衬线字体做主标题 (会失去散文/海风气质)"
    - "❌ 禁止给海岸照片加圆角或多张并排"
    - "❌ 禁止落日圆盘超出画布或被文字裁切"
    - "❌ 禁止单页同时出现 >2 张照片"
    - "❌ 禁止引入图标系统 (除可能的脚标三角符号外)"
---

## Overview

这套设计系统编码了一种**沿海日出 / 散文式个人作品集**的视觉语言——它不是一份汇报 deck，而是一本可以摊在桌上慢慢读的小册子。其核心特质是**克制、衬线、温度对照（暖渐变 + 冷海岸）**。

与西方 pitch deck 的 SaaS 极简风不同，本系统不在乎"留白即专业"——它的留白是**有温度的留白**，是被金黄→雾灰蓝渐变填满的安静呼吸。与中国机构汇报模板的"信息富集 + 仪式对称"也完全不同——本系统反过来追求**一页一意象**：一张海岸、一颗落日、一句话。

它服务于"会停下来读一首诗"的受众——文学社读者、个人作品集的浏览者、把作品集印出来送朋友的作者。其目标是同时作为屏幕展示媒介和打印小册子使用。

## Audience & Context

- **谁看**：文学社成员、写作社团读者、作品集本人想送出/留念的小圈层观众
- **在哪看**：屏幕分享 + 投影 + 偶尔打印为 A4 横版小册
- **看多久**：单页停留 8–20 秒，整本翻完 3–5 分钟，但读者会回看
- **物理约束**：投影下衬线大字需 ≥ 96pt，正文 ≥ 16pt；打印时砖红 #9B461C 在米黄背景上对比度足够，但需校对家用喷墨色偏

## Canvas & Grid

1920×1080 (16:9) 是 deck 的标准规格，本系统不做任何响应式让步——固定画布。

安全区（左右 96px、顶部 56px、底部 80px）刻意比常规更宽，因为本系统的核心叙事元素（日出渐变 + 落日圆盘）需要充分的边缘呼吸；底部留 80px 是为了"CREATED AND DESIGNED BY..." 脚标不与正文打架。

栅格层面是**参考性的**——12 列网格只用于卡片网格（toc）和三联段落（content-three-up）。其它版式以"中央/左/右"三档锚点定位即可，不严格执行栅格。

## Colors

视觉权重比例为 **渐变背景 70% / 砖红文字 20% / 落日圆盘 10%**。这一比例由模板自身定型——一旦渐变缺席或砖红被替换，整套系统的"气质"立刻坍塌。

**砖红 #9B461C** 是这套系统的灵魂色，它来自落日反射在海岸湿沙上的颜色——是大地色而非品牌红。具体值（primary / primary-deep / primary-darkest 三档极相近的砖红）在 deck 内交替出现是 PowerPoint 渲染量化误差的结果，下游可视为同色处理。

本系统**没有独立 accent 色**——这是关键决策。强调由"字号 + 衬线"完成，不引入额外色相。这一克制是模板风格的护栏，下游若引入紫/绿/蓝 accent 即破坏系统。

## Typography

本系统使用**单字体家族策略**——以 **Canela Bold**（衬线 display 体）为主，中文落到思源宋 / Songti SC。一字体家族让整本 deck 的"嗓音"高度统一，像一个人在说话而非一支乐队。

正文 21pt 略低于通用投影下限，但这是有意——本系统假设的阅读距离不是大会议室投影，而是 1.5m 内的桌面屏幕或打印纸张。

一张典型内容页同时使用 **3 个字号层级**（巨字 150 / 中字 50 / 正文 21）——这种巨大跨度（display 是 body 的 7×）是衬线作品集的常用张力手法，不是层级失控。

## Layouts

8 个版式构成结构核心：`cover / toc-grid-2x2 / section-divider / content-bullets-card / content-photo-band / content-three-up / big-quote-disc / closing`。

- **cover**：扉页，承担整本 deck 的气质宣告，必须有砖红巨字主标 + 落日圆盘 + 底部脚标。
- **toc-grid-2x2**：唯一的目录形态，固定 4 章——这是模板的结构假设。
- **section-divider** (Part ONE/TWO/THREE/FOUR)：四章式骨架的可见骨节，不可省略。
- **content-photo-band**：唯一允许出现照片的版式，海岸带必须横贯；其它内容页禁用照片。
- **closing**：与 cover 完全同构，主标改为 THANKS——这是首尾同构的仪式收束，是本系统庄重感的来源。

## Imagery & Icons

本系统中的图像发挥**情绪烘托**功能——而非信息载体。海岸 / 海鸥 / 水浪照片必须脱色到冷灰，与暖色渐变形成温度对照；这种对照本身就是 deck 的视觉论点。

落日圆盘（半透 #EDCF77）是这套系统的核心识别符号，比文字更先被识别。它有三种用途：封面/尾页的右下定锚、quote 页的引言容器、节拍页的多盘排列（"心跳"装饰）。它不可被裁切、不可超出画布、不可改色。

图标系统**极简到几乎为零**——这套衬线散文系统不需要 Material/Feather 风格图标，它们与"海风/纸本"气质硬冲突。如果非要装饰，用一个砖红衬线大字（"T"、"S"、"春"…）作为锚点字即可。

## Do's and Don'ts

完整规则列表见上方 YAML 中的 `doAndDont`。需要深入理解的核心护栏：

- **整页日出渐变是地基**——任何把背景改成纯白/纯灰的尝试都会让整套系统失重，因为衬线砖红在纯白上会变成"商务文档"。
- **单色相律**——除砖红 + 渐变外不引入第三色相（accent）。绿/紫/蓝在这套系统里都是噪音。
- **首尾同构**——封面与 THANKS 页必须共享同一版式骨架，区别仅在文字。这是仪式感的物理基础。
- **照片仅限 content-photo-band**——其它内容页禁用照片，避免视觉碎裂；海岸照片必须脱色到冷灰且不加圆角。
- **落日圆盘不可超界**——这是工程层最容易踩的雷：圆盘半径与 left/top 偏移必须保证整盘留在画布内。
