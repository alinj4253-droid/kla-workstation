# 集团三一规划 · 管理员「派发任务 / 任务收束」实施与验收报告

日期：2026-10-24　分支：feature/SANY_Development_administrator

## 一、原项目技术架构与审查结论

**技术栈**：pnpm workspaces 多包结构。`apps/desktop`（React 18 + Vite + Tailwind 渲染层，Electron 壳仅提供窗口与 preload）、`server`（Fastify + PostgreSQL + Zod）、`packages/contracts`（API 契约）。

**既有「集团三一规划」应用**（应用中心唯一业务应用，入口：协同工作台 → 应用中心 → 集团三一规划）：

- 前端 `apps/desktop/src/features/sany-planning/` 已包含完整页面骨架：管理员导航（组织成员 / 工作台 / 公司层填报 / 校验公司层内容 / 派发任务 / 任务收束 / 汇总合并 / 公司级成果）、负责人导航（工作台 / 材料准备 / 内容校验 / 缺口处理 / 我的成果）。
- 后端 `server/src/sany/` 已有 bootstrap、成员、材料、字段、任务创建、产出物版本等接口，数据全部落 PostgreSQL。
- 数据库迁移 `0049_sany_planning.sql`（主表）与 `0050_sany_task_workflow.sql`（任务工作流表：sany_task_assignments / sany_task_submissions / sany_task_closures / sany_task_events）。

**审查发现的关键缺口**（本次补齐）：

1. `POST /api/v1/sany/tasks` 只插入任务行，不创建 assignment、不关联身份、不写事件流水——负责人无法提交、管理员无法收束。
2. 完全没有提交（submissions）、收束（closures）、工作流查询（workflow）接口。
3. 管理员前端「任务收束」页只有只读统计，无核验/退回/通过/收束操作。
4. 负责人「我的成果」提交只生成产出物版本，不产生真实提交记录。
5. 已存在任务（迁移 0050 前创建）没有 assignment 记录。

## 二、新增与修改文件清单

**新增（3）**：

| 文件 | 内容 |
|---|---|
| `server/migrations/0051_sany_task_assignment_backfill.sql` | 为已有任务回填 assignment（关联 owner 成员与项目归属身份），保证收束链路可用 |
| `server/src/mock/sany-memory-pool.ts` | mock 模式三一规划内存池（SQL 模式匹配，覆盖全部 sany 读写），使无数据库环境可完整联调 |
| `server/src/sany/sany-workflow.test.ts` | 5 个端到端工作流测试（派发→提交→通过→收束、退回重提、身份隔离、参数校验） |

**修改（11）**：

| 文件 | 内容 |
|---|---|
| `server/src/sany/routes.ts` | createTask 增强（管理员校验、assignment 创建、身份关联、事件流水）；新增 submissions / closures / workflow 三个接口 |
| `server/src/sany/store.ts` | seedProject 创建 assignment；bootstrap 增加任务提交摘要（submissions / latestSubmission）与 assignments；新增 readSanyTaskWorkflow |
| `server/src/mock/catalog-pool.ts` | 委托 sany SQL 到 SanyMemoryPool（INSERT 优先于 FROM 判断，避免子查询误匹配） |
| `server/src/mock/memory-account-repository.ts` | 新增 getIdentityDisplayName（供收束历史显示操作人） |
| `apps/desktop/src/api/sany.ts` | 新增 Workflow/Submission/Closure/Event DTO；createTask 增加 planningPeriod/note；新增 submitTask / closeTask / getTaskWorkflow |
| `apps/desktop/src/features/sany-planning/SanyDataContext.tsx` | 新增 submitTask / closeTask / fetchTaskWorkflow action 与 workflow 状态 |
| `apps/desktop/src/features/sany-planning/pages/AdminAssignPage.tsx` | 下发规划周期与个别要求 |
| `apps/desktop/src/features/sany-planning/pages/AdminTrackPage.tsx` | 重写为真实收束页：成果提交摘要、明细抽屉（任务/派发状态/提交记录/收束操作/事件流水）、提醒/退回/通过/收束操作 |
| `apps/desktop/src/features/sany-planning/pages/OwnerOutputPage.tsx` | 任务选择器 + 真实提交（创建 submission + 交付物清单） |
| `apps/desktop/src/features/sany-planning/ui.tsx` | 状态样式补充「已收束」 |
| `apps/desktop/src/features/sany-planning/sany-planning.css` | 任务选择条样式 |

## 三、「派发任务」完成情况（已完成并测试）

管理员进入「集团三一规划 → 派发任务」可完成：

- 填写任务名称、规划意图、规划周期、提交截止；
- 从组织成员中勾选负责人（已派发者禁用）；
- 逐人设置个别要求、勾选通用要求（可新增/删除）；
- 确认弹窗展示分析方式、生成范围、回收方式与全部下发要求；
- 提交后后端创建任务 + assignment + 事件流水，任务编号自动递增（R-XX）。

权限控制：仅项目归属身份（规划项目创建者）或项目内 admin 成员可派发，服务端校验，非管理员调用返回 403；负责人不在组织中返回 400。

## 四、「任务收束」完成情况（已完成并测试）

管理员进入「任务收束」可完成：

- 查看全部任务的材料齐备度、生成/确认进度、成果提交次数、最新提交状态与已收束数；
- 点击「明细」打开工作流抽屉：任务信息、派发状态（含提交/通过/收束时间）、下发要求、成果提交记录（每条含摘要、交付物、字段快照、管理员意见）、收束操作历史、事件流水（全程留痕）；
- 对任务执行四种处置：提醒（不改状态）、退回（最新提交置 returned、任务回校验中、附意见）、通过（提交置 accepted、任务已通过）、收束（需先通过，任务已收束并关闭）；
- 退回后负责人可重新提交（版本号递增），已确认内容不丢失；
- 收束后任务拒绝再次提交（409）。

状态机与原型一致：待上传 → 分析中/校验中 → 已提交 → 已通过/已退回 → 已收束。

## 五、接口与数据库改动

**新增接口**（均经服务端权限校验）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/sany/tasks/:taskId/workflow` | 任务工作流（assignment + submissions + closures + events） |
| POST | `/api/v1/sany/tasks/:taskId/submissions` | 负责人提交成果（仅 assignee 或项目管理员） |
| POST | `/api/v1/sany/tasks/:taskId/closures` | 管理员处置：reminded/returned/accepted/closed |

**增强接口**：`POST /api/v1/sany/tasks`（管理员校验、planning_period、个别要求、assignment、事件流水）。

**数据库**：新增迁移 `0051_sany_task_assignment_backfill.sql`（回填已有任务的 assignment）；无删表、无改表结构；seed 逻辑同步创建 assignment。所有写操作走事务（BEGIN/COMMIT/ROLLBACK）。

## 六、测试执行结果

### 服务端（mock 内存池，无数据库依赖）

- `src/sany/sany-workflow.test.ts`：**5/5 通过**
  - bootstrap 初始化 + assignment 回填
  - 派发 → 提交 → 通过 → 收束 全流程真实落库（含收束后拒绝再提交 409）
  - 退回 → 重新提交（版本递增、内容保留）
  - 跨身份任务隔离（404）
  - 非法负责人 400

### HTTP 端到端（mock server 真实进程）

- 派发 → 提交 → 通过 → 收束 → 历史查询：全部 2xx，事件流水 [assigned, submitted, accepted, closed]，closures [accepted, closed]，收束后再提交 409。
- 退回流程：退回后任务回「校验中」，第二版提交成功，第一版保留为 returned。

### 浏览器端到端（vite + mock server 真实页面）

- 应用中心 → 集团三一规划 → 管理员导航（派发任务 / 任务收束）正常；
- 派发任务页：填写表单 → 勾选王芳 → 确认下发 → 新任务出现（已派发 4→5 项）；
- 负责人视图：我的成果 → 提交给管理员 → 确认提交成功；
- 管理员任务收束：成果提交 1 次可见；明细抽屉展示提交记录与收束操作；通过 → 收束 → 已收束 1/5；
- 提醒操作真实写入收束历史与事件流水。

### 类型检查 / Lint

- server typecheck、desktop typecheck、eslint：全部通过。

## 七、回归测试结果

- 桌面端测试：128 通过 / 9 失败。9 个失败位于 MeetingsPage / HomeAiReview / Workstation 导航测试，经 git stash 在干净代码树上复跑**同样失败**，确认为既有问题，与本次改动无关。
- 服务端集成测试（auth / migrations / agent-loop 等 16 个文件）失败，原因为 `DATABASE_URL` 指向的远程库（192.168.10.216）不可达且本机无 PostgreSQL/Docker——既有环境限制，非本次改动引入。本次新增的 sany 测试不依赖真实数据库。
- 应用中心、集团三一规划入口、原有页面（公司层填报、校验、汇总合并、公司级成果、负责人各页）未受影响。

## 八、启动与管理员操作方法

**开发模式（无数据库，mock 内存数据）**：

```bash
# 1. 构建契约
corepack pnpm --filter @kla-workstation/contracts build
# 2. 启动 mock server（8787）
cd server && corepack pnpm exec tsx src/mock/mock-server.ts
# 3. 启动前端（5173）
cd apps/desktop && corepack pnpm exec vite
```

浏览器打开 http://localhost:5173 → 注册账号（验证码 123456）→ 应用中心 → 集团三一规划 → 管理员。

**生产模式**：配置 `server/.env` 的 `DATABASE_URL` → `pnpm db:migrate`（含 0051）→ 启动 server 与桌面端。管理员为规划项目创建者身份。

## 九、未完成内容与限制

1. **真实 PostgreSQL 未验证**：本机无 PostgreSQL/Docker，远程库不可达，迁移 0051 与全部 SQL 仅经 mock 池与单元测试验证，未在真实 PostgreSQL 上执行。迁移语句为标准 SQL（INSERT...SELECT、ON CONFLICT、CASE），风险低，但建议在可用库上跑一次 `pnpm db:migrate` 确认。
2. **负责人身份绑定**：seed 成员与新派发任务的 assignee_identity_id 默认为 NULL（组织架构成员未与系统账号绑定）。绑定后（sany_members.identity_id 有值）提交将严格限定为 assignee 本人；未绑定时项目管理员可代为提交（演示场景）。这是既有模型缺口，非本次引入。
3. **浏览器自动化限制**：IAB 浏览器中 Playwright 定位器点击偶发超时，最终采用页面内脚本交互完成验证；不影响真实用户操作。
4. **不在本次范围**：公司层填报/校验、汇总合并、公司级成果、产出物版本链等模块保持原样未动。
