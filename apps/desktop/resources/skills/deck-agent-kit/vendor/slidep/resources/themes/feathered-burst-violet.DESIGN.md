---
version: "0.1"
name: "feathered-burst-violet"
description: "Black-cover 16:9 portfolio template with feathered/exploded abstract spheres in violet–cyan gradient. Uses huge serif-leaning numerals on transition slides, black-on-white minimal text pages with one off-canvas burst image as accent, and wide letter-spacing English subheads. Aesthetic = creative-portfolio · ethereal · sci-fi-organic."
audience: "面向需要呈现『创意作品集 / 艺术随笔 / 视觉年鉴』的个人创作者；高级感与意象感优先于信息密度，以图像气场带动文字。"
locale: "zh-CN"

canvas:
  aspectRatio: "16:9"           # 实测
  width: 960.0                  # 实测
  height: 540.0                 # 实测
  safeArea:                     # 视觉估计
    top: 32
    right: 56
    bottom: 32
    left: 56
  printSafe: false              # 推断（屏幕呈现优先，黑底封面不适合印刷）

grid:                           # 视觉估计
  columns: 12
  gutter: 16
  margin: 56
  baseline: 8

colors:
  # ── 主色系 (深紫近黑，封面与正文标题主体) ──
  primary: "#151540"            # 实测，标题主用色
  primary-deep: "#0A0A1F"       # 推断，封面/尾页底纹
  primary-darkest: "#000000"    # 实测，封面纯黑底

  # ── 强调色 (爆炸图自带的青蓝高光) ──
  accent: "#3CC4D9"             # 视觉估计，对球体高光的归一化

  # ── 中性色 ──
  surface: "#FFFFFF"            # 视觉估计，正文页底色
  surface-muted: "#F5F5F8"      # 视觉估计
  on-surface: "#1F1F2E"         # 视觉估计，正文文字（避免纯黑增加文学感）
  on-surface-secondary: "#6C7278"   # 视觉估计，副文/说明
  on-primary: "#FFFFFF"         # 推断，黑底配白字

typography:
  display:
    fontFamily: '"Playfair Display", "Source Han Serif SC", "Songti SC", "PingFang SC", "Microsoft YaHei", serif'
    fontWeight: 700             # 实测 Bold
    fontSize: 230               # 实测，章节扉页大数字
    lineHeight: 1.0
    minProjectedSize: 200       # 规范底线
  title:
    fontFamily: '"Playfair Display", "Source Han Serif SC", "Songti SC", "PingFang SC", "Microsoft YaHei", serif'
    fontWeight: 700
    fontSize: 46                # 实测，正文页主标题
    lineHeight: 1.2
    minProjectedSize: 32
  body:
    fontFamily: '"Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 24                # 实测，主体字号
    lineHeight: 1.6
    minProjectedSize: 18
  body-small:
    fontFamily: '"Source Han Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
    fontWeight: 400
    fontSize: 18                # 实测
    lineHeight: 1.5
  caption:
    fontFamily: '"Inter", "Source Han Sans SC", "PingFang SC", system-ui, sans-serif'
    fontWeight: 400
    fontSize: 14                # 实测
    lineHeight: 1.4
    letterSpacing: "0.18em"     # 视觉估计，封面英文副标的稀疏字距

spacing:                        # 视觉估计，按 8 基线归纳
  xs: 4
  sm: 8
  md: 16
  lg: 32
  xl: 56
  xxl: 96

rounded:                        # 视觉估计
  none: 0
  sm: 4
  md: 8
  pill: 9999

imagery:
  style: "abstract feathered-burst sphere（羽毛爆炸式抽象球体） — 高密度毛刺、放射状层片、明暗反差强烈，呈现『冻结的爆炸』瞬间"
  treatment: "single-subject 单主体居中或偏置 — 不允许把多张爆炸图拼贴到同一页"
  cornerRadius: 0
  aspectRatio: "free-form-mask（轮廓本身即遮罩，无外框）"
  paletteFamilies:
    - violet-cyan: "封面/章节扉页主用 — 蓝紫青三色融合"
    - mauve-grey: "随笔类内容页右上点缀 — 暖灰玫瑰"
    - ember-red: "强情绪页 — 玫红/橙红主导"
    - jade-amber: "自然/田园页 — 翠绿琥珀"
  usage:
    - "封面：占满整个画面或居中作球体"
    - "章节扉页：主导整页 ≥ 60% 宽，与大数字咬合"
    - "内容页：从右上或左下『出血』半截，仅做画面气场，不传达内容"
    - "尾页：与封面同构，做同一抽象主体"
  doNotUse:
    - "禁止用真人摄影或实物图替换爆炸图（破坏视觉签名）"
    - "禁止用纯渐变色块占位 — 必须是有结构有毛刺的羽毛抽象图"
    - "禁止把爆炸图加圆角或框架（其轮廓本身就是装饰）"
    - "禁止两张爆炸图同框拼贴"

iconography:
  style: "thin-line outline（细线图标） — 1.5px 描边，圆头端点，无填充"
  metaphors: ["check / chevron / quote / play / star / diamond / chat-bubble"]
  color: "primary（#151540）描边色，与主标题同色系"
  size: "24px / 32px / 48px 三档"
  doNotUse:
    - "禁止使用面性图标或彩色品牌图标"
    - "禁止图标内填充与背景产生第二色块"

layouts:
  cover:
    structure: |
      - 整页深紫近黑底 (primary-darkest #000)
      - 居中悬浮一颗超大羽毛爆炸球体（violet-cyan 系），占画面高度 ≈ 90%
      - 球体上方居中叠印中文巨字主标题（白色，serif，字号 ≈ 96px，字距收紧）
      - 球体下方一行稀疏字距英文副标（letterSpacing ≈ 0.18em，opacity 0.85）
    requiredFields: [mainTitle, subtitleEn]
    rationale: "黑底+发光球体的组合是该模板的视觉身份证，封面与尾页必须共享此结构以建立首尾闭环"

  section-divider:
    structure: |
      - 整页白底
      - 左半区：超大数字 1/2/3/4（display 字号 230，semi-transparent 白色或灰白），与左侧出血的紫色羽毛球体重叠咬合
      - 右半区：英文 'TRANSITION SLIDE' 主标题 (primary 色，46pt) + 一行细体英文描述 (caption 14pt)
    requiredFields: [sectionNumber, sectionTitle, sectionDesc]
    behaviorRule: "数字与球体必须有部分重叠 — 这是该版式的灵魂；纯左右分栏会失去意境"
    rationale: "巨大的数字+爆炸图是章节切换的仪式感来源"

  content-default:
    structure: |
      - 整页白底
      - 左上角：title 主标题（primary 色，46pt，serif，可换行至两行）
      - 标题下方：1-3 列正文（body 24pt，每列 ≤ 60 字符，列间距 32px）
      - 右上角『出血』半截爆炸球体（仅露 30-40% 宽），与正文不重叠
    requiredFields: [title, columns]
    bodyMaxItems: 3
    rule: "正文与右上爆炸图严格不重叠 — 不能让图压住任何文字行"
    densityNote: "若超过 3 列改用其它版式"

  big-number:
    structure: |
      - 白底
      - 中央『大数字 + 单位』：圆形白底+灰描边，内置数字 (display 96pt) 与单位 (caption)
      - 圆环周围让爆炸图作环抱（左上+右下双向出血）
    requiredFields: [bigNumber, label]
    rationale: "数据感单页，让数字成为图像的眼睛"

  quote:
    structure: |
      - 白底 + 整页中心一颗 violet-cyan / ember 系爆炸球体（占 60% 宽，居中或微偏左）
      - 球体上叠印一段大引言（white，serif，36pt，单引号开头如 “）
      - 引言下方一行作者署名（caption，opacity 0.7）
    requiredFields: [quoteText, attribution]
    rationale: "引言页是文学社作品集的情绪高点，让爆炸图与引言互相映衬"

  full-image:
    structure: |
      - 整页爆炸图出血占满画布
      - 左下角小卡片：白色半透明描边框 + 一行白色 title + 一行说明
    requiredFields: [imageId, caption]
    rationale: "图为主、字为辅 — 让某些章节有『图像独白』的瞬间"

  features-grid:
    structure: |
      - 白底
      - 顶部 title 居中或偏左
      - 中部 3-6 个并排卡片：每卡含一个 icon（线性，primary 色） + 小标题 + 1-2 行描述
      - 卡片之间留宽间距，icon 不嵌入色块，呈悬浮感
    requiredFields: [title, items]
    bodyMaxItems: 6

  ending:
    inheritsFrom: cover
    structure: |
      - 与封面同构：整页爆炸图 + 中央巨字（"THANKS" / "感谢观看"）
      - 主标题下方可加 caption 副标 (英文谚语)
      - 可选：底部小行 "GET STARTED" 按钮线框
    requiredFields: [closingTitle]
    rationale: "首尾同构带来仪式感闭环，是该模板的庄重感来源"

patterns:
  decorations:
    burstImage:
      where: "封面 / 章节扉页 / 引言页 / 内容页右上 / 尾页"
      role: "视觉灵魂，所有页都至少有一颗，但用法不同（出血、咬合、点缀）"
      constraint: "整 deck 必须出现至少 4 种色相变体（violet-cyan / mauve-grey / ember-red / jade-amber），制造章节差异"
    bigNumeral:
      where: "section-divider / big-number"
      role: "巨型数字作为视觉锚，与爆炸图构成对位"
      constraint: "字号 ≥ 200pt；不能与正文同时使用大数字"
    letterSpacedSubhead:
      where: "封面 / 尾页 / 章节扉页底部"
      role: "稀疏字距英文副标传达高级感，letterSpacing 0.15-0.20em"
      constraint: "仅用于英文，避免中文宽距"
  supported:
    - cover
    - section-divider
    - content-default
    - big-number
    - quote
    - full-image
    - features-grid
    - ending

motion:
  enabled: false                # 实测，原 deck XML 未声明动画
  fallback:
    transitions: ["fade"]
    maxDurationMs: 400

meta:
  source: "文学社素材022.pptx (22 slides)"   # 实测
  totalSlides: 22                            # 实测
  layoutCount: 19                            # 实测，但本模板归纳为 8 个语义版式
  sectionCount: 4                            # 推断，4 个 transition slide 暗示 4 章
  sectionMap:                                # 推断
    - id: ch01
      name: "第一章"
    - id: ch02
      name: "第二章"
    - id: ch03
      name: "第三章"
    - id: ch04
      name: "第四章"
  brandMark: "个人作品集 · Yielding god hath waters"   # 实测，封面文字
  watermark: null

doAndDont:
  do:
    - "✅ 每页都用真实的羽毛爆炸抽象图，至少准备 4 种色相变体"
    - "✅ 主标题用 serif（中英文），字距收紧；副标用细体加宽字距 0.18em"
    - "✅ 章节扉页让大数字与爆炸图『咬合重叠』，制造仪式感"
    - "✅ 正文页严格让右上爆炸图与文字不重叠（出血但不入侵）"
    - "✅ 首尾同构：封面与尾页共享黑底+爆炸图+巨字结构"
  dont:
    - "❌ 不要用纯渐变色块或圆角矩形替代爆炸图 — 视觉签名会塌"
    - "❌ 不要在同一页放两张爆炸图（除非是 ending 与 cover 间的并置）"
    - "❌ 不要用品牌彩色面性图标 — 与极简 serif 排版冲突"
    - "❌ 不要让正文超过 3 列；超过即改用 features-grid 或拆页"
    - "❌ 不要在内容页让爆炸图压住任何文字行（即使透明度也会破坏可读性）"
---

## Overview

这是一份以『羽毛爆炸抽象球体』为视觉灵魂的作品集模板。整 deck 的视觉身份建立在一个核心母题上：高密度毛刺、明暗反差强烈、呈现『冻结的爆炸』瞬间的抽象球体，在不同页面上以不同色相变体（紫蓝、暖灰、玫红、翠绿）出现，既保持视觉一致性，又通过色相差异暗示章节情绪转换。整套模板使用极简的黑白主调与 serif 字体共同烘托『高级、文学、有距离感』的氛围，适合个人创意作品集、艺术随笔、视觉年鉴这类追求气场胜过信息密度的场景。

## Audience & Context

目标受众是个人创作者（作家、摄影师、设计师、文学社编辑）需要把『一段时期的创作汇编成册』的场景。它不适合做产品发布会或销售型展示——那需要更多数据图表与 CTA 按钮；它擅长的是『让一组作品被庄重地呈现』，让观众在每一页停留更久，被图像的气场推动着进入文字。原作 22 页设计了 4 个章节扉页（标号 1-4），暗示创作者把作品按四个主题分章；正文页的版式（三列排版、引言、大图、特色网格）覆盖了从『密集文字』到『纯图像』的所有节奏需求。

## Colors

色板上极度克制：深紫近黑（#151540）作为主色与黑色（#000000）共同承担所有标题与背景，白色（#FFFFFF）承担正文页底色，两个灰色（#6C7278 副文 / #F5F5F8 微弱分色块）补足层次。强调色不在色板里——而是从爆炸图本身的色相中『借』出来：青色高光（#3CC4D9）、玫红、翠绿、琥珀，每个章节通过爆炸图的色相变体来制造情绪差异，而正文文字始终保持深紫近黑的稳定。这种『把强调色让给图像』的策略让色板保持干净，同时给图像最大的视觉空间。

## Typography

字体系统以 serif（中英文）作为标题，sans-serif 作为正文。display 巨字（章节数字 230pt、封面巨字 96pt）依赖 serif 的优雅曲线传达文学感；title 主标题（46pt）保持 serif 但收紧字距；正文与说明转用 sans-serif 求清晰可读。最有签名感的细节是『稀疏字距英文副标』——封面下方一行 letterSpacing 0.18em 的细体英文，是该模板的视觉胎记之一。中文字体推荐 Source Han Serif（思源宋体）+ Source Han Sans（思源黑体）的搭配，渲染层无中文字体时降级到 PingFang SC / Songti SC。

## Canvas & Grid

画布 16:9 / 960×540，12 列栅格，列间距 16px，左右页边距 56px，垂直基线 8px。spacing tokens 按 4-8-16-32-56-96 渐进，xl（56）用于版块间距、xxl（96）用于章节扉页主题块的纵向呼吸。这套间距偏宽——与『让图像呼吸、让文字有距离感』的整体气场匹配，与密集汇报型 deck 形成显著区别。安全区上 32 / 下 32 / 左右 56，正文与说明文字必须落在安全区内。

## Layouts

8 个语义版式覆盖了从封面到尾页的全部叙事节奏：cover（黑底+巨字+居中爆炸图）→ section-divider（数字与爆炸图咬合）→ 内容版式三态（content-default 三列排版 / quote 中心引言 / full-image 图像独白）→ big-number 数据强调 → features-grid 特色卡片 → ending（与 cover 同构）。其中 cover、section-divider、ending 三个版式构成结构骨架，必须共享视觉签名（黑底/爆炸图/巨字），其它版式服务于具体内容。原 PPT 的 19 个 PowerPoint 母版 layout 大多是冗余的兼容版本，本模板归纳后仅保留 8 个真正被使用的语义版式。

## Patterns & Decorations

模板的装饰元素只有三个，但每个都极致：burstImage（爆炸图，整 deck 灵魂，至少 4 种色相变体）、bigNumeral（巨型数字，章节扉页与大数字页专用）、letterSpacedSubhead（稀疏字距英文副标，封面与章节扉页底部）。三个装饰元素在不同页之间的组合方式定义了所有版式：cover = burstImage + 巨字主标题；section-divider = bigNumeral + burstImage + letterSpacedSubhead；content-default 仅保留 burstImage 作右上点缀。这种『元素少而组合多』的策略保证了 deck 的视觉一致性。

## Motion

原 PPT 未声明动画（XML 无 timing 节点），motion.enabled 设为 false。fallback 仅允许简单 fade 过渡，时长 ≤ 400ms。爆炸图本身已经是『动态』的视觉，再叠加动画会喧宾夺主。

## Imagery & Icons

图像系统的核心是『羽毛爆炸抽象球体』——单主体、自由轮廓、无外框、无圆角，用其轮廓本身作遮罩。整套 deck 必须出现至少 4 种色相变体（violet-cyan / mauve-grey / ember-red / jade-amber），通过色相差异而非内容差异来标记章节情绪。爆炸图在不同版式中的用法严格区分：封面/尾页占满或居中、章节扉页主导 ≥ 60% 宽并与大数字咬合、内容页仅作右上『出血』点缀（≤ 40% 宽、不压文字）。图标系统极克制——只用 1.5px 描边的细线图标，单色（primary 色），三档尺寸 24/32/48px；禁止任何面性图标或彩色品牌图标，避免与极简 serif 排版冲突。

## Do's and Don'ts

最重要的红线：**不要用任何替代品代替爆炸图**——纯渐变色块、圆角矩形、几何抽象都会让模板失去灵魂。第二条红线：**正文页爆炸图必须『出血但不入侵』**——从画面边缘探入，不能压住任何文字行。第三条：**首尾同构必须严格执行**——封面与尾页共享黑底+爆炸图+巨字结构，这是仪式感的来源。第四条：**主标题用 serif 字体**——中英文都要 serif，sans-serif 只能进入正文与说明，否则会丢失文学气质。
