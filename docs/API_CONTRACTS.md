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
| `health.ts` | 服务健康与 PostgreSQL/Redis 依赖健康响应 |
| `workspaces.ts` `agents.ts` | 工作区行、智能体目录行、群聊成员智能体与添加请求（现有实现，snake_case 原始行） |
| `models.ts` | 模型目录行（含 `configured` 标记）与测速结果 |
| `runs.ts` | 运行记录（repository 形态）、取消运行原始行、运行步骤行与批量替换请求 |
| `artifacts.ts` | 成果文件 DTO |
| `memories.ts` | 记忆视图/原始行/检索命中与增改查请求 |
| `files.ts` | 文件视图、上传会话原始行与创建请求 |
| `knowledge.ts` | 知识检索请求/透传结果、分段读取请求/响应 |
| `operations.ts` | 运营平台/技能/执行任务请求与响应 |
| `meetings.ts` | 会议、转写片段、会议详情与请求 |
| `skills.ts` | 智能体技能行、`/me/permissions` 权限行 |
| `bootstrap.ts` | `/v1/bootstrap` 聚合响应（含模型摘要与任务摘要） |

> 契约补全约定：以上自 M0 契约补全批次加入的模块**忠实记录当前线上格式**。schema 内带 `TODO(M1)` 注释的字段表示数据库原始行（snake_case），归一为 camelCase 时必须与 server/desktop 三同步；knowledge 检索结果为知识服务响应透传，其结构以知识服务契约为准。
>
> 已知漂移（M1 收口时三同步修复）：`/v1/agents` 返回 `model_id`，而 desktop `Workstation.tsx` 按 `modelId` 读取；`/memories` POST/PATCH 返回原始行而 GET 返回 camelCase 视图。

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
