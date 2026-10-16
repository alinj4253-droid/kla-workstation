---
name: pptx-deck-builder
display_name: "K-PPT 智作"
display_name_en: "K-PPT Studio"
description: "用声明式 DSL + Yoga 布局引擎从零构建 .pptx 演示文稿的完整流水线。核心方法论：先锁规范(STORY.md/DESIGN.md) → 用 Flexbox 语法写页级版式 → 引擎算布局 → lint 门禁校验 → 批量写入。触发词：做PPT、生成PPT、演示文稿、幻灯片、deck、汇报材料、用本地方案做PPT、不用云端做PPT。"
description_zh: |
  专治明天汇报、今晚开工。把你的想法变成 PPT，让熬夜少一点，让从容多一点。
  从主题构思到内容梳理，从逻辑搭建到页面设计，帮助你快速生成结构清晰、重点突出、视觉专业的 PPT。适用于工作汇报、商业方案、项目复盘、培训课件等场景，让每一个想法都能成为有说服力的演示稿。
description_en: "Build .pptx decks from scratch with a declarative DSL and a Yoga layout engine. Methodology: lock spec (STORY.md/DESIGN.md) -> author page-level Flexbox layout -> engine computes geometry -> lint gate -> batch upsert. Triggers: make PPT, build a deck, slides, presentation."
version: 1.0.0
agent_created: true
---

# PPT 演示文稿构建器（声明式 DSL 方案）

一套**在本机离线可跑**的 PPT 生产流水线。不依赖云端渲染服务，成品不上传任何第三方。

## 快速导航

| 任务 | 读这个 |
|---|---|
| 了解整体流程与决策点 | [workflow](references/workflow.md) |
| 确认引擎/运行时路径与绕行方式 | [environment](references/environment.md) |
| **换机器 / 换智能体：要装什么、有什么限制** | [portability](references/portability.md) |
| 写叙事稿 STORY.md | [story-md](references/story-md.md) |
| 写设计稿 DESIGN.md | [design-md](references/design-md.md) |
| 排版骨架 / Flexbox / 字号表 / 图片摆放 | [layout-recipes](references/layout-recipes.md) |
| **配色怎么定（4 套起步预设 + 自创配色自证）** | [theme-presets](references/theme-presets.md) |
| **引擎自带 30 套主题契约库怎么查、怎么抄** | [theme-library](references/theme-library.md) |
| 命令行速查（create/lint/upsert-dsl） | [commands](references/commands.md) |
| lint 报溢出怎么修 | [lint-troubleshooting](references/lint-troubleshooting.md) |
| DSL 各组件怎么写 | [dsl-components](references/dsl-components.md) |

## 一句话原理

**我定规则，机器算账，算式验错，人来审美。**

我只写意图（这行字 40 号、这栏占 1/3、这块高 100），**不写坐标**；
引擎里的 Yoga（WASM）负责算尺寸、折行、坐标、溢出；
`lint` 是**门禁**不是验收——不过就不许写入 pptx；
画面好不好看，只有人能判断（引擎的视觉校验通道在本机不可用）。

## 使用前提：模板是中性骨架，不是某份 deck 的复制

`assets/` 里两份 `.slide` 是**中性骨架**——**可复用的是版式结构**（A/B/C 三区、大图卡 + 三栏、
图片三用法、`height` 写法），而它们的色值只是**占位**，不含任何题材倾向：

- 模板顶部「主题区」那几个常量（`BG` / `INK` / `CARD` / `ACCENT` + `DIM` / `LINE` / `MASK`）**必须按本项目
  `DESIGN.md` 替换**。换色只改这几行，版式一行不用动。
- `STORY.template.md` / `DESIGN.template.md` 里所有「…」都要填真实内容；
  `DESIGN.md` 的字号表给的是**区间**，取值由题材决定。
- **配色与字号每个项目重新决策**，不要沿用别的项目的。三个取值来源，按需选一个：
  1. **引擎自带 30 套主题契约**（真实项目反向抽取的成熟配色）——`bash scripts/themes.sh list`
     看全表、`palette <编号>` 直接生成可粘贴的常量块。细节见
     [theme-library](references/theme-library.md)。
     ⚠ 该库 **29/30 是浅底**，且**没有游戏娱乐类**。
  2. **4 套起步预设**（中性商务浅色 / 深色科技 / 学术人文 / 政务红金）+ 自创配色的自证方法，
     见 [theme-presets](references/theme-presets.md)。
  3. 题材两者都不覆盖时（如游戏、动漫）→ **自配并自证**：主色 ≤60% / 辅色 ≤30% / 强调 ≤10%、
     色彩池 ≤4 hex。

一句话：**这个技能固化的是"怎么做"的机制，不是"长什么样"的答案。**

## 环境铁律（必须先读 environment.md）

1. **绝不使用 `slidep` 命令别名**。它在本机会误报"引擎尚未就绪"(exit 69)，因为 shim 找的是
   `node_modules/`，而包实际在 `lib/node_modules/`。**统一直调引擎入口**：
   ```bash
   bash scripts/slidep.sh lint <deck.pptx> --dsl-file <page.slide>
   ```
   该脚本会**自动扫** `~/.workbuddy/binaries/node/versions/*` 找 Node 与引擎，
   也可用 `SLIDEP_ENGINE` / `SLIDEP_NODE` / `SLIDEP_NODE_ROOT` 显式覆盖（换机器时用）。

   **上机第一件事**：`bash scripts/check_env.sh` —— 逐项检查 bash / node / 引擎 / 冒烟 lint / Pillow，并给出修法。
   换机器、换智能体、报错排查，都先跑它。依赖清单与平台差异见
   [portability](references/portability.md)。

2. **`screenshot` 与 `lint --visual` 在本机不可用**（引擎内置一条写死的 Linux CI 路径），
   **不要依赖它们出预览图**。质量把关只走纯布局层面的 `lint`。

3. **没有撤销**。改稿 = 改 `.slide` 源文件再整页 `upsert-dsl` 覆盖。源文件是纯文本，可无限重写；
   引擎写入前会自动把旧 pptx 备份到 `.slidep/bak/`。

4. **操作粒度是"页级声明式重写"，不是"对象级微调"**。没有"选中形状改某段字符"这种能力，
   能力在 SDK 层但当前 CLI 未暴露。要改样式就改源码里对应组件的 `style`，整页覆盖。

## 五段责任链

```
第0步 锁规范（一次性）  事实核对 → STORY.md（叙事线） + DESIGN.md（设计常量）
第1步 定规则（我）      内容写进 <Text>，规则用 flex 写进 <Box>。不写坐标
第2步 算布局（引擎）    折行 / 坐标 / 宽高 / 溢出判断，全自动
第3步 验算式（引擎）    lint 门禁：不过就改源码重跑，通过才准写入 pptx
第4步 定审美（人）      打开成品，好不好看只有人能判断
```

第 1–3 步是**逐页内循环**（写一页 → lint → 通过 → 写入，重复 N 次），不是写完再统一检查。
第 0 步之所以必须前置，是因为第 4 步没有机器兜底——**事后没有视觉兜着，就只能事前把规范锁死**。

## 项目目录约定

```
<deck-name>/
├── STORY.md              叙事稿（受众/目标/分章/逐页大纲/自检）
├── DESIGN.md             设计稿（画布/色彩/字体/密度/配图/页面映射表）
├── slides/               01.slide … NN.slide（页级声明式源码）
├── assets/               图片素材（英文短名，禁止中文/空格）
└── <deck-name>.pptx      成品
```

## 脚本速用

```bash
S="C:/Users/Administrator/.workbuddy/skills/pptx-deck-builder/scripts"

# 0) 上机自检：bash / node / 引擎 / 冒烟 lint / Pillow 逐项检查并给修法
bash "$S/check_env.sh"

# 1) 初始化一个新 deck 的项目骨架（复制模板 + 建目录）
bash "$S/new_deck.sh" "C:/path/to/我的演示" "我的演示"

# 2) 校验单页（返回 JSON，ok:true/false）
bash "$S/slidep.sh" lint "<deck>.pptx" --dsl-file slides/07.slide

# 3) 逐页校验 + 通过才写入（全量构建）
bash "$S/build_deck.sh" "<deck>.pptx" slides

# 3b) 查引擎自带的 30 套主题契约；palette 直接产出可粘贴的常量块
bash "$S/themes.sh" list
bash "$S/themes.sh" palette 13

# 4) 图片预处理：裁掉右下角水印；可选把竖图切 N 条横带
"C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  "$S/prep_images.py" --dir assets --crop-watermark
```

## 写每一页前必须确认的硬约束

- **所有 `<Text>` 显式声明 `height`**；巨型数字所在的行容器也要写死高度。
  这是 lint 溢出检测能收敛的**根本前提**（引擎对未声明高度的文本只能估，常估高）。
- **能用 Flexbox 就用 Flexbox**（`flexDirection` / `flex` / `gap` / `justifyContent` / `padding`）；
  `position: 'absolute'` 只留给两种情况：满版铺底图、需要叠在别的元素之上的层。
- **每张 `<Image>` 都显式写 `width` + `height`**（否则 Yoga 无法计算），统一 `objectFit: 'cover'`。
- **压暗背景用独立的半透明 `<Box>` 渐变层**，绝不给 `<Image>` 设 opacity。
- **字号只用一套表，不越界**；字重只有 normal / bold 两档；文字层次用 `opacity`（0.55–0.88）做，
  不要靠引入更多灰色；全篇控制在 4–5 个色常量 + 2 个字体栈（中文栈 / 数字栈）。
- **字体栈里第一位要是本机确实装了的字体**。写不存在的字体不会报错，但会被静默替换，
  且引擎**不嵌字体**（成品换机就会变样）。lint 的度量与字体无关（实测），所以它**不会**帮你发现这个问题。
- **字号别顶到边界，留 5–10% 余量**。lint 用的是内置度量模型（不解析真实字体），
  与 PowerPoint 实际折行不会完全一致；数字块尤其要留空间。
- 巨型数字必须用数字字体栈，否则中文字体里的数字形态会偏窄难看。
