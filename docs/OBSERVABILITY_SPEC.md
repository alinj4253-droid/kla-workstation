# KLA Workstation 可观测性规范（P0-05）

> 目标：一次请求可按**用户、任务、文件和调用 ID** 追踪。
> 范围：本文是全服务端的日志、关联 ID、审计事件、指标与链路追踪的**统一约定**；当前已落地部分见 §9，其余按里程碑接入。

## 1. 日志规范

### 1.1 形态与级别

- 全部日志为**结构化 JSON**（Fastify 内置 pino），禁止拼接文本日志。
- 级别约定：`error`（需人工介入）、`warn`（可自动恢复的异常，如依赖超时降级）、`info`（请求生命周期、关键业务动作）、`debug`（仅本地/排障，生产默认关闭）。
- 配置：`LOG_LEVEL` 环境变量，默认 `info`；`NODE_ENV=test` 时关闭日志。

### 1.2 标准字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `time` / `level` / `msg` | pino | 时间、级别、摘要 |
| `service` / `env` | logger base | 固定 `kla-backend` / `NODE_ENV` |
| `reqId` | Fastify | 请求关联 ID，语义同 §2 |
| `userId` / `identityId` | auth 后 `setBindings` | 操作者；身份解析点应补充绑定 `identityId` |
| `method` / `url` / `statusCode` / `responseTime` | Fastify 请求日志 | 一次 HTTP 请求的进出对 |
| 业务实体 ID | 业务代码显式传入 | `taskId` / `fileId` / `artifactId` / `conversationId` / `runId` 等，见 §4 |

### 1.3 脱敏清单（redact）

以下字段在任何日志中必须脱敏为 `[REDACTED]`，新增敏感字段须同步补充：

- 请求头：`authorization`、`cookie`、`set-cookie`、`x-api-key`
- 载荷：`password`（含任意嵌套层级）、`apiKey` / `api_key`、`token` / `accessToken` / `refreshToken`

### 1.4 请求生命周期

Fastify 默认输出 `incoming request` 与 `request completed`（含 `responseTime`），**业务代码不再手工记录重复的请求日志**；业务动作日志只记"发生了什么"，不记"收到了什么请求"。

## 2. 请求关联 ID（x-request-id）

| 规则 | 约定 |
|---|---|
| 客户端提供 | 桌面端每次调用生成并携带 `x-request-id`（格式 `^[A-Za-z0-9_-]{8,64}$`）；SSE/轮询重试时复用同一 ID |
| 服务端复用 | 合法则直接复用（服务端、客户端、日志三方同 ID）；非法或缺失则生成 UUID |
| 响应回传 | 所有响应头回写 `x-request-id`，错误信封 `meta.requestId` 与之同值 |
| 检索 | 以 `reqId` 为键检索日志即可还原一次调用的完整日志链 |

实现：`server/src/observability/logger.ts` 的 `createRequestIdGenerator`，通过 Fastify `genReqId` 全局生效。

## 3. 用户与身份追踪

- 认证通过后（`auth()` 内）以 `request.log.setBindings({ userId })` 绑定操作者，该请求后续所有日志自动携带。
- 身份相关路由（身份切换、企业创建/加入）在解析出身份后补充绑定 `identityId`。
- 未认证请求不绑定，靠 `reqId` + IP 关联。

## 4. 按实体追踪（完成标准映射）

| 追踪维度 | 字段 | 写入位置 |
|---|---|---|
| 用户 | `userId` / `identityId` | 认证中间件（已落地）+ 身份解析点 |
| 任务 | `taskId` / `runId` / `stepId` | 任务与智能体循环代码（P2-05/P6 落地时） |
| 文件 | `fileId` / `uploadSessionId` | 文件与知识管道（P3 落地时） |
| 调用 | `reqId` | 全局（已落地） |

约定：业务实体 ID 必须作为日志字段的**顶层键**传入（`log.info({ fileId }, '...')`），不得拼进 `msg` 字符串。

## 5. 审计事件规范（由 P2-06 实现）

表结构（迁移随 P2-06 落库）：

```sql
CREATE TABLE audit_logs (
  id                 uuid PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  actor_user_id      uuid,
  actor_identity_id  uuid,
  action             text NOT NULL,            -- 命名 `<域>.<动作>`，如 auth.login / artifact.publish
  resource_type      text NOT NULL,
  resource_id        text,
  scope_type         text NOT NULL,            -- personal | project | enterprise
  scope_id           text,
  request_id         text NOT NULL,            -- 关联日志链路
  outcome            text NOT NULL,            -- success | denied | failed
  metadata           jsonb NOT NULL DEFAULT '{}'
);
```

写入时机（最小集）：注册、登录、登出、身份切换、企业创建/加入、权限变更、文件删除与发布、成果发布/回滚、管理员禁用。判权拒绝（denied）必须记录。

## 6. 指标规范（M2 随 P2-05 队列接入）

- 命名：`kla_<域>_<对象>_<单位/量纲>`，如 `kla_http_requests_total`、`kla_http_request_duration_seconds`、`kla_queue_jobs_pending`、`kla_model_usage_tokens_total`。
- HTTP 三件套（RED）：请求数（按 route/method/status）、错误数、时延直方图。
- 队列与水位线：pending/failed/死信数量、用量同步滞后秒数。
- 暴露：`/metrics`（仅内网，受网络边界保护，不进公共网关）。

## 7. 链路追踪（M3 接入 OpenTelemetry）

- 当前以 `reqId` 作为最小关联键；跨服务调用（Model Gateway、知识服务、sub2api）出站请求透传 `x-request-id`。
- M3 引入 OTel：入站解析 `traceparent`，出站注入；resource 注入 `service.name=kla-backend`。
- 采样：生产按率采样（默认 10%），错误强制采样。

## 8. 健康检查语义

| 端点 | 语义 |
|---|---|
| `/api/health` | liveness：进程存活即 200 |
| `/api/health/database`、`/api/health/redis` | readiness 组成部分：依赖不可达返回 503 |
| Docker `HEALTHCHECK` | 调用 `/api/health`（Node fetch 实现） |

## 9. 落地状态

| 项 | 状态 |
|---|---|
| 结构化日志 + base 上下文 + 脱敏 | 已落地（`observability/logger.ts`） |
| `x-request-id` 复用与回传、`meta.requestId` 同源 | 已落地 |
| `userId` 日志绑定 | 已落地（`routes.ts` auth） |
| 审计事件 | 规范已定，P2-06 实现 |
| 指标 / OTel | 规范已定，M2 / M3 接入 |
