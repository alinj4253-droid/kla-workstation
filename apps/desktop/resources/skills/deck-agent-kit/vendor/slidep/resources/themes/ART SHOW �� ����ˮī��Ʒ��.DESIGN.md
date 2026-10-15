---
name: "ART SHOW · 极简水墨作品集"
description: "黑白灰极简风、水墨/液态抽象纹理、几何点缀、强首尾同构的艺术作品集模板。从《文学社素材007.pptx》反向抽取的视觉设计契约。"
audience: "艺术院校学生、设计师作品集、创意展览/求职面试、文艺类社团展示"
locale: "zh-CN"

# ─────────────────────────────────────────────────────────────
# CANVAS — 16:9, 兼容 960×540pt 与 1280×720px 双坐标系
# ─────────────────────────────────────────────────────────────
canvas:
  aspectRatio: "16:9"                    # 🟢 from presentation.xml/sldSz
  # 原模板坐标 (pptx pt 单位)
  width_pt: 960.0
  height_pt: 540.0
  # 渲染目标坐标 (slidex / web px 单位)
  width_px: 1280
  height_px: 720
  unitConversion: "1pt = 4/3 px (1280/960)"

  # 🔴 安全区 — 60px 给 LibreOffice / slidep-validate 双引擎留够冗余
  safeArea:
    top: 40
    right: 60
    bottom: 60
    left: 60

  # 🔴 内容必须严格在 safeArea 之内, 装饰性元素 (水墨/几何小点) 例外
  contentZone:
    top: 40
    right: 60
    bottom: 60                           # 页脚也算 contentZone
    left: 60

  printSafe: false

# ─────────────────────────────────────────────────────────────
# GRID — 12 栏 + 密度护栏
# ─────────────────────────────────────────────────────────────
grid:
  columns: 12
  gutter: 16
  margin: 60                             # 与 safeArea.left/right 对齐
  baseline: 8

  # 🔴 内容填充率护栏 — 下半页大面积空白是风格红线
  fillRatio:
    min: 0.65                            # 内容页主体占比 ≥ 65% 画布有效高度
    max: 0.85

  # 🔴 双栏密度平衡 — 严禁一栏占 ≥ 70%
  densityBalance:
    leftRightRatio: [0.4, 0.6]           # 双栏比例需在 40:60 ~ 60:40 之间

# ─────────────────────────────────────────────────────────────
# COLORS — 极简单色相系统
# ─────────────────────────────────────────────────────────────
colors:
  # 主色系 (中性色系统, 频次冠军 ≥ 1.5× 色相色冠军)
  primary: "#464441"                     # 🟢 XML srgbClr (27x, 主标题栏/几何块)
  primary-deep: "#000000"                # 🟢 XML srgbClr (16x, 纯黑书法字/几何强调块)
  primary-ink: "#244842"                 # 🟢 XML srgbClr (4x, 水墨阴影)

  # 中性色
  surface: "#FFFFFF"
  surface-muted: "#F5F5F5"
  on-surface: "#000000"
  on-surface-secondary: "#97A19F"        # 🟢 XML srgbClr (10x)
  on-surface-tertiary: "#E8E8E8"         # 🟢 XML srgbClr
  on-primary: "#FFFFFF"

  # accent: 不设 — 中性色系统的根基红线, 严禁彩色 accent

# ─────────────────────────────────────────────────────────────
# TYPOGRAPHY — 双坐标系字号映射
# 🔴 fontSize_pt 对应原 pptx 960×540pt; fontSize_px 对应 1280×720px 渲染
# ─────────────────────────────────────────────────────────────
typography:
  display:                               # 封面巨大字
    fontFamily: '"Calibri Light", "Source Han Serif SC", "Songti SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontWeight: 300
    fontSize_pt: 96
    fontSize_px: 128
    lineHeight: 1.0
    minProjectedSize_px: 96
  hero-num:                              # 章节大数字 PART 01-04
    fontFamily: '"Calibri Light", system-ui, sans-serif'
    fontWeight: 300
    fontSize_pt: 143
    fontSize_px: 190
    lineHeight: 1.0
  hero-num-watermark:                    # 灰色水印 PART ONE/TWO/…
    fontFamily: '"Calibri Light", system-ui, sans-serif'
    fontWeight: 300
    fontSize_pt: 96
    fontSize_px: 110
    color: "#E8E8E8"
    opacity: 0.5
  title:                                 # 内容页标题
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontWeight: 600
    fontSize_pt: 28
    fontSize_px: 28
  subtitle:
    fontWeight: 600
    fontSize_pt: 20
    fontSize_px: 22
  body:                                  # 🔴 1280×720 画布下限 16px, 保证投影可读
    fontFamily: '"Calibri", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontWeight: 400
    fontSize_pt: 14
    fontSize_px: 16
    lineHeight: 1.65
    minProjectedSize_px: 14
  body-small:
    fontSize_pt: 10
    fontSize_px: 13
  caption:
    fontFamily: '"Calibri Light", system-ui, sans-serif'
    fontSize_pt: 18
    fontSize_px: 18
    letterSpacing: "0.05em"
  meta:                                  # 页边竖排英文
    fontSize_pt: 9
    fontSize_px: 11
    letterSpacing: "0.2em"
    textTransform: "uppercase"

# ─────────────────────────────────────────────────────────────
# SPACING
# ─────────────────────────────────────────────────────────────
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64

# ─────────────────────────────────────────────────────────────
# ROUNDED — 🔴 全部为 0, 中性色系统的硬朗几何, 严禁圆角
# ─────────────────────────────────────────────────────────────
rounded:
  none: 0

# ─────────────────────────────────────────────────────────────
# IMAGERY — 水墨抽象 + 真实作品图双轨
# ─────────────────────────────────────────────────────────────
imagery:
  style: "ink-wash-abstract"
  palette: "monochrome-grayscale"
  saturation: 0
  contrast: "high"

  treatment:
    - "全幅或半幅作背景纹理, 不裁剪成规整矩形"
    - "图像边缘保留有机不规则形状"
    - "可叠加在白底上做点缀, 也可作整页底图"

  # 🔴 配图来源策略 — 语义相关页必须用真实图, SVG 抽象仅作背景
  sourcing:
    rule: "主题相关页 (艺术家个案/作品对照) 必须用真实作品图, SVG 抽象只作背景纹理"
    strategy:
      - "优先级 1: 真实艺术作品图 (Wikipedia / Wikimedia Commons / 公共领域)"
      - "优先级 2: 艺术家肖像 / 工作室照片"
      - "优先级 3: SVG 抽象水墨 (兜底, 但仅限封面/扉页/致谢)"
    grayscaleFilter: "所有真实图必须 saturate(0) + contrast(1.05) 转黑白, 保证整套语言统一"
    requiredPages:
      - "艺术家个案页必须配作品图"
      - "艺术家代表卡片应配每人 1 张作品图或肖像"
      - "媒介对比页应配 1 张代表作品"

  # 🔴 章节扉页水墨形态必须多样化, 不可复用同一形态
  inkVariants:
    rule: "4 张章节扉页必须用 4 种不同水墨形态"
    variants:
      - id: "blob-vertical"
        description: "竖向卵圆 (适合单一线性叙事)"
      - id: "splash-horizontal"
        description: "横向飞溅+多团碎墨 (适合多人/多元叙事)"
      - id: "stripes-vertical"
        description: "多条竖向墨痕+滴落 (适合多媒介并列)"
      - id: "circle-radial"
        description: "中心扩散同心圆 (适合全球辐射/核心放射)"

  do:
    - "封面/扉页/致谢页用 SVG 抽象水墨"
    - "艺术家个案/对比页用真实作品图 (转黑白)"
    - "图片可越界出血, 但必须在 safeArea 之内"
  dont:
    - "不要用彩色照片"
    - "不要用规整裁剪的产品图"
    - "不要 4 张扉页用同款水墨形态"
    - "不要全篇靠抽象 SVG 替代真实作品图"

# ─────────────────────────────────────────────────────────────
# ICONOGRAPHY — 几何符号系统, 取代传统图标
# ─────────────────────────────────────────────────────────────
iconography:
  style: "geometric-marks"
  vocabulary:
    - "黑色实心矩形 (标题栏左侧 6×24px)"
    - "黑色/灰色菱形"
    - "黑色/灰色三角线框"
    - "× 小叉号"
    - "细横线 / 短斜线"
  strokeWidth: 1
  fill: "primary | primary-deep | none(stroke-only)"
  do:
    - "用几何形+大字号承担强调职责, 不依赖颜色对比"
  dont:
    - "不要引入 Material/Feather 等图标库"
    - "不要用彩色/渐变图标"

# ─────────────────────────────────────────────────────────────
# LAYOUTS — 11 个 slideLayouts, 每个版式的最小填充率
# ─────────────────────────────────────────────────────────────
layouts:
  cover:
    role: "封面 / 致谢页 (首尾同构)"
    fillRatioTarget: 0.7

  toc:
    role: "目录"
    fillRatioTarget: 0.75
    notes: "4 章网格底部必须距离页脚 ≥ 80px"

  section-divider:
    role: "章节扉页"
    fillRatioTarget: 0.6
    requiredInkVariant: true             # 🔴 必须使用 inkVariants 的不同形态

  content-text-3col:
    fillRatioTarget: 0.75

  content-image-grid:
    fillRatioTarget: 0.8
    requiredRealImage: true              # 🔴 必须配真实作品图

  content-image-text-split:
    fillRatioTarget: 0.8
    requiredRealImage: true              # 🔴 必须配真实作品图

  content-card-overlay:
    fillRatioTarget: 0.75

  content-numbered-list:
    fillRatioTarget: 0.75

  content-data-chart:
    fillRatioTarget: 0.85
    densityBalanceRequired: true         # 🔴 双栏密度必须均衡

  content-cta:
    fillRatioTarget: 0.7

# ─────────────────────────────────────────────────────────────
# PATTERNS — 反复出现的视觉构件
# ─────────────────────────────────────────────────────────────
patterns:
  supported:
    - "title-bar-with-block: 标题左侧紧贴 6×24px 黑色实心矩形"
    - "section-watermark: 章节序号配淡灰水印英文"
    - "vertical-side-text: 页边竖排英文小字 (uppercase + letter-spacing)"
    - "ink-wash-bleed: 水墨图越界出血 (但在 safeArea 内)"
    - "geometric-numbering: 用菱形/方块/圆形作序号容器"
    - "first-last-mirror: 封面与致谢页结构同构"
  forbidden:
    - "彩色 accent / 彩色高亮"
    - "圆角卡片"
    - "渐变填充 (除水墨自然过渡)"
    - "投影 / 浮雕等拟物效果"
    - "4 张扉页用同款水墨形态"
    - "内容页用 14px 以下作主体文字"
    - "下半页留白 ≥ 35%"
    - "双栏比例失衡 (一栏占 ≥ 70%)"
    - "全篇靠抽象 SVG 替代真实作品图"

# ─────────────────────────────────────────────────────────────
# MOTION — pptx 未声明动效
# ─────────────────────────────────────────────────────────────
motion:
  declared: false
  recommended: "fade-only"
  duration: 400
  easing: "ease-out"

# ─────────────────────────────────────────────────────────────
# META
# ─────────────────────────────────────────────────────────────
meta:
  totalSlides: 20
  layoutCount: 11
  themeName: "Calibri Light / Calibri"
  primaryColorXmlOccurrences:
    "#464441": 27
    "#000000": 16
    "#97A19F": 10
    "#244842": 4
    "#E8E8E8": 1

# ─────────────────────────────────────────────────────────────
# LAYOUT QA — 双引擎渲染检查清单
# ─────────────────────────────────────────────────────────────
layoutQA:
  rule: "slidep-validate 通过 ≠ 最终渲染过关. 必须在 build 后再用 LibreOffice 转 PDF 抽样检查."
  checklist:
    - "build 完成后运行: soffice --headless --convert-to pdf <pptx>"
    - "用 pdftoppm -r 120 转每页 JPEG"
    - "肉眼检查: (1) 是否有重叠遮挡 (2) 是否有半页空白 (3) 文字是否溢出"
    - "若 LibreOffice 渲染失败但 validate 过关 → 减少元素到 safeArea 内 ≥ 20px"
  knownPitfalls:
    - "grid 子元素的 marginTop 累积可能让容器实际高度大于显式 height → 改用绝对定位"
    - "slidep-validate 用 React 渲染高度, LibreOffice 用 PPTX 规范, 两者偏差可达 30-50px"
    - "页脚必须放在 contentZone 内 (距底 ≥ 60px), 不能贴底"

# ─────────────────────────────────────────────────────────────
# DO & DON'T — 风格护栏
# ─────────────────────────────────────────────────────────────
doAndDont:
  do:
    - "保持严格黑白灰中性色系统"
    - "每章前插入 section-divider, 4 章对应 4 种 inkVariant"
    - "封面与致谢页结构同构"
    - "用大字号 (96-190px) + 水墨图作视觉锚点"
    - "用几何形 (矩形/菱形/三角) 作图标替代品"
    - "页边可加竖排英文 uppercase 小字"
    - "艺术家页必须配真实作品图 (转黑白)"
    - "内容页 body 字号 ≥ 16px (1280×720 画布)"
    - "内容填充率 ≥ 65%"
    - "build 后用 LibreOffice 抽样校验"
  dont:
    - "❌ 任何彩色 accent"
    - "❌ 圆角"
    - "❌ Material/Feather 图标"
    - "❌ 省略章节扉页"
    - "❌ 4 张扉页用同款水墨"
    - "❌ 内容页用 14px 以下正文"
    - "❌ 下半页留白超 35%"
    - "❌ 双栏比例失衡"
    - "❌ 仅靠 SVG 抽象替代真实作品图"
---

# ART SHOW · 极简水墨作品集 — 设计契约说明

## 一句话定位

**"用水墨的有机边缘 × 几何的硬朗骨架 × 真实作品的语义锚点, 把'艺术作品集'的高级感落到 1280×720 的画布上。"**

## 视觉语言三要素

1. **色彩**: 严格黑白灰中性色系统, 用 `#464441 / #000000 / #97A19F` 三档深浅承担全部层次
2. **图像**: 真实艺术作品图 (转黑白) 为主, SVG 抽象水墨为辅
3. **结构**: 几何形替代图标, 大字号替代彩色 accent, 4 种 inkVariant 区分章节

## 叙事骨架 (强制四幕式)

```
封面(blob-vertical) → 目录 → PART 01(blob-vertical) → 内容页
→ PART 02(splash-horizontal) → 内容页(配作品图)
→ PART 03(stripes-vertical) → 内容页(配代表作品图)
→ PART 04(circle-radial) → 内容页 → 致谢
```

- **首尾同构**: 封面与致谢页采用相同版式
- **章节扉页 强制出现**: 4 个章节各有一张扉页, 含 PART 01-04 大数字 + 灰色水印英文 + 不同 inkVariant
- **章节内**: 自由组合 content-text-3col / image-grid / image-text-split / card-overlay / numbered-list 等版式

## 字体哲学

- **拉丁文**: Calibri Light (300) — 细瘦优雅, 与水墨调性匹配
- **中文标题**: 用书法体或宋体 (主题未声明 CJK, fallback 至 Source Han Serif SC / Songti SC)
- **基准字号**: 原模板 body = 14pt (出现 224 次), 映射到 1280×720 画布时提升至 16px
- **极端字号跨度**: 9pt → 171pt 共 15 个层级, 反映「高信息密度 + 大字号锚点」双重风格

## 关键护栏 (P0 红线)

| 护栏 | 理由 |
|---|---|
| ❌ safeArea < 60px | LibreOffice 渲染会溢出 |
| ❌ 内容填充率 < 65% | 半页空白触发必扣 |
| ❌ body 字号 < 16px (1280×720 画布) | 投影场景不可读 |
| ❌ 4 张扉页用同款水墨 | 单调, 破坏视觉节奏 |
| ❌ 艺术家页无真实作品图 | 主题语义不匹配 |
| ❌ build 后不做 LibreOffice 抽检 | validate 通过 ≠ 渲染过关 |
| ✅ 所有真实图必须 saturate(0) 转黑白 | 保持中性色系统统一 |

## 置信度审计线索

| 字段 | 置信度 | 说明 |
|---|---|---|
| canvas / fonts / 字号梯度 | 🟢 高 | 直接读自 XML |
| colors token 选取 | 🟢 高 | 基于 XML 频次, 中性色系统判定 |
| safeArea / fillRatio / densityBalance | 🟡 中 | 基于反复渲染验证 |
| imagery.sourcing / inkVariants | 🔴 推断 | 一致性反推 |
| layoutQA | 🟢 高 (操作性) | 双引擎抽检流程 |
