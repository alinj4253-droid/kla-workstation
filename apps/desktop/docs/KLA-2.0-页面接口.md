# 鲲擎 2.0 页面接口草案

> 前后端联调契约草案。本轮前端未请求这些接口，`server` 未修改。路径和字段须与后端负责人确认后冻结；所有接口统一以当前登录身份授权，不接受前端自报租户或权限。时间使用 ISO 8601，金额以字符串/最小货币单位返回，Token 计数为整数。

## 通用约定

- Base URL：`VITE_KLA_API_BASE_URL`（待配置）；认证建议 HttpOnly 安全 Cookie 或短期访问令牌配合刷新机制。`GET /api/v1/me` 返回用户、当前身份、身份列表、权限与默认身份。
- 分页：`cursor`、`limit`，响应 `{ items, nextCursor }`；错误 `{ code, message, requestId, details? }`。401 触发重新登录，403 展示无权限，409 展示冲突，429 展示限流。
- 所有写入接口支持 `Idempotency-Key`；消息发送、文件上传与费用操作必须防重复提交。服务端依据身份检查企业、项目和个人空间权限。

## 登录与身份

| 方法 | 路径 | 请求 | 响应/用途 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | `{ account, password, identityType: "personal" | "enterprise" }` | `{ user, identities, currentIdentity, expiresAt }` |
| POST | `/api/v1/auth/logout` | 无 | 清理会话 |
| GET | `/api/v1/me` | 无 | 用户、身份、权限、展示名称 |
| POST | `/api/v1/identities/switch` | `{ identityId }` | 新会话范围及身份摘要 |

## 首页与项目

| 方法 | 路径 | 请求/查询 | 响应/用途 |
| --- | --- | --- | --- |
| GET | `/api/v1/home/summary` | 当前身份 | `{ availableTokens, appsCount, knowledgeCount, memoryCount, coreModels, serviceStatus }` |
| GET | `/api/v1/tasks` | `status, cursor, limit` | 待办列表 |
| GET | `/api/v1/projects` | `q, cursor, limit` | `{ id, name, description, progress, memberCount, updatedAt }[]` |
| POST | `/api/v1/projects` | `{ name, description? }` | 创建的项目 |
| GET | `/api/v1/projects/{id}/dashboard` | 时间范围 | `{ completedTasks, totalTasks, trend[], milestones[], members[], activity[] }` |

## 群聊

| 方法 | 路径 | 请求/查询 | 响应/用途 |
| --- | --- | --- | --- |
| GET | `/api/v1/chats` | `projectId?, q?, cursor?, limit?` | 群组摘要及最后消息 |
| POST | `/api/v1/chats` | `{ name, projectId?, memberIds?, agentIds? }` | 新群组 |
| GET | `/api/v1/chats/{id}/messages` | `before?, limit?` | `{ id, sender: { id, type, displayName }, content, attachments[], createdAt, status }[]` |
| POST | `/api/v1/chats/{id}/messages` | `{ clientMessageId, text, mentions[], attachmentIds[] }` | 消息确认 ID、时间及状态 |
| GET | `/api/v1/chats/{id}/events` | SSE 或 WebSocket | 增量消息、智能体状态、编辑与撤回事件 |

## 知识库

| 方法 | 路径 | 请求/查询 | 响应/用途 |
| --- | --- | --- | --- |
| GET | `/api/v1/knowledge/spaces` | 当前身份 | `{ id, type: enterprise/project/personal, projectId?, name, permissions }[]` |
| GET | `/api/v1/knowledge/documents` | `spaceId, q?, status?, cursor?, limit?` | 文件名称、大小、类型、处理状态、更新时间 |
| POST | `/api/v1/knowledge/uploads` | `{ spaceId, filename, size, checksum, contentType }` | 上传会话或签名 URL |
| POST | `/api/v1/knowledge/uploads/{id}/complete` | 校验值 | `{ documentId, jobId, status }` |
| GET | `/api/v1/knowledge/jobs/{id}` | 无 | `{ status, stage, progress, errorCode? }` |
| GET | `/api/v1/knowledge/documents/{id}` | 无 | 元数据、可预览链接（短期授权） |
| POST | `/api/v1/knowledge/query` | `{ spaceIds[], question, cursor? }` | 答案、引用文档与定位信息 |

## 算力中心

| 方法 | 路径 | 请求/查询 | 响应/用途 |
| --- | --- | --- | --- |
| GET | `/api/v1/compute/summary` | `from, to, granularity?` | 余额、密钥、请求、费用、Token、响应指标、趋势与分布 |
| GET | `/api/v1/compute/keys` | `q?, status?, cursor?, limit?` | 掩码密钥、分组、状态、配额与创建时间 |
| POST | `/api/v1/compute/keys` | `{ name, groupId?, expiresAt? }` | 创建结果及**仅一次**完整密钥 |
| PATCH | `/api/v1/compute/keys/{id}` | `{ enabled }` | 更新后状态 |
| GET | `/api/v1/compute/usage` | `from, to, modelId?, keyId?, status?, cursor?, limit?` | 请求时间、模型、Token、金额、状态 |
| POST | `/api/v1/compute/usage/exports` | 同上筛选条件 | 异步导出任务 ID；下载需鉴权 |
| GET | `/api/v1/compute/models` | `q?, category?, cursor?, limit?` | 模型能力、上下文、延迟、价格、状态 |
| GET | `/api/v1/compute/models/selected` | 当前身份 | 已选模型 ID 列表 |
| PUT | `/api/v1/compute/models/selected/{id}` | 无 | 选用模型 |
| DELETE | `/api/v1/compute/models/selected/{id}` | 无 | 移除模型 |
| POST | `/api/v1/compute/models/{id}/benchmark` | 无 | 测速任务/结果，服务端限流 |

## 设置 / 智能体管理

| 方法 | 路径 | 请求/查询 | 响应/用途 |
| --- | --- | --- | --- |
| GET | `/api/v1/agents` | `type?, q?, cursor?, limit?`，当前身份 | `{ items: [{ id, name, role, type, modelId, skills, enabled, connectionStatus, version }], nextCursor }`，按权限过滤 |
| POST | `/api/v1/agents` | `{ name, role?, modelId, type: "custom" }`，`Idempotency-Key` | 新建自定义智能体；名称冲突返回 409 |
| GET | `/api/v1/agents/{id}` | 无 | 角色配置、可用模型、技能及权限详情 |
| PATCH | `/api/v1/agents/{id}` | `{ role?, modelId?, enabled?, version }` | 更新配置，版本冲突返回 409，禁止越权修改 |
| GET | `/api/v1/agents/{id}/capabilities` | 无 | 可挂载技能及授权能力清单，后续版本接入 |

所有接口须以会话身份解析租户范围；官方与外接智能体的模型编辑和启停策略由服务端授权，第三方连接状态不可仅由前端启用开关推断。写入记录操作者、身份、时间和变更字段。模型选择应使用模型 ID，而非展示名称。

## 联调顺序

1. 冻结认证与身份契约，打通 `/me` 及权限错误处理。
2. 项目与群聊列表/消息接通，完成游标翻页和实时事件去重。
3. 知识空间、上传、作业状态、文档预览及检索联调。
4. 算力只读指标及模型目录先接通，再接密钥管理、导出与模型选用；费用数据由计量系统核准。
