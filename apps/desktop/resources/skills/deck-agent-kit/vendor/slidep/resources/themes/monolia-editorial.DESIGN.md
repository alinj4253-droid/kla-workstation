---
# ── 元信息 ──
version: "1.1"
name: monolia-editorial
description: 编辑向极简调研模板——奶油色背景 + 黑色衬线大标 + 半版图文二分 + 单一墨蓝锚色 + 强制数据可视化。适用于品牌作品集、产业调研、技术报告、白皮书。
family: editorial-research
extends: families/editorial-research/design.md
audience: 调研 / 报告 / 作品集 / 白皮书——面向客户、合作方、评委、面试官
locale: en-US
supportedLocales: [en-US, zh-CN]

# ── 画布 ──
canvas:
  aspectRatio: "16:9"
  width: 1920
  height: 1080
  unit: px
  safeArea:
    top: 96
    right: 96
    bottom: 110
    left: 106
  printSafe: false

# ── 栅格 ──
grid:
  columns: 12
  gutter: 24
  baseUnit: 8
  primarySplit: half-canvas
  splitRatio: [50, 50]

# ── 颜色 ──
colors:
  surface: "#F1F1ED"
  surface-alt: "#FFFFFF"
  on-surface: "#000000"
  on-surface-secondary: "#2E2E2E"
  on-surface-tertiary: "#555555"
  divider: "#969696"
  divider-soft: "#BFBCBC"
  muted: "#727171"
  muted-light: "#A2A2A2"
  # ▶ v1.1 新增：单一锚色（仅用于关键数字下划线 / 章节编号小色块 / 图表关键序列）
  accent: "#1B365D"            # 墨蓝（深海蓝，不抢戏，与 cream 对比克制）
  accent-soft: "#7A8FA6"       # 锚色弱化态，用于次级数据序列
  primary: null                # 仍无品牌主色——accent 不是主色，使用率必须 ≤ 全页 5%
  data:
    series-1: "#000000"
    series-2: "#1B365D"
    series-3: "#7A8FA6"
    series-4: "#BFBCBC"
    positive: "#1B365D"
    negative: "#000000"
    neutral: "#727171"

# ── 字体 ──
typography:
  display:
    fontFamily: "Playfair Display"
    fontFallbackCJK: "方正160号-超粗"
    fontWeight: 400
    fontSize: 130
    lineHeight: 1.0
    letterSpacing: normal
    minProjectedSize: 110
  title:
    fontFamily: "Playfair Display"
    fontWeight: 400
    fontSize: 100
    lineHeight: 1.05
    letterSpacing: normal
    minProjectedSize: 72
  h3:
    fontFamily: "Poppins Medium"
    fontWeight: 500
    fontSize: 28
    lineHeight: 1.2
  body-lead:
    fontFamily: "Poppins Light"
    fontWeight: 300
    fontSize: 24
    lineHeight: 1.4
  brand-mark:
    fontFamily: "Playfair Display Bold"
    fontWeight: 700
    fontSize: 21
    lineHeight: 1.0
    letterSpacing: "+8%"
  caption:
    fontFamily: "Poppins Light"
    fontWeight: 300
    fontSize: 18
    lineHeight: 1.3
  body:
    fontFamily: "Poppins Light"
    fontWeight: 300
    fontSize: 24
    lineHeight: 1.4
  subtitle: null
  body-small: null
  data-number: null
  label: null

# ── 间距 ──
spacing:
  contentGap: 32
  sectionGap: 64
  headerToBody: 48
  footerOffset: 96
  brandOffset: 106
  pageNumberOffset: 96

# ── 形态 ──
rounded:
  none: 0
  default: 0
  pill: 0
  policy: sharp-only

# ── 图像 ──
imagery:
  style: editorial-subject-matched        # ▶ v1.1：从 fashion-portrait 改为"主题匹配"——图必须语义命中页面主题
  aspect:
    preferred: ["2:3", "3:4"]
    allowed: ["16:9", "1:1"]
  treatments:
    - full-bleed-half
    - warm-neutral-palette
    - no-overlay
    - three-up-grid
  forbidden:
    - hard-colored-overlay
    - round-masked-photos
    - drop-shadow
    - saturated-backgrounds
    - semantic-mismatch                   # ▶ v1.1 新增：图片内容必须语义命中；禁止占位图 / 无关场景
  applicationRules:
    - cover-and-thankyou-use-halfbleed-photo
    - every-content-chapter-opens-with-halfbleed-photo
    - portfolio-uses-3up-equal-columns
    - image-must-match-page-semantics     # ▶ v1.1 新增：图片主体必须与页面标题直接对应
    - image-download-requires-preview     # ▶ v1.1 新增：使用前必须人眼 / vision 核对实际内容

# ── 数据可视化（v1.1 新增） ──
dataviz:
  required: true                          # 凡有数据比较 / 趋势的页面，必须至少 1 张图表
  minChartsPerDeck: 1                     # 全套至少 1 张图表（10 页以内），20 页以上至少 2 张
  chartStyle:
    palette: [black, accent-ink, accent-soft, divider-soft]  # 严格 4 色内
    stroke: 1.5                           # 线宽 1.5px
    font: "Poppins Light"                 # 图表字体用无衬线
    gridlines: dashed-1px-divider-soft
    labels: on-surface-secondary
  chartTypes:
    preferred: [bar-minimal, line-dotted, donut-two-tier]   # 三种扁平无彩图表
    forbidden: [3d, gradient-fill, pie-rainbow, bubble]

# ── 图标 ──
iconography:
  style: thin-line-monochrome             # ▶ v1.1：允许极少量 1.5px 细线图标作为章节编号点缀
  strokeWeight: 1.5
  size: [16, 20, 24]
  color: on-surface
  allowedUse:
    - chapter-number-marker               # 章节编号旁的 ◼ 或 ─ 装饰
    - data-kpi-unit-indicator             # KPI 卡片的单位小图标
  policy: prefer-typography-over-icons
  maxIconsPerPage: 3                      # 硬上限防止视觉噪音

# ── 版式 ──
layouts:
  cover:
    role: 封面 / Cover
    composition: 全画布图 + 左上 brand + 中部 headline + 底部 Playfair 超大字标 + 底中 tagline
    elements:
      - brand-mark @ topLeft (1.1in, 1.1in)
      - section-label @ topRight (7.44in, 1.09in) · 18pt
      - hero-image @ fullBleed squareCrop left (0,0,6.94×6.94in)
      - display-title @ bottom (3.65in, 6.96in, 12.71×2.55in, 130pt)
      - tagline @ bottomCenter (5.56in, 9.72in, 28pt)
  toc:
    role: 目录
    composition: 左上 brand + 左中大 display "Table of Content" + 右侧 2×2 分栏目录 + 底 URL
    elements:
      - brand-mark @ topLeft
      - display-title @ centerLeft (1.1in, 2.0in, 100pt)
      - list-2x2 @ right (4.6in 列宽, 28pt, lineGap 1.1in)
      - footer-url @ bottomLeft (1.1in, 9.8in, 18pt)
  section-divider:
    role: 章节扉页
    composition: 整幅图（左半）+ 右侧空白区大标 + 右下正文 intro + ▶ 新增下半条"章节亮点"3-bullets 条带 + 左下 footer + 右上页码
    elements:
      - hero-image @ left halfbleed (0..6.9in, 0..6.9in)
      - page-number @ topRight (17.1in, 1.1in, 21pt)
      - brand-mark @ topLeft
      - title @ rightUpper (10.4in, 2.0in, 7.4×3.8in, 100pt)
      - body-lead @ rightLower (10.4in, 6.7in, 8.3×2.3in, 24pt)
      - highlight-strip @ below-image (0..20in, 7.0..10.0in, 3 bullets 横向排列, 18pt) # ▶ v1.1 新增
      - footer-url @ bottomLeft
    fillRate: "≥65%"                      # ▶ v1.1：硬指标，消除大片留白
  content-default:
    role: 常规内容页
    composition: 半幅图 + 对侧栏标题 / 正文 / 签名字；允许左右镜像
    variation: mirror-allowed
    fillRate: "65%–85%"
  content-data:                           # ▶ v1.1 新增版式
    role: 数据页
    composition: 顶 title + 左栏 2-3 条大数字 KPI + 右栏图表（柱 / 线 / 环）+ 底部 source 线
    columns: [kpi-left(45%), chart-right(55%)]
    mustInclude: [chart, source-citation]
    fillRate: "≥70%"
  portfolio-grid:
    role: 作品栅格页
    composition: 顶 title (100pt) + brand + page# + 3 张等宽纵图 + 每图下方 H3 + caption
    columns: 3
    rowStructure: [image, h3, caption]
  compare-3col:                           # ▶ v1.1 新增版式
    role: 三列对比页
    composition: 顶 title + 3 列等宽；每列 = 项名 + 3 行属性表 + 短注
    columns: 3
    mustInclude: [table-row-attributes]
    fillRate: "≥75%"
  contact:
    role: 联系页
    composition: 半幅图 + 右栏大 title + 3–5 条 key-value（社交账号 / 邮箱 / 电话）
  thank-you:
    role: 致谢页
    composition: 与 cover 完全镜像；标题替换为 THANK YOU（130pt Playfair Display）
    mirrorsCover: true

# ── 版式节奏规则（v1.1 新增） ──
layoutCadence:
  rule: "连续同骨架不得超过 2 页"           # 防止 6/10 页都是半版图文二分
  maxConsecutiveHalfCanvas: 2
  requiredMix:
    - at-least-one-data-chart-page        # 全套必须有 ≥1 数据页
    - at-least-one-3col-or-grid-page      # 全套必须有 ≥1 多列页
    - cover-toc-thankyou-structural       # 开头目录结尾必须结构性不同

# ── 信息架构模式 ──
patterns:
  supported:
    - 半版图文二分（cover / section / content）
    - 3-up 纵图作品网格（portfolio）
    - 2×2 并列目录（toc）
    - 首尾同构（cover ↔ thank-you）
    - 顶部品牌条（brand-left / pageNumber-right）
    - KPI 数字 + 图表二分（content-data）     # ▶ v1.1
    - 3 列属性对比（compare-3col）             # ▶ v1.1
  denied:
    - 满屏纯色填色
    - 多彩图表（≥5 色）
    - 满屏大段正文
    - 圆角卡片 / 带阴影的浮层 UI
    - 3 列以上的图文网格
    - 连续 ≥3 页使用相同骨架                   # ▶ v1.1
    - 单页 accent 使用面积 > 5%                # ▶ v1.1：锚色必须克制

# ── 动效 ──
motion:
  transition: none
  buildIn: none
  policy: no-motion

# ── 元数据 ──
meta:
  topDecoration:
    brandMark:
      position: top-left
      fixed-at: "1.1in, 1.1in"
      style: "MONOLIA · Playfair Display Bold 21pt"
    pageNumber:
      position: top-right
      fixed-at: "17.1in, 1.1in"
      format: 2-digit-zero-padded
      style: "Poppins Medium 21pt"
  bottomDecoration:
    footerURL:
      position: bottom-left
      style: "Poppins Light 18pt"
      defaultText: "www.presentation.com"
  pageMargin: "1.1in all sides"

# ── 明确护栏 ──
doAndDont:
  do:
    - 用 Playfair Display 承担 100–130pt 的大标，让版面由字号建立层级
    - 使用 surface #F1F1ED 作为全局底色
    - 为每一章加一张语义命中主题的半版图（人像 / 产品 / 场景不限，但必须精准匹配内容）
    - 在所有非封面页顶部固定 brand-left + 右上页码（两位数零填充）
    - 保持 cover 与 thank-you 的首尾同构（同 130pt、同底部定位）
    - 内页坚持 3 列等宽（portfolio）或 2 列对分（content-default）
    - 文案保持 editorial 克制语气（短句、品牌词、低标点密度）
    - 每套 PPT 至少 1 张数据图表（柱 / 线 / 环），严格 4 色内                                    # ▶ v1.1
    - 章节扉页必须在图下加 3-bullets 高亮条（fillRate ≥65%）                                     # ▶ v1.1
    - 关键数字可使用 accent #1B365D 作下划线 / 底边，使用面积 ≤ 全页 5%                         # ▶ v1.1
    - 每套 PPT 骨架至少 3 种（不能 10 页都用半版图文二分）                                        # ▶ v1.1
    - 下载的配图使用前必须人眼或 vision 核对主体是否命中主题                                     # ▶ v1.1
  dont:
    - 使用主色 / 强色（primary 仍为 null；accent 是唯一允许的墨蓝锚点，占比 ≤ 5%）
    - 使用圆角、阴影、浮层卡片
    - 给照片叠加滤镜 / 色遮罩 / 晕影
    - 把主体图裁成圆形 / 异形
    - 用动效做转场或进入
    - 把正文做到 16pt 以下（下限从 18pt 放宽以适配 1280×720 画布，但不可再低）                   # ▶ v1.1 微调
    - 在作品栅格页加入第 4 列或插入标注块
    - 使用无法核对语义的占位图 / 风格图 / AI 幻觉图                                              # ▶ v1.1
    - 连续 ≥3 页使用相同版式骨架                                                                 # ▶ v1.1
    - 页面下半部分留白超过 35%（editorial 留白不代表空旷）                                       # ▶ v1.1
    - 全套 PPT 0 图表（数据密集型主题必须出图）                                                  # ▶ v1.1
---

## Overview

**MONOLIA · Editorial Research Template (v1.1)** 是一套面向调研、白皮书、产业报告、作品集的演示模板，走克制的编辑向（editorial）路线。设计语言三句话：

1. **近无彩色系统 + 单一墨蓝锚色**：底色奶油 #F1F1ED + 主文本黑 #000000 + 三级灰 + 唯一锚色墨蓝 #1B365D（使用面积 ≤5%）。锚色仅用于关键数字下划线、章节编号小色块、图表关键序列。视觉焦点仍属于内容本身。
2. **衬线字母作雕塑**：Playfair Display 130pt / 100pt 承担所有标题层级；Poppins Light / Medium 承担中小字号；CJK 由 Source Han Serif（标题）+ Source Han Sans（正文）承接。字体对比 = 设计张力。
3. **半版大图 + 数据图表 + 多骨架混排**：章节扉页和内容页以"半版图 + 文字"为骨架；但每套至少 1 张数据图表，至少 3 种不同骨架（防止单调），章节扉页底部强制加 3-bullets 高亮条以填充留白。

## Audience & Context

- 目标使用者：调研分析师、产业研究员、品牌设计师、作品集作者
- 典型场景：行业调研报告、技术白皮书、产品发布、面试、甲方汇报
- 信息密度：中低密度——每页 1 张图或 1 张图表 + 1–2 段 ≤4 行的引导文字 + 品牌 / 页码导航
- **不适用**：高密度财务三表、工程图纸（图表色板太克制）、需要重彩营销视觉的发布会主 KV

## Canvas & Grid

- **画布**：1920×1080（16:9），实英寸 20×11.25，打印 / 演示通用；适配 1280×720 时所有字号按 0.67 缩放
- **安全区**：上 96 / 右 96 / 下 110 / 左 106 px
- **栅格**：12 列 / gutter 24 / baseUnit 8；以"整幅半版切分"为主要结构。portfolio 页面 3 列等宽；TOC 页 2×2 区块
- **对切比例**：50 / 50 为主

## Colors

| Token | Hex | 用途 |
|---|---|---|
| surface | #F1F1ED | 全局背景 |
| surface-alt | #FFFFFF | 少量卡片 / 装饰 |
| on-surface | #000000 | 主文本、大标题 |
| on-surface-secondary | #2E2E2E | 次级文本 |
| on-surface-tertiary | #555555 | caption / 脚注 |
| **accent (v1.1)** | **#1B365D** | **关键数字下划线 / 章节编号小色块 / 图表主序列。使用面积 ≤5%** |
| accent-soft (v1.1) | #7A8FA6 | 锚色弱化态，用于次级数据序列 |
| divider / divider-soft | #969696 / #BFBCBC | 分隔灰 |
| muted / muted-light | #727171 / #A2A2A2 | 标注用灰 |

**关键**：无主色（primary 仍为 null），仅有一抹墨蓝作为锚点。图表配色严格 4 色内（黑 / 锚蓝 / 浅灰蓝 / 浅灰）。

## Typography

| 层级 | 字体 | 字号（1920×1080 / 1280×720 缩放）|
|---|---|---|
| Display（封面 / 致谢） | Playfair Display（+ Source Han Serif CN） | 130 pt / 80 pt |
| Title（章节） | Playfair Display | 100 pt / 64 pt |
| H3 / 列表项 | Poppins Medium | 28 pt / 18 pt |
| Body-lead / 大正文 | Poppins Light | 24 pt / 16 pt |
| Brand / PageNumber | Playfair Display Bold / Poppins Medium | 21 pt / 14 pt |
| Caption / URL | Poppins Light | 18 pt / 12 pt |

**设计意图**：Playfair 的高对比衬线 × Poppins 的几何无衬线——这是编辑向报告最稳的字体搭配。6 档刚性梯度，任何新的字号必须落在这 6 档之一。

## Layouts (v1.1)

模板包含 **8 种骨架**（较 v1.0 的 6 种新增 content-data + compare-3col）：

1. **cover**：底部大字标 + 半版图 + 顶部小品牌标
2. **toc**：左中大字 "Table of Content" + 右侧 2×2 目录
3. **section-divider**：左半图 + 右上 title + 右下 intro **+ v1.1 底部 3-bullets 高亮条**（fillRate ≥65%）
4. **content-default**：半版图 + 对侧栏文字（允许左右镜像）
5. **content-data (v1.1)**：顶 title + 左栏 2-3 条大数字 KPI + 右栏图表（柱 / 线 / 环）+ 底部 source 线
6. **portfolio-grid**：顶 title + 3 纵图 + 每图 H3 + caption
7. **compare-3col (v1.1)**：顶 title + 3 列等宽；每列 = 项名 + 3 行属性表 + 短注
8. **thank-you**：与 cover 完全同构

**节奏规则（v1.1）**：10 页以内至少 3 种骨架混排；连续同骨架不得超过 2 页；全套必须含 ≥1 数据图表。

## Imagery & Icons

- **图像风格（v1.1）**：主题语义匹配优先——人像 / 产品 / 场景不限，但主体必须精准命中页面主题。编辑感气质保留（暖调中性 / 克制构图 / 无滤镜）
- **比例**：首选 2:3 或 3:4 纵图；封面 / 致谢可用 16:9 或 1:1 半版横幅
- **处理**：full-bleed，无任何滤镜 / 蒙层 / 阴影 / 圆角遮罩
- **使用规则**：配图下载后必须人眼或 vision 核对主体是否命中主题；禁用占位图 / 风格图
- **图标（v1.1）**：允许极少量 1.5px 细线图标作为章节编号点缀或 KPI 单位指示；单页上限 3 个

## Do's and Don'ts

### DO
- 坚持 Playfair Display 的 100–130pt（或缩放态 64–80pt）大标，让字号建立层级
- 保持 surface #F1F1ED 底色，全模板统一
- 每章一张语义命中的半版图扉页
- 首尾同构：cover ↔ thank-you
- 固定顶部 brand-left + pageNumber-right 导航
- 内页坚持 3 列等宽（portfolio / compare）或 2 列对分（content-default）
- **每套至少 1 张数据图表（v1.1）**
- **章节扉页底部加 3-bullets 高亮条以填补留白（v1.1）**
- **关键数字可用 accent #1B365D 下划线，占比 ≤ 5%（v1.1）**
- **骨架至少 3 种混排（v1.1）**

### DON'T
- 引入任何主色 / 强色（只允许一抹墨蓝 accent）
- 使用圆角、阴影、浮层卡片
- 给照片叠加色遮罩
- 把主体图裁成圆形 / 异形
- 加入动效
- 把正文做到 16pt 以下
- 扩展至 4 列以上的作品网格
- **使用语义不匹配的占位 / 风格图（v1.1）**
- **连续 ≥3 页使用相同骨架（v1.1）**
- **页面下半留白 >35%（v1.1）**
- **全套 0 图表（数据密集型主题必须出图）（v1.1）**
