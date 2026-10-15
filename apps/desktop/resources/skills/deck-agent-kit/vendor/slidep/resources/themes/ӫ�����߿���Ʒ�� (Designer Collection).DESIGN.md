---
version: "0.1"
name: "荧光绿线框作品集 (Designer Collection)"
description: "清新荧光绿 + 黑色双主色, 极细线框 + 倾斜卡片叠层, 首尾同构的四章式作品集模板; 适合个人作品集/学生社团/轻量品牌汇报"
audience: "学生社团 / 设计师个人 / 创意工作室 — 风格年轻、活泼、低正式度, 不适用于金融/医疗/政企等高严肃度场景"   # 🔴 基于缩略图 + 封面"Designer Collection 设计师作品集"标题归纳
locale: "zh-CN"                          # 🟢 基于字体 fallback chain 推断

canvas:
  aspectRatio: "16:9"           # 🟢 from presentation.xml/sldSz
  width: 960.0                          # 🟢
  height: 540.0                          # 🟢
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
  primary: "#02BF31"          # 🟢 XML srgbClr (1232x)
  primary-deep: "#00BE2E"          # 🟡 pixel-sampled (13x)
  primary-darkest: "#02B53F"          # 🟡 pixel-sampled (4x)

  # ── 强调色 (互补色相桶, 与主色相距 ≥ 90°) ──
  accent: "#031443"           # 🟢 XML srgbClr (6x)

  # ── 中性色 ──
  surface: "#FFFFFF"                       # 🟡 视觉估计
  surface-muted: "#F5F5F8"                 # 🟡
  on-surface: "#000000"                    # 🟢 XML srgbClr (avoid pure black)
  on-surface-secondary: "#6C7278"          # 🟡
  on-primary: "#FFFFFF"                    # 🔴 默认: 主色为深色时白字, 反之需手工调整

typography:
  # 主字体: 等线 Light → fallback chain: default     # 🟢
  # 正文字体: 等线 → fallback chain: default   # 🟢
  display:
    fontFamily: '"等线 Light", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 700                        # 🟢 (Bold)
    fontSize: 115                          # 🟢 (最大字号)
    lineHeight: 1.1                        # 🟡
    minProjectedSize: 95                 # 🔴 规范底线
  title:
    fontFamily: '"等线 Light", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 700
    fontSize: 34                          # 🟢
    lineHeight: 1.3
    minProjectedSize: 24
  body:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 20                          # 🟢 基准字号
    lineHeight: 1.5
    minProjectedSize: 16                   # 🔴 规范底线
  body-small:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 18                          # 🟢
    lineHeight: 1.4
  caption:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 12                           # 🟢
    lineHeight: 1.3

# spacing 全部为视觉估计                                 # 🔴
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64

rounded:                                   # 🟡 视觉估计
  none: 0
  sm: 4
  md: 8
  pill: 9999

# imagery / iconography / patterns / motion / meta / doAndDont
# 以下字段由 Claude 基于 20 张缩略图归纳补充                  # 🔴

imagery:                                   # 🔴 视觉归纳
  style: "line-illustration"               # 黑白细线插画 (人物轮廓+铅笔等), 与"设计师"主题呼应
  treatment: "monochrome"                  # 插画统一为黑色单色, 不混入彩色照片
  background: "transparent-on-white"       # 插画无背景, 直接放在白底或荧光绿色块上
  photographyAllowed: false                # 整套未使用任何实拍照片
  illustrationLibrary: "lineart-people"    # 推荐用线性人物/物件插画补图

iconography:                               # 🔴 视觉归纳
  style: "outline-thin"                    # 极细描边图标, 1-2pt 线宽
  weight: "thin"
  color: "primary | on-surface"            # 图标只用主绿色或纯黑, 不用强调色
  backdrop: "circle | square | none"       # 图标常被放在圆形或方形色块内 (见 slide18/19)
  size: 24                                 # 推荐基础图标尺寸 (pt)

patterns:                                  # 🔴 由 12 个 layout + 20 张实页归纳
  supported:
    - cover                                # 封面: 大标题 + 主插画卡片 (slide 1)
    - section-divider                      # 章节扉页: 倾斜叠层卡片 + 大编号 (slide 3, 7, 11, 15)
    - toc                                  # 目录: 4 卡平铺 + 数字编号 (slide 2)
    - card-grid-2x2                        # 2×2 卡片网格 (slide 4, 6, 16)
    - card-grid-1x3                        # 1×3 卡片横排 (slide 8, 18)
    - card-grid-1x4                        # 1×4 横排 + 配图 (slide 10)
    - chart-line                           # 折线图 (slide 12)
    - chart-bar                            # 柱状图 (slide 14)
    - chart-donut                          # 环形图 (slide 17)
    - text-3col                            # 三栏内容 (slide 5)
    - thanks                               # 致谢页, 与封面同构 (slide 20)
  decorations:
    - "header-bar"                         # 顶部细分隔线 + 三角箭头节奏点 (▶▶▶) , 全 deck 一致
    - "footer-bar"                         # 底部荧光绿色条 + 联系信息
    - "side-label"                         # 右侧竖排英文 section 名 (Personal introduction 等)
    - "tilted-card-stack"                  # 章节扉页的 3 层倾斜叠层卡片 (核心视觉锚点)

motion: {}                                 # 🟢 pptx 中未发现自定义动画时序

meta:
  slideCount: 20                           # 🟢
  layoutCount: 12                          # 🟢
  primaryFamilyOrigin: "等线 (DengXian)"   # 🟢 Microsoft Office 默认中文字体, 暗示该模板来自 PowerPoint 而非 Keynote/WPS

doAndDont:                                 # 🔴 由一致性反推
  do:
    - "主色 #02BF31 用于大色块、强调线、章节编号背景; 与黑色形成核心双主色对比"
    - "每个内容页保留顶部 header-bar (细线 + ▶▶▶ + 章节英文名 + 年份) 与底部 footer-bar"
    - "章节扉页强制使用倾斜叠层卡片 + 大数字编号 (01-04), 保持 4 章节叙事节奏"
    - "封面与致谢页结构同构 — 均采用倾斜卡片 + 中英文双语标题, 形成首尾呼应"
    - "插画统一为黑色 outline 风格, 配色三色封顶: 荧光绿 / 黑 / 白"
    - "正文卡片用 1-2pt 极细描边, 不用填充背景, 保持轻盈感"
  dont:
    - "不要引入第三种品牌色 (除 accent #031443 用于极少量深色块外)"
    - "不要使用照片或彩色插画 — 与 line-illustration 风格冲突"
    - "不要去掉 header-bar / footer-bar — 这是该模板的核心节奏装饰"
    - "不要使用粗描边或圆角 > 8pt — 与极细线框语言冲突"
    - "不要在金融/政企/医疗场景套用 — 风格过于活泼, 缺少正式度"
    - "不要把绿色用于失败/错误状态 — 该 deck 中绿色等同于主品牌, 语义已被占用"
---

# 荧光绿线框作品集 — 设计理由

## 1. 一句话定位

**清新、年轻、低正式度的"作品集"模板** — 用极简的双主色 (荧光绿 + 黑) 与极细线框语言, 把"设计师/创作者"的轻盈、个性、手工感传达给读者. 适合个人作品集、学生社团 (尤其文艺/设计/文学类)、独立工作室. **不适合**金融、政企、医疗等高严肃度场景.

## 2. 颜色哲学

- **主色 `#02BF31`**: 高饱和荧光绿 (HSV H=135°), 在全 deck 出现 1232 次, 是绝对的视觉锚点. 用于色块、章节编号背景、装饰条、大字 highlight.
- **强调色 `#031443`**: 近黑深蓝, 仅出现 6 次, 用于极少量需要"重音"的深色块 (如 slide 5 的中央深色卡片). **不当作日常文字色用** — 文字色应使用 `on-surface = #000000`.
- **去除原作色彩噪音**: 像素采样发现绿色实际有 3 个略微不同的近似值 (`#02BF31` / `#00BE2E` / `#02B53F`), 已收敛为 `primary` / `primary-deep` / `primary-darkest` 三个语义 token, 下游使用时**优先用语义名**, 不要直接写 hex.

## 3. 字体哲学

- **主字体 等线 Light** (Microsoft Office 默认中文字体之一), 暗示模板来自 PowerPoint 工作流.
- **字号梯度大 (12 个层级, 11pt – 115pt)** — 反映"标题大、辅助文字小"的作品集典型节奏, 不是传统商业 PPT 的"匀速字号"风格.
- **基准 20pt 出现 100 次** — 这是该系统的灵魂正文字号, 下游生成新 PPT 时正文应优先使用 20pt.
- 在非 Windows 环境下渲染时, fallback chain 会切到 `PingFang SC` / `Microsoft YaHei` / `system-ui`, 视觉风格基本保持.

## 4. 版式与叙事

- **20 张 / 12 layout, 四章节式 (个人介绍 → 作品概览 → 创作思路 → 风格介绍)**, 每章前一张倾斜叠层卡片 + 大编号扉页.
- **首尾同构**: 封面 (slide 1) 与 谢页 (slide 20) 共用相同的"倾斜卡片 + 中英文双语 + 主插画"结构, 形成强烈呼应.
- **节奏装饰统一**: 每张内容页头部都有 `▶▶▶` 三角箭头序列 + 顶部细线 + 右侧竖排 section 英文名, 这是该模板的"心跳", **不要去掉**.

## 5. 插画 / 图像

- 全 deck 0 张实拍照片. 全部使用**单色黑线插画** (人物轮廓、铅笔、办公道具). 这与"设计师作品集"主题强绑定.
- 下游补图时**禁止引入彩色照片或多色插画**, 保持单色 line-art 风格统一.

## 6. 与规范的偏差

- 本 DESIGN.md 仅定义 L3 模板级契约, 未涉及 L0/L1.
- `motion` 留空 — 原 pptx 未声明自定义动画时序.
- `narrative.md` 未输出 (本 skill 不负责叙事节奏).
