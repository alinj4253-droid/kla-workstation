# API 契约索引与冻结流程

> 本文是前后端契约的**索引与流程约定**；接口的业务定义以《FULL_STACK_IMPLEMENTATION_SPEC.md》§6 为事实源，机器可读契约为 `packages/contracts`（`@kla-workstation/contracts`）。

## 1. 契约包现状（M0/M1 范围）

| 模块 | 内容 |
|---|---|
| `envelope.ts` | 统一响应信封 `ApiOk<T>` / `ApiError`（`{ ok, error: { code, message, retryable }, meta.requestId }`）、分页参数与分页元数据 |
| `errors.ts` | `ErrorCode` 12 个枚举 + `retryable` 规则 + `apiError()` 工厂 |
| `headers.ts` | `x-request-id` / `idempotency-key` / `x-identity-id` / `authorization` |
| `events.ts` | SSE 事件名（10 个）+ 事件封套 schema（`eventId`/`sequence`/`identityId`/`scope`/`createdAt`） |
| `user.ts` `auth.ts` `identity.ts` | 用户/身份/会话 DTO、注册/登录/刷新/会话列表、`/me`、身份激活与默认、权限响应 |
| `organizations.ts` | 企业创建、角色、成员、邀请骨架（C 组 M1 范围） |
| `projects.ts` | 项目/群聊/消息 DTO 与请求（现有已实现接口） |

## 2. 统一约定

- **成功**：`{ ok: true, data, meta?: { requestId } }`；**失败**：`{ ok: false, error: { code, message, retryable }, meta?: { requestId } }`。
- **错误码**：`UNAUTHENTICATED` / `INVALID_CREDENTIALS` / `INVALID_ARGUMENT` / `VALIDATION_FAILED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `IDEMPOTENCY_CONFLICT` / `RATE_LIMITED` / `NOT_IMPLEMENTED` / `INTERNAL` / `UNAVAILABLE`。`RATE_LIMITED`、`UNAVAILABLE`、`INTERNAL` 默认 `retryable: true`，其余默认 `false`（可用 `apiError(..., { retryable })` 覆盖）。
- **请求头**：所有响应携带 `x-request-id`；写操作携带 `idempotency-key`（由客户端生成）；身份相关请求携带 `x-identity-id`。
- **分页**：查询参数 `page`（默认 1）、`pageSize`（默认 20，上限 100）；返回 `{ items, page: { page, pageSize, total } }`。
- **时间**：一律 RFC 3339（`z.string().datetime()`）；**ID**：当前不限定格式，B 组定稿（建议 UUID v7）后统一收紧。
- **SSE**：事件封套必含 `eventId`、`sequence`、`identityId`、`scope`、`createdAt`；客户端保存最后 `sequence`，重连带 `Last-Event-ID`。

## 3. 契约冻结与变更流程

1. **契约先行**：各组开工前冻结本组 schema（进 `packages/contracts`）；未冻结不得开发业务分支（主计划 §3.0）。
2. **变更三同步**：修改契约必须同批次更新——① `packages/contracts` schema 与测试；② server 路由/测试；③ desktop 类型与页面调用。
3. **破坏性变更**：需在主计划里程碑处集中评审；迁移必须向前兼容。
4. **状态跟踪**：契约冻结状态登记在《NEXT_VERSION_MVP_TASK_PLAN.md》对应任务行，不在此处维护。

## 4. 校验接入策略

| 阶段 | 策略 |
|---|---|
| 当前（M0） | **类型级最小接入**：server/desktop 仅 `import type` 引用契约（错误信封 `satisfies ApiErrorBody`），无逐路由运行时校验 |
| M1 收口 | C 组 `auth/identity/permission` 中间件合入时，**同批次**为存量路由补 zod request/response 校验与契约测试；server 切换为运行时使用 `apiError()` 工厂 |
| M1 之后 | 新路由**生而带校验**（schema + 契约测试计入交付四件套），不再存在补齐问题 |

## 5. 使用方式

```ts
// 服务端（当前类型级；M1 起可运行时使用）
import type { ApiErrorBody, ErrorCode } from '@kla-workstation/contracts';

// 客户端
import type { ApiEnvelope, ApiErrorEnvelope } from '@kla-workstation/contracts';
```

> 契约包 `exports.types` 直指 `src/index.ts`（internal package 模式），typecheck 无需先构建；`dist` 仅生产运行（`pnpm -r build` 拓扑序自动先建 contracts）。

## 知识库范围联调（2026-10-10）

KLA 身份权限侧以 `knowledge_library_scopes` 登记稳定库 ID、企业 ID、项目 ID 和个人身份 ID。`getCatalog` 返回当前身份可读的库及 `canWrite`；前端通过 `createLibrary/updateLibrary/deleteLibrary` 逐条变更，旧的整表 `saveCatalog` 在正式服务中拒绝。个人身份字段取 `identities.id`，绝不取账号 `users.id`。上传请求增加 `knowledgeBaseId`；KLA 重新核验库与项目关系，然后向知识服务 `/v1/process/async` 传 `knowledge_base_id/organization_id/project_id/personal_identity_id`，不采用客户端提交的归属 ID。

`POST /api/v1/knowledge/search` 必须二选一提供 `knowledgeBaseId` 或 `conversationId`。库内 `contentRequest(search)` 需 `knowledgeBaseId`，群聊智能体 `knowledge_search` 使用运行群聊 ID。服务端计算可读库并向 `/v1/search` 传 `knowledge_base_ids` 和三个范围 ID；知识服务必须返回 `permission_filtered: true`，每个命中必须有 `doc_id/knowledge_base_id/collection`，否则整次请求失败。多个集合按集合分别检索，再按倒数排名融合结果。

发送文件前，知识服务 `GET /v1/knowledge-scope/capabilities` 必须返回 `{ "scoped_upload": true }`；否则 KLA 不发送文件。上传响应必须返回 `scope_accepted: true`。`/v1/documents?knowledge_base_id=...` 必须返回 `permission_filtered: true`，且每个文档带匹配的 `knowledge_base_id`。这些字段和召回前过滤需知识库后端实现；在它们上线前，KLA 拒绝无可信归属的列表、全文及旧直通检索，任务旧绑定也暂不展示。历史目录/文档不会自动迁成共享库。对接及迁移细节见 [KNOWLEDGE_SCOPE_API_AND_ACL_PLAN.md](./KNOWLEDGE_SCOPE_API_AND_ACL_PLAN.md)。

## 6. 记忆浏览与生命周期契约

新增 `GET /api/v1/memories/browser/scopes` 与 `GET /api/v1/memories/browser`，提供按当前身份的项目、群组、来源智能体、长短期及 ISO 创建时间范围 `from/to` 筛选和分页。请求参数通过 `memoryBrowserQuerySchema` 校验，响应使用 `memoryBrowserScopesSchema` / `memoryBrowserPageSchema`；原有记忆读写接口保持兼容。

浏览条目补充 `reinforcedAt`、`retainedUntil`、`timeWeight`。长期记忆无权重（`null`）；短期采用 72 小时半衰期、30 天归零，服务器保留 365 天，客户端缓存最近七天。共享规则由 `packages/contracts/src/memory-policy.ts` 定义。

`POST /api/v1/memories/search` 当前只检索未过期且未归零的短期记录；长期记录只允许写入和浏览，不进入检索或对话上下文。对话使用身份 / 群组 / 智能体隔离的短期上下文和旧版有界评分召回。数据口径、身份隔离及只读边界详见 [MEMORY_BROWSER.md](./MEMORY_BROWSER.md)，实际缓存、清理与接入边界见 [MEMORY_LIFECYCLE.md](./MEMORY_LIFECYCLE.md)。

## 7. 首页手动任务创建

`POST /api/v1/tasks` 使用 `createTaskRequestSchema`，请求体仅接受 `{ title }`：去除首尾空白后 1–200 字，不允许传入归属或状态字段。请求携带当前登录会话、`x-identity-id` 和 UUID 格式的 `idempotency-key`，服务端校验当前身份的 `write` 权限，以该身份写入现有 `tasks` 表，初始状态为 `pending`。

成功返回 `taskDtoSchema`（`id/title/status/result/created_at`）；首次创建 HTTP 201，同一身份、同一请求编号及同一标题重试返回已有记录 HTTP 200，编号冲突返回 HTTP 409 `IDEMPOTENCY_CONFLICT`。客户端在成功后插入首页列表并更新待办数量；刷新后由 `/api/v1/bootstrap` 的 `tasks` 读取持久化记录。此接口创建手动待办，自动智能体执行及 OA 同步另行对接。

### 任务状态与删除

`PATCH /api/v1/tasks/:taskId` 使用 `updateTaskRequestSchema`，请求体 `{ status: "completed" | "pending" }`。只修改当前身份且原状态为 `pending/completed` 的手动待办；运行中及其他状态返回 HTTP 409，不存在或属于其他身份返回 HTTP 404。响应为更新后的 `TaskDto`。重复设置相同状态不会创建记录。

`DELETE /api/v1/tasks/:taskId` 按任务 ID 和当前身份删除，返回 `{ id }`；重复删除仍成功且不泄露其他身份记录。两个接口均校验登录、当前身份与 `write` 权限，客户端携带身份头和请求编号。页面删除前要求确认，失败时保留记录和错误提示。
