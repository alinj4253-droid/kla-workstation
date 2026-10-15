---
version: "1.1"
name: "sample-reels-purple"
description: "Purple-based literary scrapbook template for campus clubs and personal portfolios. Filmstrip perforation bands, stacked white photo frames, and handwritten-style Chinese titles form a soft, photo-album aesthetic — showing rather than selling."
audience: "校园文学社团成员、文艺爱好者、个人作品归档场景"   # 🔴 推断
locale: "zh-CN"                                              # 🟢 字体方案为简体中文字符集

canvas:
  aspectRatio: "16:9"          # 🟢 实测
  width: 960                   # 🟢 pt
  height: 540                  # 🟢 pt
  safeArea:                    # 🟡 视觉估计
    top: 60                    # 顶部胶片装饰带占用 ~56pt
    right: 48
    bottom: 60
    left: 48
  printSafe: false             # 🔴 推断：原作未声明打印场景

grid:                          # 🟡 视觉估计；本 deck 偏自由排版，下列仅作软参考
  columns: 12
  gutter: 16
  margin: 48
  baseline: 8

colors:
  # ── 主色族 ──
  primary: "#9459FF"           # 🟢 全 deck 主背景，像素采样
  primary-mute: "#A473FF"      # 🟢 装饰元素淡蒙层色
  primary-soft: "#9D66FF"      # 🟢 章节扉页字标次级紫

  # ── 表面与中性 ──
  surface: "#FFFFFF"           # 🟢 内容卡片、相片白边
  surface-muted: "#F5F2FF"     # 🟡 视觉估计
  on-surface: "#2A1A4D"        # 🔴 推断：白卡片上深紫文字
  on-surface-secondary: "#6F5BA8"   # 🔴 推断
  on-primary: "#FFFFFF"        # 🟢 紫底全白文字
  on-primary-secondary: "rgba(255,255,255,0.65)"  # 🟢 次级英文小字

  # ── 装饰透明白 ──
  decoration-tint-08: "rgba(255,255,255,0.08)"    # 🟡 胶片孔洞、虚线圆环
  decoration-tint-15: "rgba(255,255,255,0.15)"    # 🟡 装饰球、相片框白边淡色
  decoration-tint-35: "rgba(255,255,255,0.35)"    # 🟡 章节序号大字装饰半透明

  # 强调色刻意留空 — 见 doAndDont.dont 第 1 条

typography:
  display:                     # 封面巨字标题
    fontFamily: "演示佛系体, 站酷庆科黄油体, 霞鹜文楷, PingFang SC"   # 🔴 手写感字体降级链
    fontWeight: 400
    fontSize: 96               # 🟢🟡 实测
    lineHeight: 1.1
    color: "#FFFFFF"
  title:                       # 内页主标题
    fontFamily: "演示佛系体, 站酷庆科黄油体, PingFang SC"             # 🔴 手写感降级
    fontWeight: 400
    fontSize: 36               # 🟡 视觉估计
    lineHeight: 1.3
    color: "#FFFFFF"
  subtitle:                    # 'sample reels' 英文字标
    fontFamily: "Allura, Great Vibes, Pacifico"                        # 🔴 连笔体降级链
    fontWeight: 400
    fontSize: 28
    lineHeight: 1.2
    style: "italic"
    color: "#FFFFFF"
  emphasis:                    # 章节扉页大数字 01/02/03/04
    fontFamily: "演示佛系体, Pacifico"                                 # 🔴
    fontWeight: 400
    fontSize: 88               # 🟢 实测
    lineHeight: 1.0
    color: "#FFFFFF"
  body:                        # 正文段落
    fontFamily: "等线, 思源黑体 CN, PingFang SC"                       # 🟢 主题字体
    fontWeight: 400
    fontSize: 18               # 🟡 内容页基准
    lineHeight: 1.7
    color: "#FFFFFF"
  body-small:                  # 副信息
    fontFamily: "等线, 思源黑体 CN"                                    # 🟢
    fontWeight: 400
    fontSize: 14               # 🟢 实测最高频
    lineHeight: 1.5
    color: "rgba(255,255,255,0.85)"
  caption:                     # 占位英文 Lorem
    fontFamily: "Georgia, 等线"                                        # 🔴 衬线体匹配占位语义
    fontWeight: 400
    fontSize: 11
    lineHeight: 1.4
    style: "italic"
    color: "rgba(255,255,255,0.55)"
  data-number:                 # 目录页大号灰白章节序号
    fontFamily: "Allura, Pacifico, 演示佛系体"                         # 🔴
    fontWeight: 400
    fontSize: 72               # 🟡 视觉估计
    lineHeight: 1.0
    color: "rgba(255,255,255,0.35)"

spacing:                       # 🔴 推断：基于元素留白的统计估计
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64

rounded:                       # 🟡 视觉估计
  none: 0
  sm: 4
  md: 8
  lg: 12
  pill: 9999                   # 胶片孔洞为 pill 形

imagery:                       # 🔴 推断
  style: "实拍摄影：建筑、室内、城市空间为主，色调偏冷"
  treatment: "白色相框 + 后置错位白卡 + 不加滤镜不加蒙层"
  cornerRadius: 4              # 相片切角与白卡保持一致
  aspectRatio: "auto"          # 不强制比例，依内容而定
  usage:
    - "封面：单张大图置于白色相框 + 后置错位白卡"
    - "内容页：左图右文 / 双图穿插 / 大图+段落组合，相片始终带白边"
    - "致谢页：双图并列，可不带白边"
  doNotUse:
    - "禁止全幅出血图（图片永远在卡片内）"
    - "禁止圆形或异形裁剪"
    - "禁止饱和滤镜或紫色蒙层"

iconography:                   # 🔴 推断
  style: "极简几何 + 手绘装饰，不使用具象图标"
  metaphors:
    - "胶片孔洞带：把每页暗示为'从一卷胶片上撕下来的画面'"
    - "虚线圆环：章节扉页的视觉标记，环绕大数字"
    - "装饰球组：左上角点缀，呼应封面构图"
    - "手绘水滴 logo：'sample reels' 字标前的小图形"
  color: "#FFFFFF"
  size: "几何为主，最大装饰球直径 160pt"
  doNotUse:
    - "禁止 Material 风格的实色填充图标"
    - "禁止给装饰元素着色（必须保持纯白或半透明白）"

layouts:                       # 🟢🔴 内容版式归纳
  cover:
    structure: |
      - 全屏紫底 #9459FF
      - 顶部 + 底部胶片装饰带（12 个 pill 孔洞水平排列）
      - 左侧白色相框堆叠：前层主图相框 + 后层错位白卡（12-16pt 偏移）
      - 左上角装饰球组：160pt 半透明大球 + 28pt 实心小球
      - 右上角英文小字 lorem（5 行内）
      - 右侧手写中文巨字标题（96pt+，3-4 字）
      - 标题下方 'sample reels' 英文连笔字标
    requiredFields: [topic, mainTitle, subtitle, year]
    rationale: "封面承担'打开作品集'的仪式感，白色相框 + 实拍图是手作温度的来源"

  toc:
    structure: |
      - 全屏紫底 + 顶底胶片装饰带
      - 顶部 'sample reels' 字标 + '目录' 二字（44pt+）
      - 左上角装饰球组（与封面同构）
      - 中央 4 列等距章节卡：每列 = 大号灰白章节序号（72pt 半透明）+ 中文章节标题（26pt）
      - 章节序号字体为手写连笔
    requiredFields: [chapterNumbers, chapterTitles]
    bodyMaxItems: "固定 4 列；超过 4 章需改用纵向列表版式"
    behaviorRule: "序号颜色固定 rgba(255,255,255,0.35)，不随章节变化"

  section-divider:
    structure: |
      - 全屏紫底 + 顶底胶片装饰带
      - 左上角装饰球组
      - 左侧虚线圆环（直径 280pt，单线虚线）
      - 圆环内手写章节序号（130pt）
      - 圆环右侧 'sample reels' 字标 + 手写中文章节标题（76pt）
      - 章节标题下方 3 行英文 lorem 占位
    requiredFields: [sectionNumber, sectionTitle]
    behaviorRule: "扉页结构在所有章节中保持完全一致，仅章节序号递增 — 这是该版式的灵魂，是全文档章节边界的视觉锚点"
    rationale: "强制扉页让 24 页内容拥有清晰的四章节结构，否则容易沦为图片流水账"

  content-default:
    structure: |
      - 全屏紫底 + 顶底胶片装饰带
      - 左上角 'sample reels' 小字标
      - 主区域图文混排（三种变体见 variants）
      - 副图位于正文下方，不侵入正文区域
    requiredFields: [title, body]
    variants:
      - id: "image-left-text-right"
        description: "左大图（白色相框）+ 右标题段落 + 副图位于右下方正文之下"
      - id: "image-right-text-left"
        description: "镜像版"
      - id: "card-frame"
        description: "整页内容外包一个虚线 / 淡白边框矩形"
    rule: "图片必须置于白色相框内 + 正文段落不超过 5 行 + 副图不侵入正文带"
    densityNote: "本模板偏低密度，每页一个观点；高密度页面应改用 'card-grid' 或表格版式"

  ending:
    inheritsFrom: cover
    structure: |
      - 与封面共享白色相框 + 大图的同构语言
      - 左侧白卡相框 + 右侧白卡相框（错位分布）
      - 左下方'谢谢观看'巨字（≥56pt）
      - 副信息一行（社团名 / 期号 / 投稿邮箱等）
    rationale: "首尾同构带来作品集'打开-合上'的仪式感"

patterns:                      # 🔴 推断
  decorations:
    filmStrip:
      structure: "12 个 pill 形孔洞水平排列；顶部与底部对称；色为 decoration-tint-15"
      placement: "全 deck 每页顶 28pt + 底 28pt"
      mandatory: true
    cornerLogo:
      structure: "手绘水滴 + 'ample reels' 手写英文字标"
      placement: "每页左上角（封面与扉页除外，封面占据该区域为装饰球）"
      mandatory: true
    sectionRibbon:
      structure: "扉页虚线圆环 + 大数字"
      placement: "section-divider 版式专用"
      mandatory: false
    ornamentBalls:
      structure: "160pt 半透明大球 + 28pt 实心小球"
      placement: "封面与目录页左上角"
      mandatory: false
  supported:
    - cover
    - toc
    - section-divider
    - content-default
    - ending
  denied:
    - id: "data-dashboard"
      reason: "本模板视觉语言偏文艺，无图表色板预设，不适合密集数据"
    - id: "kpi-grid"
      reason: "无强调色，无法形成 KPI 视觉重心"
    - id: "full-bleed-image"
      reason: "全幅出血图破坏紫色基底与装饰带连贯性"

motion:                        # 🟢 原作未声明动效
  enabled: false
  fallback: "如需添加，仅允许 fade，时长 ≤ 300ms"

meta:                          # 🟢 主要测量值
  source: "文学社素材021.pptx"
  totalSlides: 24              # 🟢
  layoutCount: 11              # 🟢
  sectionCount: 4              # 🔴 从扉页观察推断
  sectionMap:
    - { id: 1, label: "春日抒怀" }     # 🔴 章节命名建议；原 deck 为占位 lorem
    - { id: 2, label: "夏夜星语" }
    - { id: 3, label: "秋意笺墨" }
    - { id: 4, label: "冬藏絮语" }
  brandMark: "Sample Reels"
  watermark: false
  pageNumber: false            # 🟢 全 deck 未见页码

doAndDont:                     # 🔴 全部为一致性反推
  do:
    - "✅ 整体保持紫色基底 #9459FF；文字与装饰使用纯白或半透明白"
    - "✅ 每章节前插入虚线圆环扉页，章节序号递增、结构保持一致"
    - "✅ 图片必须置于白色相框，不直接贴紫底"
    - "✅ 中文标题使用手写或书法风字体；正文使用等线"
    - "✅ 顶底胶片孔洞装饰带在每页保持出现"
    - "✅ 保留 'sample reels' 英文字标作为统一视觉签名"
  dont:
    - "❌ 不使用饱和强调色（紫白对比已建立完整视觉层级）"
    - "❌ 不对图片做圆形或异形裁剪"
    - "❌ 不给图片加滤镜或紫色蒙层"
    - "❌ 不使用 Material 风格的实色填充图标"
    - "❌ 不在内容页放置数据表格或堆叠柱状图"
    - "❌ 不把胶片装饰带替换为实线条或几何条带（语义为'胶片'，不可替换）"
---

## Overview

本模板编码了**校园文学社作品集**的视觉语言——这套美学被用于年度作品合辑、社团回顾、个人随笔归档。其核心特质是文艺、轻盈、剪贴本式手作感。

与商业汇报模板不同，本系统刻意省略了强调色、数据图表与高信息密度。所有页面共享同一片紫色基底，搭配白色相框中的实拍图片，使整份文档读起来像一本被翻阅的纸质摄影集。

本系统服务于"会逐页慢读"的受众——文学社成员、读者、归档读者。其目标是**展示而非说服**，通过统一的视觉氛围让作品本身成为主角。

## Audience & Context

- **谁看**：校园文学社团成员、文艺爱好者、社团指导老师、亲友与社刊订阅者
- **在哪看**：投影展示、电脑屏幕分享、移动端图片浏览、纸质打印作为社刊插页
- **看多久**：单页停留 15-30 秒，整份文档常被反复翻阅
- **物理约束**：投影场景下正文字号不低于 16pt；紫底白字保证投影对比度

## Canvas & Grid

16:9 标准画布（960×540pt）适配现代投影与屏幕。安全区上下各 60pt 是为顶底胶片装饰带预留——这是本模板的视觉签名，必须始终可见。

栅格态度为**软约束**。本系统的视觉编排偏感性，依赖白色相框与图片之间的相互压叠形成隐含节奏，不强制 12 列硬对齐。

## Colors

视觉权重比例为 **主紫 75% / 白色 22% / 装饰透明白 3%**。这一比例使整份文档具有"沉浸式相册"的统一感——不是每页换一种主色，而是用一片紫色把所有内容包裹起来。

主色 `#9459FF` 是画面主背景的真实颜色，全 deck 一致。色板里另外两个紫色 `primary-mute` 与 `primary-soft` 仅作装饰元素和次级文字之用，与主色形成微妙分层但不形成对比。

本系统**故意不设强调色**。所有视觉重点通过字号、字体风格与白色透明度建立——而非靠对比色。这一选择由 `doAndDont.dont` 强制执行，因为引入饱和强调色会破坏紫色基底的沉浸感。

## Typography

本系统使用**双字体策略**——中文标题为手写或书法风字体，中文正文为印刷字体。两者形成"手作 vs 印刷"的张力，是这套美学的关键技术。原作的中文标题为带笔锋的手写感字体，下游生成时的字体降级链已写入 `typography.{display,title,emphasis}.fontFamily`，按优先级尝试匹配。

英文字标 'sample reels' 使用连笔体（`Allura / Great Vibes / Pacifico`），与中文手写体共同构成"剪贴本"质感。基准正文 18pt 高于投影场景的 16pt 下限。一张典型内容页同时使用 4-5 个字号层级（巨字标题、章节序号、正文、引言、英文字标），通过显著的字号跳变建立视觉重心。

## Layouts

5 个内容版式构成结构核心：`cover / toc / section-divider / content-default / ending`。

- **cover** 与 **ending** 共享"白色相框 + 大图"的同构语言，呼应作品集"打开-合上"的仪式感（`ending` 显式 `inheritsFrom: cover`）
- **section-divider** 是本模板最严苛的护栏——`behaviorRule` 字段明确：每个新章节前必须插入结构完全一致的扉页，仅章节数字递增。这一设计让全文档具有清晰的四章节边界
- **content-default** 提供三种变体（左图右文、右图左文、卡框包裹），但骨架始终是"图片在白卡内 + 段落短而克制 + 副图位于正文下方"

原 PPT 母版中保留的其他版式骨架（仅标题 / 比较 / 空白 / 图片与标题 / 中文竖排等）在本作品集中未实际使用，本契约不为它们定义版式；如有需要由下游 Agent 按 `content-default` 的护栏自行扩展。

## Imagery & Icons

本系统中的图像发挥**氛围建立**功能——而非装饰也非数据可视化。图片题材集中于建筑、室内空间与城市瞬间，色调与紫底形成冷暖呼应。所有图片必须置于白色相框中，并常配后置错位白卡形成纸质相册的层次。

顶底的胶片孔洞装饰带是本系统的核心识别符号——它把每一页都暗示为"从一卷胶片上撕下来的画面"。这一装饰带在 `patterns.decorations.filmStrip` 中标记 `mandatory: true`，不可省略，也不可替换为其他几何形式。

图标系统**几乎为空**。所有装饰都是几何形（孔洞、虚线圆环、白色实心小点、半透明大球），不使用任何具象图标。这一选择与手写感和摄影集氛围保持一致。

## Do's and Don'ts

完整规则见上方 YAML 中的 `doAndDont`。需要深入理解的核心护栏：

- **统一紫色基底，不引入强调色** —— 强调色会瞬间打破沉浸式相册的氛围
- **图片必须置于白色相框** —— 这是本模板手作质感的来源；图片直接贴紫底会丧失纸质感
- **每章节前插入结构一致的扉页** —— 章节边界是这套系统的叙事骨架，省略扉页等于打散结构
- **中文标题用手写体，正文用等线** —— "手作 vs 印刷"的张力是本模板与同类紫色模板的区分点
- **顶底胶片装饰带必须保留** —— 它是本模板最具识别性的视觉签名
