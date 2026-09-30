# 文档索引

> 新成员阅读顺序建议：仓库 `README.md` → 本文 → `CLIENT_SERVER_SPLIT.md`（拆分原则）→ `FULL_STACK_IMPLEMENTATION_SPEC.md`（技术权威）→ `DEVELOPMENT_DELIVERY_PLAN.md`（分工与里程碑）→ `API_CONTRACTS.md`（契约规则）。

## 权威规格

| 文档 | 说明 |
|---|---|
| [FULL_STACK_IMPLEMENTATION_SPEC.md](FULL_STACK_IMPLEMENTATION_SPEC.md) | 完整前后端技术落地规格（v1.1）：数据库表、API 清单、智能体调度、迁移步骤、验收清单；接口事实源 |
| [API_CONTRACTS.md](API_CONTRACTS.md) | 契约索引与冻结/变更流程、校验接入策略；机器可读契约为 `packages/contracts` |
| [CLIENT_SERVER_SPLIT.md](CLIENT_SERVER_SPLIT.md) | 客户端/服务端拆分原则与数据归属 |

## 设计专项

| 文档 | 说明 |
|---|---|
| [KLA Workstation 账号、身份与权限管理设计.md](KLA Workstation 账号、身份与权限管理设计.md) | 身份/账号/权限概念设计与决策依据（表命名已被 FULL_STACK §5.1 采纳） |
| [DESIGN_SUB2API_COMPUTE_PLATFORM.md](DESIGN_SUB2API_COMPUTE_PLATFORM.md) | sub2api 算力中台专项：账号映射、同步器、对账、灰度回滚（CM1–CM5） |

## 计划与跟踪

| 文档 | 说明 |
|---|---|
| [DEVELOPMENT_DELIVERY_PLAN.md](DEVELOPMENT_DELIVERY_PLAN.md) | **唯一主开发计划**：A–I 组分工、M0–M4 里程碑、分支与合并规则 |
| [NEXT_VERSION_MVP_TASK_PLAN.md](NEXT_VERSION_MVP_TASK_PLAN.md) | 任务计划表（P0–P8 编号），**状态只在此更新** |
| [NEXT_VERSION_MVP_REQUIREMENTS.md](NEXT_VERSION_MVP_REQUIREMENTS.md) | MVP 产品需求与验收标准 |
| [NEXT_VERSION_MVP_TECHNICAL_DESIGN.md](NEXT_VERSION_MVP_TECHNICAL_DESIGN.md) | 早期技术设计（架构与 sub2api 部分仍有效；数据模型/接口以 FULL_STACK 为准） |
| [NEXT_VERSION_MVP_PROJECT_PLAN.md](NEXT_VERSION_MVP_PROJECT_PLAN.md) | 已退役，指向主计划 |

## 工程配套

| 位置 | 说明 |
|---|---|
| `packages/contracts` | 机器可读契约包（Zod schema + 类型 + 错误码 + SSE 事件） |
| `docker-compose.dev.yml` | 本地开发依赖编排（PostgreSQL/Redis/MinIO） |
| `AGENTS.md` | 仓库协作规则速览 |
