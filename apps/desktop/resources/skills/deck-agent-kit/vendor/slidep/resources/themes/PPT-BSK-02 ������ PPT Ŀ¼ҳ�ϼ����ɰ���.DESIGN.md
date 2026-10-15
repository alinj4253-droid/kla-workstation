---
version: "0.1"
name: "PPT-BSK-02 工作型 PPT 目录页合集·松柏绿"
description: "一套以松柏绿为主色、聚焦'目录/导航页'的 100 页工作型 PPT 样板合集, 用于汇报/述职/年终总结等正式工作场景下快速挑选目录版式."
audience: "企事业单位、政府机构、公司中层及以上的工作型汇报场景——年度总结、述职、项目复盘. 受众为上级领导、评审、同事, 看的是'结构感'而不是'视觉创意'."     # 🔴 基于封面副标题"工作型 PPT 目录"与 21 张章节扉页 + 大量"工作回顾/经验总结/问题复盘/下步打算"语料归纳
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
  printSafe: false                         # 🔴 默认值 (投影优先, 非打印优先)

# grid 未在原 deck 中显式声明, 以下为视觉估计           # 🟡
grid:
  columns: 12
  gutter: 16
  margin: 32
  baseline: 8

colors:
  # ── 主色系 (松柏绿, HSV 主色相桶 H≈150-165°) ──
  primary: "#37A783"          # 🟡 pixel-sampled (17x) — 标准松柏绿, 用于主块/高亮
  primary-deep: "#2B9D74"          # 🟡 pixel-sampled (19x) — 渐变深端 / 强调
  primary-darkest: "#1D9970"          # 🟡 pixel-sampled (76x) — 深绿, 装饰带与深底

  # ── 强调色 (原 deck 为单色相体系, 不设 accent, 避免破坏统一感) ──
  # accent: 未检测到与主色相距 ≥ 90° 的次要色相桶 — 本系统以单色相渐变 + 明度分层建立层级, 不引入 accent

  # ── 中性色 ──
  surface: "#FFFFFF"                       # 🟡 主背景
  surface-muted: "#F5F5F8"                 # 🟡 次级卡片底
  surface-tint: "#EAF6EF"                  # 🟡 极浅绿底 (卡片悬浮 / 分段背景), pixel-sampled
  on-surface: "#000000"                    # 🟢 XML srgbClr (避免纯黑可下沉到 #1A1A1A)
  on-surface-secondary: "#6C7278"          # 🟡 次级正文/小标题
  on-primary: "#FFFFFF"                    # 🟢 深绿底上白字, 占观察样本绝大多数

typography:
  # 主字体: 思源黑体 CN Light → fallback chain: cjk-sans-modern     # 🟢
  # 正文字体: 思源黑体 CN Light → fallback chain: cjk-sans-modern   # 🟢
  display:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 700                        # 🟢
    fontSize: 138                          # 🟢 封面大字 "100" 实测 (原始 XML 有 287/496pt 极端值系 PPT 缩放容器, 投影参考值采 138pt)
    lineHeight: 1.1                        # 🟡
    minProjectedSize: 96                   # 🔴 规范底线
  title:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 700
    fontSize: 54                          # 🟢 目录主标题字号上限 (如大号"目 录")
    lineHeight: 1.2
    minProjectedSize: 32
  subtitle:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 700
    fontSize: 32                          # 🟢 目录条目主文字 (岗位经历/工作成效 等)
    lineHeight: 1.3
    minProjectedSize: 24
  body:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 18                          # 🟢 基准字号 (出现 3015 次, 绝对主导)
    lineHeight: 1.5
    minProjectedSize: 16                   # 🔴 规范底线
  body-small:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 16                          # 🟢 英文对照 (CONTENTS / Project Introduction)
    lineHeight: 1.4
  caption:
    fontFamily: '"思源黑体 CN Light", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, -apple-system, sans-serif'
    fontWeight: 500
    fontSize: 12                           # 🟢 页脚 / 极小补充
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
  lg: 16
  pill: 9999

imagery:
  style: "自然实拍 (山水 / 田园 / 风车 / 城市天际线) + 少量办公场景黑白片 (手持钢笔书写) + 少量插画/合成蒙层"  # 🔴
  treatment: "几乎全部叠加松柏绿半透明渐变蒙层, 使异色原图收敛到绿色系, 确保与主色统一"
  cornerRadius: 0                          # 实拍背景图不切圆角 (贴边/贴条)
  aspectRatio:
    banner: "16:3"                         # 顶部装饰带/横幅
    full: "16:9"                           # 整屏背景图
    sideStrip: "1:4"                       # 左右侧竖向图片条
  usage:
    - "顶部横幅 banner (1/3 ~ 1/2 高度), 与下方白/浅绿卡片区形成上下分层"
    - "左/右竖向条带, 与正文区并列 (约 1/4 宽度)"
    - "全屏背景 + 下方白色或浅绿卡片悬浮 (最常见)"
  doNotUse:
    - "❌ 不使用未叠绿色蒙层的原色实拍图 — 会破坏松柏绿主色系的统一"
    - "❌ 不使用暖色主导的图 (橙/红/黄大面积) — 除非已压成黑白"
    - "❌ 不使用人物特写/肖像大图 — 本系统强调'结构感'而非'人'"

iconography:
  style: "面性填充 + 圆角矩形/圆形底座 (通常是白底圆形 + 绿色线性图标)"  # 🔴
  metaphors:
    - "团队 — 三人剪影"
    - "工具 — 扳手"
    - "项目 — 讲台/展板"
    - "列表规划 — 菜单"
    - "增长 — 折线柱图"
  color: "图标主体取 primary-deep (#2B9D74), 底座用 surface (#FFFFFF) 或 primary (#37A783) 渐变"
  size: "对角约 40-56pt, 置于卡片上半区中央"
  doNotUse:
    - "❌ 不用彩色品牌图标 (破坏单色相)"
    - "❌ 不用超写实 3D 图标 (与扁平/半扁平卡片语言不搭)"
    - "❌ 不用线性细描 1px 图标 — 本系统偏好略厚的面性轮廓以保投影可读"

layouts:
  toc-card-grid:
    structure: |
      - 左侧竖向深绿大色块 (约占宽度 1/4 ~ 1/3), 内嵌大号 "目 录 / CONTENTS"
      - 右侧 3-6 个并列卡片, 每张含: 图标 / 序号 (01-05) / 中文条目标题 / 英文对照
      - 卡片顶部图标区 + 底部标题区明暗分层 (渐变绿 → 白)
    requiredFields: [tocTitle, items]
    itemSchema: [index, icon?, titleCn, titleEn?]
    bodyMaxItems: 6
    behaviorRule: "卡片数量 3-6 为宜; 超过 6 条, 应改用 toc-list-vertical 或 toc-numbered-horizontal"
    rationale: "并列卡片适合'平级章节'的视觉表达, 是本合集最核心的版式"

  toc-numbered-horizontal:
    structure: |
      - 顶部 (或居中) 大号 "目 录 / CONTENTS" 标识
      - 下方横向 4 条并列: Part.01-04 + 中文短标题 (+ 可选一行副问句, 如 "做了什么?")
      - 每条用大号数字 (01/02/03/04) 作视觉锚点, 常加短横线 / 斜分隔符
      - 数字可位于条目上方 (Part.01 形式) 或下方水印
    requiredFields: [items]
    itemSchema: [partNumber, titleCn, subtitleZh?]
    bodyMaxItems: 5
    behaviorRule: "偶数条目优先 (4 条) — 视觉对称是该版式的灵魂"
    rationale: "工作型 PPT 的经典四段式 (回顾 / 成效 / 能力 / 规划), 对齐中国机构汇报结构惯例"

  toc-banner-split:
    structure: |
      - 顶部整幅自然风景照 (叠绿色蒙层), 约占 1/3 ~ 1/2 高度
      - 底部白底或浅绿底 (surface-tint) 区, 承载目录条目
      - 顶部照片与底部正文之间常有一条深绿实色分隔带 + 居中 "目 录 CONTENTS"
    requiredFields: [bannerImage, items]
    itemSchema: [partNumber, titleCn, bullets?]
    bodyMaxItems: 4
    rationale: "上下分层 — 顶部营造氛围/品牌感, 底部保持信息密度, 适合外部汇报开篇"

  toc-dial-row:
    structure: |
      - 顶部 "目 录 / CONTENTS" 标识带 (居中或靠左)
      - 下方一条基线 + 4-5 个圆形/水滴形节点, 节点内嵌序号 (数字或 '壹贰叁肆')
      - 节点下/旁挂条目标题 (时间轴/流程感)
      - 常见交替上下错位排列 (壹在下, 贰在上, 叉在下 ...)
    requiredFields: [items]
    itemSchema: [index, titleCn]
    bodyMaxItems: 5
    rationale: "借'时间轴/流程'的隐喻, 暗示四个板块之间有先后顺序或逻辑递进"

  toc-overlap-layered:
    structure: |
      - 左侧深绿实色大色块 + 大号"目 录"
      - 右侧多个半透明白卡片前后错位叠放 (2-4 层), 每层一条章节
      - 卡片透明度 / 阴影做出景深, 营造'层层展开'感
    requiredFields: [items]
    itemSchema: [index, titleCn]
    bodyMaxItems: 4
    rationale: "本合集中的'设计表达感更强'的分支, 用于外部路演或品牌色更重的场合"

  toc-number-watermark:
    structure: |
      - 主画面只有 3-4 个超大字号数字 (01/02/03/04) 作水印底色
      - 数字前/下方叠一行中文短标题 + 一行副问句
      - 背景通常为浅绿渐变 (surface-tint → surface), 底部常压一条深绿实色基线
    requiredFields: [items]
    itemSchema: [index, titleCn, subtitle?]
    bodyMaxItems: 4
    rationale: "极简取向分支, 极度削弱装饰, 靠字号对比与留白建立层级"

  cover:
    structure: |
      - 整屏深绿渐变背景 + 下半部 PPT 缩略图阵列 (作为合集展示)
      - 中央超大字号 "100" + "页" + 副标题 "工作型 PPT 目录"
      - 下方胶囊条一句 slogan ("目录简洁而清晰")
    requiredFields: [mainNumber, unit, subtitle, slogan]
    note: "这是合集封面, 单页使用场景下一般不会被复用; 其余 101 页才是真正的'目录版式样板'"

patterns:
  decorations:
    gradientBlock:
      description: "左/右或顶部的深绿实色大色块 (常带渐变 primary-darkest → primary), 是最高频装饰"
      usage: "toc-card-grid / toc-overlap-layered / toc-banner-split 的主锚"
    topBanner:
      description: "顶部 1/3 高度的自然风景带 (必叠绿色蒙层)"
      usage: "toc-banner-split 的核心元素"
    bottomBar:
      description: "底部细实色带 (深绿 #1D9970), 横贯整页, 作为收尾"
      usage: "大多数版式都以一条底部色带收口, 维持'画框感'"
    dottedLine:
      description: "虚线分隔 (纵向/横向, 常见 1px #2B9D74 dashed)"
      usage: "toc-numbered-horizontal 的条目间分隔 / toc-dial-row 的基线"
    chineseNumeral:
      description: "壹贰叁肆 (毛笔感字号大号水印)"
      usage: "toc-dial-row 变体, 带中式仪式感"
    cornerStamp:
      description: "右上角小号 logo / 水印 ('PP 90 TER' 等)"
      usage: "少量页面的品牌落款, 不强制"
  supported:
    - toc-card-grid
    - toc-numbered-horizontal
    - toc-banner-split
    - toc-dial-row
    - toc-overlap-layered
    - toc-number-watermark
    - cover

motion:
  enabled: false                           # 🟢 未在 XML 中检测到动画声明
  fallback:
    allowedTransitions: ["none", "fade"]
    maxDurationMs: 300
  rationale: "工作型汇报场景下, 观众注意力应集中在内容结构, 而非过场特效"

meta:
  source: "PPT-BSK-02@工作型PPT目录页-松柏绿（100页）.pptx"     # 🟢
  totalSlides: 102                         # 🟢 measurements.slide_fingerprints
  layoutCount: 3                           # 🟢 slideLayouts/*.xml (仅 PPT 母版层)
  contentLayoutCount: 7                    # 🔴 本 DESIGN.md 归纳出的语义版式数
  sectionCount: 101                        # 🔴 除 slide1 封面外, 每张都是一个目录版式独立样板
  collection: true                         # 🔴 这是目录版式合集, 不是一次完整汇报
  theme: "松柏绿 / pine-cedar-green"
  brandMark: null                          # 未检测到统一落款 (个别页面有"PP 90 TER"水印, 非全局)
  watermark: null

doAndDont:
  do:
    - "✅ 整套只用松柏绿单色相 + 白/浅灰中性色, 通过明度与渐变分层建立视觉层级"
    - "✅ 条目数量控制在 3-6 个 (以 4 最经典), 保持'四段式'工作汇报节律"
    - "✅ 所有实拍背景图必须叠松柏绿半透明蒙层, 使其与主色收敛"
    - "✅ 序号 (01/02 或 Part.01) 应作为强视觉锚点, 与条目标题保持固定的相对关系"
    - "✅ 英文对照 (CONTENTS / Project Introduction) 字号小于中文, 灰度降级, 只作辅助"
    - "✅ 正文基准 18pt, 不低于 16pt 的投影底线"
  dont:
    - "❌ 不要引入第二个色相 (蓝/红/橙) — 这是单色相体系, 破坏等于换皮肤"
    - "❌ 不要放未叠蒙层的原色实拍图 (尤其暖色系照片)"
    - "❌ 不要把条目数量扩到 7 条以上 — 超过即应换表格或改版式"
    - "❌ 不要用 3D / 彩色品牌图标, 与扁平单色语言不搭"
    - "❌ 不要为目录页添加入场动画 — 该系列强调结构感, 动效会削弱权威感"
    - "❌ 不要删除底部收口色带 — 缺失会让画面失去'画框感'"
---

## Overview

本模板编码了一套**中国工作型汇报**场景下的**目录页视觉语言**——所谓"松柏绿"体系. 它不是一份完整汇报 deck, 而是一份**100 页目录版式合集样板**: 封面之外, 几乎每张 slide 都是一个独立的目录页变体, 供挑选/复用.

这套美学的核心特质是**单色相主导、结构优先、克制装饰**. 与西式路演 deck 追求封面-章节-内容-致谢的完整叙事闭环不同, 本合集只解决一个问题——**"如何把 3-6 条章节排布成一张既正式又不呆板的目录页"**. 因此它没有 cover 之外的叙事节奏 (narrative), 只有版式图谱 (layout catalog).

观察到的视觉共性: 松柏绿 (#37A783 / #2B9D74 / #1D9970) 以**渐变明度分层**承担几乎全部色彩信息 — 没有 accent, 没有第二色相; 自然风景图一律叠绿色蒙层; 字体统一为思源黑体 CN Light; 序号 (01/02 或 Part.01) 被反复复用为视觉锚点.

## Audience & Context

- **谁看**: 上级领导 / 评审专家 / 公司同事 / 政府对接人——会议室场景的正式受众.
- **在哪看**: 投影 + 笔记本屏幕双模式. 少量场景可能需要打印归档, 但非主目标.
- **看多久**: 目录页本身停留 10-30 秒, 是"章节之间的呼吸点", 不承担核心信息.
- **物理约束**: 最小投影字号 16pt; 单色相须在不同投影色温下可识别 (所以用明度分层而非色相分层).

## Canvas & Grid

16:9 960×540pt 是 PPT 投影的标准规格, 本合集不挑战默认画布. 安全区 top:24 / left:32 / right:32 / bottom:32 稍窄于常规, 是因为目录页常用整幅 banner 压顶 + 深绿侧块贴边, 故意把内容贴近边缘来制造"画框感".

栅格**参考而非严格**: 观察到的排版没有一套能套用所有版式的 12 列网格——toc-dial-row 是等分圆点基线, toc-number-watermark 完全是大字号自由分布. YAML 给出 12 列仅作为生成新页时的起步参考, 不建议反向约束现有版式.

## Colors

视觉权重比例约为 **主色 55% / 中性 40% / 强调 5%** — 其中"强调 5%"也由主色最深阶 (primary-darkest) 承担, 实质为**单色相体系**. 没有 accent 是有意的: 一旦引入互补色相, 整套'稳重职场绿'的气质会被打破.

松柏绿来自中式工作汇报的经典语境——稳定、可靠、不张扬, 与"政府绿/体制蓝"同属官方色系但更亲和. 具体三阶 `primary (#37A783) / primary-deep (#2B9D74) / primary-darkest (#1D9970)` 的选择覆盖了亮 (前景卡片)、中 (主块)、深 (装饰带/侧块) 三档明度, 在投影下仍能拉开层级.

中性色 `surface-tint (#EAF6EF)` 是本系统的隐藏英雄——它是白与松柏绿之间的过渡, 用于卡片悬浮底与分段背景, 让版式"有明度分层但不跳色". 文字默认 `#000000` 配白底, 投射时若发虚可降到 #1A1A1A.

## Typography

本系统是**单字体家族系统**——**思源黑体 CN Light**——通过**字号与字重**建立层级. 选 Light 而非 Regular 是全合集刻意的选择: 在松柏绿大色块背景下, Light 字重的中文既保留黑体的端正感, 又避免过"实"带来的压迫.

基准字号 **18pt** 远高于平台下限 (16pt), 且在全 deck 出现 3015 次, 是这套系统的呼吸节拍. 题注 / 条目主标使用 32pt、54pt 两档拉开结构感; 封面 "100" 的超大字号 (138pt 投影参考) 完全是视觉符号, 不是可读文本.

一张典型目录页同时出现 **3-4 个字号层级** (大标题 + 序号 + 条目中文 + 英文对照/副问句), 层级数是克制的. 这与基准字号稳定、装饰克制一起, 构成了"看着简单却不单调"的体感.

## Layouts

7 个版式构成结构核心: `cover` / `toc-card-grid` / `toc-numbered-horizontal` / `toc-banner-split` / `toc-dial-row` / `toc-overlap-layered` / `toc-number-watermark`.

- **toc-card-grid**: 最高频, 并列卡片 (3-6 张) + 左侧深绿标识块, 用于表达'平级章节'.
- **toc-numbered-horizontal**: 四段式横排 (Part.01-04), 对齐中国工作汇报的经典四段节奏 (回顾/成效/能力/规划), 是本合集的**灵魂版式**.
- **toc-banner-split**: 顶部风景带 + 下方目录区, 两段结构营造开篇仪式感.
- **toc-dial-row**: 时间轴/节点式, 暗示章节间有递进关系.
- **toc-overlap-layered**: 层叠卡片, 装饰感最重, 偏向外部汇报 / 路演.
- **toc-number-watermark**: 大数字水印 + 短标题, 极简分支.
- **cover**: 仅限合集封面页, 不建议单独复用.

**各版式不可混用**: 同一份汇报建议只选一种目录版式, 保持"可预期感".

## Imagery & Icons

本系统中的图像发挥**氛围过渡**功能, 而非信息承载——自然风景 (田园/山水/风车) 被压进绿色蒙层后, 退化为"色块 + 肌理", 与顶部深绿色块一起构成 banner. **图像不是主角**: 真正承担信息的永远是下方的卡片/条目. 少量办公场景黑白照 (手持钢笔) 用于侧边竖条, 其作用同样是'氛围' + 人文气息.

图标系统是**极简面性**. 只在 toc-card-grid 版式中出现, 以白底圆形 + 绿色线性图标为主, 对角 40-56pt. 图标符号语汇围绕**'团队 / 项目 / 工具 / 规划 / 数据'**五个工作类隐喻, 不引入品牌/行业特定图标, 保证合集的通用性.

## Do's and Don'ts

完整规则见 YAML 中的 `doAndDont`. 需要深入理解的核心护栏:

- **单色相不可破** —— 引入 accent 会彻底破坏本系统的松柏绿气质, 等于换皮肤而非微调.
- **图片必叠绿色蒙层** —— 原色实拍图 (尤其暖色系) 会让 banner 变成视觉噪音.
- **条目数 3-6 条** —— 超过 6 条应改用表格或分拆多页, 否则字号会压到 16pt 以下, 投影不可读.
- **序号锚点固定** —— 01/02 或 Part.01 在每个版式里都是主视觉锚点, 不能被装饰元素盖过.
- **不要加入场动画** —— 目录页的作用是"停顿+结构", 动效会让这个停顿变得轻浮.
- **底部色带必须保留** —— 这是本系统的"画框"闭合符号, 缺失会让整页失去仪式感.
