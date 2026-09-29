# KLA Workstation 下一版本 MVP 技术开发文档

> 本文只描述技术架构、服务边界、数据模型、接口、迁移和实施顺序。
> 产品需求见 `docs/NEXT_VERSION_MVP_REQUIREMENTS.md`。
> 状态注记（对齐）：总体架构与 sub2api/Model Gateway 设计仍有效；数据模型、知识/记忆/文件的接口路径与字段以《FULL_STACK_IMPLEMENTATION_SPEC.md》为实现规格（冲突时以它为准）；sub2api 专项以《DESIGN_SUB2API_COMPUTE_PLATFORM.md》为准。

## 1. 目标架构

```text
Electron 工作站
  Renderer：页面、消息流、文件选择、缓存视图
  Preload：类型化 API、会话桥接
  Main：短期记忆、上传分片、队列、服务端客户端、离线重试

KLA 服务端
  API Gateway/Auth：租户、登录、会话、权限
  Knowledge Service：解析/OCR、标准化、切片、embedding、检索
  Artifact Service：临时产物、成果、版本、预览
  Memory Service：长期记忆和摘要提升
  Agent Orchestrator：任务、技能、MCP、运行审计
  Model Gateway：模型路由、流式响应、重试、用量事件
  sub2api：模型中转、路由、配额和计费数据
  Metadata DB + Object Storage + Vector DB + Queue
```

服务端是知识、成果、长期记忆和审计的事实源。客户端只保留加密短期记忆、上传缓存、流式恢复点和未同步草稿。

## 2. 服务端数据模型

| 实体 | 关键字段 |
|---|---|
| tenant/user | 租户、用户和状态 |
| resource_scope | 类型、项目、群聊 |
| permission_binding | 主体、资源、动作、过期时间 |
| file | 作用域、SHA-256、名称、媒体类型、状态 |
| knowledge_version | 文件、版本、解析器、状态 |
| knowledge_chunk | 文本、offset、页码、章节、ACL |
| embedding | 切片、模型、向量引用 |
| task_run | 用户、项目、群聊、智能体、状态 |
| artifact | 任务、作用域、名称、版本、对象引用 |
| memory | 作用域、类型、来源、置信度、ACL |
| model_usage | 用户、项目、智能体、任务、模型、token、费用、延迟 |
| mcp_server/tool | 注册、版本、授权、超时、审计状态 |

同一租户内按 SHA-256 复用原始对象和处理结果；不同作用域仍单独建立权限关联。文件更新产生新知识版本，旧版本保留审计但默认不参与检索。

## 3. 知识服务实现

异步链路：

```text
upload session → object upload → complete
→ parse/OCR → normalized text → chunk
→ embedding → index publish → ready
```

每个阶段写入幂等键、状态、错误、重试次数、处理器版本和时间戳；只有 `ready` 版本加入索引。HTML、Word、Markdown、TXT、可解析 PDF 走原生解析，图片型 PDF/图片走 OCR。标准化全文放对象存储；切片记录 offset、页码、章节；全文读取按 offset/页码/分段返回。

建议 API：

```text
POST /api/v1/files/upload-sessions
POST /api/v1/files/{fileId}/complete
GET  /api/v1/files/{fileId}
POST /api/v1/knowledge/jobs
GET  /api/v1/knowledge/jobs/{jobId}
POST /api/v1/knowledge/jobs/{jobId}/retry
GET  /api/v1/knowledge/search
POST /api/v1/knowledge/fulltext/read
GET  /api/v1/knowledge/files/{fileId}/versions
```

检索和全文读取必须携带用户身份及 `scope/projectId/groupId`，服务端先判权再查询，禁止客户端拉取全量后过滤。返回 `sourceId`、文件、版本、位置、权限标签和分数。

## 4. 权限与记忆实现

采用租户 + 资源作用域 + RBAC/策略。服务端中间件统一执行 `read/write/execute/manage/export`，并将判权结果传给知识、成果、智能体、MCP 和用量服务。上传、下载、预览、全文、检索、知识任务、智能体/技能/MCP 执行、成果发布、长期记忆、算力配置和用量查看均必须校验并审计。

短期记忆由桌面端按群聊/项目/任务隔离，设置上限和 TTL。任务结束或用户确认时生成摘要，调用 Memory Service 的幂等写入接口；上传前去重、脱敏和权限标注。

```text
POST /api/v1/memory/promote
GET  /api/v1/memory/search
PATCH /api/v1/memory/{memoryId}
DELETE /api/v1/memory/{memoryId}
```

## 5. sub2api 与算力接入

```text
Agent Runtime → KLA Model Gateway → sub2api → upstream model
                         ↓
                usage/billing events
```

KLA Model Gateway 负责模型选择、上下文策略、流式转发、超时、有限重试和业务标签；sub2api 负责上游中转、路由和用量数据。记录租户、用户、项目、群聊、智能体、任务、模型、输入/输出/缓存 token、耗时、状态和费用。sub2api 管理密钥不进入 Renderer。

## 6. 智能体、技能与 MCP

- 统筹智能体读取群聊角色注册表，生成任务 DAG 并委派。
- 文档编写智能体聚合检索、全文读取、调研、模板、编写和基础验收技能。
- PPT 与数据分析智能体拥有版本化默认技能和输入/输出契约。
- MCP 注册包含服务器、工具发现、授权范围、超时、撤销和调用审计。
- 学习结果先写技能/偏好草稿；发布由用户或管理员确认，保留 diff、版本和回滚点。

技能运行时携带 `tenantId/userId/scopeId/taskRunId/agentId`，调用前重新判权，输出写入 Artifact Service 而非本地路径。

## 7. 前端与兼容迁移

新增概览、项目群聊、知识库、智能体市场页面；Renderer 不直接访问 Node、数据库、对象存储或 sub2api，所有能力经 preload 类型化桥接。

旧工作区迁移：扫描文件元数据和哈希 → 分片上传 → 服务端去重并建立作用域关联 → 本地结果只读 → 成功后以服务端版本为准。迁移失败不得删除本地数据。旧路由、数据库表和外接适配器保留兼容期。

## 8. 实施顺序与验证

1. 服务端工程、认证、租户、对象存储、元数据 DB、队列和权限中间件。
2. 文件上传、解析/OCR、标准化、切片、embedding、检索和全文读取。
3. 真实文件端到端联调和迁移工具。
4. sub2api、Model Gateway、流式调用和用量事件。
5. 新信息架构及 Renderer/preload 对接。
6. 注册 PPT、数据分析、文档编写智能体及默认技能/MCP。
7. 权限矩阵、跨项目隔离、断线重试、幂等、检索质量、用量对账和迁移回滚测试。

## 9. 非功能要求

- 写接口支持幂等键；队列重试有上限并进入可观测死信状态。
- 日志脱敏，文件内容和模型密钥不得写入普通日志。
- 关键操作具备审计 ID，前后端可按任务追踪。
- 服务端不可用时显示离线/待同步状态，不伪造成功。
- 生产技能、权限和系统提示词必须支持审批和回滚。

