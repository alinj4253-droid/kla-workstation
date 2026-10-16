---
version: "0.1"
name: coral-portfolio-3d
description: "珊瑚粉渐变 + 3D 几何悬浮装饰的轻商务作品集风格——冷钢灰文字与黑白图片压舱，柔粉色块承担情绪表达"
audience: "面向校园社团 / 创意工作室 / 个人作品集发布场景的年轻女性受众，气质偏温柔、文艺、有设计感"
locale: zh-CN

canvas:
  aspectRatio: "16:9"           # 🟢 from presentation.xml/sldSz
  width: 1440
  height: 810
  safeArea:
    top: 48
    right: 56
    bottom: 48
    left: 56
  printSafe: false

# 🟡 视觉估计：原 deck 用栅格但不严格，估计为 12 列
grid:
  columns: 12
  gutter: 24
  margin: 56
  baseline: 8

colors:
  # ── 主色系：珊瑚粉渐变家族 ──
  primary: "#FF9A9E"            # 🟢 XML srgbClr (出现 19 次, 主导色)
  primary-deep: "#E3B5B7"       # 🟢 XML srgbClr
  primary-soft: "#FAD0C4"       # 🟢 XML srgbClr (用于渐变末端)

  # ── 中性灰系（3D 装饰 + 长正文）──
  on-surface: "#3B3B3B"         # 🟢 XML srgbClr (出现 258 次, 正文主色, 近黑非纯黑)
  on-surface-secondary: "#6C7278"   # 🟡 视觉估计 (副标题/说明文字)
  surface-muted: "#C8D0D8"      # 🟢 XML srgbClr (装饰浅灰)
  surface-decoration: "#9AA7B2" # 🟢 XML srgbClr (3D 立方体阴影面)

  # ── 背景与反白 ──
  surface: "#FFFFFF"            # 🟢 内容页主背景
  on-primary: "#FFFFFF"         # 🟢 粉色块上反白文字

  # ── 强调（细分割线 / 角标）──
  accent-line: "#FF9A9E"        # 🟢 与 primary 同色, 仅用于 2px 细线分割

typography:
  display:
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 300
    fontSize: 96
    lineHeight: 1.15
    letterSpacing: 0.02
    minProjectedSize: 72
  title:
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 600
    fontSize: 40
    lineHeight: 1.25
    letterSpacing: 0.05
    minProjectedSize: 32
  subtitle:
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 600
    fontSize: 22
    lineHeight: 1.35
  body:
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 16
    lineHeight: 1.6
    minProjectedSize: 16
  caption:
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 12
    lineHeight: 1.4
    letterSpacing: 0.1

# 🟡 视觉估计：原 deck 间距比例尺
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64

rounded:
  none: 0
  sm: 4
  md: 8
  lg: 16
  pill: 9999

imagery:
  style: "monochrome-photography"
  treatment: "黑白滤镜 + 高对比度，与粉色背景形成冷暖反差"
  cornerRadius: 0
  aspectRatio: "4:3 / 3:4 / 1:1 不限，但同页面多图须统一长宽比"
  usage:
    - "人物特写与生活场景：建立人文气息与可信度"
    - "工作环境/书桌静物：传达专业与日常的并置"
    - "团队协作/集体合影：服务于'我们'叙事"
  doNotUse:
    - "❌ 彩色照片：会破坏粉/灰二色压舱平衡"
    - "❌ 任意角度裁切：图片必须矩形整齐排列，禁止斜切/羽化"
    - "❌ 在粉色全屏背景上直接叠彩照"

iconography:
  style: "thin-line-circle"
  metaphors:
    - wifi
    - plant
    - coffee
    - lightbulb
    - document
    - person-silhouette
    - clock
  color: "#3B3B3B"
  size: "48-64px (single icon), 32-40px (icon-row)"
  strokeWidth: "1.5px"
  doNotUse:
    - "❌ 面性彩色图标 (与极简线性体系冲突)"
    - "❌ 拟物/3D 图标 (3D 装饰元素已经承担'立体感'职能)"

layouts:
  cover:
    structure: |
      - 整页珊瑚粉渐变 (左 #FF9A9E → 右 #FAD0C4)
      - 左下: 中文主标题 (display 巨字, 反白) + 英文副标题 (title, 反白)
      - 右上: 英文标语 (caption 大写字距宽, 反白, 多行右对齐)
      - 四角悬浮: 1-2 个 3D 立方体/三角形 (灰白渐变, 含阴影)
      - 右侧: 一条垂直细线 (反白, 2px), 作为构图锚点
    requiredFields: [topic, mainTitleZh, mainTitleEn, tagline]
    rationale: "首页用最大反差建立调性: 粉底 + 反白 + 3D 装饰 + 巨字, 一眼定风格"

  toc:
    structure: |
      - 整页粉色渐变背景
      - 左侧: 章节序号 + 大标题 (THE OUTLINE 类), 反白
      - 右下: 4-6 条目竖排 (反白, body 字号, 行间距大), 当前条目可加点状前缀
      - 装饰 3D 立方体 1-2 个
    requiredFields: [chapters[]]
    behaviorRule: "条目以纯文本竖排, 不画卡片, 保持轻盈"

  section-divider:
    structure: |
      - 整页粉色渐变背景
      - 中央: 章节大标题 (display, 反白) + 一行说明 (body, 反白)
      - 左下角小字: 章节序号 / 标记
      - 1-2 个 3D 装饰几何体悬浮
    inheritsFrom: cover
    rationale: "扉页与封面同构, 强化粉色作为'章节锚点'的视觉记忆"

  text-with-photo:
    structure: |
      - 白底
      - 左 1/2: 1-3 张黑白照片 (堆叠或并排), 不留圆角
      - 右 1/2: 章节小标题 (caption 浅灰大写) + 标题 (title 黑) + 正文段落
      - 顶部一条粉色细线 (2px, 跨页或局部) 作为分隔
    requiredFields: [sectionTag, title, body, images[]]
    bodyMaxItems: 1   # 仅一段正文, 超长改 stat-card 版式

  stat-highlight:
    structure: |
      - 整页粉色渐变背景
      - 中央或右侧: 巨型百分比/数字 (display, 反白, 200pt+)
      - 数字下方: 一行说明 (subtitle, 反白)
      - 左侧或顶部: 简短补充段落 (body, 反白)
      - 3D 立方体悬浮装饰
    requiredFields: [bigNumber, label, supportingText]
    rationale: "粉色背景 + 巨数字 = 情绪锚点, 用于章节结论或核心数据"

  card-grid-3:
    structure: |
      - 白底
      - 顶部: 区块大标题 (title) + 小标题 (caption 浅灰大写)
      - 中央: 3 列卡片, 每列 = 圆形细线图标 + 标题(subtitle) + 1 行说明(caption)
      - 卡片之间留白, 不画边框
      - 顶部一条粉色细线锚定
    requiredFields: [sectionTag, title, items[3]]
    bodyMaxItems: 3

  team-row:
    structure: |
      - 白底
      - 左 1/2: 团队成员名单 (姓名 subtitle 黑 + 职称 caption 浅灰), 竖排 3-4 条
      - 右 1/2: 1-3 张人物黑白照片, 矩形堆叠
      - 顶部粉色细线
    requiredFields: [members[]]

  closing:
    structure: |
      - 整页粉色渐变背景
      - 中央或右侧: CONTACT US / 感谢语 (title, 反白)
      - 反白竖排联系方式 / 致谢
      - 3D 立方体装饰
    inheritsFrom: cover
    rationale: "尾页与封面同构, 形成'粉 → 白 → 粉'的呼吸闭环"

patterns:
  decorations:
    floatingPolyhedron:
      shapes: ["cube", "tetrahedron", "triangle"]
      colors: ["#FFFFFF + soft gray gradient"]
      placement: "页面四角或边缘, 不进入文字主区"
      count: "1-3 个/页, 不可堆叠"
      rationale: "3D 几何体是这套系统的核心视觉签名, 替代了传统的色块/线条装饰"
    hairlineDivider:
      color: "#FF9A9E or #FFFFFF"
      thickness: "2px"
      placement: "白底页顶部 / 粉底页右侧"
      rationale: "细线代替块面分割, 保持极简感"
    cornerLogo:
      content: "页眉左上小字 (社团名 + 年份)"
      color: "#3B3B3B on white / #FFFFFF on coral"
      size: "10-12pt"
  supported:
    - cover
    - toc
    - section-divider
    - text-with-photo
    - stat-highlight
    - card-grid-3
    - team-row
    - closing

motion:
  enabled: false
  fallback: "若必须加过渡, 仅允许 fade, 时长 ≤ 300ms"
  rationale: "原 deck 未声明动画, 静态阅读语境优先"

meta:
  source: "文学社素材024.pptx"
  totalSlides: 27
  layoutCount: 8
  sectionCount: 4
  sectionMap:
    - "封面 / 开篇"
    - "关于我们 / 使命"
    - "数据 / 团队 / 时间线"
    - "扩展 / 联系"
  brandMark: "页眉左上小字 (品牌名 + 年份)"
  watermark: false

doAndDont:
  do:
    - "✅ 粉色仅作为情感锚点（封面/扉页/数据高光页/尾页），白色作为内容主战场"
    - "✅ 黑白照片必须矩形排版, 多图同页须等宽或等高"
    - "✅ 每页保留 1-2 个 3D 几何装饰, 维持视觉签名"
    - "✅ 文字层级靠字号与字重区分, 不靠彩色"
    - "✅ 中文标题与英文标题双语并置时, 中文在上、英文在下、中文字号略大"
  dont:
    - "❌ 不在粉色背景上铺彩色照片"
    - "❌ 不要在文字主区上方放 3D 装饰 (会遮文字)"
    - "❌ 不要给图片加圆角/羽化/阴影 (破坏极简)"
    - "❌ 不要把粉色用作正文文字色"
    - "❌ 不要在一页同时使用 3 种以上字号层级"
---

## Overview

本模板编码了**轻商务粉调作品集**的视觉语言——这套美学常见于校园社团手册、独立设计工作室介绍册、年轻创作者的个人作品集页。其核心特质是**柔粉情绪锚点 + 黑白人文压舱 + 3D 极简装饰**的三段式平衡。

与正式机构汇报的"权威 + 信息富集"路径不同，本系统刻意做减法：粉色块只在 cover / divider / stat 这种节奏关键点出现，承担"换气"与情绪标记的职能；其余内容页一律白底黑字 + 黑白照片，保持阅读重量。3D 几何悬浮装饰是这套系统最显著的视觉签名——它替代了传统的彩色色块或粗线条，用很小的视觉成本传达"这是 2020+ 设计语言"的时代信号。

本系统服务于**文学社、艺术社、设计社、文化兴趣团体**这类受众——他们既需要传达专业感，又不愿落入企业化冷淡。粉色提供温度，黑白照片提供文学感，3D 几何提供当代感，三者缺一不可。

## Audience & Context

- **谁看**：高校师生、社团招新对象、文化活动赞助方、文创合作伙伴
- **在哪看**：投影 / 微信公众号导出页 / 招新展位平板 / 社团迎新晚会大屏
- **看多久**：单页停留 8-15 秒，全册扫读 3-5 分钟
- **物理约束**：正文 ≥ 16pt，标题 ≥ 32pt，粉底反白文字字重 ≥ 600，对比度满足 AA

## Canvas & Grid

1440 × 810 (16:9) 是当前数字投影与公众号长图的通用规格。安全区比常规更宽（左右 56px / 上下 48px），原因是 3D 装饰元素需要在角落呼吸——若安全区压到边缘，几何体会被切，破坏"漂浮感"。

栅格 12 列只是参考骨架，原 deck 大量使用"一分二"或"一分三"的近似切分，并不严格对齐栅格。在生成新页时优先尊重视觉重心，栅格只用于多卡片版式的列分配。

## Colors

视觉权重比例约为 **白 60% / 粉 30% / 灰 10%**——粉色是稀缺资源，仅在 cover / section-divider / stat-highlight / closing 出现。这种节奏感建立了"粉色 = 章节锚点"的阅读契约，破坏它会让整册松散。

主色家族是珊瑚粉渐变（#FF9A9E → #FAD0C4），属于 2018-2022 年活跃的"千禧粉"色谱，自带"年轻、温柔、有设计感"的语义。三个色阶不是任选其一，而是**作为渐变两端 + 中段同时出现**——单色铺底会显廉价，渐变才是这套系统的真正主色。

文字主色 #3B3B3B 是近黑而非纯黑（#000000），原因是与粉色背景搭配时纯黑会过于刺眼，#3B3B3B 提供更柔和的阅读体验。深灰还兼任 3D 装饰的描边色，统一了"非粉色都是冷调"的二色法则。

## Typography

本系统使用 **单字体策略**——Calibri (西文) + PingFang SC / Microsoft YaHei (中文)，通过字重（300 / 400 / 600）与字号差（96 / 40 / 22 / 16 / 12）建立层级。单字体让设计师无需平衡字体配对，把注意力放在排版节奏上。

正文 16pt 略低于"投影最佳"的 18pt，但本套系统更多用于电子阅读与微信发布场景，16pt + 1.6 行高在屏幕阅读中表现良好。封面 display 字号高达 96pt，与正文形成 6 倍跨度——这是**有意的层级戏剧化**，让封面承担"声明"职责。

一张典型内容页同时使用 2-3 个字号层级（caption 标签 + title 标题 + body 正文），不超过 3 个。一旦超过，就该考虑拆页。

## Layouts

8 个版式构成结构核心：`cover / toc / section-divider / text-with-photo / stat-highlight / card-grid-3 / team-row / closing`。

- **cover & closing 同构**：粉色渐变背景 + 反白巨字 + 3D 装饰，仅文字内容不同。这种首尾对称是本系统的"仪式感"来源——开场和谢幕被同等重视。
- **section-divider 继承 cover**：每个章节切换都由一张全粉扉页承担，相当于阅读节奏的换气符。省略它会让全册扁平。
- **stat-highlight 是粉色的高光时刻**：把一个百分比或数字放大到 200pt+，是把"情绪"转化为"事实"的关键工具。
- **白底版式（text-with-photo / card-grid-3 / team-row）** 承担信息密度，所有论据、人物、细节在这里展开。

## Imagery & Icons

本系统中的图像发挥**人文叙事**的功能——黑白处理把所有照片拉到同一情绪基调，与粉色背景形成冷暖反差。读者不是在看"项目截图"，而是在看"人在做事的状态"。这是文学/艺术社团尤其需要的语境。

3D 几何悬浮装饰（立方体、三角锥）是本系统的**核心识别符号**。它几乎出现在每一页，但每页只 1-3 个、不进入文字主区——是一种"不打扰的存在"。删除它，整套系统会立刻失去时代感。

图标系统极简——单线条、圆形外框、深灰描边。原因是 3D 几何已经承担了"立体感"职能，图标必须保持平面、不与之争夺视觉。复杂彩色图标会破坏二色法则。

## Do's and Don'ts

完整规则列表见上方 YAML 中的 `doAndDont`。需要深入理解的核心护栏：

- **粉色稀缺律** —— 粉色只在节奏关键点出现，整册占比 ≤ 30%。多了就廉价。
- **黑白照片律** —— 不允许彩色照片，保持二色压舱平衡。文学社的"文艺感"靠的就是这个克制。
- **3D 装饰非主角律** —— 几何体是配角，不能进入文字主区或挡住人物面孔。
- **双语对仗律** —— 中英双语标题须并置，中文在上、字号略大；不要省略一种。
- **字号克制律** —— 单页字号层级 ≤ 3 个，超过就拆页。
