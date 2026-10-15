---
version: "0.1"
name: pink-portfolio-watercolor
description: "粉色水彩个人作品集 (Personal Portfolio) 设计契约：黑底 PD 衬线巨字 + 粉色水彩纹理底 + 永久左侧装饰栏（DESIGN logo · 汉堡 icon · 旋 90° 「CREATIVE POWER」侧标），主打 magazine-editorial 节奏，强调留白、单焦点、衬线大字与 letter-spaced 英文小标的对比。"
audience: "面向独立设计师 / 自由职业者 / 文学社编辑部 — 用于年度作品集、季度刊、个人简历、工作室对外宣讲。受众期待安静、克制、有杂志气质的视觉语言，反感拥挤模板与高饱和企业色。"
locale: zh-CN

canvas:
  aspectRatio: "16:9"           # 🟢 from presentation.xml/sldSz
  width: 1920.0                  # 🟢
  height: 1080.0                 # 🟢
  safeArea:                       # 🟡 视觉估计 (左侧鞋带栏永久占位 ≈ 96px)
    top: 24
    right: 64
    bottom: 48
    left: 120
  printSafe: false               # 🔴 默认值 — 屏幕优先

# grid 未在原 deck 中显式声明, 以下为视觉估计           # 🟡
grid:
  columns: 12
  gutter: 16
  margin: 32
  baseline: 8

colors:
  # ── 主色系 (粉桃色相桶) ──
  primary: "#F2D5D0"            # 🟡 像素采样 — 主水彩底浅粉桃 (cover/章节扉页背景)
  primary-deep: "#E89B95"       # 🟡 水彩底深处的桃红 (slide-15 / slide-25 蘸笔笔触最深处)
  primary-darkest: "#BC695F"    # 🟢 XML srgbClr — 强调装饰红 (slide-15 进度条满格、章节副标)

  # ── 强调色 (灰金色相桶, 用作"克制 accent") ──
  accent: "#C5A396"             # 🟢 XML srgbClr (34x) — 灰桃色, 用于编号 01-06、副标题斜体、装饰旋转字
  accent-soft: "#D7C0B7"        # 🟡 比 accent 浅 1 阶, 仅 0X 大编号水印

  # ── 中性色 ──
  surface: "#FFFFFF"            # 🟡 白卡片底 (slide-15 简历卡 / slide-30 内容栏右侧)
  surface-muted: "#F8F4F2"      # 🟡 极淡奶粉色 (左侧鞋带栏底)
  on-surface: "#1A1A1A"         # 🟢 近黑 — 标题与中文巨字主用色
  on-surface-secondary: "#6C7278"  # 🟡 副文 / WRITE CAPTION HERE 类小字
  on-primary: "#FFFFFF"         # 🔴 反白 (粉底大字偶尔反白 e.g. slide-25 "IN PURSUIT OF MAGIC")

typography:
  display:
    fontFamily: '"Playfair Display", "Noto Serif SC", "Songti SC", serif'
    fontWeight: 700              # 🟢 (Bold)
    fontSize: 239                # 🟢 (最大字号 — 章节扉页 "Inspiration." 等)
    lineHeight: 1.0
    minProjectedSize: 96         # 🔴 投影最小不可低于 96
  hero-cn:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontWeight: 700
    fontSize: 166                # 🟢 (中文封面巨字 "个人作品集")
    lineHeight: 1.0
    letterSpacing: "0.04em"
    minProjectedSize: 88
  title:
    fontFamily: '"Playfair Display", "Noto Serif SC", serif'
    fontWeight: 700
    fontSize: 54                 # 🟢 (章节大标题、case 标题)
    lineHeight: 1.2
    minProjectedSize: 36
  subtitle:
    fontFamily: '"Questrial", "PingFang SC", sans-serif'
    fontWeight: 500
    fontSize: 28                 # 🟢
    lineHeight: 1.4
    letterSpacing: "0.16em"      # 🟡 letter-spaced 英文小标 (WRITE CAPTION HERE 风格)
    textTransform: "uppercase"
    minProjectedSize: 20
  body:
    fontFamily: '"Questrial", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontWeight: 400
    fontSize: 20                 # 🟢
    lineHeight: 1.55
    minProjectedSize: 18
  body-small:
    fontFamily: '"Questrial", "PingFang SC", sans-serif'
    fontWeight: 400
    fontSize: 16                 # 🟢
    lineHeight: 1.5
  caption:
    fontFamily: '"Questrial", "PingFang SC", sans-serif'
    fontWeight: 500
    fontSize: 14                 # 🟢
    lineHeight: 1.3
    letterSpacing: "0.2em"
    textTransform: "uppercase"

# spacing 全部为视觉估计                                 # 🔴
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 32
  xl: 64
  xxl: 120                       # 左侧装饰栏宽度

rounded:                          # 🟡 视觉估计 — 整体偏直角, 仅 NEXT/PINK 标签卡 sm 圆角
  none: 0
  sm: 4
  md: 8
  pill: 9999

imagery:
  style: photo-editorial          # 🟡 — 实拍人像 / 静物 / 水彩材质背景三类
  treatment: |
    - 主图绝大多数走「静物 / 极简人像 / 时装片」, 整体偏冷调灰白底配粉色道具 (slide-05 椅子+粉气球)
    - 不加蒙层、不加圆角, 直接用矩形长卡呈现 (slide-05 / slide-20)
    - 背景大图大量使用「粉色水彩 / 粉色刷漆纹理」 (slide-15 / slide-25), 营造手工质感
    - 不用滤镜风格化, 保持原片冷静感
  cornerRadius: 0
  aspectRatio: ["3:4 portrait card", "16:9 fullbleed", "1:1 square"]
  usage:
    - "封面 hero 大字下半部分 — 浅粉水彩纹理"
    - "case 内容页右半部分 3:4 竖图卡, 左半部分留白排文字"
    - "案例 hero — 16:9 满版水彩底 + 反白衬线大字"
  doNotUse:
    - "不要用商务办公室 / 城市灯火 / 数据可视化感的图"
    - "不要把图加渐变蒙层或低饱和处理 — 失去原模板手工水彩调性"
    - "不要用 emoji / 卡通插画 / 3D 渲染"

iconography:
  style: outline-thin             # 🟡 — slide-80 服务图标即典型: 线性图标, 1-1.5pt 描边, 略圆角端点
  metaphors:
    - "工具/工作流 (放大镜 / 靶心 / 文档)"
    - "导航 (汉堡 icon / 右箭头 ›)"
    - "排版字符 (.,/ 装饰)"
  color: "#BC695F"                # primary-darkest, 与水彩主色保持一族
  size:
    sm: 24
    md: 36
    lg: 48
  doNotUse:
    - "禁止面性 / 渐变 / 多色图标"
    - "禁止 emoji 替代 — 风格断裂"
    - "禁止使用品牌彩色图标 (Slack 紫 / Figma 多色)"

layouts:
  cover-magazine:
    structure: |
      - 左上「DESIGN」logo (黑体小字, 永久占位)
      - 左侧 96px 鞋带栏: 汉堡 icon (≡) + 旋 90° 浅灰侧标 「CREATIVE POWER」
      - 中央偏左: 中文巨字标题 (PingFang Bold, 166pt, 占 1-1.5 行)
      - 标题下方两行 letter-spaced 英文短句 (caption 灰色, 居中或左对齐)
      - 右侧 30-40% 区域: 浅粉水彩纹理通栏背景
      - 底部 1/3 处一个超大半透明 Playfair 衬线英文水印 (例: "Portfolio")
      - 右下角小标签卡: 白底 sm 圆角, 内嵌一个英文短词 (PINK / NEXT)
    requiredFields: [topic, mainTitleCN, subtitleEN, watermarkEN, tagLabel]
    rationale: "封面是该模板灵魂 — 黑色衬线 / 中文巨字 / 粉色水彩 / 旋转侧标四件套缺一不可, 缺任何一件都会丧失杂志感"

  toc-numbered-grid:
    structure: |
      - 沿用永久左侧鞋带栏
      - 主区 2 列 × 3 行卡片网格 (01-06 编号)
      - 每条目 = 浅粉灰大编号 (Playfair 88pt) + 黑色中文小标 + 英文副标
      - 编号与标题水平对齐, 编号略下沉 8px 营造视觉层次
      - 右侧裁出一个超大水印字符 (slide-10 见 "S" 字符) 作为装饰
    behaviorRule: "TOC 不高亮当前章节 — 与同族 magazine 模板一致, 仅作为目录预览, 章节激活态在扉页表达"
    bodyMaxItems: 6

  section-divider-serif-burst:
    structure: |
      - 沿用左侧鞋带栏
      - 中央: 一个反白 Playfair 衬线巨字英文章节名 (例: "Inspiration.")
      - 巨字背后叠加一张 3:4 黑色照片 (一把椅子 / 一个静物), 形成"字+物"互嵌
      - 巨字下方: letter-spaced 灰色 caption (TEMPLATE / CHAPTER 01)
      - 右半部: 粉色水彩通栏底
    rationale: "扉页用「字嵌物」做超大尺度视觉锚点 — 这是该模板独有的奢华感来源"

  content-text-image-split:
    structure: |
      - 左半 (40%): 黑色 letter-spaced 小标 WRITE CAPTION HERE 类似副标
      - 左半下部: 5-7 行正文 (Questrial 20pt 灰黑色, 不分栏)
      - 右半 (60%): 一张 3:4 竖图卡 (静物或人像) + 右下白底 caption 卡
      - 全图无遮挡 — 文字与图片严格分区
    requiredFields: [smallCaption, body, imageRef, imageCaption]

  content-numbered-list:
    structure: |
      - 左半: WRITE CAPTION HERE 副标 + 6 条编号列表 (1.-6.), 编号用 primary-darkest 加粗
      - 右半: 一张人物 / 静物大图 + 半透明 Playfair 衬线英文水印 (Numbering List / Portfolio 等)
      - 列表底部一个圆形 › 翻页按钮 (黑底 / 白箭头)
    bodyMaxItems: 6

  content-skill-bars:
    structure: |
      - 左中: 一张 ~30% 宽白底浮卡, 顶部 caption + 中部 7 条进度条 (Photoshop 98% 形态)
      - 进度条统一 primary-deep 色, 满格用 primary-darkest 加深
      - 右半: 满版粉色水彩通栏 + 反白衬线英文 hero 字 (例: "IN PURSUIT OF MAGIC")
      - 卡片底部署名 (姓名 / 头衔)
    rationale: "技能条/进度条页是该模板少有的「数据感」表达 — 必须保持卡内极简 + 进度条只用 1-2 个色阶"

  content-chart-comment:
    structure: |
      - 左半: 一个 round chart (饼图/环形) 居中, 配色仅用灰阶 + 底部图例 letter-spaced
      - 右半: WRITE CAPTION HERE 小标 + 4-6 行 paragraph 注解
      - 不用红绿色块, chart 的"数据强调"由灰阶层级表达
    rationale: "图表克制使用灰阶, 与水彩页拉开节奏 — 杜绝模板里出现彩虹饼图"

  content-keyword-stack:
    structure: |
      - 左半: 一组 6-7 个英文关键词单字纵向堆叠 (Imagination / Identify / Design / Prototyping / Integrate / Beta-testing / Release)
      - 当前激活关键词加粗黑色 (Imagination), 其余降到 accent-soft 半透明
      - 右半: 长段 paragraph (Questrial 20pt) 紧贴左半边界
    behaviorRule: "永远只激活 1 个关键词 — 该版式的灵魂是「焦点 vs 候选」对比"

  content-icon-service-list:
    structure: |
      - 左半: 一台笔记本 mock-up 长图 (slide-80) 作为视觉支撑, 屏幕区可放 case 截图
      - 右半: 3 条横排 service 条目, 每条 = 圆形线性图标 + 中文小标题 + 3 行说明
      - 图标统一 primary-darkest 描边
    bodyMaxItems: 3

  closing-mirror-cover:
    inheritsFrom: cover-magazine
    structure: |
      - 与封面完全同构
      - 主标题改为 "THANK YOU" 或 "感谢观看", 中文小字署名 + 联系方式
      - 右下标签卡内英文改为 "END" / "BYE"
    rationale: "首尾同构 — 杂志阅读完成感的来源"

patterns:
  decorations:
    permanent-side-rail:
      desc: "永久左侧装饰栏 — DESIGN 黑体 logo (左上) + 汉堡 icon ≡ (左中) + 旋 90° 浅灰 letter-spaced 「CREATIVE POWER」 (左下)"
      mandatory: true
      note: "本模板核心识别符 — 任何一页都不能省略"
    big-letter-watermark:
      desc: "超大半透明 Playfair 衬线英文水印, 60-80% 透明度, 占页面 1/3 高度"
      usage: ["cover", "section-divider", "content-numbered-list"]
    label-pill-corner:
      desc: "右下白底 sm 圆角小标签卡, 内嵌 1-2 个英文词 (NEXT / PINK / END)"
      usage: ["cover", "section-divider"]
    rotated-side-tag:
      desc: "旋 90° 的 letter-spaced 灰色 caption, 永久挂在左侧鞋带栏底部"
  supported:
    - cover-magazine
    - toc-numbered-grid
    - section-divider-serif-burst
    - content-text-image-split
    - content-numbered-list
    - content-skill-bars
    - content-chart-comment
    - content-keyword-stack
    - content-icon-service-list
    - closing-mirror-cover

motion:
  enabled: false                  # 🟢 XML 未声明动画
  fallback:
    transition: "fade"            # 🔴 仅允许淡入淡出 — 杂志感来源是静态克制, 滑动/旋转会破坏
    durationMs: 400
    easing: "ease-out"

meta:
  source: "文学社素材023.pptx"
  totalSlides: 94                # 🟢 from extract.py
  layoutCount: 10                # 🔴 推断的语义版式数 (与 layouts 顶层键集合呼应)
  sectionCount: 4                # 🔴 杂志典型四章式 (Inspiration / Works / Skills / About)
  sectionMap:
    - {id: "inspiration", title: "灵感"}
    - {id: "works", title: "作品"}
    - {id: "skills", title: "技能"}
    - {id: "about", title: "关于"}
  brandMark: "DESIGN"             # 🟢 左上 logo 文字
  watermark: "CREATIVE POWER"     # 🟢 旋 90° 侧标
  family: editorial-portfolio-pink-watercolor   # 🔴 family 候选 (与同族 sample-reels-purple / feathered-burst-violet 并列)

doAndDont:
  do:
    - "✅ 永远保留左侧 96px 鞋带栏 (DESIGN logo + 汉堡 icon + 旋 90° CREATIVE POWER 侧标) — 缺一不可"
    - "✅ 中文巨字必须用 PingFang/Noto Sans CJK Bold, 绝不用 Playfair (Playfair 仅给英文与衬线水印)"
    - "✅ 主色用浅粉桃 (#F2D5D0), accent 用灰桃 (#C5A396), 强调用 (#BC695F) — 仅这 3 阶"
    - "✅ 每页大标题旁边或下方至少出现一段 letter-spaced uppercase 英文小标 (caption / subtitle 风格)"
    - "✅ 图片永远矩形, 永远不加蒙层、不加圆角"
    - "✅ 章节扉页必须用「衬线巨字嵌入静物图」结构, 不能简化为纯字"
    - "✅ TOC / numbered list 编号必须用 Playfair Bold 88pt+ 浅灰编号置于标题左侧"
    - "✅ 首尾页必须同构 — 封面与谢幕页仅改文字, 不改结构"
  dont:
    - "❌ 不要用饱和品牌色 (蓝 / 绿 / 紫 / 黄), 哪怕作为 chart 配色"
    - "❌ 不要把英文设为黑体 (Questrial sans 是辅, Playfair serif 是主)"
    - "❌ 不要给图片加圆角 / 蒙层 / 滤镜 — 失去手工水彩感"
    - "❌ 不要在一页放超过 1 个核心视觉焦点 (字 OR 图, 不能字图打架)"
    - "❌ 不要使用 emoji / 多色图标 / 3D 渲染插画"
    - "❌ 不要省略左侧鞋带栏 — 那是这个模板的「身份证」"
    - "❌ 不要用 PowerPoint 默认饼图 / 柱状图配色 — 必须降到灰阶"
    - "❌ 不要在卡片堆里塞 6 张以上同尺寸卡 — 杂志感来自留白"
---

# Pink Portfolio Watercolor — 设计契约

## Overview

这是一份典型的「粉色水彩个人作品集 (Pink Portfolio with Watercolor texture)」杂志型 PPT 模板。模板的视觉签名由四件套构成：

1. **左侧 96px 永久鞋带栏** —「DESIGN」黑体 logo（左上）+ 汉堡 icon ≡（左中）+ 旋 90° letter-spaced 浅灰侧标「CREATIVE POWER」（左下）。这条鞋带栏在 94 页中无一缺席，是模板的身份识别符。
2. **粉色水彩通栏底** — 浅粉桃 `#F2D5D0` 渐变到桃红 `#E89B95`，常带刷漆颗粒纹理（slide-15 / slide-25 蘸笔笔触清晰可见），制造手工质感而非数字渐变。
3. **Playfair Display 衬线巨字** — 章节扉页超大反白英文（"Inspiration." 占满 60% 宽），与 PingFang Bold 中文巨字（"个人作品集"）相互避让而非堆叠。
4. **letter-spaced uppercase 英文小标** — 字距拉大到 0.16-0.2em 的英文短句（WRITE CAPTION HERE / IN PURSUIT OF MAGIC），永远以小字号、灰色出现，是衬线巨字的"听众"。

整套模板拒绝企业感、拒绝拥挤、拒绝高饱和。它不是给汇报型场景的，是给作品集、季刊、独立工作室对外展示用的。

## Audience & Context

目标受众分两层：

- **创作者层（首要）**：独立设计师 / 摄影师 / 文学社编辑部 / 自由职业者。他们用这份模板装订年度作品集、季度刊、工作室简介，需要的是"安静地展示作品本身"，而不是"用模板抢戏"。
- **观看者层（次要）**：上述创作者的客户、读者、面试官。他们希望在 30 秒内通过 1-2 张图理解作者的审美高度，对密集文字、企业 KPI 图表、彩色 emoji 高度敏感。

使用场景集中在：年度作品集 PDF 静态阅读、文学社季刊在线翻阅、独立工作室对外宣讲（投影或大屏静态展示）。**不适用**于：内部汇报、数据驱动 KPI 解析、产品发布会动态 demo。

## Canvas & Grid

画布 1920×1080 (16:9), 全屏使用率高。安全区因为左侧 96px 鞋带栏占位, 主区有效宽度 ≈ 1800px。栅格 12 列 × 16gutter, 但实际版式很少严格走 12 列 —— 更多是 40/60、50/50、30/70 这种粗粒度二分。

baseline 8px, 所有间距倍数（8/16/24/32/64/120）。`xxl: 120` 是为左侧鞋带栏量身设计的, 不要用作普通段间距。

## Colors

色板严格收敛在 **粉桃 + 灰桃 + 黑白** 三族：

| Token | 值 | 用途 |
|---|---|---|
| `primary` | `#F2D5D0` | 主水彩底浅粉桃 — cover / section 整版背景 |
| `primary-deep` | `#E89B95` | 水彩纹理深处 — 自然出现, 不要主动作为色块 |
| `primary-darkest` | `#BC695F` | 强调装饰红 — 进度条满格 / 章节副标 / 列表编号 |
| `accent` | `#C5A396` | 灰桃色 — 编号 01-06 / 副标题斜体 / 装饰旋转字 |
| `accent-soft` | `#D7C0B7` | 比 accent 浅 1 阶 — 仅作大编号水印 |
| `on-surface` | `#1A1A1A` | 标题与中文巨字主用色 — 不用纯黑 |

整个体系**不出现蓝 / 绿 / 紫 / 黄**。即使 chart / table 也只用灰阶层级（slide-30 饼图就是典型证据 — 全灰 4 阶）。这条规则不可破，破了模板气质立刻坍缩。

## Typography

字体双轨制：

- **英文（主）**：Playfair Display Bold —— 用于章节扉页巨字、TOC 编号、超大水印。其衬线脚的「饱满 + 收尾尖锐」是模板的灵魂。
- **中文（主）**：PingFang SC Bold —— 用于中文封面巨字（166pt）。中文绝不混用 Playfair（中文衬线 ≠ 英文衬线）。
- **辅（中英共用）**：Questrial Regular —— 正文 / caption / 小标。一种字体覆盖所有非 hero 文本，避免字体堆栈混乱。

字号层级是宽间距、跳跃式的：`14 → 20 → 28 → 54 → 166 → 239`。中间没有 32 / 40 / 48 这类常规过渡 —— 杂志型模板就是要让正文与 hero 之间形成断崖式对比。

排版节奏由"鞋带栏 + 主区"双层构成：左侧 120px 永久占位（鞋带栏 + 安全留白），右侧主区按版式分割。**绝不允许**在鞋带栏区域放正文内容。

## Layouts

10 个语义版式（详见 yaml.layouts），按使用频次降序：

1. `content-text-image-split`（最高频，约 30 页）— 左文右图 3:4 卡
2. `cover-magazine` / `closing-mirror-cover`（首尾同构）
3. `section-divider-serif-burst`（每章 1 页, 约 4-5 页）— 衬线巨字嵌入静物
4. `content-numbered-list`（高频, 约 10 页）— 6 条编号 + 大水印
5. `toc-numbered-grid`（1-2 页）— 2×3 编号网格
6. `content-skill-bars`（2-3 页）— 进度条卡 + 水彩通栏
7. `content-chart-comment`（1-2 页）— 灰阶饼图 + 注解
8. `content-keyword-stack`（1-2 页）— 关键词纵向堆叠焦点 vs 候选
9. `content-icon-service-list`（1-2 页）— 笔电 mock-up + 3 服务条

**版式行为铁律**：相邻 3 页内不允许出现两次 `content-text-image-split` 或两次 `content-numbered-list` —— 杂志感来自版式切换的节奏感，连排同版式立刻沦为 PPT 工厂模板。

## Imagery & Icons

图片三类：

- **静物 / 时装片**（slide-05 椅子 + 粉气球）—— 冷调灰白底 + 粉色道具，作为 3:4 竖图卡使用
- **水彩 / 刷漆纹理**（slide-15 / slide-25）—— 整版作为通栏底, 不裁切
- **人像 / 服装局部**（slide-20 白卫衣）—— 靠右半版满版, 配反白巨字水印

**严禁**：办公室照、城市灯火、数据可视化感的图、3D 渲染、卡通插画、emoji。

图标走 outline thin（1-1.5pt 描边）+ 单一 primary-darkest `#BC695F` 描边色。slide-80 service 区是图标使用的标准锚点 —— 简洁、几何、不带情感色彩。

## Patterns & Decorations

四种装饰元素，权重排序：

1. **permanent-side-rail**（强制） —— 左侧鞋带栏, 任何一页不可省略
2. **big-letter-watermark**（高频） —— 超大半透明 Playfair 水印, 60-80% 透明
3. **label-pill-corner**（中频） —— 右下白底小标签 (NEXT / PINK / END)
4. **rotated-side-tag**（强制） —— 旋 90° letter-spaced 侧标, 鞋带栏组成部分

装饰元素遵循「克制叠加」原则：单页最多 2 种装饰元素同时出现, 永远不超过 3 种。

## Motion & Interaction

整套模板**不带动画**（XML 未声明）。如必须加，仅允许 fade in/out, 时长 400ms 以内。**禁用** push / wipe / cube / 3D 翻转 —— 那些会立刻摧毁杂志感。

## Do's and Don'ts

详见 yaml.doAndDont。最关键的三条：

1. ✅ 左侧鞋带栏永远保留, 这是模板的身份证
2. ❌ 不要在版式里出现品牌彩色（蓝 / 绿 / 紫 / 黄）, 包括 chart
3. ❌ 不要给图片加圆角 / 蒙层 / 滤镜 —— 失去手工水彩调性
