# PPT 助手：pptx-deck-builder 流程

更新日期：2026-10-16。适用项目：`kun-ai-chat` 新版客户端与服务端。

## 目标与边界

官方预置的「PPT助手」继续由服务端保存智能体定义、模型与技能挂载，使用平台统一技能/工具网关下发本地执行任务。身份权限、设备路由、审批、审计、成果上传、群聊成果展示均沿用现有平台链路。本次替换的是 PPT 生产流程，不修改独立知识库、算力或记忆模块。

旧版 `deck-agent-kit` 的语义 JSON 输入、固定三套设计体系和 Python PPTX 编译已经停用。历史源码不能直接传给新版构建工具；旧 PPTX 仍可由已有读取工具检查。旧包保留必要的 `slidep` 引擎资源与可选读取/渲染辅助脚本，并不再作为生成方案。

## 新版生产流程

1. `local_ppt_doctor` 实测本机的 DSL 校验、Yoga 布局和 PPTX 写入能力；Python 与 Office/WPS 只影响可选读取和 PDF 渲染，不是生成必需条件。
2. 核实用户事实与资料，形成 `STORY.md`（目标、受众、逐页叙事）和 `DESIGN.md`（1280×720 画布、设计常量、版式、素材计划）。可用 `local_ppt_guide` 阅读原技能包指南与模板，用 `local_ppt_theme_list` 查询主题契约。
3. 每页用静态 JSX `.slide` 描述 `<Slide>`、`<Box>`、`<Text>`、`<Image>`、`<Chart>` 等元素。布局优先用 Flex。图片经批准的本地读取门禁复制到本次任务的 `assets/`，页面只引用该目录。
4. `local_ppt_dsl_validate` 可预检单页。`local_ppt_build` 逐页执行静态源码安全检查和真实 slidep `lint`；通过后读取相同引擎的 Yoga 布局并写入原生、可编辑的 PPTX。失败不上传成果。
5. 一次最多提交 20 页，最多 60 页。多批制作时使用 `finalize=false` 保存草稿和 `documentId`，最后一批 `finalize=true` 才上传成果。改稿传入同设备、同身份的 `documentId` 和要替换的完整页面；旧版文件保持不变。
6. 最终上传 PPTX、`deck.source.json` 和 `deck.qc.json`；启用 `render=true` 且本地渲染依赖可用时，再附真实 PDF/PNG。渲染失败会返回提示，但不把已通过布局和写入检查的 PPTX 误判为未生成。

原技能包的 `upsert-dsl` 依赖另一套文档服务接口，与当前捆绑的 slidep 引擎不兼容。平台适配层保留该方案的 STORY/DESIGN、逐页 DSL、Yoga 布局和 lint 门禁，但使用本地原生 PPTX 写入器完成交付，不调用不可用的文档服务。此兼容调整与原包的 CLI 命令实现不同；不能把当前产物称为原包 CLI 的直接输出。

## 工具与成果

| 工具 | 职责 |
| --- | --- |
| `local_ppt_doctor` | 实际构建一页测试 PPTX，报告生成、校验、读取、渲染能力 |
| `local_ppt_guide` | 按章节读取新技能包工作流、设计、DSL、lint 指南和模板 |
| `local_ppt_theme_list` | 查询主题目录或完整设计契约 |
| `local_ppt_dsl_validate` | 静态安全检查及 slidep 单页 lint |
| `local_ppt_build` | 草稿、续写、按页改稿、最终可编辑 PPTX 与质检成果 |
| `local_ppt_inspect` | 可选读取既有 PPTX 的内容 |
| `local_ppt_render` | 可选生成真实 PDF/PNG 供预览 |

工具定义在 `packages/contracts`，服务端网关负责挂载和权限检查；本地执行器负责获批素材读取、任务目录和成果回执。渲染层不直接访问文件系统或模型密钥。上传后的成果继续按现有身份及群聊权限下载/预览；`KLA_LOCAL_ARTIFACT_UPLOAD=false` 时仅保留本机成果，不宣称已经云端保存。

源码门禁只允许静态常量及受支持的 JSX 组件，不允许导入、函数、调用、动态文件路径、网络地址或事件属性。素材限 PNG/JPEG/WebP，单个 8 MiB、总计 24 MiB、最多 40 个。PPTX 限 16 MiB；超限或未加载图片会报错而不伪造成功。`documentId` 绑定当前本机任务根目录，不能跨身份或跨设备续稿。

## 安装与部署

`apps/desktop` 正式依赖包括 `pptxgenjs`、`@babel/parser`、`@swc/core`、`canvas` 和 `yoga-wasm-web`。Electron 包把技能指南、slidep 引擎及主题资源放进 `extraResources`，单独把 `yoga-wasm-web` 放到引擎的 ESM 依赖位置；其他 Node 原生依赖来自应用依赖。生成 PPTX 不要求单独安装 Python、Office 或外部 slidep 文档服务。

旧 PPTX 内容读取和 PDF/PNG 转换仍可用本地 Python 辅助环境。需要这些可选能力时运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ppt-runtime.ps1
```

实际渲染还取决于 WPS/LibreOffice 等本机转换器。缺少转换器时 PPTX 本身仍能生成，右侧可使用现有 PPTX 预览能力；应在 PowerPoint/WPS 中目检最终排版和字体。当前画布固定 1280×720；不支持任意外部母版、动画、任意自定义形状的保真导出，遇到不能映射的布局元素会中止交付。

## 验证

```powershell
node --test apps/desktop/desktop/local-ppt.check.cjs
node scripts/verify-ppt-runtime.cjs
pnpm ci-check
```

本地测试覆盖草稿续写、按页替换、旧 `specJson` 拒绝、跨目录句柄拒绝、图片缺失阻断，以及可编辑文本、图片、柱线饼图的实际 PPTX ZIP 内容。验证脚本会通过平台本地执行入口生成两页真实 PPTX，检查页数、成果校验和原生图表。测试数据写入被忽略的 `.runtime/ppt-smoke`，不写用户群聊。上述检查不等同于真实模型对话或 PowerPoint 视觉验收；现场还需用 Electron 登录、在群聊调用 PPT助手、下载产物并目检。
