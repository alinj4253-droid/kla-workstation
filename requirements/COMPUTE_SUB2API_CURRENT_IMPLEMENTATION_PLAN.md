# KLA Workstation 算力板块与 Sub2API 当前落地方案

> 版本：V1 MVP 设计（2026-10-06 修订：经 Sub2API 源码核实，其额度体系全部以美元计价，本文额度单位由 Token 调整为美元/USD；建号不预置额度，统一由管理员分配）
>
> 状态：可直接拆分开发。本文针对当前账号、身份、企业权限和算力页面实现，优先级高于早期算力概念稿中与本文冲突的部分。
>
> 相关文档：`DESIGN_SUB2API_COMPUTE_PLATFORM.md`、`KLA Workstation 账号、身份与权限管理设计.md`、`FULL_STACK_IMPLEMENTATION_SPEC.md`。

## 1. 目标与范围

KLA 的算力模块作为 Sub2API 的业务前端和服务端代理层：

- 用户只在 KLA 中查看余额、创建 API Key、查看模型、查看用量和管理额度，不直接进入 Sub2API 前端。
- KLA 服务端负责账号身份、企业权限、Token 台账、审计和业务标签。
- Sub2API 负责模型路由、请求转发、Key 验证、限流、实际请求计量和上游调用。
- 模型管理页废弃。用户不能在 KLA 中任意添加、编辑、删除模型或填写模型供应商 Key。
- 模型广场只展示平台已经接入并允许当前身份使用的模型、能力和费用，不展示上游 API Key。
- 额度单位与 Sub2API 保持一致，统一使用美元（USD）。Sub2API 不存在 Token 余额概念：用户余额、Key 配额、限速窗口和平台日/周/月配额全部按美元扣减，Token 仅用于计费换算与用量统计。人民币计价、积分、支付渠道和结算规则仍不进入本期逻辑。

## 2. 总体架构

```text
KLA Desktop/Web Renderer
  └─ 算力页面：仪表盘 / API 密钥 / 使用记录 / 模型广场
       │ Bearer KLA Session Token
       ▼
KLA Backend
  ├─ Identity/Auth/Permission Context
  ├─ Compute Service（余额、额度、Key、模型、用量）
  ├─ Model Gateway（内部智能体调用、SSE、工具调用、业务标签）
  ├─ Sub2API Adapter（Admin API + User API）
  ├─ Outbox/Sync Worker（建号、建 Key、额度、停用、漂移修复）
  ├─ Usage Sync Worker（用量回流、去重、对账）
  └─ PostgreSQL + Redis
       │ 内网 TLS + Admin API Key / 托管用户会话
       ▼
Sub2API
  ├─ 用户/余额/Key/分组/限流
  ├─ OpenAI Compatible Chat Completions / Embeddings
  └─ 上游官方模型渠道
```

### 2.1 数据权威边界

| 数据 | 权威来源 | KLA 是否保存 | 说明 |
|---|---|---:|---|
| KLA 用户、身份、企业、成员、角色 | KLA PostgreSQL | 是 | 权限上下文唯一来源 |
| KLA Token 分配和审批流水 | KLA PostgreSQL | 是 | 防止 Sub2API 余额变动无法审计 |
| Sub2API 用户余额和硬限额 | Sub2API | 镜像/缓存 | 调用前以 KLA 软额度闸门校验，定期回流 |
| Sub2API API Key 明文 | Sub2API | 否 | KLA 只保存引用、前缀和指纹 |
| 模型路由与上游凭据 | Sub2API/服务端 Secret | 元数据 | 前端只能看模型目录和费用 |
| KLA 业务请求标签 | KLA PostgreSQL | 是 | 用户、身份、项目、群聊、任务、智能体 |
| 实际 token usage | Sub2API + KLA Gateway | 聚合保存 | Sub2API 对账，KLA 用于业务查询 |

## 3. 账号、身份与 Sub2API 账号生命周期

### 3.1 核心原则

Sub2API 账号粒度为 KLA `identity`，不是登录用户 `user`。一个用户可以拥有个人身份和多个企业身份，每个身份必须独立映射一个 Sub2API 托管账号。

```text
KLA user account
  ├─ personal identity   → one Sub2API user + one default key
  ├─ enterprise A identity → one Sub2API user + one default key
  └─ enterprise B identity → one Sub2API user + one default key
```

这样可以保证企业额度、离职停用、模型权限和个人充值完全隔离。

### 3.2 首次注册

账号注册事务完成后，服务端必须创建个人身份；随后通过 Outbox 触发 `provision_identity_compute`：

1. 生成确定性 Sub2API 用户名：`kla-personal-{identityId}`，使用内部邮箱域名。
2. 生成随机托管密码，字段级加密后保存，用户不可见、不可修改。
3. 调 Sub2API Admin API 创建普通 `user` 账号，禁止创建 admin、禁止开启 2FA。
4. 建号后 Sub2API 余额为 0，不自动发放任何初始额度；额度按 §4 流程由管理员/运营分配。
5. 通过用户面 API 创建默认 Key，名称为“默认工作站 Key”，绑定默认个人分组。
6. KLA 只保存 `sub2api_user_id`、Key 引用、Key 前缀和指纹。
7. 同步成功后身份状态为 `compute_ready`；失败时身份仍可登录，但算力页面显示“初始化中/需要重试”，不得伪造余额或 Key。

### 3.3 创建企业身份

企业创建成功并产生企业身份后，执行与个人身份完全相同的建号流程：

- Sub2API 独立用户账号。
- 一把默认 Key。
- 建号后余额为 0；企业管理员本人的额度同样由企业池分配获得。
- 创建企业的管理员拥有企业额度分配权限；普通成员没有充值和分配权限。

### 3.4 加入企业

成员通过邀请码加入企业后：

1. 创建该用户在该企业下的新 identity/member 记录。
2. 建立该企业身份对应的 Sub2API 用户账号和默认 Key。
3. 成员建号后额度为 0，由企业管理员从企业池分配后方可使用算力。
4. 成员角色为企业系统角色“成员”，无 `compute.allocate`、`compute.recharge` 权限。

### 3.5 禁用和注销

- KLA 身份禁用时，Outbox 调用 Sub2API 禁用对应用户，所有 Key 立即不可用。
- 用户离开企业只注销该企业 identity 的调用资格，不影响个人身份及其他企业身份。
- 删除 KLA 业务记录不等于删除算力账：Sub2API 用户和用量记录至少保留审计周期，状态改为 disabled。
- Sub2API 调用失败时不能把 KLA 身份标记为 ready；使用补偿任务和漂移检测重试。

## 4. 额度规则（单位：美元）

### 4.1 MVP 规则

| 身份类型 | 首次初始化 | 自助充值 | 分配给成员 | 查看企业成员用量 |
|---|---:|---:|---:|---:|
| 个人身份 | 0（不预置） | 允许，充值接口先占位 | 不适用 | 仅本人 |
| 企业管理员身份 | 0（不预置） | 不走个人充值；企业权益充值后入池 | 允许 | 允许 |
| 企业成员身份 | 0（不预置） | 不允许 | 不允许 | 仅本人 |

建号不预置任何金额，Sub2API 余额初始为 0。企业身份（含企业管理员本人）的额度由企业管理员通过分配接口从企业池发放；企业池资金由企业权益开通/充值流程注入，本期不涉及支付渠道。个人身份额度来自自助充值（本期占位）或平台运营发放。

说明：企业管理员的“分配”必须受企业可分配余额约束，不允许透支。管理员可以把企业池中的额度转移给成员，也可以回收未使用额度；已经消耗的额度不可回收。

### 4.2 额度分层

```text
企业总权益池 organization_entitlements
  ├─ 企业管理员可用余额
  ├─ 成员 A 已分配余额
  ├─ 成员 B 已分配余额
  └─ 未分配余额

个人额度 personal_entitlement
  └─ 个人身份可用余额
```

KLA 台账字段至少包含：`quota_total`、`quota_granted`、`quota_used`、`quota_reserved`、`available`、`expires_at`、`version`。

所有 `quota_*` 字段以美元计价，存储精度建议 NUMERIC(20,8)，与 Sub2API `users.balance`（decimal(20,8)）一致，避免二次换算。

计算：

```text
available = quota_total + quota_granted - quota_used - quota_reserved
```

实际请求前使用数据库事务和行锁预扣 `quota_reserved`；收到 usage 后转为 `quota_used`。请求失败或未产生 usage 时释放预扣，防止并发下超发。

### 4.3 额度操作

- 运营发放（企业池注入/个人额度）：系统事件，幂等键 `grant:{identityId}:{requestId}`。
- 管理员分配：幂等键 `allocate:{organizationId}:{requestId}`。
- 管理员回收：幂等键 `reclaim:{organizationId}:{requestId}`。
- 个人充值：幂等键 `recharge:{identityId}:{paymentOrderId}`；本期支付未实现时返回 `NOT_IMPLEMENTED`，不能直接改余额。
- 额度同步：KLA 成功写台账后写 Outbox，Sub2API balance 操作成功才标记 `granted`。

## 5. Sub2API 适配层

### 5.1 认证

- Admin API：仅服务端使用 `x-api-key`，从 Secret Manager 或环境变量注入。
- User API：服务端用托管账号登录后缓存 JWT；Redis Key 为 `sub2api:user-session:{sub2apiUserId}`，按 JWT `exp` 判断过期。
- Renderer 不接触 Sub2API Admin Key、托管密码、User JWT 或任何真实 Key。
- 所有适配器请求禁止日志记录 Authorization、密码和完整 Key。

### 5.2 必须实现的 Sub2API 操作

| KLA 能力 | Sub2API 操作 | 可靠性要求 |
|---|---|---|
| 创建身份算力账号 | `POST /api/v1/admin/users` | 确定性用户名 + 幂等查询 |
| 发放/调整余额（美元） | `POST /api/v1/admin/users/:id/balance` | 幂等 request id |
| 禁用身份 | `PUT /api/v1/admin/users/:id` | 重试和告警 |
| 创建默认/用户 Key | 用户面 `POST /api/v1/api-keys` | 明文只返回一次 |
| 查询 Key | 用户面 `GET /api/v1/api-keys` 或 Admin 只读接口 | 不返回完整 Key |
| 修改/停用 Key | 用户面 `PUT /api/v1/api-keys/:id` | 权限校验后执行 |
| 删除 Key | 用户面 `DELETE /api/v1/api-keys/:id` | 默认 Key 不允许删除，只能停用 |
| 查询模型分组 | `GET /api/v1/groups/available` | 按身份允许范围过滤 |
| 查询余额/流水 | Admin 用户余额和 history 接口 | 定时缓存，页面可刷新 |
| 查询用量 | Admin usage 接口 | 水位线、去重、对账 |

### 5.3 同步状态机

```text
pending → provisioning → user_created → balance_granted → default_key_created → ready
                         └→ failed → retrying → dead_letter
```

所有步骤写 `compute_provision_jobs` 和 `outbox_events`。页面展示真实状态；失败时允许“重试初始化”，不得重复创建账号或重复发放额度。

## 6. KLA 数据模型

在现有 `users`、`identities`、`organizations`、`roles`、`permissions` 基础上新增：

### `compute_bindings`

```text
id, identity_id UNIQUE, organization_id NULL,
sub2api_user_id UNIQUE, sub2api_username,
status, provision_state, default_group_id,
managed_password_ciphertext, password_key_version,
last_synced_at, last_error, created_at, updated_at
```

### `compute_entitlements`

```text
id, identity_id NULL, organization_id NULL,
quota_total, quota_granted, quota_used, quota_reserved,
unit='usd', source, expires_at, version, created_at, updated_at
```

个人身份使用 `identity_id`；企业池使用 `organization_id`。两者不可同时为空，也不可同时有值。

### `compute_allocation_ledger`

```text
id, request_id UNIQUE, source_type, source_id,
from_entitlement_id, to_entitlement_id,
amount, action, operator_identity_id,
status, sub2api_operation_id, idempotency_key UNIQUE,
reason, created_at, completed_at
```

### `compute_keys`

```text
id, identity_id, sub2api_user_id, sub2api_key_id UNIQUE,
name, key_prefix, fingerprint, group_id,
is_default, status, expires_at, last_synced_at,
created_by_identity_id, created_at, updated_at
```

### `compute_usage`

```text
id, identity_id, organization_id NULL,
sub2api_usage_id NULL, key_id NULL, model_id,
project_id NULL, conversation_id NULL, task_id NULL,
input_tokens, output_tokens, total_tokens,
request_count, latency_ms, status, usage_at,
dedupe_hash UNIQUE, raw_summary jsonb
```

### `compute_provision_jobs` / `compute_sync_logs`

分别记录建号、建 Key、额度同步、停用、用量归集的状态、重试次数、错误和请求 ID。

## 7. 服务端 API 设计

所有接口要求 KLA Session Token；服务端从 Session 重新计算当前 identity、organization、member、roles、permissions 和 entitlements。客户端传递的 `X-Identity-Id` 只能作为选择提示，不能直接授权。

### 7.1 当前身份和余额

```text
GET  /api/v1/compute/summary
GET  /api/v1/compute/balance
GET  /api/v1/compute/provision-status
POST /api/v1/compute/provision/retry
```

`summary` 返回当前身份、余额（美元）、已用、保留、默认 Key 状态、可用模型数量、Sub2API 健康状态和权限标志；不返回任何密钥。

### 7.2 API Key

```text
GET    /api/v1/compute/keys
POST   /api/v1/compute/keys
PATCH  /api/v1/compute/keys/:keyId
POST   /api/v1/compute/keys/:keyId/disable
DELETE /api/v1/compute/keys/:keyId
```

创建参数：`name`、`groupId`、`expiresAt`、`quota`（美元，对应 Sub2API Key 级 USD 配额）、`rpm`、`ipAllowList`。响应中的 `secret` 只返回一次；服务端数据库不保存明文。默认 Key 不允许删除，允许停用后重新生成。

权限：`compute.key.view`、`compute.key.create`、`compute.key.update`、`compute.key.disable`。

### 7.3 模型广场

```text
GET /api/v1/compute/models
GET /api/v1/compute/models/:modelId
```

模型来自 KLA 服务端同步的官方目录和 Sub2API 可用分组，不提供“添加模型”“编辑模型”“填写 API Key”功能。返回：模型名、模型 ID、供应商、能力、上下文、输入/输出 Token 费率、当前身份是否可用、可用分组和状态。

### 7.4 使用记录

```text
GET /api/v1/compute/usage?from=&to=&modelId=&keyId=&projectId=&page=&pageSize=
GET /api/v1/compute/usage/summary?from=&to=
GET /api/v1/compute/usage/export?from=&to=&format=csv
```

查询优先使用 KLA `compute_usage`，后台由 usage sync 与 Gateway usage 写入；Sub2API 原始数据只作为对账和补偿来源。

### 7.5 企业管理员额度管理

```text
GET  /api/v1/organizations/:organizationId/compute/summary
GET  /api/v1/organizations/:organizationId/compute/members
POST /api/v1/organizations/:organizationId/compute/allocations
POST /api/v1/organizations/:organizationId/compute/allocations/:id/reclaim
GET  /api/v1/organizations/:organizationId/compute/ledger
```

发放参数：`memberIdentityId`、`amount`、`reason`、`expiresAt`、`idempotencyKey`。只有当前企业管理员或拥有显式 `compute.allocate` 权限的角色可以调用。

### 7.6 个人充值占位

```text
POST /api/v1/compute/recharge/orders
GET  /api/v1/compute/recharge/orders/:orderId
```

本期可以创建 `pending` 订单，但没有支付成功回调时不得增加余额。后续接入支付后，支付服务通过签名回调完成幂等入账。

## 8. Model Gateway 与智能体调用

内部统筹、本地执行、操作、会议等智能体不直接调用 Sub2API。统一调用 KLA Model Gateway：

1. 从 Session 得到当前 identity。
2. 校验 `model.use`、项目/群聊/任务权限和模型范围。
3. 锁定并预扣额度（美元）。
4. 根据模型槽位和当前身份分组选择 Sub2API Key。
5. 注入业务标签：`identityId`、`organizationId`、`projectId`、`conversationId`、`taskId`、`agentId`。
6. 透传普通响应、SSE、tool calling 和 usage。
7. 写入 `compute_usage`，完成预扣转实际扣减；失败则释放预扣。

Model Gateway 不允许使用前端模型管理页面传入的 URL 或 Key，所有路由来自服务端模型目录和安全配置。

## 9. 前端算力模块调整

保持现有页面风格和二级菜单，但数据全部来自 API。

### 9.1 仪表盘

- 顶部显示当前身份和 Sub2API 同步状态。
- 核心指标：可用额度（美元）、已使用额度（美元）、保留额度（美元）、默认 Key、今日请求、今日 Token（统计）与今日消费（美元）。
- 显示余额水位、最近用量、模型分布、失败率和延迟。
- 个人身份显示“充值”入口；企业成员隐藏或禁用充值入口并说明需联系管理员。
- 企业管理员显示“成员额度管理”入口。
- 初始化未完成显示进度和重试按钮，不展示虚拟余额。

### 9.2 API 密钥

- 列出当前身份的 Key：名称、前缀、分组、状态、创建时间、过期时间、今日用量。
- 创建 Key 弹窗：名称、模型分组、限额（美元）、速率、有效期。
- 创建成功展示一次完整 Secret，并提供复制按钮和“我已保存”确认；关闭后永不再次显示。
- 默认 Key 显示“系统默认”，不能删除。
- 禁止把 Key 放进 URL、localStorage、Redux 或日志。

### 9.3 使用记录

- 支持时间范围、模型、Key、项目筛选。
- 显示 Token、请求状态、响应耗时、任务/群聊来源。
- 企业管理员可以切换“我的用量/成员汇总”，不能读取无权限企业。
- 导出由服务端生成，导出任务同样经过权限校验。

### 9.4 模型广场

- 只读展示模型和费用。
- 模型卡显示：名称、模型 ID、供应商、上下文、视觉/推理/工具能力、输入/输出 Token 单价、可用状态。
- 移除旧“我的模型”和“添加模型”能力；如果保留路由入口，改成“已启用模型”只读列表。
- 不展示 API Key、上游地址编辑框和任意供应商配置表单。

## 10. 权限矩阵

| 能力 | 个人 | 企业管理员 | 企业成员 |
|---|---:|---:|---:|
| 查看本人算力余额 | 是 | 是 | 是 |
| 创建/停用本人 Key | 是 | 是 | 是 |
| 查看本人用量 | 是 | 是 | 是 |
| 查看企业总用量 | 否 | 是 | 否 |
| 查看成员用量 | 否 | 是 | 否 |
| 分配企业额度 | 不适用 | 是 | 否 |
| 回收成员未用额度 | 不适用 | 是 | 否 |
| 个人充值 | 是 | 仅个人身份 | 否 |
| 编辑模型/上游 Key | 否 | 否 | 否 |
| 模型广场只读 | 是 | 是 | 是 |

建议权限码：

```text
compute.view
compute.key.view
compute.key.create
compute.key.update
compute.key.disable
compute.usage.view
compute.organization.usage.view
compute.allocate
compute.reclaim
compute.recharge
model.use
model.catalog.view
```

## 11. 同步、幂等和异常处理

### 11.1 Outbox

身份创建、企业加入、额度分配、身份禁用与 Outbox 事件在同一 PostgreSQL 事务中提交。Worker 每 5 秒扫描：

- 最多重试 5 次，指数退避。
- 相同 `idempotency_key` 只允许一条成功操作。
- 达到 dead-letter 后发送站内告警，并允许管理员手动重试。
- 任何 Sub2API 失败都不回滚 KLA 已存在的身份，但身份算力状态保持非 ready。

### 11.2 用量归集

- Gateway 实时写入带请求 ID 的 usage。
- 每 10 分钟从 Sub2API 拉取增量用量作为校准。
- 使用 `dedupe_hash` 去重。
- 日对账：KLA Gateway usage、Sub2API usage、余额变化三方比对；KLA 台账与 Sub2API 余额同为美元，可直接按金额比对，Token 数仅作明细校验。
- 差异超过阈值时停止自动补扣，进入人工复核；不得静默修改余额。

### 11.3 Redis 用途

继续使用 Redis DB4：

- Sub2API 用户面 JWT 缓存。
- 身份算力摘要短缓存。
- 建号/额度分配/建 Key single-flight 锁。
- Gateway 并发限流和幂等短锁。
- SSE/任务状态短期事件。

PostgreSQL 仍是额度、权限和审计事实源，Redis 丢失后可以完全重建。

## 12. 安全要求

- Sub2API Admin API Key 只注入服务端 Secret，不写数据库明文、不进日志。
- 托管密码使用 KMS/字段级加密，轮换时写审计日志。
- 完整 Key Secret 只在创建响应返回一次。
- 所有额度变更记录操作身份、目标身份、前后余额、理由、请求 ID 和 Sub2API 操作 ID。
- 服务端所有接口重新检查当前身份和企业权限，不能信任前端按钮状态。
- 页面切换身份后必须重新加载余额、Key、模型可用范围和用量，禁止复用上一身份缓存。
- Sub2API 健康检查失败时，算力页面显示不可用；新请求快速失败，正在进行的流式请求允许自然结束。

## 13. 部署与配置

服务端环境变量：

```env
SUB2API_BASE_URL=https://sub2api.internal.example.com
SUB2API_ADMIN_API_KEY=由SecretManager注入
SUB2API_TIMEOUT_MS=15000
SUB2API_DEFAULT_GROUP_ID=group-chat
SUB2API_PERSONAL_GROUP_ID=group-personal
SUB2API_FAST_GROUP_ID=group-lite
COMPUTE_USAGE_SYNC_INTERVAL_MS=600000
COMPUTE_OUTBOX_INTERVAL_MS=5000
COMPUTE_RECONCILIATION_ENABLED=true
COMPUTE_SECRET_ENCRYPTION_KEY=由SecretManager注入
```

Sub2API 部署要求：

1. 关闭自助注册、支付和无关外部登录入口。
2. 创建只用于 KLA 同步器的 Admin API Key，限制来源 IP 和权限。
3. 配置官方模型上游、模型分组、费率和 Token usage 返回。
4. 确认 Chat Completions、SSE、tool calling、usage、Key 管理和余额接口版本。
5. KLA 和 Sub2API 仅通过内网 TLS 通信。

## 14. 开发拆分与验收

### 后端

1. `Sub2ApiClient`：Admin/User API、错误映射、超时、重试。
2. 迁移 `compute_bindings`、`compute_entitlements`、`compute_allocation_ledger`、`compute_keys`、`compute_usage`、Outbox 和任务表。
3. 身份创建事务接入初始建号事件。
4. 额度（美元）预扣、实际扣减、释放和管理员分配事务。
5. Key、模型广场、用量和管理员额度 API。
6. Model Gateway 接入当前身份和 Sub2API Key。
7. Provision Worker、Usage Sync Worker、漂移检测和对账任务。

### 前端

1. 算力仪表盘改为 API 数据和身份状态。
2. API Key 页面接入创建、一次性 Secret 展示、停用和默认 Key 保护。
3. 使用记录接入筛选、分页、导出。
4. 模型管理入口改为模型广场，只读展示。
5. 企业管理员增加成员额度分配页；企业成员隐藏分配和充值操作。
6. 身份切换后清理算力缓存并重新加载。

### 必测验收场景

- 注册个人账号：自动创建个人 Sub2API 账号（余额 0）和默认 Key，重复事件不重复创建。
- 企业管理员分配额度后，成员 Sub2API 余额同步增加；未获分配额度的成员请求被软额度闸门拒绝。
- 创建企业：管理员身份自动建号；管理员和成员身份隔离。
- 加入企业：成员自动建号；成员无法调用额度分配和个人充值接口。
- 管理员给成员分配/回收额度，余额不足和重复请求正确拒绝/幂等。
- 个人身份充值占位不会直接增加余额；支付回调前保持 pending。
- 创建 Key 只返回一次完整 Secret，默认 Key 不可删除。
- 智能体通过 Model Gateway 真实调用 Sub2API，usage 写入并扣减当前身份额度。
- 切换身份后看不到上一身份的余额、Key、用量和模型权限。
- Sub2API 超时、401、余额不足、模型不可用时返回稳定错误，不伪造成功。
- 日对账重复拉取不重复扣减，差异进入告警和人工复核。

## 15. 本期明确不实现

- KLA 页面直接编辑模型供应商、Base URL 或上游 API Key。
- 用户直接进入 Sub2API 管理后台。
- 企业成员个人充值和 Token 分配。
- 积分兑换、人民币计费、支付渠道和发票结算。
- 将 Sub2API Admin 权限暴露给任何企业身份。
- 通过前端或 localStorage 保存完整 API Key。

## 16. 待部署前确认项

以下项目不阻塞方案落地，但部署 Sub2API 前必须用实际版本确认：

1. Admin API 的建号、余额操作和 usage 返回字段是否与适配器契约一致。
2. 用户面创建 Key 是否必须验证码/2FA；若必须，需要采用服务端专用免验证码托管账号或改为 Sub2API 管理 API 扩展。
3. Token usage 是否能按 Key、模型和时间返回；若不能，Gateway usage 作为业务明细事实源，Sub2API 仅做余额对账。
4. 已确认（2026-10 对照 main 分支源码）：Sub2API 用户余额（`users.balance`，decimal(20,8)）、Key 配额（`api_keys.quota`，注释明确为 USD）、5h/1d/7d 限速窗口和平台日/周/月配额（`user_platform_quotas`）全部以美元计价，不存在 Token 余额或 Token 配额；Token 仅作为计费输入。本文额度单位据此统一为美元。
5. 企业池的资金注入（企业权益开通/充值）本期由运营/商务流程完成，不含支付渠道；是否需要产品化运营发放界面待后续确认。
6. 个人额度来源：本期个人身份无自动发放，余额为 0，仅充值占位或运营发放；个人算力在发放/充值上线前不可用，需产品确认可接受。
