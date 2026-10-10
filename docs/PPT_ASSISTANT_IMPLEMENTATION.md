# PPT 助手：本地执行与统一网关落地说明

更新日期：2026-10-10。适用项目：KLA-2.0/kun-ai-chat。

## 1. 本次交付范围

增加官方预置智能体「PPT助手」，服务端保存身份、角色、模型挂载与技能挂载；实际 PPT 生成、读取、质检、渲染由登录同一身份的 Electron 本地执行器完成。所有调用沿用现有工具网关、设备路由、审批、回执和审计链路。

设置中的技能管理展示「PPT 制作与改稿」，工具管理展示四个 PPT 工具。底层目录独立存在，不反向绑定某个智能体；用户在「我的智能体 → 技能管理」调整挂载。

新增真实二进制成果回传，支持下载 PPTX、预览 PDF 和 PNG。原有文本成果、知识库、算力与记忆服务继续沿用既有实现。

## 2. 技能包来源与集成边界

来源：用户提供的 `deck-agent-kit.zip`。

- 包内声明名称：`ppt-agent`。
- 包内版本：1.0.0；许可声明：MIT。
- 原 ZIP SHA-256：`39fcae97260d14ee535e2c03f1c71fdbfa2b834b5d1b6ea81a914a2f3a0dba25`。
- 源码位置：`apps/desktop/resources/skills/deck-agent-kit/`。
- 保留包内 SKILL.md、Python 引擎、语义 schema、10 页样例。
- 不纳入参考成品二进制、Python 虚拟环境、缓存和测试产出。
- 新增固定适配器 `scripts/kla_bridge.py`，接收受限操作和语义 JSON，不执行模型传入的 Python 源码。

打包通过 electron-builder 的 extraResources 将技能包放在安装目录 resources/skills/deck-agent-kit，避开 asar；Python、字体和渲染器由本机提供，目前不打入安装包。

## 3. 智能体与权限

### 3.1 智能体定义

每个身份首次访问运行时目录时，幂等创建本身份的官方 PPT助手，默认本地执行。定义在 `server/src/runtime/ppt-assistant.ts`，目录初始化在 `server/src/runtime/registry.ts`。

默认挂载：

| 技能 | 用途 |
| --- | --- |
| PPT 制作与改稿 | 环境检查、生成、读取、真实渲染 |
| 本地文件处理 | 列目录、读取用户材料、保存文本 |
| 成果管理 | 读取语义 JSON 与质检报告、保存配套文件 |
| 短期记忆 | 使用本群聊、本智能体的已有短期上下文 |

初始化标识 `capabilities_initialized` 保证用户后续卸载或修改挂载不会被目录读取覆盖。本地执行智能体不会因为本次新增而自动获得 PPT 工具。

新建/空群聊按现有初始化规则包含预置智能体；已有非空角色池不会被自动增加成员。旧群聊请通过群聊「智能体角色池」添加 PPT助手。

### 3.2 模型与设备

模型继续通过现有服务端模型网关调用。用户可在 PPT助手的「挂载模型」中选择当前身份的 Key 和该 Key 下可用模型；未单独挂载时沿用现有默认槽位。

本地执行需要 Electron 桌面端在线并登录同一账号身份。浏览器页面不能直接访问本机文件或运行 Python。自动设备选择与指定设备沿用现有逻辑；离线时显示等待设备，不伪造本地执行成功。

工具网关检查智能体挂载及身份权限；本地执行沿用用户审批、路径校验、超时、取消和执行日志。工具实际权限是当前操作系统用户权限，不是绕过操作系统安全边界。

## 4. 工具契约

模型看到的工具定义由统一网关暴露，参数经过 packages/contracts 校验。

| 工具代码 | 入参 | 主要返回 |
| --- | --- | --- |
| `local_ppt_doctor` | 空对象 | environment：full/partial/blocked、生成/质检/渲染能力、依赖、渲染器、中文字体与建议 |
| `local_ppt_build` | specJson、fileName?、render? | pageCount、qc、renderStatus、documentId、文件元数据；回执成功后附 artifactId/artifactIds |
| `local_ppt_inspect` | path 或 documentId，二选一 | pageCount、pages（文本/表格/备注）、truncated |
| `local_ppt_render` | path 或 documentId，二选一 | pageCount、qc、renderStatus、实际 PDF/PNG 与质检报告 |

`specJson` 是完整语义 JSON 的字符串，最多 100 万字符。`fileName` 默认「演示文稿.pptx」，只接受合法文件名且必须以 .pptx 结尾；`render` 默认 true。

`path` 是用户提供或批准的本机绝对 PPTX 路径。`documentId` 是该身份在本设备上的任务相对句柄，不能跨身份或通过 ../ 越界。读取限制为 PPTX 16 MiB、最多 60 页；解析压缩包时限制条目数及展开总量。

读取结果按传输预算截断并标注 truncated；不是任意 PowerPoint 对象模型的完整导出。二进制成果读取只返回元数据，Base64 不进入模型上下文。

## 5. 对话工作流

1. 用户在群聊指定 PPT助手，或由统筹智能体根据角色池委派 PPT 任务。
2. 首次制作调用环境检查；缺依赖时给出实际缺口。
3. 读取用户明确提供/批准的材料。普通文本使用本地文件工具，PPTX 使用 PPT 内容读取。
4. 给出页数、大纲、每页任务、关键结论和待补数据，等待用户确认；用户明确要求直接生成时可以跳过确认。
5. 生成语义 DeckSpec，调用 PPT 生成与质检。模型不得生成几何坐标、字号或配色参数。
6. 固定引擎执行 schema 校验、确定性布局、原生 PPTX 编译、结构质检。
7. 渲染器读取实际 PPTX，产出 PDF、逐页 PNG 和缩略图网格。前端不重做另一套幻灯片渲染。
8. 本地执行器回传经过校验的成果批次；服务端在一个事务中保存文件和工具回执。
9. 智能体收到成果编号后完成回复；群聊消息、运行结果、审计事件携带整个 artifactIds 列表。
10. 用户在右侧成果抽屉查看真实 PDF/PNG，并下载原生可编辑 PPTX。

改稿基于上一次语义 JSON 重新构建，修改用户指定内容，保留之前文件。当前不是单页增量编辑，也不支持任意外部模板克隆或动画。跨设备继续修改时需先下载已有 PPTX/语义 JSON；本地 documentId 不具备跨设备文件同步能力。

## 6. 语义输入与质量门禁

完整 schema 见技能包的 references/deck.schema.json；可运行样例见 assets/deck.sample.json。

- 页数 1–60；page_id 唯一，必须有封面，每页 page_job 明确。
- kind：cover、section、content、closing。
- design_system：modern-tech、classic-pro、deep-premium。
- 支持 lead、card、bullets、kpi、steps、chart、compare、matrix、image_slot、concl、quote、table 等语义块。
- 中文标点由引擎归一化，质检比较使用同一份归一化语义，避免误报。
- KPI/图表不得虚构来源；缺资料时标注待提供或显式假设。
- 结构质检检查内容漏画、字号、页码、标点等；不等同于人工视觉审稿。
- image_slot 是占位，不表示已插入真实图片。

失败处理：

| 状态 | 行为 |
| --- | --- |
| blocked | 不生成、不上传；返回缺失依赖与安装建议 |
| partial | 可生成并结构质检，渲染不可用则明确提示需在 Office/WPS 中检查；不显示虚构预览 |
| QC 不通过 | 不上传成果，模型根据 findings 修正语义后重试 |
| 已发现渲染器但转换失败 | 返回失败，不交付冒充成功的文件 |
| 渲染成功 | 核对渲染页数与 PPTX 页数一致后回传真实 PDF/PNG |

每次构建/渲染使用独立目录，防止渲染器清理输出目录时删除源文件或旧版成果。调用进程限制 660 秒，服务端等待本地 PPT 回执上限为 720 秒。

## 7. 成果上传、数据库和预览

### 7.1 批量回执

沿用 `POST /api/v1/runtime/devices/:deviceId/calls/:callId/receipt`，新增 artifacts 数组；旧 artifact 单文件格式继续支持，二者不能同时提交。

每个文件包含 fileName、mimeType、content、contentEncoding（utf8/base64）、checksum。JSON 为 utf8，PPTX/PDF/PNG 为 Base64；checksum 是原始文件字节的 SHA-256。

服务端先校验整个批次，再事务入库：

- 成功回执必须有本地用户 approved=true。
- PPT 成果必须 qc.ok=true 且 blocked=0，不能带失败或渲染失败标识。
- 限制最多 6 个文件、单文件 16 MiB、总计 32 MiB，请求体上限 48 MiB。
- 校验规范 Base64、SHA-256、扩展名/MIME/文件头以及 JSON 可解析性。
- 同批文件名不重复；任何一个文件无效则整个批次不入库。
- receiptId 相同重复提交返回原结果，不重复保存；不同 receiptId 对已完成调用返回冲突。

目前使用既有 PostgreSQL artifacts 表存储内容，新增迁移 0036 的 content_encoding 字段；没有声称已接入 S3/MinIO。二进制列表接口不返回 Base64 大字段，单文件读取/下载才获取内容。以后可以按相同成果契约迁移到对象存储。

### 7.2 权限与下载

成果绑定身份和群聊，继续走现有 auth/identity/permission 检查。

`GET /api/v1/artifacts/:artifactId/download` 校验 export 权限与当前身份，Base64 解码成真实文件字节并带原始文件名。其他身份获取该成果返回不存在。

本地根目录在 Electron userData/agent-runtime/身份ID/tasks 下。上传策略 `KLA_LOCAL_ARTIFACT_UPLOAD=false` 时保留本地成果、回传 localOnly，不上传文件内容；不能把本地保留描述成已在云端保存。

### 7.3 前端

PPTX 提供下载及同批次同名 PDF 预览入口；用 createdAt 区分重复命名的不同版本。PDF 使用实际文件 Blob URL，PNG 显示真实缩略图；切换或关闭时释放 URL。Markdown、纯文本、隔离 HTML 预览保留现有行为。

## 8. 本地安装与运行

本机需要 Python 3.10+、python-pptx、Pillow；真实渲染还需要 pypdfium2 和 WPS 转换器或 LibreOffice。中文字体由本机提供。

从项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ppt-runtime.ps1 -Python "C:\Path\To\python.exe"
```

默认创建 `%LOCALAPPDATA%\kla-workstation\ppt-runtime` 虚拟环境。可通过 RuntimeDirectory 指定目录。

Electron 主进程优先使用 `KLA_PPT_PYTHON`，其次使用默认虚拟环境，最后尝试系统 Python。自定义路径需设置到启动 Electron 的进程环境，不能使用 VITE_ 前缀，也不会自动读取渲染层 .env。

```powershell
$env:KLA_PPT_PYTHON = 'C:\Path\To\venv\Scripts\python.exe'
$env:KLA_RENDERER_URL = 'http://127.0.0.1:5173/'
$env:KLA_API_BASE_URL = 'http://127.0.0.1:8787/api'
pnpm --filter @kla-workstation/desktop exec electron .
```

项目后端启动时自动执行缺失迁移；现有预览脚本启动前后端，但本地 PPT 测试必须另外打开 Electron。更新本地工具源码后需重启 Electron。

本次开发机已安装所需 Python 虚拟环境；doctor 为 full，真实转换使用本机 WPS。其他机器需单独执行安装和环境检查。

## 9. 验证方式与已确认范围

### 9.1 自动化检查

```powershell
pnpm ci-check
```

覆盖内容包括：PPT 预置定义与挂载保留、设备能力与网关路由、审批与 QC 门禁、批次完整性与回执幂等、二进制下载、跨身份隔离、群聊 Loop 对批量成果的归集，以及 PDF/PNG 预览与资源释放。

数据库集成测试使用独立随机 schema，结束后清理，不能写进用户群聊记录。

### 9.2 真实本地引擎验证

```powershell
node scripts/verify-ppt-runtime.cjs
```

这是显式执行的真实环境检查，不把 Office/Python 依赖变成每台 CI 机器的强制条件。输出保存在忽略目录 .runtime/ppt-smoke。

本次已实际生成包内 10 页样例，可编辑 PPTX 经 WPS 转为 PDF 与 PNG；结构 QC 通过，页数一致，文件 SHA-256、内容读取与路径越界拦截正常。已目检实际缩略图网格。Loop 集成测试的模型答复与文件头夹具用于验证协议；不把这些夹具描述为真实大模型生成。真实模型对话应以实际挂载 Key 的模型可用性及用户现场测试为准。

### 9.3 用户验收

1. Electron 登录测试身份，在智能体目录确认 PPT助手及默认技能。
2. 已有群聊先在角色池加入 PPT助手；确认模型槽位可用且设备在线。
3. 发送「请 PPT助手做一份 5 页产品介绍，先给大纲」。确认先返回大纲、没有空文件。
4. 回复「大纲确认，开始生成」。批准本地操作，确认出现真实 PPTX、PDF、质检 JSON 与预览图。
5. 在成果抽屉查看 PDF，下载 PPTX 用 WPS/PowerPoint 验证可编辑。
6. 要求改稿，确认旧版保留且新 PPTX 打开同批次的新 PDF。
7. 用其他身份验证成果不可见，拒绝一次本地审批验证不会产生成功交付。

## 10. 当前能力边界

本版本完成语义生成、材料内容读取、重建改稿、确定性质检、真实渲染和成果交付。未提供任意 Office GUI 操作、动画设计、任意模板克隆、图片素材自动生成或本机任务目录跨设备同步。模型错误输出 schema 时会收到真实校验失败，由模型修正；不会把错误输入悄悄伪造成成功文件。
