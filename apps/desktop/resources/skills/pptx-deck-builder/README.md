# pptx-deck-builder

用**声明式 DSL + 本地 Yoga 布局引擎**从零构建 `.pptx` 的技能包。整套流程跑在本机，
离线可用，成品不上传任何第三方服务。

## 安装位置

```
C:\Users\Administrator\.workbuddy\skills\pptx-deck-builder\
```

用户级技能，本机所有智能体共享。入口是 `SKILL.md`。

## 依赖

| 档位 | 依赖 | 用途 | 谁来提供 |
|---|---|---|---|
| 必需 | `bash` | 跑脚本 | WorkBuddy 安装目录自带 PortableGit（本机在 `D:\WorkBuddy\resources\vendor\PortableGit`） |
| 必需 | Node ≥ 18 | 运行引擎 | 托管 Node（实测 22.22.2 与系统 24.18.0 均可） |
| 必需 | `@tencent/slidep` 6.5.1 | DSL → pptx + Yoga 布局校验 | **WorkBuddy 分发，唯一可能真缺的**。可由 COS 自动拉取，或离线搬 `slidep.zip` |
| 可选 | Python + Pillow | 裁水印 / 切图 | 托管 venv；缺了不影响出 PPT |
| 可选 | Python（标准库即可） | 浏览引擎自带的 30 套主题契约库 | 托管 venv；缺了直接翻目录也一样 |
| 无关 | 网络 / 字体 / Office | — | 生产链全离线；引擎不嵌字体 |

**上机先自检**：

```bash
bash scripts/check_env.sh
```

逐项检查 bash → node → 引擎（版本/自带依赖/空白底版）→ 真实 lint 冒烟测试 → Python/Pillow，并给出修法。
核心依赖不齐返回 1。**换机器、换智能体、出了问题，都先跑它。**

依赖细节、平台差异、离线搬运步骤、已知失效项 → `references/portability.md`。

## 快速开始

```bash
S="C:/Users/Administrator/.workbuddy/skills/pptx-deck-builder/scripts"

# 1) 建项目骨架
bash "$S/new_deck.sh" "C:/path/to/我的演示" "我的演示"

# 2) 改好 STORY.md / DESIGN.md，备好 assets/ 里的图，写好 slides/*.slide

# 3) 全量构建（lint 门禁 + 写入）
bash "$S/build_deck.sh" "C:/path/to/我的演示/我的演示.pptx" "C:/path/to/我的演示/slides" --append
```

## 目录结构

```
pptx-deck-builder/
├── SKILL.md                        主入口（导航 + 铁律 + 五段责任链）
├── references/
│   ├── workflow.md                 九阶段流程与决策点
│   ├── environment.md              路径 / 绕行方式 / 可用与不可用能力
│   ├── portability.md              换机器要装什么、平台差异、离线搬运引擎
│   ├── theme-presets.md            4 套配色起步预设 + 自创配色自证方法
│   ├── theme-library.md            引擎自带 30 套主题契约库：位置/字段/全表/怎么用
│   ├── story-md.md                 STORY.md 撰写规范
│   ├── design-md.md                DESIGN.md 撰写规范（含规则区间与门禁）
│   ├── layout-recipes.md           骨架公式 / Flexbox / 字号表 / 图片三用法
│   ├── commands.md                 三条命令速查
│   ├── lint-troubleshooting.md     溢出排查与修复
│   └── dsl-components.md           DSL 组件写法
├── assets/
│   ├── STORY.template.md
│   ├── DESIGN.template.md
│   ├── slide-cover.slide           封面骨架（可复制）
│   └── slide-content.slide         内容页骨架（可复制）
└── scripts/
    ├── check_env.sh                环境自检（上机先跑）
    ├── slidep.sh                   引擎直调封装（自动定位，可覆盖）
    ├── themes.sh / themes.py       浏览引擎自带 30 套主题契约 + 生成配色常量块
    ├── prep_images.py              裁水印 / 切横带
    ├── build_deck.sh               逐页 lint + 通过才写入
    └── new_deck.sh                 初始化项目骨架
```

## 配色从哪来（三个来源）

| 来源 | 命令 / 文件 | 特点 |
|---|---|---|
| 引擎自带 **30 套主题契约** | `bash scripts/themes.sh palette <编号>` | 真实项目反向抽取的成熟配色；但 **29/30 浅底、无游戏娱乐类** |
| **4 套起步预设** | `references/theme-presets.md` | 我写的起步值，覆盖 4 类常见题材 |
| **自创并自证** | 同上「自创三步」 | 题材两者都不覆盖时（游戏/动漫）唯一出路 |

三个来源都只提供**取值**，最终都要落到本项目 `DESIGN.md` 与 `.slide` 主题区；
30 套的详情见 `references/theme-library.md`。

## 换机器怎么跑

```bash
# 1) 自检
bash scripts/check_env.sh

# 2) 若目标机没有引擎：把本机的分发压缩包搬过去解压
#    源文件 <Node根>/lib/node_modules/@tencent/slidep.zip（67.7 MB，自包含，无需 npm install）
python -c "import zipfile;zipfile.ZipFile(r'<slidep.zip>').extractall(r'<目标目录>')"
export SLIDEP_ENGINE="<目标目录>/slidep/dist/index.js"      # 指向解得来的 dist/index.js

# 3) 照常构建
bash scripts/build_deck.sh "<项目>/<deck>.pptx" "<项目>/slides" --append
```

引擎可放在任意目录，不要求放进 WorkBuddy 目录树（已实测）。

## 这个技能固化的是什么

**固化的是"怎么做"的机制，不是"长什么样"的答案。**

| 固化（可复用） | 不固化（每个项目重新决策） |
|---|---|
| 五段责任链、九阶段流程 | 配色（4 个 hex 由题材决定） |
| A/B/C 母版骨架、字号**区间**、图片三用法 | 各层级**具体字号**（在区间内取值） |
| lint 门禁 + 引擎直调封装 | 每页的版式选择、章节结构 |
| 版面写法的硬约束（`height` 必须写、Flexbox 优先） | 美术风格词、图片内容 |
| 坑与绕行（shim bug、顶层注释、字体替换） | 文案与叙事线 |

模板是**中性骨架**：结构可复制，色值只是占位。换色只改模板顶部「主题区」那几行，版式一行不用动。

## 四个必须知道的坑

1. **不要用 `slidep` 命令**——shim 路径算错，永远报「引擎尚未就绪」(exit 69)。用 `scripts/slidep.sh`。
2. **`screenshot` 和 `lint --visual` 不可用**（引擎写死 Linux CI 路径）。视觉把关只能靠人。
3. **所有 `<Text>` 必须显式写 `height`**——否则 lint 溢出检测无法收敛。
4. **模板色值是占位，别沿用**；字体栈第一位必须是本机确实存在的字体（引擎不嵌字体，静默替换不会报错）。
