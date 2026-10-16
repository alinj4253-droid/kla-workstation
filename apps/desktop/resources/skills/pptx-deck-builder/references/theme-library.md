# 引擎自带主题契约库（30 套）

引擎随包分发 **30 套「设计契约」**。它们是**给人读的规范文档**，不是可直接套用的模板——
引擎自己不读它们，CLI 也没有检索入口。`scripts/themes.sh` 把「翻阅 + 抄色值」自动化。

---

## 1. 位置

```
<Node根>/lib/node_modules/@tencent/slidep/dist/resources/themes/
```

本机实际路径：

```
C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\lib\node_modules\@tencent\slidep\dist\resources\themes\
```

| 项 | 值 |
|---|---|
| 数量 | **30 份** `*.DESIGN.md`，无子目录 |
| 总体积 | **568 KB**，单份 3.4–30 KB |
| 定位 | 跟着引擎一起分发，不从网上下载 |

`bash scripts/themes.sh dir` 直接打印路径；`THEMES_DIR` 可覆盖。

同一级 `resources/` 下另有两块（与本文无关，别混淆）：

- `pptx/blank.pptx` — `create` 命令建空文件用的底版
- `prompts/whitespace/` — 6 个「留白检测」视觉模型提示词（`lint --visual` 走这条路，本机因截图链路坏而整体不可用）

---

## 2. 三条硬事实（决定了它只能这么用）

1. **引擎不消费它。** 49 MB 的 `dist/slidep.js` 里搜 `resources/themes` → **0 次**；搜 `DESIGN.md` → **0 次**。
   （bundle 里另有 232 处 `themeId`，那是 OOXML 自带的 pptx 主题部件，与这 30 套无关。）
2. **CLI 没有入口。** 包内 README 写的 `slidep template search <关键词>`（BM25 + IDF 打分）
   在实际二进制里**不存在**。可用命令只有 5 条：`create` / `upsert-dsl` / `validate` / `lint` / `screenshot`。
3. 因此它只能**人工翻阅 → 抄进本项目 DESIGN.md**。`themes.sh` 把这一步变成一条命令。

> 结论：这 30 套是**参考素材库**，不是可运行的能力。别指望 `create --theme xxx` 这种用法。

---

## 3. 字段结构

frontmatter 是 YAML，顶层字段：

```yaml
version / name / description / audience / locale
canvas:     aspectRatio, width, height, safeArea{top,right,bottom,left}   # 720×405，单位「点」
grid:       columns, gutter, margin, baseline                              # 12 栏
colors:     surface / on-surface / primary / accent / …
typography: display / title / body / body-small / caption（各带 fontFamily/fontSize/lineHeight）
```

**置信度标记**（每个字段后面）：`🟢` 从 pptx XML 读出 · `🟡` 视觉估计 · `🔴` 默认值或推断。
也就是说**不少契约是从真实 PPT 反向解析出来的**，不是人手写的。

⚠️ **`colors` 键名不统一**：全库出现 100+ 种键名，只有这几个是多数派：

| 键 | 覆盖 |
|---|---|
| `primary` | 29/30 |
| `on-surface-secondary` | 28/30 |
| `surface` / `on-surface` | 26/30 |
| `surface-muted` | 25/30 |
| `accent` | 22/30 |

所以脚本用**优先级链 + 前缀泛化**兜底，最后退到「最深的中性色」——
因为有的契约**刻意不用彩色强调色**（如 `Editorial Portfolio — Beige & Charcoal` 只有暖米 + 炭灰，
注释写着「严禁补加任何彩色 accent」）。

---

## 4. 最重要的两个统计（实测）

### ① 明暗分布：浅底 29 套 / 深底 1 套

独立交叉验证过（直接读每个文件的 `surface:` 键算感知亮度，不经过本脚本）。
唯一的深色是 **`文学社素材016 — 暗色调创意作品集模板`**（`#1E1E1E`）。

> **含义**：想要深色 deck，这套库里几乎没有可抄的现成答案。
> GTA5 那份《洛圣都暮色》（`#0E0E12` 深墨 + 霓虹粉橙）之所以必须自配，根因就在这里。
> 规范的色彩参考表也只有 4 类（科技金融 / 人文哲学 / 教育消费 / 政务党建）——
> **两处都不给游戏娱乐题材提供答案**，只能自配并自证。

### ② 题材覆盖（分类为按名称的启发式推断）

| 分类 | 套数 |
|---|---|
| 创意设计（作品集 / 摄影 / 海报 / 编辑型） | 13 |
| 政企学术（汇报 / 答辩 / 科研 / 文献 / 目录页） | 7 |
| 财务分析 | 2 |
| 未分类（英文命名 或 反向抽取契约） | 8 |

**游戏 / 娱乐 / 动漫类：0 套。**

---

## 5. 30 套全清单

```
编号  名称                                                        主色      分类
1    ART SHOW · 极简水墨作品集                                   #464441  创意设计
2    Editorial Portfolio — Beige & Charcoal                     #3D3D3D  创意设计
3    PPT-BSK-02 工作型 PPT 目录页合集·松柏绿                     #37A783  政企学术
4    Plura Portfolio — 极简摄影师作品集                          #44495D  创意设计
5    coral-portfolio-3d                                         #FF9A9E  创意设计
6    feathered-burst-violet                                     #151540  未分类
7    monolia-editorial                                          #1B365D  创意设计
8    olive-portfolio-quiet                                      #6E7063  创意设计
9    pink-portfolio-watercolor                                  #F2D5D0  创意设计
10   sample-reels-purple                                        #9459FF  创意设计
11   sunrise-haze-terracotta                                    #9B461C  未分类
12   个人作品集 · 全息液态玻璃风                                 #0A0A0A  创意设计
13   乡村振兴工作汇报模板（绿色田园风）                          #37A466  政企学术
14   从 文学社素材003 抽取的设计契约                             #224CB9  未分类
15   从 文学社素材004 抽取的设计契约                             #CE544D  未分类
16   从 文学社素材005 抽取的设计契约                             #1279EF  未分类
17   从 阿鱼PPT（最新版244页） 抽取的设计契约                    #36638C  未分类
18   国家自然基金答辩汇报-亚热带岩性森林(松柏绿)                 #0E5646  政企学术
19   寻乐·中国风非遗音乐汇报模板                                 #875F3B  政企学术
20   广东省重点研发计划答辩 · 科研汇报视觉契约                   #1E2B4D  政企学术
21   文学社素材002 · 作品集 / 艺术设计风 深绿酒红模板            #A4D1CC  创意设计
22   文学社素材016 — 暗色调创意作品集模板            ← 唯一深底   #AD84DA  创意设计
23   文学社素材017 — 复古暖米编辑型衬线大书模板                  #7B7E51  未分类
24   文学社素材018 — 白底亮黄撞色平面海报模板                    #FBE76A  创意设计
25   文学社素材019 — 古典金棕学术厚重书籍模板                    #B9974F  政企学术
26   文学社素材020 — 赛博紫 / Z 世代青春营销模板                 #BC4DFC  未分类
27   荧光绿线框作品集 (Designer Collection)                      #02BF31  创意设计
28   财务分析报告-BG10004-月度报告（蓝绿-链接版）视觉设计契约    #4A66AC  财务分析
29   财务月度分析报告 · 新蓝绿模板                               #4A66AC  财务分析
30   高级灰文献汇报模板                                          #586874  政企学术
```

（编号会随库内容变化，用 `themes.sh list` 现取为准。）

---

## 6. 怎么用进流水线

```bash
S="C:/Users/Administrator/.workbuddy/skills/pptx-deck-builder/scripts"

bash "$S/themes.sh" list                    # 1) 找候选：看名称/主色/分类
bash "$S/themes.sh" show 13 colors          # 2) 看色板 + 用法约束（含行尾注释里的禁令）
bash "$S/themes.sh" show 13 typography      #    看字号层级与字体栈
bash "$S/themes.sh" palette 13              # 3) 生成可粘贴的常量块
```

`palette` 输出的 **11 个常量与模板「主题区」完全同名**（`FONT_CN` / `FONT_NUM` / `BG` / `INK` /
`CARD` / `ACCENT` / `DIM` / `ONIMG` / `LINE` / `GRAD` / `MASK`），直接覆盖 `.slide` 顶部那几行即可，
**版式一行不用动**。

三步之后还要做两件事，别抄完就算：

1. **当作 `DESIGN.md` §2/§3 的取值依据**，按规范填进设计稿（4 色池 ≤4 hex、面积 60/30/10）。
2. **字号仍要在区间内取本项目自己的值**（封面 60–96 / 页标 32–40 / 正文 22–28 / 巨型数据 72–120）。
   契约给的是**它那个真实项目**的字号（如乡村振兴那套 `display: 144` 是 720×405 点坐标系下的值），
   与我们在 1280×720 像素坐标系里的取值不是一套尺度。

---

## 7. 脚本做了哪些加工（透明说明）

契约字段不齐、语义有歧义，脚本做了 5 处判断。这里全部写明，便于你判断是否同意：

| 加工 | 为什么 |
|---|---|
| `colors` 键优先级链 + 前缀泛化 + 最深中性色兜底 | 键名有 100+ 种；有的契约刻意不用彩色强调色 |
| **`GRAD` 第二端不取 `accent`**，改用同主色系的 `primary-light/soft/deep` | 契约的 `accent` 常是"行内强调点缀色"（如乡村振兴那套 `#DE0000` 纯红，标注「切勿大面积使用」）。拿它做渐变会得到「绿→纯红」这种翻车效果 |
| 若该契约的 `accent` 与主色**色相差 >40°**，单独打印提示 | 语义不同色系时它值得当第 5 个色单独管；同色系（如赛博紫）则不必提示 |
| **字体栈在通用族之前补入本机常见字体** | 契约首选字体（思源宋体/黑体、MiSans、PingFang、字魂58号…）本机基本都没装，而 pptx **不嵌字体** → 不补兜底就是把字形交给运气。serif 栈补 `SimSun`/`Noto Serif SC`，sans 栈补 `Microsoft YaHei`/`Noto Sans SC` |
| `CARD` 缺失时按 `BG` 朝 `INK` 偏 8% 派生 | 比硬编码灰色更贴合主题色调（如暖米底会派生暖米卡，而不是冷灰卡） |

字体这一条特别说明：栈首**保留契约原意**，兜底只是插在通用族之前，不改变"首选字体优先"的意图。
输出末尾的 `added` 行会列出补了什么。

---

## 8. 与 `theme-presets.md` 的分工

| | `theme-presets.md` | 本文（`theme-library.md`） |
|---|---|---|
| 是什么 | 我写的 **4 套起步预设** + 自创配色自证三步 | 引擎自带的 **30 套真实契约** |
| 覆盖 | 中性商务浅色 / 深色科技 / 学术人文 / 政务红金 | 作品集创意为主 + 政企学术 + 财务 |
| 何时用 | 题材落在那 4 类里，或干脆自创 | 想要"别人已设计好的"成熟配色 |
| 局限 | 我配的，未经真实项目验证 | **29/30 浅底**，无游戏娱乐类 |

**两者都是取值来源，都不是可直接运行的模板。** 最终都要落到本项目的 `DESIGN.md` 与 `.slide` 主题区。

---

## 9. 命令速查

```bash
bash scripts/themes.sh dir                        # 主题库绝对路径
bash scripts/themes.sh list                       # 30 套：编号 / 名称 / 主色 / 分类
bash scripts/themes.sh search <关键词>             # 按 文件名 + frontmatter 检索
bash scripts/themes.sh show   <编号|关键词> [节名]  # 完整契约；节名= colors|typography|grid|canvas
bash scripts/themes.sh palette <编号|关键词>       # 生成 11 个常量（与模板同名）
```

环境变量覆盖：`THEMES_DIR`（主题库目录）· `THEMES_PYTHON`（解释器）·
`SLIDEP_ENGINE` / `SLIDEP_NODE_ROOT`（由引擎路径反推）。

---

## 10. 已知限制

- **需要 Python**（任意 3.x，只用标准库）。缺失时**不影响 PPT 主链路**（写版式 → lint → 写入），
  只是没法用脚本浏览，直接翻目录读 `.md` 也一样。`themes.py` 是纯标准库实现，不依赖 pyyaml / Pillow。
- **分类是启发式的**，只按**名称**判定。原实现扫 frontmatter 全文，结果几乎全误判——
  某契约正文里提到「slide 14 财务分析」就被判成财务分析。要看准就 `show` 原文。
- **`show <关键词>` 命中多套会报错退出**（列出所有命中项），要求说得更具体或用编号——
  避免在多义关键词上猜错。
- 契约里的坐标是 **720×405 点**，`.slide` 里是 **1280×720 像素**，同为 16:9 但**尺度不同**，不要直接搬坐标数值。

---

## 11. 实测记录（2026-10-10）

| 项 | 结果 |
|---|---|
| 30 套逐个跑 `palette` | **0 异常**；11 个常量齐全、4 色池完整（全量回归） |
| 明暗统计（独立脚本交叉验证） | 浅底 29 / 深底 1 |
| `list` 性能 | 首个 bash 实现逐字符取子进程，30 行触发 120 s 超时；改 Python 后 **0.5 s** |
| 中文列宽 | bash 版必须逐字节判定（CJK 3 字节 = 2 显示列），且 `local a=$1 b=${#a}` 会读外层未定义变量（bash 先展开全部参数再赋值）——两个坑都踩过 |
| 已知问题修正 | ① YAML 块标量描述（`description: |`）显示成 `|` ② 字体值带行尾注释 `# 🟢` 漏进输出 ③ `GRAD` 取 accent 导致绿→红 |
