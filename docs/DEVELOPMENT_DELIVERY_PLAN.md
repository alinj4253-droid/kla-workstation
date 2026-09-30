# KLA Workstation 前后端开发落地方案（主计划）

版本：`v1 MVP`

本文是下一版本的**唯一主开发计划**：按 A–I 组组织分工，里程碑 M0–M4；算力专项使用独立编号 **CM1–CM5**（避免与 M0–M4 冲突，见 §4.1 与 `NEXT_VERSION_MVP_TASK_PLAN.md` 附录）。任务编号（P*）与组别的映射见 §4.1，状态统一更新在任务计划表中。

本文基于产品侧已生成的 `frontend/` 与 `backend/` 分离状态制定。目标是把新版本从"前端可构建、后端占位 API"推进到可联调、可迁移、可部署的服务端版本。

## 1. 当前基线

### 1.1 已具备

- `apps/desktop`：React + Vite + Electron 客户端，可独立构建（已入库）。
- `server`：TypeScript + Node.js + Fastify 服务端骨架（已入库）。
- PostgreSQL 迁移目录、数据访问层边界、Redis/对象存储配置占位（随骨架入库）。
- `docs/API_CONTRACTS.md` 与 `packages/contracts`：统一响应结构、错误码、请求头、SSE 事件与 M0/M1 业务契约（已入库，机器可读契约为准）。
- 根级 `docker-compose.dev.yml`（PostgreSQL/Redis/MinIO 本地开发编排）与前后端项目级 `.gitignore`（`.gitattributes` 尚未建立，需要时随 A 组补充）。

### 1.2 尚未完成

- 真实数据库连接和迁移执行。
- 用户注册、登录、Session、身份切换。
- 企业、成员、角色、权限服务。
- 服务端文件、知识、记忆和成果处理。
- 服务端群聊、任务、智能体和技能接口。
- sub2api、模型用量和结算联调。
- 前端从本地数据适配器切换到服务端 API。

## 2. 总体架构

```text
Electron Renderer
    │ typed API client / SSE / WebSocket
Electron Main + Preload
    │ HTTPS / refresh session / local short-term cache
API Gateway (Fastify)
    ├── Auth & Identity
    ├── Permission & Tenant
    ├── Workspace / File
    ├── Knowledge / Memory
    ├── Conversation / Task
    ├── Agent / Skill / MCP
    └── Compute / Usage
         │
         ├── PostgreSQL：业务主数据、权限、审计、任务状态
         ├── Redis：Session、队列、锁、流式事件、限流
         ├── Object Storage：原始文件、标准化文件、成果和版本
         ├── Vector Store：Embedding、切片向量
         └── Workers：OCR、切片、Embedding、Whisper、文件转换
```

原则：客户端只负责展示、交互和短期缓存；服务端负责身份、权限、长期数据和所有可审计事实。任何资源都必须在服务端完成权限检查后返回。

## 3. 并行开发工作流

每个工作流都可以单独建立分支和负责人。工作流之间通过 API、数据库迁移和共享 TypeScript 类型合并。

### 3.0 执行规则（对各组生效）

1. **契约先行**：各组开工前冻结本组 API/数据契约；未冻结不得开发业务分支。
2. **交付四件套**：代码 + 单测/演练脚本 + 契约或文档更新 + 自验记录，缺一不合入。
3. **承担与红线**：
   - 实习生可独立承担：契约清晰、验收可自测、不含密钥与判权逻辑的模块。
   - 必须资深主导并逐行评审：C 组权限中间件、I 组代理登录/凭据托管/余额资损路径、B 组迁移的破坏性变更。
4. **里程碑收口**：跨组集成只在里程碑处集中联调；未达出口标准不进入下一里程碑。
5. **周数为产品侧排期估算**，实际推进以各里程碑出口标准为准。

### A. 契约与工程基础组（先行，P0）

职责：冻结所有并行开发的共同边界。

- 将 `API_CONTRACTS.md` 转为 OpenAPI 或共享 Zod schema。
- 建立 `packages/contracts` 或 `backend/src/contracts`，输出请求、响应、枚举和错误码类型。
- 固定 API 版本、分页、幂等键、事件命名和时间格式。
- 建立本地、测试、预发布环境配置模板。
- 增加 API mock server 和契约测试。

交付物：

- `openapi.yaml` 或等价 schema。
- 前端可导入的 API 类型。
- 后端统一响应、错误和日志中间件。

依赖：无。其他所有组依赖本组的类型和错误码。

### B. 数据库与基础设施组（P0）

职责：提供所有服务使用的存储底座。

- PostgreSQL 连接池、迁移执行器和事务封装。
- Redis 连接、健康检查、TTL、分布式锁和队列基础封装。
- 对象存储适配器，先支持 S3 兼容实现和本地开发 MinIO。
- 向量库适配器，先定义接口，不阻塞业务开发。
- 统一审计日志、软删除、乐观锁和 `createdAt/updatedAt` 约定。
- 提供测试数据库初始化和清理脚本。

核心表：`users`、`sessions`、`identities`、`organizations`、`memberships`、`roles`、`permissions`、`workspaces`、`files`、`file_versions`、`knowledge_sources`、`chunks`、`conversations`、`messages`、`tasks`、`agents`、`skills`、`audit_logs`、`model_usage`。

交付物：迁移脚本、Repository 接口、测试 fixture、Docker Compose 开发依赖。

### C. 认证、身份与权限组（P0）

职责：实现所有业务 API 的安全上下文。

- 注册、登录、密码哈希、Refresh Token 轮换。
- Session、设备、退出登录和全部设备失效。
- 个人身份、企业管理员身份、企业成员身份。
- 身份切换、默认身份和权限版本。
- 企业创建、营业执照字段、加入企业和邀请成员。
- 内置管理员/成员角色、自定义角色和权限绑定。
- Fastify `auth`、`identity`、`permission` 中间件。
- 对资源执行 `read/write/execute/manage/export` 判权。
- 管理后台的用户、身份、企业禁用接口。

交付物：

- `/auth/*`、`/me/*`、`/organizations/*`、`/admin/*`。
- 权限判定服务和跨租户隔离测试。
- 前端可消费的 Session 和身份上下文。

依赖：A、B。C 完成后 D 至 I 才能接入真实资源权限。

### D. 前端壳层与认证接入组（可与 B/C 后半段并行）

职责：先完成客户端的服务端接入骨架，再接业务模块。

- `apiClient`、Token 存储、刷新和登出。
- 启动恢复 Session、401 跳转、403 页面和网络错误页。
- 登录、注册、密码重置页面。
- 顶部身份切换器和身份加载状态。
- 权限能力 hook：`usePermission()`、`can()`。
- 服务端/本地数据源适配器开关。
- SSE/WebSocket 基础连接和自动重连。

交付物：认证可运行的前端壳、API mock 联调页面、权限控制组件。

依赖：A；真实联调依赖 C，但可以先使用 mock。

### E. 工作区、文件与成果组（可并行）

职责：把个人、项目、企业三层工作区迁移到服务端。

- 工作区列表和作用域检查。
- 分片上传、哈希去重、上传完成确认。
- 文件版本、标准化文件、临时文件、切片和 outputs。
- 短时下载 URL、HTML/PDF/Office 预览。
- 文件发布、复制、归档和成果回滚。
- 文件所有操作写审计记录。

后端接口：`/workspaces`、`/files`、`/files/upload-sessions`、`/artifacts`。

前端页面：工作区切换、文件列表、上传队列、预览、版本和权限状态。

依赖：A、B、C。可与 F、G 并行。

### F. 知识与记忆组（可并行）

职责：迁移 OCR、标准化、切片、向量化、检索和长期记忆。

- 文件处理队列和任务状态。
- OCR、Whisper、解析、标准化和全文存储。
- 切片保存 offset、页码、章节、版本和权限标签。
- Embedding 和向量入库。
- 权限过滤的混合检索。
- 完整文件的分页、分段、按 offset 读取。
- 服务端长期记忆；客户端短期记忆和摘要上传。
- 记忆来源、置信度、版本、撤回和删除。

后端接口：`/knowledge/*`、`/memory/*`、`/processing-jobs/*`。

前端页面：知识库、处理进度、检索、全文读取和引用来源。

依赖：B、C、E。可与 G、H 并行。

### G. 群聊、项目与任务组（可并行）

职责：迁移协作主链路。

- 项目、群聊、成员和智能体实例。
- 消息发送幂等、回复引用、@ 路由。
- 流式消息、任务状态和工作树事件。
- 串行/并行委派、父子任务、恢复和取消。
- 附件、成果、临时文件和消息的权限绑定。
- SSE/WebSocket 断线恢复和重复消息去重。

后端接口：`/projects/*`、`/conversations/*`、`/messages/*`、`/tasks/*`、`/events/*`。

前端页面：项目树、群聊、消息流、工作树、附件和通知。

依赖：A、B、C、E。可以先使用 G 的事件 mock 与前端并行。

### H. 智能体、技能与 MCP 组（可并行）

职责：服务端化智能体角色、技能和外部连接器。

- 预置统筹智能体、文档编写智能体、PPT 智能体、数据分析智能体。
- 智能体定义、实例、角色卡和公开职责注册表。
- 技能挂载、启停、版本、审批和回滚。
- MCP Server/Connector 注册、凭据引用和调用审计。
- 工具调用继承用户身份、项目和群聊权限。
- 学习产物进入草稿，确认后才能发布为生产技能。

后端接口：`/agents/*`、`/skills/*`、`/mcp/*`。

前端页面：智能体市场、智能体详情、技能管理和 MCP 配置。

依赖：A、B、C、G；可以先用静态角色和 mock 任务开发 UI。

### I. 算力、sub2api 与用量组（可并行）

职责：统一模型路由、Token 计量和结算。

- 部署 sub2api 并确认上游渠道、密钥和路由。
- 服务端模型目录和模型绑定。
- 用户、企业、项目、群聊、智能体维度用量记录。
- 配额、余额、权益和超限策略。
- 成本、延迟、输入/输出/缓存 Token 统计。
- 管理员用量和结算报表。

后端接口：`/models/*`、`/model-bindings/*`、`/usage/*`、`/entitlements/*`。

前端页面：算力模块、模型切换、余额、用量和管理员结算。

依赖：A、B、C。sub2api 部署可与业务开发并行。

## 4. 合并顺序和里程碑

### M0：工程可协作（第 1 周）

- A 完成契约、错误码、类型和 mock。
- B 完成 PostgreSQL/Redis/对象存储开发环境。
- D 完成 API Client、Session 状态和基础路由。
- 所有分支通过 typecheck、lint 和契约测试。

### M1：可登录和可鉴权（第 2 周）

- C 完成注册、登录、身份切换和权限中间件。
- D 接入真实认证接口。
- 前端能正确处理 401/403 和身份切换。
- 完成跨企业、跨身份访问隔离测试。

### M2：文件和知识闭环（第 3-4 周）

- E 完成上传、版本、预览和工作区权限。
- F 完成文本知识处理、切片、Embedding 和检索。
- 前端知识库接入真实任务状态。
- 完成真实测试文件端到端导入和检索。

### M3：群聊和智能体闭环（第 5-6 周）

- G 完成消息、任务、流式事件和工作树。
- H 完成智能体、技能和 MCP 基础接口。
- 群聊可以基于当前身份委派智能体并返回流式结果。
- 完成断线恢复、幂等和重复消息测试。

### M4：算力与生产化（第 7-8 周）

- I 接入 sub2api、模型、用量和配额。
- 管理后台和审计完善。
- 完成服务端部署、备份、监控、限流和回滚。
- 旧本地逻辑进入只读兼容期，确认迁移后再下线。

### 4.1 任务编号映射（P* ↔ 组）

| 组 | 对应任务编号 |
|---|---|
| A 契约与工程 | P0-04（契约部分） |
| B 数据库与基础设施 | P0-03、P2-04（存储）、P2-05（队列） |
| C 认证身份权限 | P2-01、P2-02、P2-03 |
| D 前端壳层 | P5-01（客户端接入） |
| E 工作区文件成果 | P3-01、P2-04（文件）、P4-03、P4-04 |
| F 知识与记忆 | P3-02 ~ P3-10、P4-01、P4-02 |
| G 群聊项目任务 | P5-05 及会话/任务服务端接口 |
| H 智能体技能 MCP | P6-01 ~ P6-07、P5-07 |
| I 算力与用量 | P1-06 ~ P1-10、P5-08、P5-09、P8-03（里程碑 CM1–CM5） |

状态跟踪统一更新 `NEXT_VERSION_MVP_TASK_PLAN.md` 对应行，不在两处维护。

## 5. 分支与合并规则

建议采用以下分支命名：

```text
feature/contracts
feature/backend-storage
feature/backend-auth-permission
feature/frontend-auth-shell
feature/backend-workspace-files
feature/backend-knowledge-memory
feature/backend-conversations-tasks
feature/backend-agents-skills-mcp
feature/backend-compute-usage
```

合并规则：

1. 先合并 `contracts`，其他分支只能依赖已发布的 schema。
2. 数据库迁移必须向前兼容，禁止直接修改已发布迁移。
3. API 改动必须同时更新 OpenAPI、后端测试和前端类型。
4. 前端不得直接读取数据库或绕过 API。
5. 每个模块提交独立迁移、接口测试、最小联调页面和回滚说明。
6. 功能完成后先合并后端，再合并前端适配，最后删除本地 fallback。

## 6. 统一验收标准

- 未登录访问受保护接口返回 `401`。
- 无权限访问返回 `403`，且不泄露资源是否存在。
- 切换身份后，旧身份资源不可见。
- 文件、知识、记忆、群聊、智能体和技能全部按身份过滤。
- 所有写操作支持幂等或明确不可幂等。
- 消息和任务支持断线恢复，不能重复发送或重复执行。
- 文件成果必须由服务端确认真实存在后才允许交付。
- OCR、切片、Embedding、检索和全文读取有可追踪任务状态。
- 模型用量可以按用户、企业、项目、群聊和智能体对账。
- 关键操作均写入审计日志。
- 前后端均通过 typecheck、lint、单元测试、契约测试和端到端冒烟测试。

## 7. 首批建议立即拆分的任务

如果需要马上并行启动，优先拆成以下 6 个独立任务：

1. **契约组**：OpenAPI、共享类型、错误码和 mock。
2. **基础设施组**：PostgreSQL、Redis、对象存储、迁移和 Repository。
3. **认证权限组**：注册、登录、Session、身份、企业和权限中间件。
4. **前端壳层组**：登录页、Token 刷新、身份切换和权限 hook。
5. **文件知识组**：上传、标准化文件、OCR、切片、Embedding、检索。
6. **协作智能体组**：群聊、任务、流式事件、智能体、技能和 MCP。

其中 1、2、3 是基础依赖；4 可以在 mock 上立即开始；5、6 在 2 和 3 的接口稳定后并行推进。sub2api 和算力模块（第 7 组/I 组）不阻塞前五组的基础联调，但其 **CM1 连通验证应与 1、2 同批启动**，是全项目最早要收口的关键路径。
