---
name: "olive-portfolio-quiet"
description: "橄榄灰绿 × 暖米白的极简作品集风格 PPT 设计契约。从《文学社素材010.pptx》(D8 作品集模板) 反向抽取。整体气质安静、克制、文艺、自然系，适合艺术作品集 / 创意求职 / 设计提案场景。"
audience: "艺术作品集 / 创意求职 / 设计提案 / 摄影展示 / 极简文学社风。🔴 基于封面文案 PROJECT PROPOSAL、签名水印 mwydesign、黑白摄影意象与文艺极简版式归纳"
locale: "zh-CN"                                # 🟢 主/正文字体均为中文等线 Light/等线

canvas:
  aspectRatio: "16:9"                          # 🟢 from presentation.xml/sldSz
  width: 960.0                                 # 🟢
  height: 540.0                                # 🟢
  safeArea:                                    # 🟡 视觉估计
    top: 24
    right: 32
    bottom: 32
    left: 32
  printSafe: false                             # 🔴 默认值

# 12 列栅格在原 deck 中并未严格约束, 但内容页常见"左 1/3 视觉锚 + 右 2/3 内容"的二分构图,
# 三列内容页使用近似 1:1:1 等分.                                              # 🟡
grid:
  columns: 12
  gutter: 16
  margin: 32
  baseline: 8

colors:
  # ── 主色系: 橄榄灰绿背景 (该 deck 的视觉灵魂) ──
  primary: "#6E7063"                           # 🟢 XML srgbClr + 像素采样确认为背景主导
  primary-deep: "#5A5C50"                      # 🟡 暗化版, 用于深色卡片描边/分隔线
  primary-darkest: "#3F4138"                   # 🔴 用于极少数高对比强调

  # ── 装饰性 accent (不是色相 accent, 而是灰阶弱强调, 用于区分图表系列/对比组/active 项) ──
  accent-muted: "#D9D6CD"                      # 🟡 图表/对比的弱强调
  accent-deep: "#3F4138"                       # 🔴 图表暗系列 / 对比页强项

  # ── 中性色 (前景文字 / 卡片 / 装饰线) ──
  surface: "#FEF9F1"                           # 🟢 暖米白, 主要前景色
  surface-muted: "#D9D6CD"                     # 🟡 浅灰米色, 用于圆形图标底 / muted 卡片
  on-surface: "#3F4138"                        # 🔴 米白卡片上的文字
  on-surface-secondary: "#8A8B7E"              # 🟡 次要正文
  on-primary: "#FEF9F1"                        # 🟢 主背景上的所有文字
  on-primary-secondary: "#C9C5BB"              # 🟡 caption / 弱化文本

typography:
  # 核心哲学: "Light 字重 + 巨大字号" 的反差, 搭配 "小密正文 + 宽行距"
  display:
    fontFamily: '"等线 Light", "PingFang SC Light", "HarmonyOS Sans SC Light", "Microsoft YaHei Light", system-ui, -apple-system, sans-serif'
    fontWeight: 300                            # 🔴 等线 Light 实际字重 300, 不可加粗
    fontSize: 88                               # 🟢 封面/致谢巨字
    lineHeight: 1.05                           # 🟡
    letterSpacing: "-0.01em"                   # 🔴
    minProjectedSize: 64                       # 🔴 投屏底线
  title:
    fontFamily: '"等线 Light", "PingFang SC Light", "HarmonyOS Sans SC Light", "Microsoft YaHei Light", system-ui, -apple-system, sans-serif'
    fontWeight: 300                            # 🔴 标题也走 Light, 靠字号制造层级
    fontSize: 48                               # 🟢 内容页标题主用 36-48pt
    lineHeight: 1.2
    minProjectedSize: 32
  subtitle:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 24                               # 🟢
    lineHeight: 1.4
  body:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 14                               # 🟢 正文最高频字号
    lineHeight: 1.7                            # 🟡 行距宽松, 提升小字呼吸感
    minProjectedSize: 13                       # 🔴
  caption:
    fontFamily: '"等线", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 12                               # 🟢
    lineHeight: 1.4
    letterSpacing: "0.02em"                    # 🔴
  numeric:                                     # 编号字体 (01/02/03 大编号)
    fontFamily: '"等线 Light", "Helvetica Neue Light", "Arial", sans-serif'
    fontWeight: 300
    fontSize: 36                               # 🟢
    letterSpacing: "0.05em"                    # 🔴
  signature:                                   # 签名/水印手写体 (反向草书)
    fontFamily: '"Allura", "Pinyon Script", "Caveat", "Brush Script MT", cursive'
    fontWeight: 400
    fontSize: 32
    fontStyle: italic
    transform: "scaleY(-1)"                    # 🔴 垂直翻转作为水印
  bigNumber:                                   # ── 大数字 (KPI) 三段式排版 ──
    # 适用场景: "¥ 1.2 万亿" / "38% CAGR" / "4.2 亿 USERS" 这类
    # "数字 + 中文单位 + 英文标签 + 中文描述" 的 KPI 模式.
    # 必须严格遵守, 否则极易出现基线错位.
    layout: "stack-not-inline"                 # 🔴 必须竖排, 禁止三段挤在同一行
    structure:
      line1: "数字主体 (例: 1.2 / 38% / 4.2亿)"  # 40-56pt, fontWeight 300
      line2: "中文单位 · 英文标签 (例: 万亿 · TRILLION YUAN)"  # 11-13pt, color #C9C5BB
      line3: "中文描述 (例: 2025E 市场规模)"      # 11-13pt, color #FEF9F1
    alignment: "alignItems: 'flex-start'"      # 🔴 禁止 baseline
    spacing:
      between_main_and_unit: 4                 # 主数字 → 单位行 间距 (px)
      between_unit_and_desc: 8                 # 单位行 → 描述行 间距
    forbidden:
      - "alignItems: 'baseline' + flexDirection: 'row' (UNIT 飘到数字上方)"
      - "中文单位与英文标签写在数字同一行 (中英基线不一致)"
      - "用 superscript/subscript 处理单位 (字体不支持)"
    do:
      - "始终用 flexDirection: 'column' + alignItems: 'flex-start' 三段竖排"
      - "中文单位与英文标签可同行, 但必须共享同一 fontSize 与 lineHeight"
      - "数字主体的 lineHeight 设为 1, 避免视觉上空隙过大"

spacing:                                       # 🔴 视觉估计
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64
  hero: 96                                     # 封面/扉页超大留白

# ── 留白规则 (Fill Rules) ──
# "敢留白" 是这套设计的核心哲学, 但必须设上限, 否则会滑向"大面积空旷".
# 每页都要按照 globalFillRate + bySlideRole + whiteSpaceQuadrants 三层护栏校验.
fillRules:
  globalFillRate:
    target: "55-75%"                           # 🔴 内容占画布面积比例目标区间
    minimum: "45%"                             # 低于此值视为"过度空旷", 必须补内容
    maximum: "85%"                             # 超过此值视为"过度拥挤", 必须减内容
  bySlideRole:
    cover:
      target: "50-65%"
      mustHave: "巨字标题 + 副标题 + 装饰元素三组以上 + 作者信息"
    toc:
      target: "60-75%"
      mustHave: "巨字 CONTENTS + 章节列表 + 顶部说明段落 (≥3 行) 三块共填"
      forbidden: "上半部留白 > 35% 画布面积"
    section-divider:                           # 章节扉页 — 最容易过度空旷的页型
      target: "40-55%"
      mustHave:
        - "章节编号 + 章节名 + 横向声波线 (主轴)"
        - "下方/旁侧 2-3 行章节摘要 (50-80 字)"
        - "底部 3-5 个关键词 pill (小圆角米白描边标签)"
        - "右下竖排年份"
      forbidden:
        - "整页只有一根横线 + 编号 (违背 minimum 45%)"
        - "下半部完全空白"
    content:
      target: "65-80%"
      mustHave: "标题 + 主体 (图/表/列表) + 装饰元素至少 1 组"
    closing:
      target: "55-70%"
      mustHave:
        - "巨字 THANK YOU + 副标题分隔线 + 装饰元素三组以上"
        - "右半部结论摘要卡片 (3-5 条核心结论, 填满右半部分)"
      forbidden:
        - "右上 1/2 完全空白"
        - "只有 THANK YOU + 装饰, 无信息性内容"
  whiteSpaceQuadrants:                         # 四象限留白审计
    rule: "把画布切成 4 个象限, 每个象限至少有 1 个内容元素 (装饰元素也算)"
    purpose: "防止视觉重心严重偏向一角"

rounded:                                       # 🟡 极简风格, 零圆角或微圆角
  none: 0
  sm: 2
  md: 4
  pill: 9999                                   # 仅图标圆形容器使用

imagery:                                       # 🔴 图像使用规范
  treatment: "monochrome"                      # 所有照片统一去饱和为黑白
  mood: "introspective, natural, quiet"        # 自然系 / 安静 / 内省
  subjects:
    - "natural landscapes (mountains, lake, fire, sea)"
    - "single figures in quiet poses"
    - "wide horizons, low key lighting"
  composition: "vertical-crop preferred (3:4 or 2:3 portrait), placed on left third"
  overlay: "无统一蒙层, 直接黑白处理后嵌入背景"
  edge: "硬边矩形, 无羽化无圆角"
  fallbackWhenNoPhoto:                         # 🔴 无真实照片资源时的视觉填充方案
    - "在内容卡片外侧加 2-4 个细线 SVG 几何形 (圆/竖矩形/菱形) 作视觉锚点"
    - "用 surface-muted #D9D6CD 填充的圆形容器 + 米白图标 替代 hero image"
    - "用大号灰阶图表 + 数据标签 占据图片应有位置"
  do:
    - "用黑白照片让画面与橄榄绿背景共振 (低饱和呼应)"
    - "选择留白多、构图简洁的照片"
    - "竖向裁切优先, 与左侧波浪虚线装饰呼应"
  dont:
    - "禁止使用彩色照片 — 会破坏整套色彩协议"
    - "禁止使用高饱和、高对比的现代商业图"
    - "禁止给图片加阴影、发光、模糊滤镜"

# ── 图表规范 (Charts) ──
# 极简单色相哲学下, 数据标签和 palette 灰阶序列是保证可读性的关键,
# 不可以"为极简而极简"删掉这些信息层.
charts:
  philosophy: "data over decoration — 信息密度优先, 但图表仍需符合极简单色相哲学"
  background: "transparent"                    # 必须透明, 让画布橄榄绿主导
  border: "1px solid #FEF9F1 outer container"  # 图表外层卡片必须有米白细描边
  padding: "outer container 16px"
  axisColor: "#FEF9F1"
  axisOpacity: 0.5                             # 🔴 坐标轴线条降低 opacity, 不抢主色
  legendColor: "#FEF9F1"
  dataLabelColor: "#FEF9F1"
  dataLabelEnabled: true                       # 🔴 必须开启 — 单色相风格下标签是可读性关键
  fontSize:
    axis: 11
    legend: 11
    dataLabel: 12
    title: 12
  series:
    palette:                                   # 🔴 多系列调色板 (灰阶单色相, 拉开对比)
      - "#FEF9F1"                              # 主系列 (米白)
      - "#D9D6CD"                              # 次系列 (浅灰米)
      - "#8A8B7E"                              # 三系列 (中度灰)
      - "#3F4138"                              # 四系列 (近黑灰)
      - "#C9C5BB"                              # 五系列 (弱化米白)
    rule: "系列 ≤ 3 时只用前 3 色, 系列 ≥ 4 时按顺序展开, 禁止跳序使用"
  byChartType:
    bar:
      barWidth: "40-50% of slot"
      gridLines: "horizontal only, opacity 0.3"
      dataLabels: "above bar, fontSize 12, color #FEF9F1"
    line:
      strokeWidth: 2
      pointRadius: 4
      pointFill: "#FEF9F1"
    pie:
      donutHole: "55%"                         # 圆环, 中心镂空 55% 留白
      labels: "outside ring with leader lines"
      dataLabelEnabled: true                   # 🔴 强制
      legendPosition: "bottom"
    table:
      headerStyle: "bottom-border 1px #FEF9F1, no fill"
      rowSeparator: "1px solid rgba(254,249,241,0.2)"
      zebraStripe: "rgba(254,249,241,0.04)"
      cellPadding: "12px 0"
      headerFontSize: 11
      cellFontSize: 14                         # 🔴 投屏可读底线
      letterSpacing: "0.04em"
  do:
    - "数据标签必须开启, 让用户不依赖坐标轴也能读数"
    - "多系列时用 palette 灰阶序列, 拉开对比但不引入彩色"
    - "图表外层必须用 1px 米白描边卡片包裹, 与正文卡片形成系统感"
    - "饼图统一用 doughnutChart (中心镂空) 而非 pieChart, 更符合极简硬边气质"
  dont:
    - "禁止使用彩色调色板 (任何 saturation > 20% 的色都不行)"
    - "禁止 3D 图表 / 阴影 / 发光"
    - "禁止把数据标签放在图表外的 caption 区 (用户视线要跨距阅读)"
    - "表格禁止全表实心填充背景 — 只用 header 底边 + 行分隔线 + 微弱斑马"

iconography:                                   # 🔴 图标规范
  style: "thin-stroke line icons, sometimes inside a soft circle"
  strokeWidth: 1.5                             # 🔴 px 级细线
  strokeColor: "#FEF9F1"
  fill: "none"                                 # 默认描边, 极少填充
  cornerRadius: 0                              # 图标本体不带圆角, 常被 pill 圆容器包裹
  container:
    shape: "circle"
    fill: "#D9D6CD"
    diameter: 64
  signature_icons:                             # 反复出现的标志性图标
    - "saturn / planet (右上角作 logo)"
    - "leaf"
    - "umbrella"
    - "heart (outline)"
    - "speech bubble"
  decorative_lines:                            # 装饰线条 (非图标但属于图标语汇)
    - "横向声波线 (spectrum waveform) — 封面/扉页/THANK YOU 共用"
    - "竖向波浪虚线 + 短斜线 (左侧贯穿装饰)"
    - "横向虚点线 (用于章节连接)"
  do:
    - "图标统一描边, 不要混用填充"
    - "图标只用 on-primary (米白) 一种颜色"
    - "圆形容器只用 surface-muted 一种填充"
  dont:
    - "禁止使用彩色图标"
    - "禁止使用 3D / 拟物 / emoji 风格图标"
    - "禁止给图标添加投影或渐变"

layouts:                                       # 🟢 数量 + 🔴 语义
  slideLayoutCount: 3                          # 🟢 from ppt/slideLayouts/
  semantic:
    cover:
      role: "封面 / 项目首页"
      anchors:
        - "巨型 display 标题 (88pt, Light) 左对齐, 占左 2/3"
        - "右上角土星 logo + 右侧波浪声波线"
        - "右下: PPT By / Creator Information"
        - "左下: 竖排年份 + 折线装饰"
    toc:
      role: "目录 / 章节索引"
      anchors:
        - "顶部说明段落 ≥ 3 行 (ABOUT THIS REPORT)"
        - "右侧 Title Summary 01/02/03 列表 + 虚点连接线 + 页码区间"
        - "左下 CONTENTS 巨字超大字号"
        - "右下声波线短版 + 竖排年份"
      forbidden: "上半部留白 > 35%"
    section-divider:
      role: "章节扉页"
      anchors:
        - "左上土星图标 + 章节编号 (01/02...)"
        - "横向声波线 + 章节名 (中英对照)"
        - "CHAPTER SUMMARY 2-3 行章节摘要 (50-80 字中文)"
        - "底部 3-5 个关键词 pill (小圆角米白描边标签)"
        - "右下竖排年份"
      forbidden:
        - "整页只有一根横线 + 编号 (违反 fillRules.section-divider.minimum 45%)"
        - "下半部完全空白"
    content-text:
      role: "纯文字内容页"
      anchors:
        - "左上 title (36-48pt)"
        - "正文段落 (14pt) 下方"
        - "右下年份装饰"
    content-image-text:
      role: "左图右文 / 文字配图"
      anchors:
        - "黑白图片左侧或居中, 竖向裁切优先"
        - "标题在图片上方或图片左上"
        - "正文/列表在图片右侧"
    content-3col:
      role: "三栏并列"
      anchors:
        - "等宽三列, 各列含图片 + 标题 + 简短描述"
    content-data:
      role: "数据展示页"
      anchors:
        - "图标矩阵 / 表格 / 简单图表"
        - "禁止使用彩色填充, 全部走描边或灰阶"
    closing:
      role: "致谢页 — 与 cover 首尾同构"
      anchors:
        - "左下 THANK YOU 巨字 (88-120pt, Light)"
        - "顶部贯穿短声波线"
        - "其他元素与 cover 镜像对应 (土星/声波线/年份/折线)"
        - "右半部结论摘要卡片 (KEY TAKEAWAYS 3-5 条核心结论)"
      forbidden:
        - "右上 1/2 完全空白"
        - "只有 THANK YOU + 装饰, 无信息性内容"

patterns:
  supported:                                   # 🔴 反复出现的视觉构件
    - "🌑 颗粒纹理背景: 整个 deck 都覆盖一层细颗粒/噪点纹理 (grain), 让纯色背景多一点呼吸感. 核心识别特征."
    - "🪐 右上角土星 logo: 几乎每页右上都有一枚细线手绘风土星图标, 作品牌锚点"
    - "🌊 横向声波线 (spectrum waveform): 封面 / 扉页 / 致谢页贯穿出现的声波装饰线, 是首尾同构的关键标志"
    - "📜 反向手写体水印: cursive 草书经垂直翻转作为签名水印, 散布在多页"
    - "📅 右下角竖排年份: 单字符竖向排列, 配折线 / 山形装饰"
    - "🔻 左侧竖向波浪虚线: 大多数内页左侧固定一条竖向虚点波浪 + 短斜线"
    - "🪞 首尾同构: cover 与 closing 共用 88-120pt Light 巨字 + 声波线 + 年份装饰, 视觉对称"
    - "🔢 超大编号: 01/02/03/04 用作章节/列表序号, Light 字重大字号, 不带任何圆框/底色"
    - "🖼 黑白照片为主视觉: 所有图片去饱和, 与橄榄绿背景形成冷峻文艺感"
    - "📏 极简边框卡片: 卡片采用 1px 米白细描边矩形, 零圆角或仅 2-4px 微圆角"
    - "🏷 关键词 pill: 1px 米白细描边矩形标签, 用于章节扉页底部或目录页作索引"
    - "📋 结论摘要卡片: 致谢页右半部 KEY TAKEAWAYS 分条列出, 替代空旷的纯装饰致谢"

  forbidden:                                   # 🔴 与该风格冲突的做法
    - "❌ 任何彩色 accent (蓝/红/橙/绿明亮饱和色) — 该 deck 是单色相系统"
    - "❌ 圆角 > 8px 的卡片 / 按钮 — 破坏极简硬边气质"
    - "❌ 投影 / drop-shadow / 发光效果 — 该 deck 是平面化设计"
    - "❌ 渐变填充 (除非是颗粒纹理本身的微噪点)"
    - "❌ 彩色照片 / 高饱和 illustration"
    - "❌ 商业 / 科技感图标库 (Material / 苹果系填充图标)"
    - "❌ 黑色 (#000) 大面积使用 — 用 primary-darkest #3F4138 替代以保持温润"
    - "❌ 标题用粗体 (Bold/Black) — 该 deck 标题反其道使用 Light + 巨大字号制造反差"
    - "❌ 装饰元素居中放置 — 该 deck 的装饰永远在角落或边缘, 中心留给内容"

motion:                                        # 🟢 原 deck 未声明任何 transition / animation
  defaultTransition: "none"
  recommendedTransition: "fade"                # 🔴 若必须加, 推荐淡入淡出
  forbidden:
    - "wipe / 3D / push — 与极简气质不符"

meta:
  source: "文学社素材010.pptx"                  # 🟢
  sourceFamily: "D8 作品集 PPT 模板系列"        # 🟢
  slideCount: 15                               # 🟢
  detectedRoles:
    cover: 1
    section-divider: 1
    closing: 1
    content: 12
  paletteSize: 3                               # 🟢 XML srgbClr 仅 3 色
  hueDiversity: "single-hue"                   # 🟢 单色相系统

doAndDont:                                     # 🔴 风格红线
  do:
    - "✅ 背景始终使用 #6E7063 橄榄灰绿, 并保留细颗粒纹理 — 这是模板的灵魂"
    - "✅ 文字与装饰统一使用 #FEF9F1 暖米白 — 不要用纯白 #FFFFFF (会显得太冷硬)"
    - "✅ 标题用等线 Light + 巨大字号制造反差 (88-120pt 封面/致谢, 36-48pt 内页)"
    - "✅ 正文压到 14pt 配 1.7 行距 — 该 deck 偏好'巨标题 + 小密正文'反差"
    - "✅ 图片统一去饱和为黑白, 竖向裁切优先"
    - "✅ 装饰元素 (土星 / 声波线 / 波浪虚线 / 竖排年份) 至少出现 1 个在每页, 但永远在角落"
    - "✅ 首尾同构: 封面与致谢页保持 88-120pt 巨字 + 声波线 + 年份装饰对称"
    - "✅ 编号 (01/02/03) 用 Light 字重 + 36pt+, 不加任何容器"
    - "✅ 章节扉页要敢留白 — 但填充率不低于 45%, 必须有章节摘要 + 关键词 pill"
    - "✅ 大数字 (KPI) 采用三段式竖排: 数字 → 单位+英文标签 → 中文描述, alignItems: flex-start"
    - "✅ 图表必须开启数据标签, 多系列用灰阶 palette (米白/muted/中灰/近黑灰)"
    - "✅ 图表外层用 1px 米白描边卡片包裹, 与正文卡片系统统一"
    - "✅ 致谢页右半部分必须有'结论摘要'卡片 (KEY TAKEAWAYS), 不能只有 THANK YOU 孤字"
    - "✅ 目录页顶部说明段落 ≥ 3 行, 上下密度需均衡 (上半留白 ≤ 35%)"
    - "✅ 四象限规则: 把画布切 4 块, 每块至少 1 个元素 (装饰元素也算)"
  dont:
    - "❌ 不要把背景换成纯白 / 浅灰 — 直接破坏整套设计契约"
    - "❌ 不要在标题用 Bold / Black 字重 — 与 Light 反差哲学冲突"
    - "❌ 不要使用彩色 accent — 哪怕是品牌色, 该 deck 是严格单色相"
    - "❌ 不要给元素加投影 / 圆角 > 8px / 渐变"
    - "❌ 不要使用彩色或高饱和插画 / 图标"
    - "❌ 不要让装饰线条进入版心中央 — 装饰永远靠边"
    - "❌ 不要省略颗粒纹理 — 没有颗粒就只剩'死板灰绿', 失去该模板的文艺感"
    - "❌ 不要混用其他字体家族 — 等线系列 + 一种手写体足矣"
    - "❌ 大数字禁止 alignItems: 'baseline' 三段行内 — 中英基线不一致会错位"
    - "❌ 章节扉页禁止'整页只有一根横线 + 编号' — 填充率底线 45%"
    - "❌ 致谢页禁止右上 1/2 完全空白, 必须有 KEY TAKEAWAYS 卡片"
    - "❌ 表格 cellFontSize 禁止 < 13pt — 投屏不可读"
    - "❌ 图表禁止省略数据标签 — 单色相下没标签无法辨识"
---

# 设计契约说明 (供下游 Agent / 设计师参考)

## 一、整体气质定位

**"安静、克制、自然系、文艺。"**
这套设计是一份典型的**艺术作品集 / 创意求职 / 文学社风格**模板, 走的是与"科技感蓝白""商务正红"完全不同的路线 ——
它的灵魂是**橄榄灰绿背景 + 暖米白文字 + 黑白摄影 + 颗粒纹理**, 营造一种"翻一本独立杂志"的阅读体验.

## 二、关键色彩决策

- 真正的视觉主色是 `#6E7063` 橄榄灰绿 (整版背景), 像素采样验证背景在 `#5D5F52~#797B6E` 区间波动 (颗粒噪点导致).
- `#FEF9F1` 暖米白是**前景文字与装饰色** (`on-primary` / `surface`), **不是主色**.
- 这套设计是**单色相** (single-hue) 系统, 没有彩色 accent; `accent-muted` 与 `accent-deep` 是灰阶弱强调, 用于区分图表系列或对比组, 不是色相。

## 三、字体哲学

等线 Light 字重 300, 该 deck 的核心反差哲学是 **"Light 字重 + 巨大字号"**:
- 88-120pt 封面/致谢页巨字
- 36-48pt 内页标题
- 14pt 小密正文 + 1.7 行距

下游 Agent 在生成同风格时务必遵守此反差, 不要把标题加粗.

## 四、首尾同构 (Bookend Symmetry)

封面 (cover) 与致谢页 (closing) 共用同一布局骨架:
- **左下/左中**: 88-120pt Light 巨字 (主标题 ↔ THANK YOU)
- **右上**: 土星 logo
- **横贯**: 声波线 (waveform) 装饰
- **右下**: 竖排年份 + 折线装饰
- **致谢页右半部**: 必须有 KEY TAKEAWAYS 结论摘要卡片, 不可空旷

这是该模板的**核心识别特征**, 复用此模板生成新 deck 时必须保留.

## 五、装饰元素清单 (复用时保留)

| 元素 | 出现位置 | 含义 |
|---|---|---|
| 🪐 土星 logo (细线) | 右上角, 几乎每页 | 品牌锚点 |
| 🌊 声波线 / 频谱线 | cover / section-divider / closing | 章节信号 |
| 〰️ 竖向波浪虚线 + 斜线 | 左侧, 大多数内页 | 节奏装饰 |
| 📜 反向手写体水印 | 角落水印 | 作者签名 |
| 📅 竖排年份 | 右下角 | 时间锚点 |
| 🔻 折线/山形装饰 | 与年份配对 | 视觉点缀 |
| 🏷 关键词 pill | 章节扉页底部 / 目录右侧 | 章节索引 |
| 📋 KEY TAKEAWAYS 卡片 | 致谢页右半 | 结论摘要 |

## 六、与 PPT DESIGN.md 规范的关系

- 本契约属于 **L3 模板级 (template-level)**
- 不输出 `family` / `extends` (需用户在自己的 family 体系里手工挂载)
- 该风格特征接近一个"**formal-quiet / editorial / portfolio**"风格族
- 本契约**不包含 narrative.md** (叙事节奏属于独立体系)

## 七、置信度审计线索

- 🟢 高置信度 (XML 直读): canvas / fonts / fontSizes / colors XML 频次 / slideLayout 数量
- 🟡 中置信度 (像素采样估计): safeArea / surface-muted / on-surface-secondary / 颗粒纹理位置
- 🔴 推断值 (Claude 看缩略图归纳): primary 判定 / fontWeight 判定 / imagery / iconography / patterns / layouts 语义 / doAndDont / fillRules / bigNumber / charts

🟡🔴 字段是诚实标注的审计线索, 下游 Agent 与设计师可参考可信来源, 但**字段值已自动填好**, 无需用户额外确认即可使用.
