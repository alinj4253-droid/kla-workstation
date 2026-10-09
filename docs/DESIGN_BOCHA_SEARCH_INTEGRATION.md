# 博查搜索接入技术方案（工具类计费项）

> 本文是联网搜索（博查 Web Search API）的专项设计：服务端接入方式、工具网关、与算力点计费体系的衔接。
> 上位文档：`DESIGN_POINTS_BASED_BILLING.md`（积分口径，任务 P1-11）、`DESIGN_SUB2API_COMPUTE_PLATFORM.md`（算力中台）、`NEXT_VERSION_MVP_TASK_PLAN.md`（排期）。
> 定稿日期：2026-10-09。

## 1. 背景与结论

需求：为智能体与前端提供联网搜索能力，选用博查（Bocha）Web Search API，按调用次数付费。

结论：

1. **不接 sub2api**。sub2api 的计量模型是"OpenAI 兼容模型调用 → token 计量 → USD 余额"；博查是按次计费、人民币结算的非 LLM 服务，与算力中台既有范围划分一致（Embedding/OCR/Whisper 同样在 sub2api 之外）。
2. **KLA 服务端自建工具网关**（Tool Gateway），博查 Key 只存在于服务端；计费直接进积分台账，成为积分体系（P1-11）的第一个"按次计费项"。
3. **服务端接入是唯一方式**：Key 安全（预付费资产）、计量必经点（扣积分/写流水/判权都在服务端）、两条调用路径（智能体工具、前端搜索）天然都汇于服务端。
4. 不使用博查官方 MCP Server（面向客户端工具生态）；服务端直连 REST，才能把计量与判权插在调用链中间。

## 2. 博查 API 对接基准

> 以开通时官方文档为准（开放平台 open.bochaai.com / open.bocha.cn）；以下为 2026-10 调研结论。

| 项 | 内容 |
|---|---|
| 端点 | `POST https://api.bocha.cn/v1/web-search`（**旧版 `chat` 分支实测在用**；AI Search 为 `/v1/ai-search`，需单独开通白名单，二期） |
| 鉴权 | `Authorization: Bearer <BOCHA_API_KEY>`，`Content-Type: application/json` |
| 计费 | 按量付费（按调用次数）+ 资源包；Web Search 约 ¥0.036/次（第三方数据，以官网为准）；人民币结算、平台预充值 |
| 限额 | 官方标称 1000–2000 QPS 上限；我们按自身需要自限 |

请求体（**含旧版实测可用参数**）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 必填，支持自然语言 |
| `count` | int | 1–50；旧版自限默认 5、上限 20（agent 场景结果过多反而稀释质量），新版沿用 5/20 |
| `freshness` | string | 时间过滤：`noLimit` / `oneDay` / `oneWeek` / `oneMonth` / `oneYear` / `YYYY-MM-DD` / `YYYY-MM-DD..YYYY-MM-DD`，默认 `noLimit`。**注意**：旧版传的是短格式 `day/week/month/year` 且实测可用，新版以官方长格式为准 |
| `summary` | boolean | 是否返回长文本摘要，固定 `true`（服务端写死，不暴露给前端） |
| `include` | string | 可选，限定站点/域名，逗号分隔，≤20 个（旧版实测可用） |
| `exclude` | string | 可选，排除站点/域名，逗号分隔，≤20 个（旧版实测可用） |

响应核心结构（**以旧版实测为准，与公开样例不一致**）：外层是信封 `{ msg?, data }`，结果在 **`data.webPages.value[]`**，每项含 `name`（标题）、`url`、`snippet`（片段）、`summary`（摘要，summary=true 时）、`siteName`、`siteIcon`、`datePublished`；错误信息取 `msg` 字段。

错误码：

| HTTP | 语义 | 我方映射 |
|---|---|---|
| 400 | 参数错误 | `INVALID_ARGUMENT`（400，不重试） |
| 401 | Key 无效 / 无接口调用权限 | `UNAVAILABLE`（503）+ 告警（配置问题，不是用户问题） |
| 403 | 余额不足 | `TOOL_UPSTREAM_EXHAUSTED`（503）+ 告警充值 |
| 429 | 限流 | `RATE_LIMITED`（429，退避重试 1 次） |
| 5xx | 服务端错误 | `UNAVAILABLE`（503，可重试） |

### 2.1 旧版实测结论（`chat` 分支，优先级高于公开文档）

旧版桌面端已完成博查接入（`apps/desktop/src/main/bocha-web-search.ts` + `bocha-web-search.test.ts` + agent 工具 `web:search`），以下为已验证事实：

1. **域名与信封**：生产用 `api.bocha.cn`；响应为 `{ msg?, data }` 信封，结果在 `data.webPages.value[]`——公开样例的顶层 `webPages` 写法不可照抄。
2. **可移植资产**：`parseResults()`（字段裁剪与空值防御）、`formatBochaSearchResults()`（给 agent 的编号+标题+URL+来源+日期+摘要文本格式）、错误处理（HTTP 非 200 / `msg` / 超时 AbortError）、`bocha-web-search.test.ts` 用例——全部可直接移植到服务端 `bocha-client.ts`，仅需剥离 `better-sqlite3` / `electron safeStorage` 依赖。
3. **Key 管理模式演进**：旧版是桌面单机形态（用户在"设置 → AI 生产力 → 工具"自带 Key，`safeStorage` 加密存本地 secrets 表，代码明确注释"不再内嵌生产 API Key"）。新版改为**平台统一 Key、服务端持有、积分计费**——用户不再感知 Key 的存在，这也是两版架构的本质差异。
4. **agent 工具契约**：旧版工具名 `web:search`，失败返回 `Web search failed: ...` 文本（agent 工具约定：错误以文本返回、不中断任务），新版 `web_search` 技能沿用此语义。
5. **隐私纪律**（来自旧版 researcher 智能体 SKILL.md，必须继承）：搜索只发公共安全词条；**严禁**把群聊消息、角色卡、记忆、本地文件内容、凭据、个人数据发给搜索 API；私有提问先泛化为非敏感公共概念，无法安全泛化则不搜索。

## 3. 总体架构

```text
渲染层（联网搜索开关/搜索入口）──┐
                                ├─HTTP─▶ KLA 服务端 Tool Gateway ──▶ 博查 API（Key 服务端持有）
智能体 agent loop（web_search 技能）┘            │
                                    判权 → 定价 → 预扣 → 调用 → 结算
                                                │
                                        积分台账（compute_entitlements / ledger / usage）
```

- 两条调用路径、一个服务端入口、一套积分流水；与模型通道（Model Gateway → Sub2API）平行，口径统一为算力点。
- Tool Gateway 复用 compute 模块的 `QuotaService` 与台账仓储，**不为工具另建账**。

## 4. 服务端模块设计

新增目录 `server/src/tools/`：

| 文件 | 职责 |
|---|---|
| `bocha-client.ts` | HTTP 适配：请求组装、超时（10s；旧版 30s 可参考）、429 退避重试 1 次、错误码映射（§2 表）、`{msg, data}` 信封解包与响应字段裁剪。**主体逻辑从旧版 `bocha-web-search.ts` 移植**（§2.1），不注入任何业务语义 |
| `tool-service.ts` | 编排：判权 → 查定价 → `quota.reserve`（固定 N 点）→ 调 bocha-client → 成功 `quota.commit` / 失败 `quota.release` → 写 `compute_usage`。幂等键沿用 `reserve:{identityId}:{requestId}` |
| `routes-tools.ts` | 路由：`POST /api/v1/tools/search`（前端搜索入口），会话鉴权与身份解析复用 `compute/permissions.ts` 的 `requireIdentity` 模式 |

设计要点：

1. **Key 管理**：`BOCHA_API_KEY` 走服务端 env（MVP）；如需多 Key 轮换，落库用 `compute/encryption.ts` 同款字段级加密（AES-256-GCM），绝不进契约、日志与前端。泄漏等同资产泄漏，纳入密钥管理规范。
2. **agent 工具接入**：在 `packages/contracts` 的 `runtimeSkillCatalog` 增加 `web_search` 技能（server 侧执行），`server/src/runtime/tools.ts` 的 `properties/required` 与 `execute()` 增加分支，转发到 `ToolService`。agent 配置里不含 `web_search` 技能时，该工具不暴露给模型（沿用 `agentTools()` 的过滤机制）。
3. **用量写入**：`compute_usage` 记 `model = 'bocha-web-search'`，`amount_usd` 记 0（工具不走 USD 口径），`amount_points` 记实扣点数，`metadata` 记 `{ kind: 'tool', toolId, costCny, pricingVersion, httpStatus }`。用量页 / byDay 聚合 / CSV 导出零改造即可展示。
4. **审计与日志**：每次调用走 observability logger（requestId 贯穿），失败含 `log_id`（博查返回的调试字段）。

## 5. 计费与积分衔接

### 5.1 计费项定价表

```sql
CREATE TABLE IF NOT EXISTS compute_tool_pricing (
  tool_id         text PRIMARY KEY,            -- 'bocha-web-search' | 'bocha-ai-search' | ...
  points_per_call NUMERIC(20,3) NOT NULL,      -- 直接定点数，不经 USD/CNY 换算
  cost_per_call_cny NUMERIC(20,8),             -- 影子成本（财务对账用）
  pricing_version integer NOT NULL DEFAULT 1,  -- 变更即 +1，流水记版本
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- 占位：bocha-web-search = 5 点/次（¥0.036 ≈ $0.005 × 1000），以运营核价为准
```

- 工具定价**直接定"点"**，不做 CNY→USD→points 双重换算；`cost_per_call_cny` 仅作财务影子。
- 定价变更走新版本号（`pricing_version`），流水记当时版本，历史可解释——等价于模型侧的 `rate_snapshot`。

### 5.2 扣费时序

```text
① 判权：tool.search.use 权限码 + 计费项 enabled
② reserve(N 点，价格固定无预估) —— 余额不足直接拒绝（这本身就是熔断）
③ 调用博查
④ 成功：commit(N 点)；失败/超时：release(N 点) —— 不扣点
⑤ upsertUsage（幂等 dedupe_hash 同模型口径）
```

与模型链路相比没有"退差额"环节；重试用同一 `requestId`，幂等由既有 `reserve` 幂等键保证。

### 5.3 台账与对账

- 台账零改动：积分流水（`compute_allocation_ledger`）的 `amount_points` / `rate_snapshot` 口径天然兼容。
- 对账独立于 sub2api 三方对账，单独一条：**`Σ(成功流水次数 × 当版单价) ≈ 博查月账单（CNY）`**，偏差告警。
- 博查平台预充值余额需主动监控：每日查询余额（或依赖其通知），低于阈值（如 1000 次用量）告警充值；博查侧无 sub2api 式熔断 API，我方熔断就是积分余额不足拒绝。

## 6. 契约变更（packages/contracts）

按 `API_CONTRACTS.md` 流程执行：

| 变更点 | 内容 |
|---|---|
| 新增 schema | `toolSearchRequestSchema`（query/freshness/count，**不含** summary——服务端固定 true）、`toolSearchResponseSchema`（裁剪为 `items[]: { name, url, snippet, summary?, siteName, siteIcon?, datePublished? }` + `totalEstimated`） |
| usage 扩展 | `computeUsageRecordSchema` 加 `kind: 'model'\|'tool'` 与 `toolId: string \| null` |
| 权限码 | `COMPUTE_PERMISSIONS` 加 `toolSearchUse: 'tool.search.use'`；`server/src/compute/permissions.ts` 同步常量（编译期对齐）；`server/src/repositories/permission-sets.ts` 把该码加入个人默认与企业成员权限集 |
| runtime 技能 | `runtimeSkillCatalog` 加 `web_search`（server 执行）；`toolArguments` 加对应 schema |

注意：搜索结果中的 URL/摘要属于外部内容，契约里保留原文字段但服务端不注入任何内容；内容安全策略（引用规范）由 agent 侧提示词约束（见 §7）。

## 7. 用户可控性与产品规则

按次计费工具的产品底线：**不能在用户不知情时自动扣点**。

| 层 | 控制者 | 形式 |
|---|---|---|
| 企业开关 | 企业管理员 | `tool.search.use` 绑定到角色；无权限则该身份所有搜索入口不可用 |
| 会话/智能体开关 | 用户 | 聊天界面"联网搜索"开关（**默认关**，开关旁标注"每次约 5 点"）；或智能体配置启停 `web_search` 技能 |
| 单次触发 | 用户/智能体 | agent 自行判断是否联网，每次调用一次扣点 |

配套规则：

1. **调用可见**：agent 自动调用时，消息流展示过程卡片"正在使用网页搜索（−5 点）"；扣点当场可见。
2. **优雅降级**：余额不足 / 无权限 / 上游 403 时，agent 不中断，提示"联网搜索不可用（点数不足或未开通）"，继续用本地知识回答。
3. **引用规范**：agent 使用搜索结果时按 [1][2] 编号引用并在结尾列出来源（标题 + URL + 站点名），无可靠来源时明确说明——由 agent 系统提示词固化。
4. **隐私纪律（继承旧版 researcher SKILL.md）**：只向搜索 API 发送公共安全词条；严禁把群聊消息、角色卡、记忆、本地文件内容、凭据、个人数据外发；私有提问先泛化为非敏感公共概念，无法安全泛化则拒绝搜索。此规则写入 `web_search` 技能的技能说明（SKILL.md），并在服务端对 query 做基础脱敏日志（不落全文）。

## 8. 非功能设计

| 项 | 方案 |
|---|---|
| 超时 | 博查调用 10s 超时；网关整体不超过 15s |
| 重试 | 仅 429/5xx 退避重试 1 次；重试与首次共用同一 `requestId`（幂等，不双扣） |
| 限流 | 身份级并发自限（如 5 QPS/身份），防异常打爆博查账单 |
| 缓存 | MVP 不做缓存（保证计费语义简单）；二期加短 TTL（10 分钟）相同 query 缓存，**命中不扣用户点**（成本平台吸收，需运营确认） |
| 内容安全 | 搜索结果仅作引用素材，服务端原样透传裁剪字段，不做加工；审计日志不落全文 |
| 失败语义 | 任何失败不扣点、不写成功流水；失败也写 usage（status='failure'，0 点）便于排障与成功率统计 |

## 9. 实施步骤与验收

| 步骤 | 内容 | 验收标准 |
|---|---|---|
| 1 | 契约变更（schema / 权限码 / runtime 技能） | 契约评审通过，`pnpm ci-check` 绿 |
| 2 | 迁移：`compute_tool_pricing` 表 | 可重复执行 |
| 3 | `bocha-client.ts` + 单测（请求组装/错误映射/超时重试） | 逻辑移植自旧版 `bocha-web-search.ts`，用例覆盖 §2 错误码表并迁移旧版 `bocha-web-search.test.ts` 可用用例 |
| 4 | `tool-service.ts` + 计费集成测试（mock 博查） | reserve→commit/release 幂等；失败不扣点 |
| 5 | 路由 `POST /api/v1/tools/search` + agent `web_search` 技能分支 | 智能体真实联网调用闭环，过程卡片展示扣点 |
| 6 | 前端：联网搜索开关 + 用量页工具条目展示 | 默认关、价格标注、扣点可见 |
| 7 | 对账脚本（次数×单价 ≈ 博查账单）+ 博查余额监控告警 | 偏差为 0（无缓存前提下） |

依赖关系：依赖 P1-11（积分口径）先落契约与台账改造；本方案可作为积分体系的第一个增量验证场景。

## 10. 二期展望

- **AI Search API**（`/v1/ai-search`，含模态卡与大模型总结，需白名单）：同网关新增计费项，单独定价。
- **Semantic Reranker**：搜索结果二次排序，按次计费同机制。
- **结果缓存**：短 TTL 缓存命中不扣点，配套防滥用策略。
- **资源包采购**：按月用量数据决策按量 vs 资源包。
- **通用工具计费框架**：`compute_tool_pricing` 扩展为统一"计费项注册表"，后续 OCR、Whisper 等按次/按量外部服务全部复用本网关与台账。

## 参考资料

- 博查开放平台：https://open.bochaai.com/
- 博查 API 定价（官方文档）：https://bocha-ai.feishu.cn/wiki/JYSbwzdPIiFnz4kDYPXcHSDrnZb
