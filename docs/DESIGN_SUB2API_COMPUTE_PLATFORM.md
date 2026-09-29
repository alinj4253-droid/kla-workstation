# Sub2API 算力中台对接设计

> 本文是下一版本"算力平台"的专项设计，收敛自 2026-09 与产品/研发的讨论。
> 上位文档：`NEXT_VERSION_MVP_TECHNICAL_DESIGN.md`（总体架构）、`NEXT_VERSION_MVP_TASK_PLAN.md`（排期）。
> sub2api 源码结论基于 2026-09 main 分支，接口以部署时实际版本为准。

## 1. 定位与边界

```text
KLA Workstation / 用户自备工具
        │  sk-xxx（每成员身份一把 key）
        ▼
KLA Model Gateway（业务路由、标签、审计）        ← 商务/租户层：KLA 服务端
        ▼
sub2api（计量、配额、限流、熔断）                ← 算力中台：计费事实源
        ▼
移动云 MaaS（Upstream 账号：Base URL + API Key） ← 上游算力
```

- sub2api 用作**内部算力中台**：按公司（租户）分发额度、计量计费，不是"订阅转 API"拼车。
- 上游是移动云 MaaS 的正规 API Key 计费服务，无上游 ToS 风险；合规风险仅剩 LGPL 与对外经营资质（见 §11）。
- 职责切分：**KLA 记商务账（合同/审批/分摊），sub2api 记计量账（token/余额/限流）**，月度对账；两边不重复建账。
- Embedding、OCR、Whisper 不在 sub2api 能力范围内，仍按任务计划 P1-02/03/04 单独部署。

## 2. 两条调用流量

| 流量 | 链路 | 计量 |
|---|---|---|
| 工作站内 | Agent Runtime → KLA Model Gateway（注入业务标签）→ sub2api → 移动云 | KLA `model_usage` 按用户/项目/任务归集 |
| 用户自备工具 | 用户 key → sub2api → 移动云 | sub2api 按用户/Key 计量，KLA 定时拉取归集 |

两条流量使用同一成员的同一把 key，月度对账时合并。

## 3. 账号模型（定论）

### 3.1 映射关系

映射主键与《KLA Workstation 账号、身份与权限管理设计》对齐：

```text
sub2api 账号 = KLA 工作身份（identity），一个 KLA 账号可有 N 个 sub2api 账号
企业身份   ：organization_members + identity_type=enterprise → kla-t{orgId}-u{userId}
个人身份   ：identity_type=personal                          → kla-personal-u{userId}
KLA 登录账号（人） → 不映射进 sub2api，身份只存在于 KLA
组织（企业）       → 表现为成员账号所属的分组授权与额度来源
sub2api API Key   → 每个工作身份按需创建，绑定模型分组
```

命名使用确定性合成邮箱（`@kla.internal`），作为同步幂等键，不依赖真实邮箱。

### 3.2 个人身份账号（个人算力）

个人身份同样建 sub2api 账号：账号注册时（或首次使用个人算力时）同步创建，平台运营发放个人额度（新客赠送/活动），后期可开放自助充值（复用 KLA 商务层收单，不经 sub2api 支付通道）。个人账号与企业成员账号机制完全一致，Model Gateway 按当前身份上下文选择对应账号的 key，个人用量与企业用量天然隔离。

### 3.3 为什么不是"一人一号"

一人一号 + key 归属公司的方案存在四个不可接受的问题：

1. **余额混合**：sub2api 余额是账号级，多家公司的发放混在一个余额里，公司池被穿透；
2. **离职停用**：离开某公司但留在另一家时，admin API 无法停用单把 key，无法精确止损；
3. **费率**：专属分组费率是账号级，无法按公司区分合同价；
4. **外部审计**：外部公司要求资金与用量隔离，账号级混合过不了尽调。

一人一号的唯一优点（免密码托管）不抵消以上问题，故弃用。

### 3.4 为什么不是"钉钉 SSO 登录 sub2api"

sub2api 支持钉钉 OAuth，但钉钉身份是"人"维度，与"一人多号"冲突（同身份无法区分登录哪个账号）。因此**钉钉只用于 KLA 自身登录与通知，不用于 sub2api 登录**；用户对 sub2api 的感知为零。

### 3.5 用户操作路径

用户不接触 sub2api 面板。建 key、查用量、看余额全部在 KLA"算力"页面完成，KLA 服务端代理调用（见 §5、§6）。

## 4. KLA 侧账号体系与生命周期

### 4.1 KLA 账号创建流程

```text
1. 账号注册：创建 user_accounts → 同步创建个人身份 sub2api 账号
   kla-personal-u{userId}（初始余额 0，平台按需发放个人额度）
2. 企业开通（平台运营）：创建 organization → 生成企业管理员 → 首登改密
3. 成员加入（企业管理员）：邀请码/邀请审核/批量导入/钉钉授权
   产出：organization_members + 企业身份（identity）
4. 设备绑定（用户首登桌面端）：登录 → 设备令牌下发
5. 开通算力（企业管理员审批）→ 触发该企业身份的 sub2api 同步（§4.2）
```

### 4.2 同步器（KLA ↔ sub2api）

| KLA 事件 | sub2api 动作 | 接口 |
|---|---|---|
| 账号注册 / 个人算力开通 | 建个人身份账号（role=user，余额 0，分组=个人组） | `POST /api/v1/admin/users` |
| 开通算力（企业成员） | 幂等建号（role=user，初始余额 0，设并发/RPM/允许分组） | `POST /api/v1/admin/users` |
| 额度发放/调整 | 余额 add/subtract（幂等） | `POST /api/v1/admin/users/:id/balance` |
| 用户建/停 key | 代理登录换 JWT → 调用户侧接口（§6.2） | `POST /api/v1/api-keys` 等 |
| 配额/合同变更 | 更新允许分组、并发、专属费率 | `PUT /api/v1/admin/users/:id` |
| 成员 suspended / 身份停用 | status=disabled（该工作身份全部 key 立即失效） | `PUT /api/v1/admin/users/:id` |
| 账号禁用 / 彻底清退 | 遍历该人全部工作身份账号（企业 + 个人）逐个停用，保留计量数据 | 同上 |
| 漂移检测 | 定时比对 KLA 开通名单 vs sub2api 用户/Key 列表 | `GET /api/v1/admin/users` 等 |

同步器订阅 `organization_members` 与 `identities` 的状态机（pending/active/suspended/removed、账号 disabled）作为事件源。

纪律（写入同步器代码约束）：同步器**永不创建 admin 角色账号**（sub2api 对提权操作强制 step-up 2FA，会卡死流程）；托管账号**永不开启 2FA、不改密码**。

### 4.3 额度流转

企业算力的池是 `organization_entitlements`（token_quota 为事实源），个人算力的池是平台个人额度台账：

```text
企业：organization_entitlements.token_quota（企业级闸门，KLA 侧）
    │ 企业管理员在池内审批发放，校验剩余额度（不透支，含 expires_at）
个人：平台个人额度台账（发放/活动赠送，后期自助充值）
    ▼
工作身份 sub2api 余额 += X（幂等发放，写入权益划拨流水）
    │ 成员使用 key，sub2api 按 token 扣余额；usage_sync 回流扣减 token_used
    ▼
余额归零 → 调用自动熔断 → 用户在 KLA 申请追加 → 审批再发放
```

### 4.4 三层配额

| 层 | 归属 | 作用 |
|---|---|---|
| 企业权益（企业级闸门） | KLA `organization_entitlements` | token_quota / storage / concurrency / model_scope / expires_at，超额或到期拒绝新增任务 |
| 业务配额（软） | KLA | 按用户/项目/任务的预算、审批、预警 |
| 硬配额（兜底） | sub2api | 工作身份余额熔断 + 用户级并发/RPM 限制，防异常打爆上游账单 |

## 5. Key 管理

- Key 由 KLA 代理创建：用户在 KLA 界面选择当前租户上下文与分组 → 服务端以托管凭据登录该成员的 sub2api 账号 → 调用户侧建 key 接口 → `sk-` 明文仅展示一次。
- 用户侧建 key 接口自带能力，直接暴露给用户使用：key 级配额（USD）、5h/1d/7d 限速、IP 黑白名单、有效期。
- KLA 存 key 引用（id、前缀、指纹），不存 `sk-` 明文。
- **key ↔ 租户上下文映射表**是用量归集正确性的关键：工作站内由 Model Gateway 按当前租户自动选 key；登记关系由建 key 时的 KLA 流程自动写入。

## 6. sub2api 接口对接清单（源码确认）

### 6.1 管理面（KLA 服务端持有 Admin API Key）

认证：请求头 `x-api-key: admin-<64hex>`（官方文档明确"服务间调用建议使用 Admin API Key"，不用 JWT 会话）。

```text
POST /api/v1/admin/users                    # 建号（email/password/role/balance/concurrency/rpm/allowed_groups）
PUT  /api/v1/admin/users/:id                # 改资料/分组/限额/费率/状态
POST /api/v1/admin/users/:id/balance        # 额度 set|add|subtract，服务端幂等
GET  /api/v1/admin/users                    # 列表（按 status/role/搜索/自定义属性过滤）
GET  /api/v1/admin/users/:id/api-keys       # 列成员的 key（只读）
GET  /api/v1/admin/users/:id/usage          # 按周期用量
GET  /api/v1/admin/users/:id/balance-history# 余额流水（对账用）
POST /api/v1/admin/users/:id/auth-identities# 身份绑定（本期不用，留作未来 SSO 钩子）
```

已知限制（设计已绕开，勿依赖）：
- admin **无"替用户建 key"接口**（key 管理仅有 `PUT /admin/api-keys/:id` 改分组）→ 代理创建走用户侧接口；
- admin **无停用单把 key 的接口** → 精确止损依赖"成员账号级停用"；
- 创建/提升 admin 角色需 step-up TOTP → 同步器只建 user 角色。

### 6.2 用户面（KLA 服务端以工作身份代理调用）

认证：该工作身份 sub2api 账号的登录 JWT（KLA 托管凭据代登录）。

```text
POST   /api/v1/api-keys          # 建 key（name/group_id/quota/限速/IP 黑白名单/有效期）
GET    /api/v1/api-keys          # 列表
PUT    /api/v1/api-keys/:id      # 改配额/状态/限速
DELETE /api/v1/api-keys/:id      # 删除
GET    /api/v1/groups/available  # 可绑定的模型分组
```

### 6.3 代理会话管理

读写分流，最小化代登录次数：

| 操作 | 通道 | 用户面 JWT |
|---|---|---|
| 查 key 列表 / 用量 / 余额流水 | Admin API Key 直查（§6.1） | 不需要 |
| 建 key / 改 key（配额、状态、限速）/ 删 key | 用户面接口 | 需要 |

用户面 JWT 使用服务端会话缓存，不做每次登录：

```text
缓存：键 = sub2apiUserId，值 = JWT + exp（解析 token 声明，不写死时长）
取用：命中未过期直接用；exp 临近（<5min）单飞提前续登；未命中或 401 重建
约束：登录受 sub2api 验证码与面板限流约束，属昂贵操作；同一身份并发请求
      单飞（single-flight）只放一个登录；工作身份停用时立即清缓存
```

## 7. 密钥安全规范

| 凭据 | 存放 | 使用方 | 附加控制 |
|---|---|---|---|
| Admin API Key | KLA 服务端密钥存储（环境注入/secret manager），不进 DB 明文、不进日志 | 仅算力同步器与用量归集任务 | 反代层限制来源 IP；`notes` 写入 `kla-audit:{id}` 双向审计；定期轮换 + 泄露急停流程 |
| 工作身份托管密码 | 字段级加密（KMS/主密钥隔离），仅代理登录时解密使用 | 仅代理登录模块 | 随机生成、用户不可见不可改、永不开启 2FA |
| 工作身份 `sk-` key | sub2api 侧保存；KLA 只存引用 | 成员本人 / Model Gateway | 明文只在创建响应出现一次；不进 Renderer |

桌面端/Renderer 永远不持有以上任何凭据；所有 sub2api 调用只发生在 KLA 服务端。

## 8. 部署与上游接入

### 8.1 sub2api 部署

- Docker Compose（PostgreSQL 15 + Redis 7），内网/DMZ，域名 + TLS；锁定版本，升级先在测试环境回归。
- 系统设置：**关闭自助注册**（邮箱/钉钉/LinuxDo 全关）、**关闭内置支付模块**、**关闭登录验证码**（硬前提，见 §11）。
- 支付定位：内部结算走 KLA 台账（对公/审批/分摊），不使用 sub2api 支付通道；外部公司走 KLA 商务层。

### 8.2 上游账号（移动云 MaaS）

- 账号类型：`upstream`（Base URL + API Key 透传），协议 `chat_completions` 直通。
- 部署前验证清单：
  1. chat/completions 直通、SSE 流式、tool calling、usage 回传；
  2. 按量账号的额度监控/冷却方式（移动云无余额 API，验证 payg 检测不会误熔断）；
  3. embeddings 转发是否可用；不可用则 embedding 调用由 KLA Gateway 直连移动云；
  4. 推理 base_url 与模型名（注意平台可能使用服务 ID 形态）。

## 9. KLA 侧数据模型增量

```text
（复用身份模型，不新建）identities / organization_members / organization_entitlements
compute_binding       # 工作身份 ↔ sub2apiUserId / 分组授权 / 状态 / 凭据引用（含个人身份账号）
entitlement_ledger    # 额度划拨流水：审批人、金额、来源权益（企业 token_quota 或个人额度）、幂等键、对账哈希
key_registry          # key 引用：id、指纹、所属工作身份、身份上下文、用途
usage_sync_log        # sub2api 用量拉取窗口、明细哈希、对账状态、差异标记；回流扣减 token_used
```

对账链路（P8-03）：KLA 台账 = sub2api 明细（usage/balance-history）= 移动云总账，三方一致，精度达开票级。

## 10. 对任务计划的修订

| 编号 | 修订 |
|---|---|
| P1-06 | 部署 sub2api：关闭注册/支付/验证码；upstream 账号接移动云；交付《Admin API Key 签发、存放、轮换与网络隔离规范》 |
| P1-07 | 交付《sub2api 接口适配说明》：本文 §6 清单 + 错误码映射 + 幂等语义 |
| P1-08 | KLA Model Gateway：代理登录模块、按服务端重建的当前工作身份选 key、业务标签注入 |
| P1-09 | `model_usage` 为商务对账事实源；新增 usage_sync 定时任务，回流扣减 `organization_entitlements.token_used` |
| P2-01/02/03 | 按《账号、身份与权限管理设计》落地 identity / organization / organization_members；工作身份为算力同步主键，个人身份账号纳入同步器 |
| 新增 P1-10 | 算力账号同步器：企业/个人两类账号的建号、额度、停用、漂移检测 + `compute_binding`/`entitlement_ledger` 表 |
| 新增 P5-09 | KLA"算力"页面：代理建 key、余额/用量展示、额度申请审批流 |
| P5-08 | 数据源改为 usage_sync 聚合结果 |
| P8-03 | 升级为三方对账测试（KLA = sub2api = 移动云），含离职停用、额度熔断、漂移告警用例 |

## 11. 风险与待验证清单

| 项 | 等级 | 说明 |
|---|---|---|
| 登录验证码可关闭 | **硬前提** | 托管密码代登录依赖它；部署日验证，不可关闭则方案回退评审 |
| 上游额度监控行为 | 高 | payg 余额检测对移动云可能误熔断，需实测并配置 |
| embeddings 转发 | 中 | 不可用则 embedding 直连移动云（影响 P1-03 拓扑） |
| LGPL-3.0 | 中 | 原则：不改源码、外层扩展；若 fork 必须分发（如交付外部公司内网部署）则须开源修改部分 |
| 版本迭代快 | 中 | 锁定版本；升级回归 upstream 转发与对账 |
| 对外经营资质 | 后置 | 外部公司接入前：ICP/edi、开票主体、移动云合同转售授权 |
| sub2api 接口变动 | 低 | 每次升级 diff admin/user 路由，CI 加契约测试 |

## 12. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| sub2api 用途 | 内部算力中台（非订阅拼车） | 上游为移动云正规 API Key 计费 |
| 是否需要 sub2api | 需要 | 开箱获得计量/配额/限流/报表；自研等价能力成本高 |
| 账号粒度 | 工作身份（企业身份/个人身份），一人多号 | 公司池隔离、离职止损、费率、外部审计四个硬需求 |
| 个人身份算力 | 个人身份同样建 sub2api 账号（选型 B） | 与身份模型对齐；个人额度/充值运营空间；机制与企业账号一致 |
| 公司池事实源 | `organization_entitlements.token_quota`，划拨另记流水 | 复用身份/权益模型，避免两套口径 |
| 登录方式 | 托管密码 + KLA 全代理，无 SSO | 钉钉身份与一人多号冲突；用户零感知 |
| Key 创建 | KLA 门户代理创建 | admin 无代建接口，走用户面 JWT；体验与管控统一 |
| 支付 | 内部台账分摊；sub2api 支付关闭 | 企业资金往来需对公/发票，第三方通道不合规 |
| 公司层级 | sub2api 无"公司"概念，由 KLA organization + 权益模型承担 | 避免二次开发；外部公司走 KLA 商务层 |

里程碑编号为 **CM1–CM5**（原 M1–M5，为避免与《DEVELOPMENT_DELIVERY_PLAN.md》M0–M4 冲突而更名），定义见《NEXT_VERSION_MVP_TASK_PLAN.md》附录；开发分工见《DEVELOPMENT_DELIVERY_PLAN.md》I 组。

## 13. 技术方案补充

### 13.1 算力账号同步器

- 形态：KLA 服务端**独立 worker 进程**（与业务 API 分离部署，故障隔离）。
- 事件链路（Outbox 模式）：业务事务（审批通过、成员/身份状态变更）与 outbox 插入同库同事务 → relay 以固定间隔（起步 5s）扫描 outbox → 调用 sub2api → 更新投递状态 `pending/sent/failed/dead`。
- 幂等键：`{scope}:{userId}:{action}:{sourceId}`（scope=orgId 或 personal；sourceId=审批单 id 或成员变更 id）。
- 失败策略：指数退避重试 ≤5 次 → dead 标记并告警；漂移检测（小时级，§4.2）为最终兜底，差异先自动补偿，不确定项转人工确认。
- 代码纪律（§4.2）：永不创建 admin 角色；托管账号永不开 2FA、不改密码。

### 13.2 用量归集（usage_sync）

- 拉取：定时任务（起步 10 分钟），按工作身份增量拉取，水位线 = 上次成功窗口右端。
- 去重：明细哈希（身份 + key + 时间窗 + token 数）唯一约束，重复忽略。
- 回流：`token_used` 扣减与 `usage_sync_log` 写入同事务。
- 待实测：sub2api 用量明细粒度（key/模型/时间维度）——M1 连通验证确认。若明细不足（仅天/用户级），任务级归集以 KLA Gateway 自身记录为准，sub2api 数据仅用于对账。
- 对账：日对账自动执行、差异告警；月对账开票级（P8-03）。

### 13.3 Model Gateway 服务端形态

- 抽取 `packages/model-core` 的 Provider 抽象与桌面 `model-gateway.ts` 执行逻辑为**服务端 gateway 服务**；能力探测（streaming/toolCalling/structuredOutput）逻辑复用。
- key 注入：按服务端会话重建的 identityId → `compute_binding` → 对应工作身份 key → Authorization 注入。
- 业务标签：sub2api 无标签通道，标签（用户/项目/群聊/任务/身份）只落 KLA `model_usage`；与 sub2api 明细靠 key + 时间窗对齐。
- 槽位映射：移动云模型 → reasoning/fast/embedding 槽位，配置存服务端配置表（按分组）。
- 错误与流式：SSE 透传、超时、有限重试沿用现有语义；sub2api/上游错误映射到 KLA error-codes。

### 13.4 sub2api 分组规划（起步值）

| 分组 | 用途 | 槽位 | 允许身份 |
|---|---|---|---|
| mc-chat | 移动云对话档 | reasoning | 企业身份 |
| mc-lite | 轻量/快速档 | fast | 企业 + 个人 |
| mc-embedding | 向量化（若转发可用） | embedding | 企业 + 个人 |
| personal | 个人算力 | chat + lite 按平台策略 | 个人身份 |

具体模型与费率倍率在 M1 按移动云模型广场实测后填入；分组变更需同步更新槽位映射配置。

### 13.5 额度审批流

- 状态机：`draft → submitted → approved / rejected → granted`（写 `entitlement_ledger` + sub2api balance，幂等键 sourceId=审批单 id）`→ done / failed`（重试）。
- 企业管理员调整成员余额、平台发放个人额度均走同一审批单模型。
- 通知：钉钉工作通知（复用渠道集成）+ 站内信。

### 13.6 算力页面（P5-09）功能清单

- 用户：当前身份余额/用量看板、key 列表与代理建 key（选身份上下文 + 分组）、追加额度申请。
- 企业管理员：成员额度发放/调整（审批流）、成员用量视图、企业权益水位（token_quota / token_used）。
- 平台运营：漂移检测报告、对账报表、个人额度发放、sub2api 健康状态。

## 14. 配置清单

| 配置项 | 说明 |
|---|---|
| SUB2API_BASE_URL / SUB2API_ADMIN_KEY | sub2api 地址与管理密钥（secret manager 注入） |
| 凭据加密主密钥 | 托管密码字段级加密的 KMS key |
| 分组映射 | GROUP_CHAT / GROUP_LITE / GROUP_EMBEDDING / GROUP_PERSONAL → sub2api groupId |
| 槽位映射 | 各分组下的模型名 → reasoning / fast / embedding |
| 同步器 | outbox 轮询间隔、重试策略、漂移检测周期 |
| usage_sync | 拉取间隔、水位线存储 |
| 网关 | 超时/重试/并发上限；embedding 直连端点（若转发不可用） |

## 15. 监控与告警

| 对象 | 指标 |
|---|---|
| 同步 | outbox 积压深度、failed/dead 计数、漂移差异数 |
| 额度 | 成员余额水位（<20% 预警）、企业 token_quota 水位、发放失败 |
| 网关 | 上游错误率/延迟、熔断触发、401 重建频率（异常升高 = 凭据问题） |
| 对账 | 日对账差异金额、usage_sync 延迟水位 |
| 通道 | 钉钉工作通知 + 站内告警（复用渠道集成） |

## 16. 灰度与回滚

- 灰度：CM5 起选**一家内部公司试点**，连续两个对账周期无误后按公司逐家放量；个人算力最后开放。
- 回滚：桌面端退回自带 provider 配置（v0.1.x 模型管理能力）；服务端算力数据转只读；sub2api 停新增不停存量（计量数据保留供对账）。
- 应急：admin key 泄露走 §7 轮换流程；sub2api 不可用 → 网关拒绝新任务，进行中的流式任务自然结束，不伪造成功。
