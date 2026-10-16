# 换机器 / 换智能体：限制条件与环境依赖

> 本文所有结论都在本机**实测过**（2026-10-10），不是推测。实测方法与结果写在各节末尾。

## 结论先行

| 档位 | 依赖 | 谁提供 | 缺了会怎样 |
|---|---|---|---|
| **必需** | `bash` | WorkBuddy 安装目录自带的 PortableGit（已在 PATH 上） | `.sh` 脚本全跑不了；可改为直接写命令行 |
| **必需** | Node ≥ 18 | 托管 Node（`~/.workbuddy/binaries/node/versions/*`） | 引擎无法运行 |
| **必需** | `@tencent/slidep` 6.5.1 引擎 | **唯一可能真的缺的那一个**，见 §1.3 | 完全没法做 PPT |
| 可选 | Python + Pillow | 托管 Python venv | 只影响「裁水印 / 切横带」，不影响出 PPT |
| 无关 | 网络 | — | 生产链（写 DSL → lint → 写入）全离线；只有生图、检索需要联网 |
| 无关 | 中文字体 | — | 实测 lint 度量与字体无关（见 §3.1） |
| 无关 | Office / PowerPoint 本体 | — | 引擎自己拼 pptx，不需要装 Office |
| 无关 | 云端渲染服务 | — | 引擎是本地 Node 进程 |

**一句话**：装了 WorkBuddy 的机器，只有**引擎**可能需要单独弄；其余都是自带或可跳过。

---

## 一、三个必需依赖

### 1.1 bash（脚本层）

本机 `which bash` → `/usr/bin/bash`，实测来源是：

```
D:\WorkBuddy\resources\vendor\PortableGit\bin\bash.exe
```

也就是说 **bash 是 WorkBuddy 应用安装目录自带的**（`resources/vendor/PortableGit`），随应用进了 PATH。
注意：`~/.workbuddy/vendor/` 是空的（曾被创建的占位目录），PortableGit 不在这里。

**目标机没有 bash 时**：
- 装 Git for Windows（自带 Git Bash），或
- 不使用 `.sh` 脚本，直接照 `references/commands.md` 写引擎命令行（三步：`create` / `lint` / `upsert-dsl`），
  或用 `.cmd`/`.ps1` 重写这几个脚本。
- 引擎本身**不依赖 bash**，它只需要 Node。

### 1.2 Node（运行时）

```bash
for R in "$HOME"/.workbuddy/binaries/node/versions/*/; do ... done   # slidep.sh / check_env.sh 的自动探测
```

- 本机：`~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（v22.22.2）
- **版本要求宽松**：实测系统 Node **v24.18.0**（`C:/Program Files/nodejs/node.exe`）同样能正常驱动引擎，返回 `ok:true`。
  所以只要 Node ≥ 18 基本都能跑，不必强求 22.22.2。
- 无 WorkBuddy 的机器：自己装 Node，用 `SLIDEP_NODE=<node 路径>` 指过去。

### 1.3 slidep 引擎（唯一可能真的缺的）

引擎不在 npm 公开仓库里，是 **WorkBuddy 分发**的：包名 `@tencent/slidep`，版本 `6.5.1`，许可证标注**内部使用**。

#### 获取路径 A：自动（有网 + 有 WorkBuddy）

WorkBuddy 主进程里有一段 `ensureSlidepAvailable()`，会把包拉到托管 Node 目录：

```
来源：https://acc-1258344699.cos.ap-guangzhou.myqcloud.com/workbuddy/saas/win32-x64-archive/slidep-<platformArch>-6.5.1.tar.gz
落地：<Node 安装根>/lib/node_modules/@tencent/slidep
标记：.slidep-version      校验：dist/index.js 存在
```

这段逻辑打包在 `app.asar` 里，**只由 WorkBuddy 桌面端启动时触发**——你手动敲命令不会触发它。
若托管 Node 还没就绪，它会直接跳过（日志提示 `vendored node not ready yet, skipping slidep prefetch`），
这就是当初"等了半天引擎还没好"的原因。

#### 获取路径 B：离线搬运（推荐，唯一不依赖网络/不靠重装的方式）

本机已经躺着一份**可直接搬走的分发压缩包**：

```
C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\lib\node_modules\@tencent\slidep.zip
  体积 70,957,095 B（67.7 MB） · 条目 13,293 个 · 顶层目录 slidep/
  含：dist/（含 resources/themes/ 30 套设计契约）、node_modules/（263 个包）、package.json、.slidep-version
```

搬运步骤（已实测）：

```bash
# 1) 目标机解压到任意目录（不必放进 WorkBuddy 目录树）
python -c "import zipfile;zipfile.ZipFile(r'<slidep.zip>').extractall(r'<目标目录>')"
#    得到 <目标目录>/slidep/dist/index.js

# 2) 用显式路径驱动（无需任何 WorkBuddy 环境）
export SLIDEP_ENGINE="<目标目录>/slidep/dist/index.js"
bash scripts/slidep.sh lint "<deck>.pptx" --dsl-file slides/01.slide
```

**引擎是自包含的**：`node_modules/` 里有 263 个依赖包（含 `yoga-wasm-web`），**不需要 `npm install`**。
（`package.json` 只声明 9 个直接依赖，但发布件把完整依赖树一起打进去了。）

#### 获取路径 C：整目录拷贝

把 `.../lib/node_modules/@tencent/slidep/` 整个目录（解包后 243 MB）拷到目标机，
用 `SLIDEP_ENGINE` 指向其中的 `dist/index.js`。等价于路径 B，只是不压缩、体积更大。

> **合规提醒**：该包标注"内部使用"。跨机器/跨组织搬运前请确认符合内部使用约定。

**实测记录**
- 解包耗时 33.6 s；解包后顶层内容 `['.slidep-version','README.md','dist','node_modules','package.json']`，`node_modules` 263 项，`dist/index.js` 存在。
- 用 `SLIDEP_ENGINE=<临时目录>/slidep/dist/index.js`（脱离 WorkBuddy 目录树）跑 `lint` → 返回 `{"ok":true,...}` ✅

---

## 二、可选依赖：Python + Pillow

只有 `scripts/prep_images.py`（裁右下角水印、把竖图切 N 条横带）需要它。

- 本机：`~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`，Pillow 10.4.0。
- **Windows 的 venv 解释器在 `Scripts/`，不是 `bin/`**（Unix 才是 `bin/`）。
- 缺了怎么办：跳过。图片不裁水印照样能出 PPT（只是图上有工具水印）；
  或用任何图像工具手动裁右下角（约 宽 ×88.5%、高 ×91.8%）。
- 不要用托管目录下的**裸解释器**（`binaries/python/versions/3.13.12/python.exe`）测依赖——它是干净的，
  没有第三方包，会把"共享 venv 里其实装了"误判成"没装"。

---

## 三、跨机器**不一定一致**的四件事

### 3.1 字体：lint 结果与字体无关（好消息），但缺失字体会被替换（要留意）

**实测**：同一个容器、同一段中文、只改 `fontFamily`，溢出量**完全相同**：

| fontFamily | lint 结果 |
|---|---|
| `Source Han Sans SC` | bottom+44px |
| `Noto Sans SC` | bottom+44px |
| `Microsoft YaHei` | bottom+44px |
| `SimSun` | bottom+44px |
| `NoSuchFontXYZ_不存在` | bottom+44px |

连不存在 的字体都一样 → **引擎用的是内置度量模型，不去解析本机实际字体**。

两个推论：
- ✅ **换机器后 lint 数字不变**，先前通过的页在别的机器上也通过，结论可以搬。
- ⚠️ 但它是**模型估算**，不等于 PowerPoint 真实排版的折行。所以**别把字号顶到边界**，
  留 5–10% 余量；内容区的文本块高度宁可多给几像素。

**另一个要注意的点**：`GTA5介绍.pptx` 里声明的字体是 `Source Han Sans SC`（596 处）和
`Space Grotesk`（166 处），而**本机这两个字体都没装**（只有 `NotoSansSC-VF.ttf`），
pptx 也**没有嵌入字体**（包内无字体文件）。所以任何人打开它，这两个字体都会被替换。

**建议**：新做 deck 时，中文栈/数字栈里**把本机确实存在的字体放在首位**，例如：

```
FONT_CN  = '"Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif'
FONT_NUM = '"Bahnschrift", "Segoe UI", "Space Grotesk", sans-serif'
```

（本机实测存在：`msyh.ttc`、`NotoSansSC-VF.ttf`、`bahnschrift.ttf`；不存在：`Source Han Sans SC`、`Space Grotesk`。）

### 3.2 图片路径相对**项目根**解析

`.slide` 里写 `src='assets/x.png'`，引擎按**当前工作目录**找图。
所以调用引擎前必须 `cd` 到 pptx 所在目录。`build_deck.sh` 已内置这一步；手敲命令时别忘。

### 3.3 `.slide` 文件顶层不能有注释

顶层写 `{/* ... */}` 会让整份文件求值为 `undefined`，报
`JSX input must evaluate to a JSX element, but received undefined`。
`{/* */}` 只在 `<Slide>` **内部**合法；顶层注释只能用 `//`。

### 3.4 路径与编码

- 中文目录/文件名**实测可用**（测试用的就是 `演示.pptx`）；但脚本里所有路径务必加引号。
- Windows Python 不认 cygwin 风格路径：`/c/Users/...` 会被当成当前盘根下的 `c\Users\...`，
  静默解包到错误位置（本人已踩并清理）。跨语言调用时统一用 `C:/Users/...`。

---

## 四、平台差异

| 项 | Windows | macOS / Linux |
|---|---|---|
| Node 可执行 | `<root>/node.exe` | `<root>/bin/node` |
| venv 解释器 | `envs/<name>/Scripts/python.exe` | `envs/<name>/bin/python` |
| `slidep` shim bug | 有（`.cmd`/`.ps1` 找错目录，exit 69） | 未验证；同样建议直调 |
| **引擎分发目录名** | `win32-x64-archive`（按 `platformArch()` 拼） | 对应平台的目录名 |
| `screenshot` / `lint --visual` | **全平台都坏**（见 §5） | 同左 |

`scripts/slidep.sh` 与 `scripts/check_env.sh` 都已同时探测 `node.exe` / `bin/node`，两端通用。

---

## 五、与机器无关的已知失效项（不必排查）

- **`screenshot` 与 `lint --visual` 不可用**：引擎 `dist/slidep.js` 里写死了一条构建期 Linux CI 路径
  （`file:///workspace/node_modules/.pnpm/@tencent+docs-slide-view-sdk-node@.../dist/index.js`，全包仅 1 处），
  且该 SDK 是 devDependency、未随发布件安装 → **换任何机器都修不好**。
  后果：只能做布局层面的 `lint`，**视觉把关必须由人做**。
- **`create` / `lint` / `upsert-dsl` 三条命令纯本地**，不联网、不需要那个本地 editor_sdk 服务；
  换机器后不存在的服务（如 `127.0.0.1:39099`）不会影响这三条。
- **没有撤销**。改稿 = 改 `.slide` 源文件再整页覆盖。源文件是纯文本可无限重写；
  引擎写入前会自动把旧 pptx 备份到 `.slidep/bak/`。
- **操作粒度是"页级声明式重写"**，没有"选中形状改某段字符"这类对象级微调；
  能力在 SDK 层但当前 CLI 未暴露（`slidep script` / `SlidesApp` 在实际二进制中不存在）。

---

## 六、换机器后的 5 分钟自检

```bash
bash scripts/check_env.sh
```

逐项检查并给出修法：bash → node → 引擎（含版本/自带依赖数/空白底版）→ **真实 lint 冒烟测试** →
Python/Pillow（可选）。核心齐全返回 0，缺必需项返回 1。

`lint` 需要一个已存在的 pptx 作为靶子，冒烟测试用的是引擎自带的
`dist/resources/pptx/blank.pptx`，所以**不需要先有项目就能自检**。

---

## 七、最小搬运清单（换一台机器要拷什么）

| 拷什么 | 体积 | 必需性 |
|---|---|---|
| `@tencent/slidep` 引擎（`slidep.zip` 或解包目录） | 67.7 MB / 243 MB | **必需**（目标机没 WorkBuddy 时） |
| 本技能包 `pptx-deck-builder/` | 约 130 KB | **必需**（规则 + 脚本） |
| 目标项目目录（`STORY.md`/`DESIGN.md`/`slides/`/`assets/`/`*.pptx`） | 视情况 | 继续改稿则需要 |
| Node 运行时 | — | 目标机已有 Node ≥ 18 则不需要 |

**目标机完全没有 WorkBuddy 时的最小组合**：Node（≥18）+ bash（Git for Windows）+ 引擎压缩包 + 本技能包。
满足这四项即可离线出 pptx；联网只影响生图和资料检索。

---

## 八、实测记录汇总（可复核）

| 断言 | 实测方式 | 结果 |
|---|---|---|
| 引擎可脱离 WorkBuddy 目录树运行 | 解 `slidep.zip` 到临时目录，`SLIDEP_ENGINE` 指过去跑 lint | `{"ok":true}` ✅ |
| 引擎自包含、无需 npm install | 数解包目录 `node_modules` | 263 个包 ✅ |
| Node 版本不敏感 | 用系统 Node v24.18.0 跑 lint | `{"ok":true}` ✅ |
| lint 度量与字体无关 | 5 种 fontFamily（含不存在的）跑同一容器 | 溢出量全部 bottom+44px ✅ |
| 镜像里未嵌字体 | 解 pptx 查 `typeface=` 与字体条目 | 82 条目、无字体文件 ✅ |
| 中文路径可用 | 用 `演示.pptx` / 中文项目名跑构建 | 成功 ✅ |
