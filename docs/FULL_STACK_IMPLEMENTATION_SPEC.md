# KLA Workstation 完整前后端技术落地文档

版本：`v1.1`（已对齐仓库结构与身份/权限模型）  
范围：旧版完整业务模块 + 新版登录、身份、企业和权限体系  
算力平台：sub2api 本期不实现，但架构、数据模型与配置已预留对接边界（见 5.5、6.7、13），专项设计见 `DESIGN_SUB2API_COMPUTE_PLATFORM.md`，模型/算力任务见 `NEXT_VERSION_MVP_TASK_PLAN.md` P1-06~P1-10

本文是可直接进入开发阶段的技术规格，不是概念方案。除特别说明外，所有服务端数据以 PostgreSQL 为事实来源，客户端只保存短期缓存和离线草稿。

对齐说明：

- 仓库结构按本仓库实际布局 `apps/desktop`（客户端）+ `server`（服务端）描述（见 §3）。
- 身份/账号/权限表命名采纳《KLA Workstation 账号、身份与权限管理设计》（`user_accounts`/`identities`/`organization_members`/`organization_roles`/`organization_entitlements`），保证与算力平台同步器（sub2api 账号 = 工作身份）映射一致；字段与接口细节以本文为准。

## 1. 目标与边界

### 1.1 需要保留的旧版能力

- 首页与工作站壳层。
- 项目、群聊、消息、回复引用、@、附件和消息流式展示。
- 统筹智能体、本地执行智能体及操作、会议等专用智能体。
- 智能体角色卡、协作注册表、群聊智能体实例和私有工作区。
- 任务拆解、串行/并行委派、父子任务、等待用户、恢复、取消和最终汇总。
- 个人、项目、企业三层工作区。
- 临时文件、标准化文件、知识切片、outputs 成果目录。
- OCR、解析、标准化、切片、Embedding、混合检索和全文分段读取。
- 短期记忆、长期记忆、记忆确认、记忆检索和记忆作用域隔离。
- 文件版本、模板复用、成果预览、发布和回滚。
- 操作平台、操作技能、DOM 工作流、视觉确认和操作智能体群聊协作。
- 会议、转写、会议纪要、代办和项目知识发布。
- 智能体市场、技能管理、渠道管理、设置和管理后台基础能力。

### 1.2 新版能力

- 个人账号注册和登录。
- 企业账号创建、营业执照信息、企业成员和邀请。
- 个人身份、企业管理员身份、企业成员身份。
- 身份切换、默认登录身份和身份隔离。
- 内置管理员/成员角色、自定义角色和权限。
- 服务端保存长期数据，客户端保存短期记忆和缓存。
- 所有资源在服务端按租户、身份和权限判定。

## 2. 总体架构

```text
Electron Renderer (React)
  ├─ 页面、组件、状态、短期缓存
  └─ typed API client / SSE client / WebSocket client
          │ preload bridge（桌面能力）
Electron Main（仅桌面兼容层）
          │ HTTPS
Fastify API Server
  ├─ Auth / Identity / Tenant / Permission
  ├─ Workspace / File / Artifact
  ├─ Knowledge / Memory / Processing Job
  ├─ Conversation / Message / Task / Event
  ├─ Agent / Skill / Operation / Meeting
  ├─ Audit / Admin
  └─ Model Gateway → sub2api（算力中台，本期预留对接边界，见 6.7）
          │
  ├─ PostgreSQL：主数据、权限、消息、任务、审计
  ├─ Redis：Session、队列、锁、流式事件、限流
  ├─ S3/MinIO：原始文件、标准化文件、成果和版本
  └─ Worker：OCR、解析、切片、Embedding、转写、文件转换
```

### 2.1 事实来源

| 数据 | 事实来源 | 客户端缓存 |
|---|---|---|
| 用户、身份、企业、角色、权限 | PostgreSQL | 当前身份摘要 |
| 项目、群聊、消息、任务 | PostgreSQL | 最近消息和未发送草稿 |
| 文件和版本 | PostgreSQL + 对象存储 | 列表和预览缓存 |
| 知识切片和向量 | PostgreSQL + Vector Store | 不缓存敏感全文 |
| 长期记忆 | PostgreSQL；当前允许写入和浏览，暂不检索或应用 | 不进入智能体上下文 |
| 短期记忆 | PostgreSQL 权威记录，保留 365 天 | IndexedDB 缓存近期七天，超出范围按需读取服务器 |
| 运行事件 | Redis Stream + PostgreSQL 归档 | 当前任务事件 |
| 模型用量（model_usage） | PostgreSQL（商务对账事实源） | 不缓存 |

## 3. 仓库结构

```text
（仓库根，pnpm workspace）
├─ apps/desktop/
│  ├─ src/api/                 # API client、SSE、WS、类型
│  ├─ src/auth/                # Session、身份上下文、权限 hook
│  ├─ src/pages/               # 页面
│  ├─ src/components/          # 通用 UI
│  ├─ src/stores/              # 服务端状态与短期状态
│  └─ desktop/                 # Electron 壳与 preload 适配
├─ server/
│  ├─ src/routes/              # HTTP 路由
│  ├─ src/services/            # 业务服务
│  ├─ src/gateway/             # Model Gateway 与 sub2api 适配（预留）
│  ├─ src/repositories/        # PostgreSQL Repository
│  ├─ src/middleware/          # auth、identity、permission
│  ├─ src/workers/             # 知识、转写、文件任务
│  ├─ src/events/              # SSE/WS/Redis Stream
│  ├─ src/contracts/           # Zod/OpenAPI
│  ├─ src/security/            # 密码、Token、密钥、审计
│  └─ migrations/              # 不可变数据库迁移
├─ packages/                   # 预留：前后端共享契约包
├─ docs/                       # 设计文档
└─ pnpm-workspace.yaml
```

## 4. 身份、账号和权限

### 4.1 核心概念

- `UserAccount`：登录账号，可拥有多个身份。
- `Identity`：权限边界。个人身份或企业身份互相隔离。
- `OrganizationMembership`：账号在企业中的成员关系（表 `organization_members`）。
- `Membership`：账号在企业中的成员关系。
- `Role`：企业内角色，内置管理员和成员不可删除。
- `Permission`：资源动作权限。
- `OrganizationEntitlement`：企业权益（token、存储、并发、成员上限等），表 `organization_entitlements`。

权限永远从 Session 的身份上下文推导，不能信任客户端提交的角色名称。

### 4.2 权限动作

```text
read       读取
write      创建或修改
execute    执行任务、技能、智能体或操作
manage     管理成员、角色、智能体和配置
export     下载、导出或对外发送
delete     软删除或停用
```

资源类型：`organization`、`project`、`conversation`、`workspace`、`file`、`knowledge`、`memory`、`agent`、`skill`、`task`、`meeting`、`operation`、`channel`。

### 4.3 鉴权流程

1. 客户端登录提交账号和密码。
2. 服务端验证 Argon2id 密码哈希。
3. 签发短期 Access Token 和轮换 Refresh Token。
4. 客户端后续请求携带 `Authorization: Bearer` 和 `X-Identity-Id`。
5. 服务端根据 Token 找到账号，再验证身份属于该账号且未禁用。
6. Permission Service 根据身份、租户、资源归属和角色判权。
7. 业务 Service 只接收已授权的 `RequestContext`。
8. 所有拒绝、切换和管理操作写入审计日志。

## 5. 数据库设计

以下为最小生产表集合。所有表包含 `id`、`created_at`、`updated_at`；删除默认使用 `deleted_at`。

### 5.1 账号与权限表

```sql
user_accounts(id, email, phone, password_hash, nickname, avatar_object_id, status, email_verified, phone_verified, last_login_at)
sessions(id, user_id, refresh_token_hash, device_name, ip_hash, expires_at, revoked_at)
identities(id, user_id, identity_type, display_name, avatar, status, is_default, permission_version)
organizations(id, name, short_name, business_license_no, status, owner_identity_id)
organization_members(id, organization_id, user_id, identity_id, member_no, department_id, job_title, status, joined_at, removed_at)
organization_roles(id, organization_id, key, name, description, is_system, status)
permissions(id, key, resource, action, description)
role_permissions(role_id, permission_id, scope_type, scope_id)
member_roles(member_id, role_id, assigned_by, assigned_at)
organization_entitlements(id, organization_id, token_quota, token_used, storage_quota, member_limit, project_limit, agent_limit, concurrency_limit, model_scope_json, knowledge_quota, expires_at, status)
audit_logs(id, actor_user_id, identity_id, organization_id, action, resource_type, resource_id, result, metadata_json)
```

约束：账号删除不级联删除企业数据；成员移除立即撤销该身份所有 Session；管理员和成员角色不可修改或删除。
权限 `key` 采用 `resource.action` 形式（如 `project.view`）；`scope_type ∈ own/assigned/project/department/organization/all`，由 `role_permissions.scope_type/scope_id` 落地。
个人算力额度不使用 `organization_entitlements`，由平台个人额度台账管理（见《DESIGN_SUB2API_COMPUTE_PLATFORM.md》4.3）。

### 5.2 项目、群聊和任务表

```sql
projects(id, organization_id, owner_identity_id, name, description, status)
project_members(project_id, identity_id, role, status)
conversations(id, project_id, organization_id, name, status, created_by_identity_id)
conversation_members(conversation_id, identity_id, member_type, status)
conversation_agents(id, conversation_id, agent_profile_id, role_card_snapshot_json, status)
messages(id, conversation_id, sender_type, sender_id, content_json, reply_to_id, idempotency_key, status)
tasks(id, conversation_id, root_task_id, parent_task_id, assigned_agent_id, status, mode, instruction, result_json)
task_dependencies(task_id, depends_on_task_id)
task_events(id, task_id, sequence, event_type, payload_json, created_at)
```

`messages.idempotency_key` 建立唯一索引，防止重复发送；`task_events.sequence` 保证事件顺序。

### 5.3 工作区、文件和成果表

```sql
workspaces(id, scope_type, scope_id, organization_id, name, status)
workspace_members(workspace_id, identity_id, permission_json)
files(id, workspace_id, parent_id, name, relative_path, mime_type, sha256, size, status)
file_versions(id, file_id, object_key, sha256, size, created_by_identity_id, status)
file_permissions(file_id, identity_id, role, expires_at)
artifacts(id, task_id, file_version_id, artifact_type, status, published_at)
templates(id, workspace_id, file_id, name, metadata_json)
```

目录逻辑：`original-files`、`standardized-files`、`knowledge`、`temp/<rootTaskId>`、`outputs`、`templates`。`temp` 不进入普通知识化和检索。

### 5.4 知识和记忆表

```sql
knowledge_sources(id, workspace_id, file_id, version_id, status, parser_version, ocr_version)
knowledge_chunks(id, source_id, chunk_index, content, start_offset, end_offset, page_no, chapter, embedding_id, permission_snapshot_json)
knowledge_items(id, source_id, title, summary, tags_json, status, confidence)
knowledge_jobs(id, source_id, type, status, progress, error_code, error_message)
memories(id, owner_identity_id, scope_type, scope_id, kind, content, summary, confidence, source_task_id, status)
memory_embeddings(memory_id, embedding_id, model_version)
memory_confirmations(id, memory_id, confirmed_by_identity_id, action, created_at)
```

知识检索和记忆检索必须在召回前过滤 `organization_id/project_id/conversation_id/identity_id` 权限范围。

### 5.5 算力与用量表（sub2api 对接预留）

本期仅建表和保留字段，不实现同步与调用；设计见《DESIGN_SUB2API_COMPUTE_PLATFORM.md》§9、§13。

```sql
model_usage(id, identity_id, organization_id, project_id, conversation_id, task_id, agent_id, model, slot, input_tokens, output_tokens, cached_tokens, latency_ms, status, cost, created_at)
compute_binding(id, identity_id, sub2api_user_id, group_bindings_json, status, credential_ref)
entitlement_ledger(id, organization_id, identity_id, amount, source_entitlement, idempotency_key, approval_id, status, reconciliation_hash)
key_registry(id, identity_id, key_ref, fingerprint, purpose, identity_context, status)
usage_sync_log(id, identity_id, window_start, window_end, detail_hash, reconcile_status, diff_flag)
```

- `model_usage` 是商务对账事实源；业务标签（用户/项目/群聊/任务/身份）只落这里，与 sub2api 明细靠 key + 时间窗对齐。
- `compute_binding` 是「工作身份 ↔ sub2api 账号」映射主键：sub2api 账号 = KLA 工作身份（企业身份与个人身份都建号）。
- Embedding、OCR、Whisper 不经 sub2api，由 Worker 直接配置上游。

## 6. 后端模块实现

### 6.1 API 基础层

- Fastify + TypeScript。
- Zod 校验请求和响应。
- 统一响应：`{ ok, data, meta }`。
- 统一错误：`{ ok:false, error:{code,message,retryable}, meta }`。
- `X-Request-Id` 贯穿日志、任务和审计。
- `Idempotency-Key` 用于写操作。
- 全局超时、限流、CORS、内容大小和 JSON 深度限制。

### 6.2 Auth/Identity/Permission Service

实现：

- 注册、登录、Refresh、退出、设备会话。
- 密码重置和账号状态。
- 个人身份创建。
- 创建企业并生成管理员身份。
- 邀请、加入和移除成员。
- 身份激活和默认身份。
- RBAC 判权和权限版本缓存。

关键接口：

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/sessions
GET  /api/v1/me
GET  /api/v1/me/identities
POST /api/v1/me/identities/{id}/activate
PUT  /api/v1/me/identities/{id}/default
GET  /api/v1/me/permissions
POST /api/v1/organizations
GET  /api/v1/organizations/{id}/members
POST /api/v1/organizations/{id}/invitations
POST /api/v1/invitations/{token}/accept
GET  /api/v1/organizations/{id}/roles
PUT  /api/v1/organizations/{id}/roles/{roleId}
```

### 6.3 Workspace/File Service

上传采用：创建上传会话 → 预签名 URL/分片上传 → complete 校验 SHA-256 → 创建文件版本 → 触发知识任务。

接口：

```text
GET  /api/v1/workspaces
GET  /api/v1/workspaces/{id}
GET  /api/v1/files
POST /api/v1/files/upload-sessions
POST /api/v1/files/upload-sessions/{id}/complete
GET  /api/v1/files/{id}
GET  /api/v1/files/{id}/content
GET  /api/v1/files/{id}/versions
POST /api/v1/files/{id}/versions
POST /api/v1/files/{id}/publish
PATCH /api/v1/files/{id}
DELETE /api/v1/files/{id}
POST /api/v1/artifacts/{id}/publish
POST /api/v1/artifacts/{id}/rollback
```

### 6.4 Knowledge Service

处理流水线：

```text
文件完成上传
 → 病毒/类型检查
 → 原文归档
 → OCR/解析
 → standardized-files
 → 切片（offset/page/chapter）
 → embedding
 → 向量与全文索引
 → source ready
```

接口：

```text
POST /api/v1/knowledge/ingestions
GET  /api/v1/knowledge/ingestions/{jobId}
GET  /api/v1/knowledge/sources
GET  /api/v1/knowledge/sources/{id}
POST /api/v1/knowledge/search
POST /api/v1/knowledge/documents/{id}/read
GET  /api/v1/knowledge/documents/{id}/outline
GET  /api/v1/knowledge/items
POST /api/v1/knowledge/items/{id}/review
DELETE /api/v1/knowledge/sources/{id}
```

`read` 支持 `pageStart/pageEnd/startOffset/endOffset/chapter/cursor`，返回 `READ_COMPLETE` 和下一段游标，确保长文覆盖完整。

### 6.5 Memory Service

记忆分层：

- 短期：服务器按身份、群组、智能体保存，保留 365 天；客户端按服务器、账号、身份隔离缓存最近七天。缓存只用于查看，不作为模型输入的权威来源。
- 时间衰减：延续旧版 72 小时半衰期，达到 30 天硬归零；归零后只作历史查看，不再自动注入上下文。读取不刷新强化时间。
- 会话摘要：当前真实 REST 对话成功回复后，由服务器保存确定性的短期任务摘要，不额外调用模型；同一运行重复保存幂等。
- 上下文：共享用户输入和对应智能体最近消息最多 12 条，另从 40 条候选短期摘要中按旧版综合评分选择最多三条，每条最多 400 字符。其他群组 / 智能体私有记忆不混入。
- 长期：服务端保存固化记录，无时间衰减权重。当前允许写入及只读浏览，禁止自动检索和上下文应用；自动提炼 / 应用留待后续启用。
- 共享：只有显式发布到项目/企业工作区的记忆才对其他成员可见。

接口：

```text
GET    /api/v1/memories
POST   /api/v1/memories/search
POST   /api/v1/memories
PATCH  /api/v1/memories/{id}
POST   /api/v1/memories/{id}/confirm
DELETE /api/v1/memories/{id}
POST   /api/v1/memories/batch-upload
```

记忆写入必须携带来源任务、来源消息、作用域、置信度和保留策略；不得将未经确认的群聊原文直接升级为企业长期记忆。

当前记忆页面使用只读接口 `GET /api/v1/memories/browser/scopes` 和 `GET /api/v1/memories/browser`，支持项目、群组、来源智能体、长短期及创建时间范围筛选。历史浏览覆盖一年，与模型的最多 12 条消息窗口独立。客户端七天缓存、服务端保留清理、当前真实对话接入边界见 [MEMORY_LIFECYCLE.md](./MEMORY_LIFECYCLE.md)，浏览字段及口径见 [MEMORY_BROWSER.md](./MEMORY_BROWSER.md)。本节列出的确认、批量上传属于目标接口，不代表本次新增实现。

### 6.6 Conversation/Task Service

消息流程：

1. 校验身份和群聊写权限。
2. 使用幂等键插入用户消息。
3. 解析引用、@、附件和工作区上下文。
4. 创建 root task。
5. 发布 `task.created` 和 `message.committed`。
6. 调度统筹智能体。
7. 持续写入 task event 和流式消息。
8. 完成后写最终消息、成果关联和记忆摘要。

接口：

```text
GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/conversations
POST /api/v1/conversations
GET  /api/v1/conversations/{id}
GET  /api/v1/conversations/{id}/messages
POST /api/v1/conversations/{id}/messages
GET  /api/v1/tasks
GET  /api/v1/tasks/{id}
POST /api/v1/tasks/{id}/cancel
POST /api/v1/tasks/{id}/retry
GET  /api/v1/tasks/{id}/events
GET  /api/v1/events/stream
```

### 6.7 Model Gateway 与 sub2api 对接边界（预留）

- 所有模型调用（智能体、技能、操作的推理请求）统一经服务端 Model Gateway 出口，业务 Service 禁止直连上游 Provider；本期 Gateway 可先直连配置的 Provider，但接口形态按算力中台适配设计（见《DESIGN_SUB2API_COMPUTE_PLATFORM.md》§6、§13.3）。
- Gateway 按服务端重建的身份上下文（`identityId` → `compute_binding`）选择对应工作身份的 key；`sk-` 明文与 Admin API Key 只存在于服务端密钥存储，不进 Renderer、消息和日志。
- 每次调用写 `model_usage`（用户/项目/群聊/任务/身份标签）；usage_sync 定时任务回流扣减 `organization_entitlements.token_used`。
- 错误码与流式语义沿用 §6.1；预留 sub2api/上游错误映射位，不改变客户端错误契约。
- 同步器（建号、额度、停用、漂移检测）为独立 worker 进程，Outbox 模式；永不创建 admin 角色账号，托管账号永不开 2FA、不改密码。

## 7. 智能体调度落地

### 7.1 角色注册表

群聊创建时生成 `conversation_agents` 和角色卡快照。统筹智能体读取注册表，不逐个扫描文件：

```text
orchestrator：理解目标、判断复杂度、委派、汇总
local-executor：文件、知识、调研、写作、验收闭环
operation-agent：绑定平台的网页操作和结果分析
meeting-agent：转写、说话人确认、纪要和代办
external-agent：Kimi/CodeBuddy 等外部执行器
```

角色卡包含：职责、输入格式、输出格式、权限、工作区、可调用技能、协作对象和禁止事项。
角色卡中的模型绑定按 reasoning/fast/embedding 槽位由 Model Gateway 解析（映射配置存服务端配置表，按 sub2api 分组）；角色卡不保存上游地址或密钥。

### 7.2 统筹 Loop

```text
读取用户消息和上下文
 → 判断闲聊/单智能体/多智能体
 → 简单任务直接回复
 → 单委派：只发送一次简洁 @ 委派
 → 复杂任务生成宏观 Todo
 → 根据注册表选择成员
 → 按依赖串行或独立项并行
 → 等待子任务事件
 → 判断缺口、重试/换人/继续
 → 服务端确认成果存在
 → 汇总并面向用户交付
```

统筹不能把本地执行智能体内部的知识检索、材料编写、验收再拆成外部任务；这些是本地执行智能体的内部 Loop。

### 7.3 任务状态

```text
queued → planning → delegated → running → waiting_user
running → completed
running → failed → retrying
任何运行态 → cancelled/interrupted
```

状态变更必须原子写入任务表并追加事件；客户端依据事件序号去重，不根据本地计时器推断完成。

## 8. 前端对接实现

### 8.1 API Client

- 自动注入 Access Token 和身份 ID。
- 401 自动刷新一次，失败清理 Session 并跳转登录。
- 403 显示权限不足，不重试。
- 写操作自动生成 `X-Request-Id` 和 `Idempotency-Key`。
- 服务端列表使用 React Query 或等价缓存。

### 8.2 页面接入顺序

1. 登录/注册/身份切换。
2. 项目和群聊树。
3. 群聊消息与任务事件。
4. 工作区和文件。
5. 知识库和全文读取。
6. 记忆管理。
7. 智能体和技能。
8. 操作和会议。
9. 管理后台。

所有页面通过 API Client 读取，不直接访问数据库或本地绝对路径。

### 8.3 SSE 事件

```text
message.committed
message.delta
task.created
task.status
task.event
task.completed
artifact.created
knowledge.job.progress
memory.updated
permission.updated
```

事件必须包含 `eventId`、`sequence`、`identityId`、`scope` 和 `createdAt`。客户端保存最后序号，重连时携带 `Last-Event-ID`。

## 9. 操作智能体与会议模块

### 9.1 操作

服务端保存：平台、URL、描述、绑定模型引用、技能版本、DOM 工作流、视觉证据和生效状态。

```text
GET  /api/v1/operation-platforms
POST /api/v1/operation-platforms
GET  /api/v1/operation-platforms/{id}
POST /api/v1/operation-platforms/{id}/sessions
POST /api/v1/operation-platforms/{id}/skills
GET  /api/v1/operation-platforms/{id}/skills
POST /api/v1/operation-skills/{id}/activate
POST /api/v1/operation-skills/{id}/revoke
POST /api/v1/operation-platforms/{id}/runs
GET  /api/v1/operation-runs/{id}
```

技能执行属于任务子树，操作智能体完成 DOM/视觉 loop 后返回业务结果，不把原始页面直接交给统筹。

### 9.2 会议

```text
GET  /api/v1/meetings
POST /api/v1/meetings
POST /api/v1/meetings/{id}/recording
GET  /api/v1/meetings/{id}/transcript
GET  /api/v1/meetings/{id}/minutes
POST /api/v1/meetings/{id}/knowledge-publish
GET  /api/v1/meetings/{id}/events
```

录音上传触发转写 Job；确认后的说话人、纪要和知识内容写入项目工作区。

## 10. 安全、审计和可靠性

- 密码使用 Argon2id，禁止明文和可逆加密。
- Refresh Token 只保存哈希，轮换后旧 Token 立即失效。
- API 密钥只保存于服务端密钥管理或加密 Secret，不进入消息、日志和前端。
- 每个查询先判身份和权限，再查询数据库，禁止客户端全量拉取后过滤。
- 文件名、路径、HTML 预览均进行路径穿越和 XSS 防护。
- Worker 任务有最大执行时间、重试次数和死信队列。
- 所有外部工具、MCP、操作技能和文件发布写审计。
- 生产环境启用 HTTPS、CORS 白名单、限流、备份和告警。

## 11. 旧版数据迁移

1. 扫描旧 SQLite 项目、群聊、消息、文件和智能体实例。
2. 建立旧 ID 到新 UUID 的映射表。
3. 先迁移个人账号和个人身份，再迁移项目和群聊。
4. 文件按 SHA-256 上传对象存储，重复文件只保存一份对象。
5. 旧工作区目录映射到 `workspaces` 和 `files`。
6. 旧消息保留原创建时间、发送者映射和引用关系。
7. 旧记忆默认归属原群聊/个人，不自动升级为企业共享记忆。
8. 迁移后生成校验报告：数量、哈希、引用、权限和孤儿数据。
9. 只读运行旧版一段时间，确认新版本后再关闭旧写入。

## 12. 开发阶段和并行拆分

### P0 基础并行

- 契约与共享类型。
- PostgreSQL/Redis/对象存储。
- Auth/Identity/Permission。
- 前端登录和身份壳层。

### P1 业务并行

- Workspace/File/Artifact。
- Knowledge/Memory/Processing Worker。
- Conversation/Task/Event。
- Agent/Skill/Operation/Meeting。

### P2 集成和迁移

- 旧 SQLite 迁移。
- 前端页面全部替换真实 API。
- SSE/WS 断线恢复。
- 权限矩阵和跨租户测试。
- 灰度发布和回滚。

每个模块必须同时提交：数据库迁移、Repository、Service、路由、OpenAPI 类型、单元测试、权限测试和最小前端联调页面。

阶段映射（三套计划已对齐，执行口径以《NEXT_VERSION_MVP_TASK_PLAN.md》任务编号为准）：

- 本文 P0（契约与基础设施、Auth/Identity/Permission、前端壳层）对应 TASK_PLAN P0、P2，DELIVERY_PLAN A–D 组 / M0–M1。
- 本文 P1（Workspace/File、Knowledge/Memory/Worker、Conversation/Task、Agent/Skill/Operation/Meeting）对应 TASK_PLAN P1、P3–P7，DELIVERY_PLAN E–H 组 / M2–M3。
- 本文 P2（旧库迁移、真实 API 替换、SSE/WS 恢复、权限矩阵、灰度回滚）对应 TASK_PLAN P8，DELIVERY_PLAN M4。
- 算力/sub2api 任务（P1-06~P1-10、P5-09、P8-03 三方对账）见《DESIGN_SUB2API_COMPUTE_PLATFORM.md》§10 修订表。

## 13. 环境变量

```env
NODE_ENV=development
PORT=8787
DATABASE_URL=postgresql://kla:kla@localhost:5432/kla
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=<random>
JWT_REFRESH_SECRET=<random>
OBJECT_STORAGE_ENDPOINT=http://localhost:9000
OBJECT_STORAGE_BUCKET=kla-workstation
OBJECT_STORAGE_ACCESS_KEY=<manual>
OBJECT_STORAGE_SECRET_KEY=<manual>
VECTOR_STORE_URL=<manual>
OCR_WORKER_URL=<manual>
WHISPER_WORKER_URL=<manual>
SUB2API_BASE_URL=<manual>
SUB2API_ADMIN_KEY=<secret manager 注入>
CREDENTIAL_MASTER_KEY=<托管密码字段级加密主密钥>
GROUP_CHAT=<sub2api 分组 id>
GROUP_LITE=<sub2api 分组 id>
GROUP_EMBEDDING=<sub2api 分组 id>
GROUP_PERSONAL=<sub2api 分组 id>
VITE_API_BASE_URL=http://127.0.0.1:8787/api
```

## 14. 验收清单

- 未登录访问受保护 API 返回 401。
- 无权限访问返回 403 且不泄露资源。
- 身份切换后旧身份资源不可见。
- 企业管理员可以管理成员和自定义角色，成员不能访问管理接口。
- 项目、群聊、文件、知识、记忆和任务均正确隔离。
- 消息幂等、引用、@、流式事件和断线恢复正常。
- OCR/切片/Embedding/检索任务可查询进度和失败原因。
- 完整文件读取能够通过游标覆盖全文。
- 短期记忆不会自动成为共享长期记忆。
- 文件必须由服务端确认存在后才能发布或交付。
- 操作技能注销后不可调用，会议知识发布受权限控制。
- 旧版迁移数量、哈希、引用和权限校验通过。
- 所有模型调用经 Model Gateway 出口并写入 `model_usage`，业务代码无直连上游 Provider。
- 算力开通后：sub2api 账号同步、额度熔断、离职停用与三方对账用例通过（《DESIGN_SUB2API_COMPUTE_PLATFORM.md》§15、§16）。
- 前后端 typecheck、lint、单元、契约、集成和端到端测试通过。
