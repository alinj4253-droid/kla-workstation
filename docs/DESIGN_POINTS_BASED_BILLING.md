# 算力点计费设计（积分口径）

> 本文是算力计费的专项设计：把用户侧计费单位从 USD 切换为"算力点"（对外亦可称"积分"）。
> 上位文档：`DESIGN_SUB2API_COMPUTE_PLATFORM.md`（算力中台总体设计）、`NEXT_VERSION_MVP_TASK_PLAN.md`（排期，任务 P1-11）。
> 工程现状参考：`COMPUTE_MODULE_HANDOVER.md`（两套账纪律与已知坑）。
> 定稿日期：2026-10-09。

## 1. 背景与目标

现状：契约 `COMPUTE_CURRENCY = 'usd'`，从 `packages/contracts/src/compute.ts` 到台账（`compute_entitlements.quota_*`）、流水（`compute_allocation_ledger.amount`）、用量（`compute_usage.amount_usd`）、前端算力四页，全链路以 USD 展示。

问题：对终端用户暴露美元口径，既不符合国内产品直觉，也无法支撑积分运营（赠送、活动、定价调整）。

目标：

1. 用户界面与用户 API **只出现算力点**，USD 退到内部成本口径。
2. 算力点是 KLA 台账里的**一等公民**（真账），不是前端换算皮——支撑后续赠送积分、有效期、积分定价调整等运营能力。
3. 不改动 Sub2API 的计量职责：它继续以 USD/token 计量、熔断，仍是**成本事实源**。

否决的替代方案：

| 方案 | 否决理由 |
|---|---|
| 纯前端换算（后端仍全 USD，前端 × 汇率显示） | 汇率散落在前端、改汇率要发版；赠送积分无台账；积分定价无法独立于美元成本调整 |
| 直接 tokens → 积分定价（不经 USD） | 与 Sub2API 的 USD 计量事实源冲突，月度三方对账（KLA 台账 = sub2api 明细 = 移动云总账）对不上 |

## 2. 口径分层

| 层 | 记账单位 | 角色 |
|---|---|---|
| 用户界面 / 用户 API | 算力点 | 唯一可见口径 |
| KLA 台账（`compute_entitlements` / `compute_allocation_ledger`） | 算力点为主 + USD 影子字段 | 用户侧权威账 |
| Sub2API | USD | 成本事实源，计量/熔断不变 |
| 运营后台 / 财务对账 | USD | 企业合同、发票、成本核算（"KLA 记商务账"的既有分工不变） |

命名建议：UI 文案统一叫"算力点"，避免与营销积分（签到等激励）混淆；两套积分**绝不共用一套账**。

## 3. 单位、汇率与精度

- **换算**：`1 USD = 1000 算力点`（`POINTS_PER_USD=1000`）。粒度参考：
  - 预扣下限 0.01 USD → 10 点；
  - 输入 $0.5/1M tokens 的模型 → 500 点/1M tokens，一次 8k tokens 输入 ≈ 4 点；
  - 充值 100 USD → 100,000 点。
- **精度**：积分存 `NUMERIC(20,3)`（毫积分），显示层格式化为 ≤2 位小数 + 千分位；USD 字段保持 `NUMERIC(20,8)` 不动。
- **换算只发生在两个边界**，中间过程各用原生精度，禁止往返换算：
  - `points → usd`：同步 Sub2API 余额时（`available_points ÷ rate`）；
  - `usd → points`：结算回流时（`actual_usd × rate`，取请求开始时的快照）。
- **汇率管理**：MVP 用 env 常量，收敛到服务端独立模块 `server/src/compute/points.ts`（`toPoints(usd)` / `toUsd(points)` / `rateAt(t)`），严禁散落换算。调整汇率视同重大变更：发版 + 一次性重估迁移（见 §9）。二期落 `compute_rate_config` 表（`points_per_usd` + `effective_at`）。

## 4. 数据模型改造

新增迁移（编号接 0019 之后），全部为增量加列，不改动历史列语义：

```sql
-- compute_entitlements：积分主口径字段（USD 四件套保留为影子，迁移期双写）
ALTER TABLE compute_entitlements
  ADD COLUMN points_total    NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN points_granted  NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN points_used     NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN points_reserved NUMERIC(20,3) NOT NULL DEFAULT 0;

-- 流水：amount 继续存 USD（历史语义不变），积分与汇率快照显式落列
ALTER TABLE compute_allocation_ledger
  ADD COLUMN amount_points NUMERIC(20,3) NOT NULL DEFAULT 0,
  ADD COLUMN rate_snapshot NUMERIC(20,8) NOT NULL DEFAULT 1000;

-- 用量：积分口径冗余（byModel/byDay 聚合直接 SUM，不依赖运行时换算）
ALTER TABLE compute_usage
  ADD COLUMN amount_points NUMERIC(20,3) NOT NULL DEFAULT 0;

-- 二期：赠送积分批次（支持有效期，FEFO 扣减）；MVP 不建
-- CREATE TABLE compute_point_batches (
--   entitlement_id uuid, points_initial numeric(20,3), points_remaining numeric(20,3),
--   expires_at timestamptz, source text, created_at timestamptz
-- );
```

设计要点：

1. `compute_allocation_ledger.amount` 的 USD 语义与历史数据**原样保留**，迁移脚本是纯增量。
2. `rate_snapshot` 落到每笔流水：将来汇率可调整的前提——历史账永远能自解释。
3. `compute_usage.amount_points` 由写入方按当时汇率算好落库。

## 5. 资金流改造（quota-service）

六条资金流的积分化对照（现状见 `server/src/compute/quota-service.ts`）：

| 流程 | 现状 | 积分口径改造 |
|---|---|---|
| `grant` / `recharge` | `amount` USD 入 `quota_total` | 入参改 points；ledger 写 `amount_points` + `usd_equiv = points/rate` + 快照；`syncBalanceToSub2Api` 时 `available_points ÷ rate` 再调 `adjustBalance`（沿用现有"设余额"语义） |
| `allocate` / `reclaim` | 企业池内 USD 转账 | **纯积分流转**，企业内不过美元；两张对偶流水（管理员 out / 成员 in）记 `amount_points` |
| `reserve` | 固定 `minReserveUsd = 0.01` | 预扣 `minReservePoints`（默认 10 点）；二期可按模型单价 × 预估 maxTokens 动态估算 |
| `commit` | 收 `amountUsd`，reserved → used | gateway 先换算成 `actualPoints`（见 §6），commit 收积分 |
| `release` | 释放预扣 USD | 释放预扣积分，逻辑不变 |
| `reconcileBalanceFromSub2api` | 正向漂移 USD 补记 recharge | `drift_points = drift_usd × rate` 补记；幂等键沿用现有"带余额快照"写法 |

配套改动：

- `QuotaInsufficientError` 文案改为"算力点不足：可用 X 点，本次需 Y 点"。
- 积分类型区分：充值/合同发放的积分长期有效；平台赠送积分（二期批次表）可设 `expires_at`、先过期先扣（FEFO）。

## 6. 网关结算链路（gateway）

单次调用的结算链路骨架（reserve → 调用 → usage 回流 → commit/release）**不变**，只有两处换口径：

```text
① 预扣积分（冻结估算额度，minReservePoints）
② 调用上游（Sub2API 转发，透传/SSE）
③ 用量回流（tokens · costUsd）
④ 结算入账：resolveAmountUsd() 原样保留（上游金额 > 费率×tokens > minReserve，成本口径）
   → amountPoints = points.fromUsd(amountUsd, rateSnapshot)
   → upsertUsage 同时写 amountUsd + amountPoints
   → quota.commit(ledgerId, amountPoints)   成功退差额 / 失败 release 全额
```

```ts
// settle() 内新增：
const rate = this.deps.points.rateAt(prepared.startedAt);   // 请求开始时的快照
const amountPoints = this.deps.points.fromUsd(amountUsd);   // NUMERIC(20,3)
// upsertUsage 写 amountUsd + amountPoints；quota.commit(ledgerId, amountPoints)
```

- 快照时机：`prepare()` 时取当前汇率传入 `Prepared`，同一请求内口径一致。
- 余额归零熔断逻辑不变（Sub2API 侧按 USD 余额熔断，行为等价）。
- usage-sync worker（Sub2API 用量回流路径）同样补 `amount_points`。

## 7. 契约变更清单（packages/contracts/src/compute.ts）

按 `API_CONTRACTS.md` 冻结与变更流程执行，一次性出契约新版本：

| Schema | 变更 |
|---|---|
| `COMPUTE_CURRENCY` | `'usd'` → `'point'` |
| `computeSummary` / `computeBalance` | `balance/used/reserved/available` 语义改积分；`currency: 'point'`；USD 不再下发 |
| `computeKey` | `quotaUsd` → `quotaPoints`，`todayUsageUsd` → `todayUsagePoints` |
| `createComputeKeyRequest` / `updateComputeKeyRequest` | `quota` 入参改积分（同步器换算成 USD 传上游） |
| `computeModel` | 加 `inputPricePerMillionTokensPoints` / `outputPricePerMillionTokensPoints`（服务端按当前汇率算好下发）；USD 单价字段不再下发 |
| `computeUsageRecord` / `computeUsageBucket` / `computeUsageSummary` | `costUsd` → `costPoints` |
| `computeEntitlement` / `computeOrgPool` / `computeOrgMember` | `quota*` / `available` 全部积分语义 |
| `computeAllocationRequest` | `amount` 改积分 |
| `computeLedgerEntry` | 加 `amountPoints`、`rateSnapshot` |

## 8. 前端改造（apps/desktop）

- `apps/desktop/src/api/compute.ts` 适配层加统一格式化工具：千分位 + "点"后缀，≤2 位小数。
- 算力四页（仪表盘 / API 密钥 / 使用记录 / 模型广场）与成员管理视图的所有金额展示切为算力点。
- 模型广场单价显示"输入 ≈ X 点 / 1M tokens"（服务端已换算，前端不再做乘法）。
- 错误提示跟随服务端新文案（算力点不足 / 余额熔断）。

## 9. 边界情况与风险

1. **两套账纪律不变**（`COMPUTE_MODULE_HANDOVER.md`）：KLA → Sub2API 单向同步；对账脚本用 `Σ points ÷ rate ≈ sub2api 余额` 校验，汇率锁死期间两式应严格一致，漂移走既有 sync_log 告警。
2. **存量迁移**：一次性脚本，`存量 USD 余额 × 1000 → 算力点`，按幂等键 `migrate-points:<entitlementId>` 落一条 `migration` 流水；企业池与个人池同规则；脚本可重复执行。
3. **汇率调整**：MVP 汇率锁死为 env；调整 = 发版 + 存量重估迁移（新旧余额按新旧汇率换算并落重估流水）。二期配置表生效后，新交易用新汇率、历史流水靠 `rate_snapshot` 自解释，余额不重算。
4. **赠送积分有效期**：需要批次表 + FEFO 扣减，改动面大，**MVP 不做过期**，二期实现。
5. **营销积分隔离**：签到/活动等激励积分单独建账，不进 `compute_entitlements`。
6. **充值占位**：A 侧充值（recharge）接口在积分口径下入参为算力点；接入真实收单时由商务层负责金额 → 算力点的换算（见 `DESIGN_SUB2API_COMPUTE_PLATFORM.md` §3.2）。

## 10. 实施顺序与验收

| 步骤 | 内容 | 验收标准 |
|---|---|---|
| 1 | 定汇率 + `points.ts` 换算模块 + 单测 | 换算/精度/舍入用例通过 |
| 2 | 契约变更评审、冻结新版本 | `packages/contracts` 出新版本，评审记录归档 |
| 3 | DB 迁移（增量加列） | 迁移可重复执行，历史数据零改动 |
| 4 | 服务端改造（quota-service / gateway / usage-sync / 同步器） | 现有算力测试全绿，`pnpm ci-check` 通过 |
| 5 | 存量迁移脚本 | 500 USD → 500,000 点，幂等重跑无重复流水 |
| 6 | 前端格式化 + 四页切单位 | 用户可见处无 USD 残留 |
| 7 | 对账脚本 | `points ÷ rate ≈ sub2api 余额` 容差内一致，漂移告警可用 |

## 11. 二期展望

- `compute_rate_config` 汇率配置表 + 生效时间 + 重估流水自动化。
- `compute_point_batches` 赠送积分批次（有效期、FEFO 扣减、到期提醒）。
- 积分定价独立运营：同一模型可配置"积分加价系数"，营销活动可定向折扣，USD 成本口径不受影响。
- 充值收单：金额 → 算力点的商务换算与发票口径。
