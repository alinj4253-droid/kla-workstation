# KLA Workstation 架构说明

> 本文档描述当前代码实现（2026-09）。产品行为以代码、IPC 契约和数据库迁移为准；历史 MVP 文档仅作为背景资料。

## 1. 系统分层

KLA 是本地优先的 Electron 工作站，运行边界分为四层：

| 层 | 目录 | 职责 |
|---|---|---|
| 桌面主进程 | `apps/desktop/src/main` | IPC、SQLite、文件系统、运行调度、渠道、知识处理和外部 CLI |
| 预加载桥 | `apps/desktop/src/preload` | 暴露类型化 `window.kunqing` API，不把 Node/Electron 暴露给 Renderer |
| 渲染器 | `apps/desktop/src/renderer/src` | React 页面、交互、消息流和文件预览 |
| 领域包 | `packages/*` | Agent、模型、知识、记忆、渠道和数据库契约 |

`apps/runtime` 提供独立的 Agent Runtime utility process。主进程负责权限和持久化，运行时负责执行隔离任务。

## 2. 持久化边界

用户选择的 Studio 根目录默认为 `~/Documents/K_Studio/`，实际路径保存在工作区配置中：

```text
K_Studio/
├── .kstudio/                 # workspace.json、SQLite、锁、日志和缓存
├── group-chats/<groupId>-workspace/  # 当前“个人”作用域：每个群聊隔离
│   ├── original-files/       # 用户上传的原始文件
│   ├── standardized-files/   # 标准化全文，中间目录，不参与普通检索
│   ├── knowledge/            # 切片、索引及知识化结果
│   ├── temp/<rootRunId>/     # 单次任务的中间稿、检索证据和版本
│   ├── templates/            # 材料编写可复用的模板
│   └── outputs/              # 已确认的正式成果
├── projects/<projectId>/     # 当前“项目”作用域：关联资源共享
│   ├── original-files/       # 项目共享原始文件
│   ├── standardized-files/   # 项目标准化全文
│   ├── knowledge/            # 项目切片、图谱和 Wiki
│   ├── templates/            # 项目模板
│   └── outputs/              # 项目成果
├── shared-knowledge/         # 当前“企业”作用域（企业共享知识与文件）
│   ├── original-files/
│   ├── standardized-files/
│   ├── knowledge/
│   ├── templates/
│   └── outputs/
└── meetings/<meetingId>-workspace/ # 会议录音、转写和纪要工作区
```

逻辑作用域与物理目录的映射由 `scopeType` 决定：`project`（个人/群聊）映射到
`group-chats/<id>-workspace`，`project-shared`（项目）映射到
`projects/<id>`，`shared`（企业）映射到 `shared-knowledge`。路径解析统一由
`apps/desktop/src/main/paths.ts`、`enterprise-project-workspace.ts` 和
`app-file-protocol.ts` 负责，智能体只能通过工具访问允许的工作区前缀。

早期版本曾使用 `personal/`、`enterprise/` 等概念名称；它们不是当前磁盘目录，
文档中仅作为作用域称谓，不应据此手动创建或迁移文件。升级已有工作区时仍会识别
旧的 `project-shared/` 内容并复制到对应项目目录。

标准化全文与知识切片并行生成：标准化文件用于整文/分段读取；切片携带 offset、页码和章节定位，用于 RAG。`temp` 永不参与知识化和普通检索；交付时由系统把真实存在的临时成果提升到 `outputs`。

## 3. 智能体与调度

- 创建群聊及成员变更时，系统把每个成员的公开 `COORDINATION.md`、角色、运行方式、操作平台和已生效技能编译到 `project_agent_coordination`。该表包含统筹自身，是群聊级集中角色注册表；源文件仍是角色公开职责的可编辑事实源。
- 统筹智能体接收用户消息和上下文后先还原目标并判断 `simple / complex / missing-input`。闲聊和自身可回答的简单问题直接回复；简单专业任务只做一次单成员转发；复杂任务必须先形成按业务结果描述的 TODO，再依据集中角色注册表分配成员。
- 复杂 TODO 持久化为 `task_plans + task_nodes` DAG，记录完成标准、依赖、串并行方式、负责人、状态、结果消息和成果引用。`agent_runs` 继续记录底层实际执行，两者分别承担“业务工作树”和“运行轨迹”的职责。
- 本地执行智能体聚合知识化、内部/外部调研、整文读取、模板编写和成果验收技能，在自身 loop 内完成完整工作包。知识管理、资料调研、材料编写、验收不再作为新的独立执行成员；历史 definition/profile/消息仅保留为兼容记录，启动时禁用，不进入成员选择、角色注册表或新 Run 调度。
- 操作智能体负责网页平台和操作技能；会议智能体负责录音/转写/纪要；外接 Kimi Code、CodeBuddy 通过 CLI/ACP 适配器接入。
- 同一实例的 Run 按 FIFO 排队，不同实例按全局并发上限运行；事件流通过主进程广播到群聊。
- 用户 `@` 回复、委派反馈和等待状态由消息路由器关联到原工作树，避免重复创建任务。

执行结果先写消息和临时文件，只有真实文件存在且满足交付条件时才发布 `outputs` 成果。正式消息只发送结论、证据和附件引用，不把 HTML 源码或虚拟路径当作成果。

## 4. 知识与记忆

知识管理负责 OCR、解析、标准化和入库；材料编写、验收和本地执行智能体拥有检索与整文读取权限。检索范围按当前 scope 合并：个人、关联项目、企业共享；未完成知识化的文件不会被假定为已可检索。相同文件以哈希复用标准化结果，避免重复处理。

记忆分为群聊/实例运行记忆、任务临时证据和项目共享知识。记忆写入由主进程统一完成，避免 Renderer 或外部 CLI 直接修改数据库。

## 5. 外部连接

模型统一经 Model Gateway 调用；外部 CLI 由 `packages/agent-core/src/adapters/` 管理。旧的 `codex-adapter.ts`、`claude-code-adapter.ts` 是兼容重导出层，不能作为新代码入口。WorkBuddy MCP 相关实现当前保留为实验性兼容模块，不影响默认群聊链路。

## 6. 开发与验证

```bash
pnpm install
pnpm dev          # Electron 桌面预览
pnpm dev:web      # Renderer 浏览器预览
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm ci-check
```

修改主进程或原生依赖后，应优先运行 `pnpm typecheck`、`pnpm lint` 和受影响包测试，再执行完整 `pnpm ci-check`。构建脚本会自动执行 Electron rebuild；单元测试脚本会先重建 `better-sqlite3`。

## 7. 兼容代码策略

仓库中的 `legacy` 标识、旧群聊目录、旧适配器重导出和旧协议解析用于升级已有工作区及外部调用。它们有明确的迁移/回退职责，不能按普通死代码删除。新功能必须使用分层适配器和当前 workspace 路径 API；待后续版本移除兼容期后，再单独提交迁移删除。
