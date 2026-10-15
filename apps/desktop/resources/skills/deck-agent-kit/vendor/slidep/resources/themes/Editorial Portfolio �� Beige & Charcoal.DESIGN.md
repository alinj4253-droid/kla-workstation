---
version: "1.0"
name: "Editorial Portfolio — Beige & Charcoal"
description: "极简编辑感作品集风格：暖米色画布 + 深炭灰对比块 + 黑白摄影 + 大号 italic serif + 大留白。无彩色 accent，靠中性灰阶层次撑起整套系统。"
audience: "艺术院校作品集 / 服装-平面-摄影类设计师求职 PPT / 文学社/创意工作室自我介绍 / 旅行手账"
locale: "zh-CN"
target_runtime: "PPTX (OOXML) — 必须在 LibreOffice/PowerPoint 中渲染等同视觉效果，不依赖浏览器 CSS"

canvas:
  aspectRatio: "16:9"
  width: 1280
  height: 720
  safeArea:
    top: 40
    right: 80
    bottom: 40
    left: 80
  printSafe: false

grid:
  columns: 12
  gutter: 24
  margin: 80
  baseline: 8

colors:
  surface: "#DBD4CA"                       # 暖米色画布 (画布主背景)
  surface-contrast: "#3D3D3D"              # 深炭灰装饰 (顶/底色带、深色卡片、章节扉页背景)
  surface-deep: "#000000"                  # 极少量更深层 (深图框内层)
  surface-paper: "#FFFFFF"                 # 极少量高亮
  on-surface: "#3D3D3D"                    # 米色画布上的主文字色
  on-surface-secondary: "#6B6862"          # 副标语/正文段落浅一档
  on-contrast: "#DBD4CA"                   # 深色块内反相文字色
  on-contrast-secondary: "#FFFFFF"         # 深色块内的高亮白字
  # 严禁补加任何彩色 accent — 所有强调通过字号、色块、留白完成

typography:
  headline:                                # 装饰大字 (封面/扉页/章节大标语)
    fontFamily: '"Georgia", "Times New Roman", "Songti SC", serif'
    fontWeight: 400
    fontStyle: italic
    fontSize: 88
    lineHeight: 1.1
    letterSpacing: "0.01em"
    minProjectedSize: 60
    usage: "封面/扉页主标语 / brand-statement 重复短语"
    note: "italic serif 大字 + 适度 letter-spacing 是编辑感的稳定来源"

  display:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif'
    fontWeight: 300
    fontSize: 54
    lineHeight: 1.1
    letterSpacing: "0.06em"
    usage: "章节编号 (01/02/03/04) / 大写英文小标"

  title:
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
    fontWeight: 500
    fontSize: 22
    letterSpacing: "0.18em"
    usage: "页内中标题 (TOWER BRIDGE / EDINBURGH 等)"

  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
    fontWeight: 400
    fontSize: 14
    lineHeight: 1.7
    usage: "正文段落"

  caption:
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
    fontWeight: 400
    fontSize: 11
    letterSpacing: "0.25em"
    usage: "页眉/页脚 caption / 编号 / 标签"

spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 64
  xxxl: 96

rounded:
  none: 0                                  # 大多数都是直角
  pill: 9999                               # 仅椭圆/圆形装饰 (borderRadius:50%)

imagery:
  style: "黑白高对比摄影 (monochrome)"
  preprocessing_required: true
  preprocessing_method: |
    用 Python Pillow 在 src 写入 JSX 之前预处理:
      from PIL import Image, ImageEnhance
      img = Image.open(src).convert("L")              # 转灰度
      img = ImageEnhance.Contrast(img).enhance(1.10)  # 略加对比
      img.save(dst, "JPEG", quality=88)
    禁止依赖 CSS filter: grayscale — PPTX 不识别
  framing: "矩形画框 (#3D3D3D 深色 padding 8-12px)，直角无圆角"
  ratios:
    - "正方形 1:1"
    - "竖向 3:4"
    - "横向 16:9"
  forbidden:
    - "彩色照片"
    - "圆角图片 / 圆形头像"
    - "渐变蒙层 / 双色调"
  source_policy: |
    图源选择优先级:
    1. AI 图片生成 (ImageGen 等) + 肉眼逐张核对内容
    2. Wikimedia Commons (https://commons.wikimedia.org) — 文件名直接标注内容
    3. 自己 web_search 找到具体图片后下载，肉眼核对内容
    禁用: unsplash photo URL 直链 (photo ID 经常不对应关键词)

iconography:
  style: "极简，纯几何"
  shapes_allowed:
    - "矩形 (Box，直角)"
    - "正圆 (borderRadius: '50%')"
    - "椭圆 (borderRadius: '50%' + 不等宽高)"
    - "细线 (Box height:1px / width:1px)"
  shapes_forbidden:
    - "菱形 (CSS clip-path / transform:rotate 不可靠)"
    - "三角形 (CSS clip-path 不可靠)"
    - "任何复杂 SVG path"
  fallback_strategy: |
    若版式必须有"多种几何"，用 Box 嵌套拼合:
    - 替代菱形: 改成正方形 + 内部小正方形
    - 替代三角形: 改成上下两个矩形
    - 整体目标: 装饰元素一律 borderRadius:0 (矩形) 或 borderRadius:'50%' (圆/椭圆)

vertical_text:
  policy: "竖排文字不用 transform:rotate，用单字一行布局"
  zh_method: |
    中文竖排:
      <Box style={{display:'flex', flexDirection:'column', gap:'8px'}}>
        {'内容'.split('').map(ch => <Text>{ch}</Text>)}
      </Box>
  en_method: |
    英文竖排: 用大写单字母，一字一行
      'CONTENTS'.split('').map(ch => <Text>{ch}</Text>)
  forbidden:
    - "transform: rotate(-90deg) + transformOrigin (PPTX 中布局会偏移，文字溢出画布)"

layouts:
  cover:
    description: "顶部 #3D3D3D 全宽色带 (h:120px) + 米色画布 + 左下大号 italic serif 主标语 (88px) + 字距 0.4em 中文副标 + 三行 14px 段落"
  toc:
    description: "左 1/3 #3D3D3D 深色块 + 单字垂直堆叠英文 (CONTENTS 8 个字母一字一行) + 右 2/3 米色 + 4 项目录 (圆点 + 编号 + 中英标题 + 描述)"
  section-divider:
    description: "全画布米色 + 巨型空心椭圆 (border-radius:50%, w:800 h:400) + 中心章节编号 (54px Light) + 副标"
    rule: "椭圆专属此版式，4 个章节 4 个椭圆扉页"
  content-text-image-split:
    description: "页眉 caption + 左/右 文字，另一侧 #3D3D3D 矩形深色画框包黑白图；数据条可选"
  content-3-col-grid:
    description: "页眉 caption + 标题行 + 三栏等宽卡片 (顶部深色色块 + 编号 + 底部文字描述)；装饰几何只用矩形和圆形"
  content-image-grid:
    description: "深色背景 #3D3D3D + 三张方图横排 + 大号 italic serif 标题"
  content-circle-diagram:
    description: "中心圆 + 5 节点环形布局；节点用正圆 (borderRadius:50%)；连接线用 Box height:1px + transform:rotate 单一旋转"
  brand-statement:
    description: "全画布 #3D3D3D + 多行重复 italic serif 标语 (透明度递减) + 中央按钮"
  closing:
    description: "与 cover 镜像同构 (顶部色带 + 左下 italic serif + 右下圆形小印章)"
    rule: "圆形印章直径 ≥100px，内部文字 ≤8 字"

patterns:
  supported:
    - id: "ribbon-top"
      description: "#3D3D3D 顶部全宽色带 120px (cover/closing)"
    - id: "oval-section-mark"
      description: "巨型空心椭圆 (border 1.5px + borderRadius:50%)"
    - id: "italic-serif-headline"
      description: "Georgia italic 大字 (88px) + letterSpacing 0.01em"
    - id: "vertical-letter-stack"
      description: "单字垂直堆叠"
    - id: "running-header-footer"
      description: "页眉/页脚 11px 中英 caption (字距 0.25em)"
    - id: "dark-photo-frame"
      description: "#3D3D3D 矩形深色画框 + 内嵌已预处理为黑白的 jpg"
    - id: "duo-tone-block-pair"
      description: "米/炭对调 (大块 vs 小块的阴阳对照)"
    - id: "hairline-border-rect"
      description: "1px 极细矩形外框"
  forbidden:
    - "任何彩色 accent"
    - "渐变 / 投影 / 玻璃拟态"
    - "圆角矩形 / 圆角图片 / 圆角按钮 (除 borderRadius:50% 椭圆装饰)"
    - "cursive / 手写脚本字 (PPTX fallback 全军覆没)"
    - "CSS clip-path / transform:rotate (除连接线)"
    - "CSS filter (grayscale/blur/contrast 都不识别)"

motion:
  transition: "none"
  animation: "none"

doAndDont:
  do:
    - "米色 #DBD4CA 画布；装饰用 #3D3D3D"
    - "4 椭圆扉页 + 首尾同构 (cover/closing 同布局)"
    - "装饰大字: Georgia italic 88px + letter-spacing"
    - "摄影图: Pillow 预处理为黑白后再写入 JSX，嵌 #3D3D3D 矩形画框"
    - "几何装饰: 仅 Box 矩形 + 正圆/椭圆 (borderRadius:50%)"
    - "竖排文字: 单字一行垂直堆叠，不用 transform:rotate"
    - "图源: AI 生成 / Wikimedia Commons + 肉眼核对内容"
    - "大留白 (xxxl 96px+) 永远是支柱"
  dont:
    - "任何彩色 accent"
    - "cursive / Allura / Pacifico / Brush Script (PPTX 不可靠)"
    - "CSS filter:grayscale (PPTX 完全失效)"
    - "CSS clip-path 做菱形/三角 (PPTX 不一致)"
    - "transform:rotate(-90deg) 做竖排 (PPTX 布局偏移)"
    - "unsplash photo URL 直链 (photo ID 与关键词不对应)"
    - "圆角图片 / 圆形头像"
    - "圆形印章里塞 >8 字"
---

# Editorial Portfolio — Beige & Charcoal

## 设计哲学

> **米色画布 (#DBD4CA) + 深炭色装饰 (#3D3D3D) + 黑白摄影 + italic serif 大字 + 大留白**

整套系统只有 4 种颜色，全部中性灰阶，0 彩色 accent。所有强调通过字号、色块、留白完成。这是编辑感 / Editorial 流派的核心 —— 克制、安静、靠对比与节奏说话。

## 三大视觉支柱

### 1. 米/炭对调

`#DBD4CA` 米色画布 + `#3D3D3D` 深炭灰，以"主体 vs 装饰"的关系出现：

- 大多数页：米色画布为底，用 #3D3D3D 做色带/卡片/画框
- 少数品牌页：反相，#3D3D3D 占据大面积，用米色作文字/装饰

这种反相节奏是阅读张力的来源。不要全篇米色（太平淡），也不要连续多张深色（太压抑）。

### 2. Italic Serif 大字

装饰大字使用：

- **Georgia / Times New Roman / 宋体 (Songti SC) italic 88px** 作主标语
- **letter-spacing 0.01em** 让字母略微透气
- 中文不写 italic，但跟着用大号 (88-92px)

这是跨平台稳定的"杂志感"做法 —— Vogue/纽约客早期 print 标题就是 italic serif，不需要手写体。

### 3. 椭圆 + 直角的几何对照

只保留两种形状：

- **巨型空心椭圆**：`borderRadius: 50%` + 不等宽高 (PPTX 支持)
- **直角矩形/色带**：默认 (PPTX 支持)

椭圆的圆润 + 矩形的硬朗形成几何对照。圆角矩形/圆形头像/胶囊按钮在这套体系里是禁用的 —— 它们会模糊掉这种对照。

## 字号哲学

基准字号 18pt 是这套系统的"灵魂字号"。视觉重量集中在两端：

- 80pt+ 的 italic serif 装饰字 — 视觉锚点
- 11pt / 12pt / 14pt 的 caption — 信息辅助
- 中段 18pt 是正文主战场

不要在 24pt - 40pt 区间堆字号 —— 那是设计的"灰区"，既不够轻也不够重。

## 颜色使用规则（硬约束）

```
on-surface 文字色 = #3D3D3D (= 装饰色)  ← 蓄意复用
背景色 = #DBD4CA                          ← 米色
反相页背景 = #3D3D3D                      ← 深色
反相页文字 = #DBD4CA / #FFFFFF             ← 米色或白
```

文字色蓄意复用装饰色是这套体系最微妙的设计 —— 它让"文字"和"色块"成为一个连贯整体，不会出现"卡片是灰、文字是黑"的两套灰阶。

## 给 AI Agent 的硬约束

如果你基于这份 design.md 生成新内容，请**严格遵守**以下：

1. **配色硬限定**：只用 `surface` (#DBD4CA) 和 `surface-contrast` (#3D3D3D) 两个主色。不许加任何彩色。
2. **椭圆专属**：章节扉页必须有空心椭圆 + 章节编号。内容页严禁出现椭圆。
3. **首尾同构**：第一页和最后一页必须用相同布局（顶部色带 + 左下文字）。
4. **装饰大字**：英文大标语（≥48pt）必须用 `Georgia, Times New Roman, Songti SC, serif` italic + letter-spacing。禁止 cursive。
5. **图片规范**：所有图片 Pillow 预处理为真灰度后落盘，嵌在 #3D3D3D 矩形画框，直角无圆角。禁止 CSS filter。
6. **几何装饰**：仅用 Box 矩形 + borderRadius:50%。禁止 clip-path / transform:rotate(45deg)。
7. **竖排文字**：单字一行垂直堆叠。禁止 transform:rotate(-90deg)。
8. **caption 行**：每个内容页都要带"关于英伦的旅行 · About Britain"风格的 11px 双语 caption（字距 0.25em）。
9. **大留白优先**：xxxl 96px 留白是底线，宁可少塞内容也不要塞满。
10. **图源核对**：AI 生成或 Wikimedia 下载后必须肉眼逐张确认内容匹配，禁止 unsplash photo URL 直链。
