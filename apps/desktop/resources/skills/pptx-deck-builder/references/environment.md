# 环境与运行时（本机）

> 这份文档是**跑通的前提**。所有路径都已在本机核实存在。

## 1. 三条绝对路径

| 用途 | 路径 |
|---|---|
| Node 运行时 | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` |
| PPT 引擎入口 | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@tencent/slidep/dist/index.js` |
| Python（含 Pillow） | `C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe` |

Windows 下 venv 的可执行文件在 `Scripts/`（不是 Unix 的 `bin/`）。

## 2. 引擎身份

| 项 | 值 |
|---|---|
| 包名 / 版本 | `@tencent/slidep` **6.5.1** |
| 体积 | 243 MB（`dist/slidep.js` 是单个 49 MB 打包产物） |
| 布局内核 | **Yoga**（Flexbox 引擎，WASM，包内 `yoga.wasm` 86.6 KB） |
| 转换器版本 | `0.4.4-alpha.*`（每次执行会打印） |
| 安装来源 | WorkBuddy vendor 流程自动下载，**不是** `npm install -g` |

## 3. ⚠️ 必读：为什么不能直接用 `slidep` 命令

`node/versions/22.22.2-6/` 下有三个 shim：`slidep` / `slidep.cmd` / `slidep.ps1`。
它们会去找 `node_modules/@tencent/slidep`，但包实际装在 **`lib/node_modules/@tencent/slidep`** ——
路径差一层，于是永远报「演示文稿引擎尚未就绪」并返回 **exit 69**。

**不要重试 shim，不要排查 shim。直接调引擎入口**（`scripts/slidep.sh` 已封装）：

```bash
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
ENGINE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@tencent/slidep/dist/index.js"
"$NODE" "$ENGINE" <子命令> ...
```

## 4. 实际可用的命令（以 `--help` 为准）

```
create       Create a new blank PPTX file
upsert-dsl   Insert or replace a DSL page in a PPTX file
validate     Validate DSL page content
lint         Lint DSL page layout and aggregate diagnostics
screenshot   Render a PPTX slide page to a PNG image
```

**本流程只用前三条中的三条实用命令**：`create` / `lint` / `upsert-dsl`（都是纯本地、可离线）。

### 4.1 包内 README 与实际二进制不一致

README（8.7 KB）写的是 `start` / `stop` / `template search` / `script` / `export-images` 一套命令，
**这些在 6.5.1 实际二进制里都不存在**。README 没跟着发版更新。**一律以 `--help` 为准。**

## 5. ⚠️ 本机不可用的能力（不要浪费时间试）

| 能力 | 状态 | 原因 |
|---|---|---|
| `screenshot` | ❌ 不可用 | 引擎 bundle 内**写死一条构建期 Linux 路径**：`file:///workspace/node_modules/.pnpm/@tencent+docs-slide-view-sdk-node@…/dist/index.js`；且该 SDK 是 devDependency，未随发布件安装，本机不存在 |
| `lint --visual` | ❌ 不可用 | 同上——它依赖截图产物喂视觉模型 |
| `script`（GAS 风格对象级 API） | ❌ 不存在 | 包内 README 有描述，实际二进制无此命令，`SlidesApp` 全局名也搜不到 |
| `template search` | ❌ 不存在 | 同上，README 有、二进制无 |

**结论**：质量把关只能走 `lint` 的**纯布局层面**（Yoga 算数），无法做视觉判断。
这也是为什么流程里必须"先锁规范"——见 workflow.md。

## 6. 引擎自带的资源目录（可以翻）

```
<引擎>/dist/resources/
├── themes/    30 套「设计契约」.DESIGN.md（568 KB，单份 12–20 KB，无子目录）
├── pptx/      blank.pptx（create 用的空白底版）
└── prompts/   whitespace/ 下 6 个留白检测提示词（qwen，lint --visual 走这条路）
```

30 套主题结构化 YAML frontmatter：`name/description/audience/locale` + `canvas` + `grid` +
色板/字体/组件规范，字段带 🟢🟡🔴 置信度标记（多为从真实 deck 反向抽取）。
覆盖面：作品集/创意 18 套、政企汇报答辩 6 套、财务报告 2 套、真实素材抽取 4 套。

**两套坐标别搞混**：主题契约的 `canvas` 是 **720×405（点）**；
`.slide` DSL 里写的是 **`<Slide style={{width:1280, height:720}}>`（像素）**。同为 16:9，尺度不同。

**目前没有调用入口**（`template search` 不存在），只能手动翻阅某份 `.DESIGN.md`，
把它的色板/字体/栅格抄进项目 `DESIGN.md`。

## 7. 依赖关系澄清（避免误判）

| 组件 | 归属 | 关系 |
|---|---|---|
| Yoga | 引擎内 WASM | DSL 里能写 flex 语法，是因为它在算 |
| Pillow | Python 第三方库（独立生态） | 裁水印/切图用，**与 PPT 技能包无任何依赖** |
| 技能包 `scripts/` 下 3 个 py | tencent-pptx 自带 | **只用标准库**，不 import PIL，本流程未使用 |

**不要用裸解释器测依赖**：`python/versions/3.13.12/python.exe` 是干净的、无任何第三方包，
用它 `import PIL` 会误判成"没装"。要测依赖一律用 `envs/default/Scripts/python.exe`。
