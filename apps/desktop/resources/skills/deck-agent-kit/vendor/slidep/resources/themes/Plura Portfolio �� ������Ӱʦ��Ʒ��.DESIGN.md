---
version: "0.1"
name: "Plura Portfolio — 极简摄影师作品集"
description: "一套以大面积黑白/单色调摄影为主角的个人作品集视觉系统——米白背景 + 深灰近黑文字 + 暗金辅色 + 无衬线单字体，通过 4 章节扉页结构与首尾同构封面实现仪式感；适配创意从业者（摄影 / 品牌 / 包装 / 插画 / 版式）对外展示工作成果。"
audience: "创意从业者个人作品集（摄影师 / 品牌设计师 / 插画师 / 平面设计师）——在屏幕与打印双模式下向潜在客户、艺术总监、工作室合伙人展示已完成作品。受众会逐页细读、反复翻阅。"
locale: "en-US"                          # 🟢 基于字体 fallback chain 推断 (主字体 Helvetica Neue Medium + 正文以英文为主, 仅副标题为中文)

canvas:
  aspectRatio: "16:9"           # 🟢 from presentation.xml/sldSz
  width: 1920.0                          # 🟢
  height: 1080.0                          # 🟢
  safeArea:                                # 🟡 视觉估计
    top: 24
    right: 32
    bottom: 32
    left: 32
  printSafe: false                         # 🔴 默认值

# grid 未在原 deck 中显式声明, 以下为视觉估计           # 🟡
grid:
  columns: 12
  gutter: 16
  margin: 32
  baseline: 8

colors:
  # ── 主色系 (HSV 主色相桶, 不预设色相) ──
  primary: "#44495D"          # 🟡 pixel-sampled — 深灰蓝, 仅在 slide18 作为大色块出现

  # ── 强调色 (互补色相桶, 与主色相距 ≥ 90°) ──
  accent: "#AD997C"           # 🟢 XML srgbClr — 暗金 / warm taupe, 用于极少量分隔线与副标题强调

  # ── 中性色 ──
  surface: "#E1E0DD"                       # 🟡 视觉估计 — 米白 / bone white, 本 deck 真正的"背景"
  surface-alt: "#FFFFFF"                   # 🟡 次选白底, 仅在 card / inline 使用
  surface-muted: "#F5F5F8"                 # 🟡
  on-surface: "#202124"                    # 🟢 XML srgbClr (99x, avoid pure black)
  on-surface-secondary: "#6C7278"          # 🟡 灰色正文
  on-primary: "#FFFFFF"                    # 🟢 主色为深灰蓝 → 白字

typography:
  # 主字体: Helvetica Neue Medium → fallback chain: latin-sans-modern     # 🟢
  # 正文字体: Helvetica Neue Medium → fallback chain: latin-sans-modern   # 🟢
  display:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 700                        # 🟢 (Bold)
    fontSize: 120                          # 🟢 (最大字号, 封面/致谢页主标题)
    lineHeight: 1.1                        # 🟡
    minProjectedSize: 100                 # 🔴 规范底线
  title:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 700
    fontSize: 80                          # 🟢 (章节扉页 01/02/03/04 + 章节标题)
    lineHeight: 1.2
    minProjectedSize: 60
  subtitle:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 400
    fontSize: 32                          # 🟢 (Concepts/Projects 等内容页二级标题)
    lineHeight: 1.3
    minProjectedSize: 24
  body:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 500
    fontSize: 18                          # 🟢 基准字号 (最高频 62x)
    lineHeight: 1.5
    minProjectedSize: 16                   # 🔴 规范底线
  body-small:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 500
    fontSize: 16                          # 🟢
    lineHeight: 1.4
  caption:
    fontFamily: '"Helvetica Neue Medium", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'
    fontWeight: 500
    fontSize: 12                           # 🟢 (页眉页脚 / 注释行)
    lineHeight: 1.3

# spacing 全部为视觉估计                                 # 🔴
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64

rounded:                                   # 🟡 视觉估计 — 本系统几乎不用圆角
  none: 0
  sm: 2
  md: 4
  pill: 9999

# ───── 以下 7 字段由 Claude 在第 7 步根据缩略图归纳后补充 ─────

imagery:                                   # 🔴 基于 20 张缩略图归纳
  style: "黑白或低饱和单色调摄影 — 自然 / 静物 / 建筑细部 / 水面 / 植物特写"
  treatment: "满幅无边框或硬裁切矩形, 无阴影、无圆角、无蒙层; 图像本身即版面主体"
  cornerRadius: 0                          # 矩形硬裁切, 绝不加圆角
  aspectRatio: "16:9 / 16:6 (横向通栏) / 1:1 (方形网格) / 9:16 (单页纵向大图)"
  colorGrading: "去饱和, 整体偏冷灰 / 暗棕, 与 #E1E0DD 米白背景形成低对比静音氛围"
  usage:
    - "封面与致谢页使用同一张大图以建立首尾同构"
    - "章节扉页 (01/02/03/04) 用一张通栏横幅照片承托章节名"
    - "内容页普遍左文字右大图或上下分栏, 图比字大"
    - "多图时用 2-4 网格矩形, 图之间留固定间距, 绝不重叠"
  doNotUse:
    - "高饱和彩色照片 — 破坏整本灰度调性"
    - "加滤镜 / 杜比色 / 渐变叠加"
    - "圆角图 / 椭圆裁切 / 不规则遮罩"
    - "图片上直接压大字 (仅允许极小 body / caption 压图, 且要白字)"

iconography:                               # 🔴 本 deck 未见功能性图标
  style: "极简装饰符 — 仅 /slash/ 斜线分隔符 + 数字序号 (01/02/03/04), 无 UI icon"
  metaphors: []                            # 不使用拟物隐喻图标
  color: "#202124 (on-surface) 或 #AD997C (accent, 副标题分隔线)"
  size: "与其所在文字的基线/字高一致, 不独立放大"
  doNotUse:
    - "彩色 icon / emoji"
    - "面性图标 / 填充图标"
    - "任何装饰性插画 icon (rocket / star / check 等)"

layouts:                                   # 🔴 本 deck 推断出 6 个语义版式
  cover:
    structure: |
      - 左 1/3 米白纯色块, 承载标题与署名
      - 右 2/3 满出血大图 (黑白摄影)
      - 左下角: "Portfolio" 超大显示字 (120pt Bold)
      - 左下角副标题行: "/ Plura 个人作品集 | 2020-2022 /" — accent 暗金色斜线包夹
      - 左上角: "Created and Designed by Plura." 说明行 (caption)
    requiredFields: [mainTitle, presenterTagline, yearRange, heroImage]
    rationale: "左文右图的非对称构图把视觉焦点推向影像, 文字退为署名标识; 大图为作者作品的第一印象"
    note: "封面与致谢页使用完全相同的版式, 仅改文字"

  personal-intro:
    structure: |
      - 整页米白底 (#E1E0DD)
      - 顶部页眉: 左 "TEL/EMAIL" 联系方式, 右 "Portfolio of Plura | Created and Designed by Plura"
      - 左上: "Plura" 大字 (80pt) 作为姓名标识
      - 下方 4 栏均分: PERSONAL STATEMENT / WORKS / PROJECTS / SKILLS, 每栏英文小标 + 中文副标 + 两三行正文
    requiredFields: [name, contact, statement, works, projects, skills]
    rationale: "作品集开篇的名片页, 用 4 栏把作者身份一次性交代清楚"
    densityNote: "信息密度故意较高 (44 段文字), 目的是一页读完作者背景"

  toc:
    structure: |
      - 左 1/2: 3 张方形小图堆叠 (来自不同章节样片)
      - 右 1/2: "The Table Of Content" 四行大字标题
      - 右侧下方 4 行条目: 01 Branding 品牌设计 / 02 Packaging 包装设计 / 03 Illustration 插画设计 / 04 Layout 版式设计
      - 每行: 序号 + 英文章节名 + 中文副名 (灰色 body-small)
    requiredFields: [tocItems (>=3)]
    behaviorRule: "条目数建议 3-5, 超过需另起一页; 章节名的英文 + 中文双语必须同时出现"
    rationale: "用图像缩略+文字并列的方式, 让目录既是导航又是悬念海报"

  section-divider:
    structure: |
      - 顶部 60-80% 高度: 通栏单张横幅大图 (16:6 裁切, 黑白/单色)
      - 左下: "0N/" + 章节英文名 (80pt Bold, 两行排列, N=1/2/3/4)
      - 右下: 中文副名 (ZH 间距放大 "品 牌 设 计") + 3-4 行 caption 引导文
    requiredFields: [sectionNumber, sectionNameEN, sectionNameZH, heroImage]
    behaviorRule: "章节序号的 / 斜线与章节名必须换行断开 — `01/` 独占一行, 下行为章节名; 这是视觉节拍"
    rule: "每进入新章节前必须插入一张 section-divider, 不可省略"
    rationale: "大图 + 巨字章节号构成翻章仪式, 是本系统信息密度突变 (上一页密, 下一页空) 的关键调节器"

  content-split:
    structure: |
      - 左半: 大图 (满出血或留边) 或大面积深色块
      - 右半: 标题 (Concepts / Projects / Cases 等, 32-80pt) + / 理念阐述 / 等副标 + 2-3 段正文 (18pt)
      - 正文采用"英文主段 + 中文副段"双栏或上下堆叠
      - 页眉左: "Portfolio of Plura | 0N Branding"; 页眉右: "Created and Designed by Plura"
    requiredFields: [sectionTitle, subtitle, bodyTexts, heroImage]
    rule: "文字 : 图 = 4:6 — 图永远至少占一半版面"
    bodyMaxItems: "正文段落 ≤ 3 段, 超出改用 content-grid 版式"
    note: "文字列内宽度保持 320-420px, 避免单行过宽"

  content-grid:
    structure: |
      - 图片网格区 (2×1 / 2×2 / 3×1), 矩形无圆角, 固定间距 16-24px
      - 网格外留白区放标题 + 1-2 段简短说明
      - 或: 顶部单图 + 下方 3 列等宽文字 (OBJECTIVES / METHODS / RESULTS 风格)
    requiredFields: [images (>=2), captionPerImage?]
    rule: "所有图片同高或同宽; 避免瀑布流 / masonry 错落; 追求矩阵整齐"
    bodyMaxItems: "图片数 2-6, 超过 6 张拆成多页"
    rationale: "网格承担作品集的核心功能 — 快速展示多件作品"

patterns:                                  # 🔴 装饰与版式清单
  decorations:
    slashSeparator:
      form: "/ 文字 /"
      color: "#AD997C (accent) 或 #202124 (on-surface)"
      usage: "副标题 / 中文补注 / 年份标注 — 用一对斜线包夹, 是本系统最高识别度的装饰"
      size: "与被包夹文字同字号"
    sectionNumberPrefix:
      form: "01/ 02/ 03/ 04/"
      color: "#202124"
      usage: "章节扉页 + 目录; 数字与斜线在一行, 章节名独立换行"
    wideSpacedCJK:
      form: "品 牌 设 计 (字间距 0.4em)"
      color: "#202124"
      usage: "中文副标加宽字距, 模仿手册 / 杂志排版的呼吸感"
    pageHeader:
      form: "左: Portfolio of Plura | 0N 章节名  ·  右: Created and Designed by Plura"
      color: "#6C7278 (caption grey)"
      usage: "每页顶部, 除封面/致谢页外不可省略"
  supported:                               # 本 deck 实际使用的版式 id
    - cover
    - personal-intro
    - toc
    - section-divider
    - content-split
    - content-grid

motion:                                    # 🔴 XML 未见动画声明
  enabled: false
  fallback:
    allowedTransitions: ["none", "fade"]
    maxDurationMs: 300
  rationale: "摄影作品集的安静气质要求 zero-animation; 最多允许淡入淡出, 禁用翻页/推入/缩放"

meta:                                      # 🟢 来自 measurements.json + 🔴 归纳
  source: "Portfolio2.pptx"                # 🟢
  totalSlides: 20                          # 🟢
  layoutCount: 12                          # 🟢 slideLayouts/*.xml 个数
  sectionCount: 4                          # 🔴 观察得 4 个章节扉页
  sectionMap:                              # 🔴 观察章节扉页归纳
    - id: "01-branding"
      enName: "Branding"
      zhName: "品牌设计"
      coverSlide: 4
      contentSlides: [5, 6, 7]
    - id: "02-packaging"
      enName: "Packaging"
      zhName: "包装设计"
      coverSlide: 8
      contentSlides: [9, 10, 11]
    - id: "03-illustration"
      enName: "Illustration"
      zhName: "插画设计"
      coverSlide: 12
      contentSlides: [13, 14, 15]
    - id: "04-layout"
      enName: "Layout"
      zhName: "版式设计"
      coverSlide: 16
      contentSlides: [17, 18, 19]
  openingSlide: 1                          # 🟢 Portfolio
  intoSlide: 2                             # 🟢 Plura 自我介绍
  tocSlide: 3                              # 🟢 The Table Of Content
  closingSlide: 20                         # 🟢 Thank You.
  brandMark: "Plura"                       # 🟢 presenter 署名
  watermark: null                          # 🔴 无水印

doAndDont:                                 # 🔴 全 deck 一致性反推
  do:
    - "✅ 保持米白 (#E1E0DD) + 深灰近黑 (#202124) 的两色骨架, 这是整本作品集的静音底色"
    - "✅ 暗金 accent (#AD997C) 只用于 / 斜线分隔符 / 和个别副标题点睛, 单页出现不超过 3 处"
    - "✅ 摄影图保持黑白或低饱和单色调, 大面积满出血; 图至少占版面的 1/2"
    - "✅ 章节扉页 (01/02/03/04) 在每章前强制出现, 不可省略"
    - "✅ 封面与致谢页保持完全同构 — 首尾闭环是本系统的仪式感来源"
    - "✅ 中文副标加宽字距 (品 牌 设 计), 且与英文主标题同时出现"
    - "✅ 图片之间用矩形硬裁切 + 等间距, 维持杂志感秩序"
  dont:
    - "❌ 绝不使用高饱和彩色照片 / 滤镜 / 杜比色分级"
    - "❌ 绝不在图上压大号标题 (仅允许白色 caption 级文字压图)"
    - "❌ 绝不添加圆角 / 阴影 / 渐变 / 发光等装饰效果"
    - "❌ 绝不使用衬线字体或手写字体 — 本系统为单字体家族 (Helvetica Neue Medium)"
    - "❌ 绝不添加动效/转场 (enabled: false), 允许的只有最基本的淡入"
    - "❌ 绝不使用 icon 库图标 (rocket/heart/check 等) — 本系统只有斜线 + 数字序号两种符号"
    - "❌ 绝不打破 4 章节结构或跳过章节扉页"
---

## Overview

本模板编码了 **极简摄影师个人作品集** 的视觉语言——这套美学被用于创意从业者（摄影、品牌、包装、插画、版式）向潜在客户与工作室展示成品的场景。其核心特质是 **静音 (muted)、秩序 (matrix)、仪式 (ritual)**。

与常见的简历型 PPT 或企业年度汇报不同，本系统把版面的主角彻底让给影像——文字被压缩成署名与段落级正文，图片承担 50%-70% 的版面面积。这是"作品说话、设计师让位"的作品集哲学。

本系统服务于会花时间逐页翻阅的受众——艺术总监、工作室合伙人、潜在客户——他们要在 20 页内判断作者的美学成熟度。其目标是通过一致的灰度调性、严谨的矩形网格、克制的装饰符号，传递"训练有素、审美稳定"的信号。

## Audience & Context

- **谁看**：艺术总监、品牌方 / 工作室合伙人、潜在客户、面试官；次级受众是作者本人在社交网络做的作品节选。
- **在哪看**：笔电屏幕 / iPad PDF / 少量情况投影仪；极少打印（整本作品集的灰度调性依赖屏幕光发色，打印后会变闷）。
- **看多久**：每页 15-45 秒，全本 8-15 分钟；部分受众会反复翻看。
- **物理约束**：正文最小 16pt（minProjectedSize），图片必须保证在 1920×1080 上无过度压缩；灰度对比度 ≥ 4.5:1。

## Canvas & Grid

1920×1080 的 16:9 是当代数字作品集的通用规格——既适配屏幕也适配投影。本系统不作 A4 / 打印版输出（`printSafe: false`）。

安全区 24-32px 相对常规（48-64px）更窄——目的是让摄影图有足够的满出血空间，文字区边距随之压缩。栅格以 12 列参考栅格存在，但本 deck **不严格执行**：图片常常打破栏宽，只保证同类元素之间的等间距。

## Colors

视觉权重比例为 **米白 60% / 摄影图灰度 35% / 暗金 accent + 其他点缀 5%**。这一近乎静音的配色结构是整本作品集的基底——任何高饱和色都会立刻"毁掉"整体调性。

主色定位为深灰近黑 `#202124`（出现 99 次），承载几乎所有文字；`#E1E0DD` 米白作为背景反复出现（surface），与白色 `#FFFFFF` 构成"骨白 vs 纸白"的微差（约 ΔE 5），手工摄影画册常见。暗金 `#AD997C`（XML srgbClr，仅 2 次）的稀缺使用是**强制规则**——它只出现在 / 斜线 / 副标题分隔符与个别年份标签中，一旦频繁使用就失去点睛效果。

需要深入理解的是 `#44495D` 深灰蓝——它仅出现在一张内容页的大色块（slide18），不是系统级主色。把它抽到 YAML `primary` 只是为保留"deck 用过一次深色块"这个事实，而非推荐滥用。

## Typography

本系统采用 **单字体家族** 策略——**Helvetica Neue Medium**——通过字重（500/700）与字号（12/16/18/32/80/120）建立层级。单一字体家族的选择与作品集的静音气质一致：字体差异越小，影像的在场感越强。

基准字号 18pt 高于屏幕阅读下限（14pt）与投影下限（16pt），在 iPad 上阅读舒适；最大字号 120pt（封面 "Portfolio"）与 80pt（章节扉页 "01/Branding"）构成戏剧性落差，这是本系统**唯一允许的视觉噪音**——让页面的安静被一次巨字打破。

典型内容页同时使用 3-4 个字号层级（80pt 标题 / 32pt 副标 / 18pt 正文 / 12pt 页眉）。这是经过训练的克制——字号层级越少，影像的权重越高。

## Layouts

6 个版式构成结构核心：`cover / personal-intro / toc / section-divider / content-split / content-grid`。

- **cover**：左文右图 1:2 非对称构图，大图压右半页，左侧承载 "Portfolio" 巨字与署名。它是作品集的门面，也是首尾同构的"前半环"。
- **section-divider**：每章开篇的通栏横幅大图 + 左下巨字章节号。这个版式**不可省略**——它是本系统的节拍器，在密集的内容页之间切出呼吸。
- **content-split**：图在左 / 文在右的标准内容页，是全本 60% 的版面。文字永远退让一半给图。
- **content-grid**：2×1 / 2×2 / 3×1 的矩形图片网格，用于展示多件作品；所有图同高同宽，追求矩阵的秩序感。
- **closing (inheritsFrom cover)**：致谢页与封面完全同构——只改 "Portfolio" 为 "Thank You."，左右图保持一致。首尾闭环是本系统的仪式感来源。

## Imagery & Icons

本系统中的图像发挥 **作品展示** 的核心功能——它不是装饰，就是内容本身。所有图片以黑白或低饱和单色调的形式出现（风景 / 静物 / 建筑细部 / 水面 / 植物），统一被处理为去饱和 + 轻微冷调；图像本身即页面的情绪载体。

本系统几乎没有"图标"。仅有的两种符号性装饰是：(1) 一对 `/ 斜线 /` 包夹的副标题/说明词，常以暗金 accent 色出现；(2) `01/ 02/ 03/ 04/` 的章节序号前缀。不使用任何 UI icon / emoji / 插画 icon——这与作品集的训练有素气质一致。

装饰带、徽标、页脚条目等在本系统也不存在。唯一跨页面的恒常元素是顶部页眉（左：作品集标识 + 当前章节；右：署名行），它用 caption 级灰色小字安静存在。

## Do's and Don'ts

完整规则列表见上方 YAML 中的 `doAndDont`。需要深入理解的核心护栏：

- **accent 只用于斜线分隔符，单页不超过 3 处** —— 这条规则决定了本系统的"贵气"来自稀缺，不来自饱和度。
- **图至少占版面的 1/2，且保持矩形硬裁切** —— 一旦图变小或加了圆角，版面立刻从"作品集"塌成"普通 PPT"。
- **4 章节扉页不可省略，首尾同构不可省略** —— 这两条是作品集的仪式骨架；省掉任何一条，整本册子就散为孤立幻灯片。
- **绝不使用彩色照片 / 高饱和滤镜 / 渐变叠加** —— 本系统的静音调性依赖整本灰度统一，一张彩图就会"染"整本。
- **单字体策略不可破** —— Helvetica Neue Medium 贯穿全本，用字重与字号分层；换字体等同于换系统。
