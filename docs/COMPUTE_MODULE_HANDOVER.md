# 算力模块交接说明（KLA Workstation）

> 用途：把这份文档 + 《鲲擎2.0_交互演示版.html》一起交给另一个会话/账号，即可继续跑通并继续开发算力模块。
> 演示稿是 **UI 版式基准**，本文是 **工程现状、环境、踩坑与待办**。
> 最后更新：2026-10-07。

---

## 1. 30 秒启动

```powershell
# 工作目录
cd e:\kunqing\kun-ai-chat-feature-kla-workstation

corepack pnpm install
corepack pnpm --filter @kla-workstation/server db:migrate      # 应用迁移（幂等）
corepack pnpm --filter @kla-workstation/server dev             # 后端 http://127.0.0.1:8787
corepack pnpm --filter @kla-workstation/desktop dev            # 前端 http://localhost:5173
```

### 必须知道的 5 个坑

| 现象 | 原因 | 正确做法 |
|---|---|---|
| `pnpm` 命令找不到 | 本机没装全局 pnpm | 一律用 `corepack pnpm ...` |
| 根目录 `pnpm dev` 失败 | 根脚本内部再调 `pnpm` | 直接调子包脚本（见上） |
| 浏览器打不开页面 | Vite 绑的是 IPv6 | 用 `http://localhost:5173`，不要用 `127.0.0.1:5173` |
| 改了 `.env` 不生效 | dotenv 只在进程启动时读 | 重启后端 |
| 后端突然全挂、日志有 esbuild `TransformError` | `tsx watch` 遇到语法错误会**整体退出**，不会自动恢复 | 先 `corepack pnpm --filter @kla-workstation/server typecheck` 定位，再重启 |

---

## 2. 外部依赖与配置

所有凭据都在 [server/.env](../server/.env)，字段含义见 [server/.env.example](../server/.env.example)。**不要把值抄进代码或提交。**

| 依赖 | 地址 | 说明 |
|---|---|---|
| PostgreSQL | `192.168.10.216:5432`，库 `kla`，schema `kla` | `DATABASE_URL`；共享库，**不要动 C 组的 roles/permissions 之外的东西**（见 §6） |
| Redis | `192.168.0.57:6379/4` | `REDIS_URL` |
| Sub2API | `http://192.168.10.218:8099` | 算力上游，独立部署 |

### Sub2API 的三套接口（实测结论，务必照做）

| 面 | 路径 | 鉴权 | 实测 |
|---|---|---|---|
| 健康检查 | `GET /health` | 无 | 返回 `{"status":"ok"}`，**不是** `/api/health` |
| 管理面 | `/api/v1/admin/*` | 请求头 `x-api-key: admin-<64hex>` | 也接受管理员**用户 JWT**（`Authorization: Bearer`）；普通用户 JWT 会 403 `Admin access required` |
| 用户面 | `/api/v1/auth/login`、`/api/v1/keys`、`/api/v1/groups/available` | `Authorization: Bearer <用户JWT>` | 登录体必须用 **`email`** 字段，发 `username` 会被 400 |
| 代理面 | `/v1/chat/completions`、`/v1/models` | **只认 API Key**（`Bearer sk-…` 或 `x-api-key: sk-…`） | 用用户 JWT 调一律 `401 INVALID_API_KEY` |

其他实测事实：
- **所有** Sub2API 响应都套 `{code, message, data}` 信封（`/health` 除外），取数据要拆 `data`。
- 管理面建 Key 的 `group_id` 必须是 **int64**，传字符串会被 400。分组 id 形如 `11`。
- 管理面查用户支持 `?search=<email>`（其他过滤参数会被忽略）。
- 分组列表：`GET /api/v1/admin/groups`（管理员），当前有 8 个；本项目用到 `7`（算力订阅分组）与 `11`（鲲擎admin）。
- 管理密钥接口（本次用到）：`GET/POST/DELETE /api/v1/admin/settings/admin-api-key(/regenerate)`。
- Sub2API 的 `GET /api/v1/keys` 会回传**完整 Key 明文**，所以服务端可以「用 JWT 现取 Key」，无需在 KLA 落库。

### 关键 `.env` 项

```
DATABASE_URL / DATABASE_SCHEMA=kla
SUB2API_BASE_URL=http://192.168.10.218:8099
SUB2API_ADMIN_API_KEY=admin-<64hex>          # 管理面建号/调额/查用量
SUB2API_DEFAULT_GROUP_ID=7                   # 算力订阅分组
SUB2API_PERSONAL_GROUP_ID=11                 # 个人身份默认 Key 分组
SUB2API_SHARED_ACCOUNT_EMAIL=…               # 共享上游账号（见 §4）
SUB2API_SHARED_ACCOUNT_PASSWORD=…
COMPUTE_SECRET_ENCRYPTION_KEY=<32字节hex>    # 托管密码字段级加密
COMPUTE_MIN_RESERVE_USD=0.01                 # 预扣下限，也充当无费率时的计价兜底
```

> Sub2API **管理员账号密码**（`admin@kunluiot.com`）不在 `.env` 里，需要向运维/部署者索取；管理密钥已在 `.env`。

---

## 3. 账号与登录

| 账号 | 密码 | 身份 | 用途 |
|---|---|---|---|
| `laok@kla.dev` | `KlaDemo2026` | 个人「老K」(+ 测试期建的几个企业身份) | 普通用户，个人额度池 500 USD |
| `orgadmin@kla.dev` | `KlaAdmin2026` | 企业「鲲擎算力管理中心」(invite `2EA33F88`) | 企业管理员，可看成员汇总/分配额度 |

- 登录接口 `POST /api/v1/auth/login` 只按 **email 或 phone** 匹配，**输工号必然 401**（前端默认值 `KQ20248866` 是工号，请改成邮箱）。
- **身份切换**是 UI 的关键动作：`POST /api/v1/me/identities/{identityId}/activate` 把该身份设为默认，后续请求才按它鉴权。切换后算力页会清缓存重载。
- 前端登录框的「个人登录 / 企业登录」**目前是装饰性的**，不参与请求。

---

## 4. 算力模块架构（改代码前先看这里）

```
apps/desktop/src/api/compute.ts          前端适配层（§7.1–§7.5 全部调用）
apps/desktop/src/workstation/ComputeSection.tsx   四页 + 成员管理视图
server/src/compute/routes-b*.ts          B 侧：summary/keys/models/usage/gateway
server/src/compute/routes.ts             A 侧：企业额度（§7.5）+ 充值占位（§7.6）
server/src/compute/sub2api-client.ts     Sub2API 适配层（信封解包 / 字段映射 / 凭据）
server/src/compute/gateway.ts            Model Gateway（§8）：预扣→调用→结算→写用量
server/src/compute/compute-repository.ts 算力仓储（含 compute_bindings/keys/usage/额度）
packages/contracts/src/compute.ts        机器可读契约（zod，唯一事实源）
```

### 四条硬约定

1. **契约先行**：新接口先加 `packages/contracts/src/compute.ts`，再写实现。
2. **服务端二次校验**：权限从 Session 重新计算（`server/src/compute/permissions.ts` 的 `hasPermission`），前端按钮状态不可信。
3. **完整 Key 不落库、不下发前端**：`compute_keys` 只存前缀与指纹；网关用托管账号 JWT 调 `GET /api/v1/keys` 现取明文，**仅内存缓存 5 分钟**。
4. **共享上游账号模式**（本次新增）：`SUB2API_SHARED_ACCOUNT_EMAIL/PASSWORD` 非空时，**所有 KLA 身份复用同一个 Sub2API 账号**（当前 `kunqingadmin@qq.com`，余额约 4997 USD），不再逐个建号；每个身份在该账号下各建一个 Key 以便归属用量。`compute_bindings.sub2api_user_id` 因此**不再是唯一**（见迁移 `0016`）。

---

## 5. 本次会话已完成（都有实测证据）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 前端算力四页与演示稿不一致 | 按《鲲擎2.0 交互演示版》重做仪表盘/密钥/使用记录/模型广场 + 侧栏信息块，单位保持 USD |
| 2 | `compute_bindings.status` 不存在 | 迁移 `0013` 里列名是 `sub2api_status`，代码三处写错，已对齐（含 `usage-sync-worker`） |
| 3 | `summary` 的权限标志硬编码 `true` | 改为真实 `hasPermission` 查询，并补回归测试 |
| 4 | `Sub2ApiClient` 没解包 `{code,message,data}` | 统一解包 + 字段映射（`createUser`/`getUser`/`loginUser` 的 `access_token`/`listApiKeys` 的 `items`）；`parseKey` 支持由完整 Key 推导前缀与指纹；`createApiKey` 的 `group_id` 转 int |
| 5 | 建号不可断点恢复 | 绑定已存在且有上游账号时复用已存托管密码续跑，不再重复 `createUser`（否则 409 且产生无法登录的孤儿账号） |
| 6 | 前端无 body 的 POST 全 400 | `KlaApiClient.request` 无条件带 `content-type: application/json`，Fastify 直接 400；改为**仅有 body 时才声明**。曾导致身份切换/重试初始化/退出登录全失败 |
| 7 | 权限绑定缺失导致全 403 | 见 §6（当前是数据层手工补的，仍待做成自动绑定） |
| 8 | 网关用 JWT 调代理面被 401 | 改为用 API Key 调代理面；并新增共享上游账号模式；补回归测试 |

**端到端实测（真实调用 + 真实扣费）**

```
POST /api/v1/compute/gateway/chat/completions
  { "model": "zhipu/glm-5.3-flash", "messages": [...], "maxTokens": 32 }
-> 200   usage: prompt=17 output=32 total=49
   余额 500 -> 499.99（used 0.01，费率未配置时按 COMPUTE_MIN_RESERVE_USD 兜底）
   使用记录写入 success / 1367ms / 0.01 USD
```

---

## 6. 数据库改动清单（含回滚）

### 迁移文件（在 `server/migrations/`，已应用）

| 文件 | 内容 |
|---|---|
| `0013_compute_sub2api.sql` | A 侧：`compute_bindings`/`entitlements`/`ledger`/`keys`/`usage`/`provision_jobs`/`sync_logs`/outbox |
| `0014_extend_compute_schema.sql` | B 侧：Key 元数据列、usage 维度列、`compute.*`/`model.*` 权限码种子 |
| `0015_compute_model_pricing.sql` | `compute_model_pricing` |
| `0016_shared_upstream_account.sql` | **本次新增**：移除 `compute_bindings.sub2api_user_id` 唯一约束（共享账号模式必需），幂等 |

> 注意：`kla.schema_migrations` 里同时存在新旧编号的残留行（`0010/0011/0012` 与 `0013/0014/0015`），是早期改号留下的历史记录，不影响运行。

### 手工数据改动（不在迁移里，换环境需重做）

1. 建角色 `个人默认`（`organization_id` 为空，`is_system=true`，id `1f357acc-3b7c-4768-b9ae-d756928c2ebf`）+ 绑 8 个用户级权限码 + 给 `laok` 个人身份插 `identity_roles`。
2. 给企业「鲲擎算力管理中心」(org `825e1ba0-b7a5-45c4-bb20-4dcbb4d2fb53`) 的「管理员」角色绑 11 个权限、「成员」角色绑 8 个权限。
3. `laok` 个人额度池 `quota_total=500` + 一条 `recharge` 流水（幂等键 `recharge:<identityId>:align-2026-10-07`，`sub2api_synced=true`，因为钱本来就在 Sub2API 侧，**没有**调 `adjustBalance`，否则会翻倍）。
4. 清理 8 条指向已删除上游账号的失效 `compute_keys`，重置绑定状态并投递 Outbox 事件，由 worker 通过共享账号重建默认 Key。

回滚示例（第 1 项）：

```sql
delete from kla.identity_roles where identity_id = '0fa497a6-e8a3-45a3-a449-9c2f7d88e001' and role_id = '1f357acc-3b7c-4768-b9ae-d756928c2ebf';
delete from kla.role_permissions where role_id = '1f357acc-3b7c-4768-b9ae-d756928c2ebf';
delete from kla.roles where id = '1f357acc-3b7c-4768-b9ae-d756928c2ebf';
```

> 约定：共享库里属于 **C 组**的对象（`roles`/`permissions`/`role_permissions`/`identity_roles`）默认不要删改，上面的写入是本次联调经过确认后做的。

---

## 7. 已知缺陷与待办（按优先级）

1. **建角色不自动绑权限（最重要）**
   `register` / `createOrganization` / `joinOrganization`（[postgres-account-repository.ts](../server/src/repositories/postgres-account-repository.ts)）创建角色时**不绑定任何权限**，所以**任何新建账号或新建企业都会 403**（现象：`model.use` 也没有、密钥页 403、企业接口 403）。
   修法：抽一份「用户级权限集 / 企业管理员权限集」常量（建议放 `server/src/compute/permission-sets.ts`，避免 `repositories → compute` 反向依赖），在这三处建角色后自动绑定，并在注册时把个人身份绑到「个人默认」角色。
2. **费率未配置**：`compute_model_pricing` 是空表 → 结算走 `COMPUTE_MIN_RESERVE_USD=0.01` 兜底，不是真实费率。需要按 Sub2API 真实模型与单价种子化。
3. **企业额度池为 0**：企业管理员分配额度会返回 `403 额度不足：可用 0 USD，请求 1 USD`。需要一条平台发放（`grant`）把额度灌进企业池。
4. **模型目录 ID 与 Sub2API 实际不一致**：目录里是 `deepseek-v4-flash`，Sub2API 实际是 `deepseek-v4-flash-0731`。网关按目录校验，所以真实 ID 反而 404。要么对齐目录（同时改 `.env` 的 `MODEL_ID`），要么加映射层。
5. **企业额度流水恒为空**：A 侧 `allocate`/`reclaim` 把流水记在**成员个人池**（`entitlement_id` = 成员池），企业池只变金额没有流水行。属 A 侧账务口径问题，需与 A 组确认。
6. **3 条 `dead_letter` Outbox 事件**：早期没有管理密钥时建号失败留下的，可清理。
7. **成员列表同名的成因**：`joinOrganization` 把企业身份的 `display_name` 写成**企业名**而不是用户昵称，管理员只能靠 identityId 区分。

---

## 8. 症状 → 原因 → 排查

| 症状 | 最可能原因 | 排查 |
|---|---|---|
| 登录报「账号或密码错误」 | 输入的不是邮箱/手机号，或账号没有 active 身份 | 直接 `POST /api/v1/auth/login {identifier,password}` 看返回；查 `kla.users`/`kla.identities` |
| 点击登录/切换身份后无反应 | 前端请求 400（空 body 带 JSON 头）——已修，若复现看 `client.ts` | 看后端日志里 `FST_ERR_CTP_EMPTY_JSON_BODY` |
| 接口 403 且 `summary.permissions` 全 false | 身份没有角色或角色没有权限绑定（§7.1） | 查 `identity_roles → role_permissions → permissions.code` |
| 企业接口 403「无权访问该企业算力数据」 | 当前默认身份是个人身份 | 激活企业身份后重试（请求头 `X-Identity-Id` 只是提示，不授权） |
| 模型调用 502「Sub2API 返回 HTTP 401 INVALID_API_KEY」 | 用了 JWT 调代理面 | §2 表格：代理面只认 API Key |
| 模型调用 404「模型不在服务端目录中」 | 目录 ID 与上游不一致（§7.4） | `GET /api/v1/compute/models` 与上游 `/v1/models` 对比 |
| 算力页「初始化失败」 | `EXTERNAL`：缺管理密钥 / 上游账号不存在 / 建号 409 | 看 `kla.compute_bindings.last_error` 与 outbox 的 `last_error` |
| 余额显示 0 但上游已充值 | KLA 台账与 Sub2API 是**两套账**，只有 KLA→Sub2API 单向同步 | 查 `compute_entitlements`；对齐时**不要**再调 `adjustBalance` |

---

## 9. 验证基线

```powershell
corepack pnpm -r typecheck          # 3 个包
corepack pnpm exec eslint .         # 全仓
corepack pnpm -r test               # contracts 11 / server 51+1skip / desktop 48
node <临时脚本>                      # 真实调用见 §5 的 curl/脚本片段
```

真实调用可参考的请求（需要先登录拿 token）：

```powershell
$body = @{ model='zhipu/glm-5.3-flash'; messages=@(@{role='user';content='只回复两个字：你好'}); maxTokens=32 } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/v1/compute/gateway/chat/completions `
  -Method Post -Headers @{ authorization="Bearer $token"; 'content-type'='application/json' } -Body $body
```

---

## 10. 配套文档

| 文档 | 作用 |
|---|---|
| `c:\Users\ZHANG\Downloads\鲲擎2.0_交互演示版.html` | **UI 版式基准**：算力四页（仪表盘/API 密钥/使用记录/模型广场）+ 二级菜单 + 侧栏信息块；文案与字段以它为准（单位改 USD） |
| [requirements/COMPUTE_SUB2API_CURRENT_IMPLEMENTATION_PLAN.md](../requirements/COMPUTE_SUB2API_CURRENT_IMPLEMENTATION_PLAN.md) | 算力板块与 Sub2API 的落地方案（§4 额度、§5 账号生命周期、§7 接口、§8 网关） |
| [docs/DESIGN_SUB2API_COMPUTE_PLATFORM.md](DESIGN_SUB2API_COMPUTE_PLATFORM.md) | 平台设计 |
| [docs/FULL_STACK_IMPLEMENTATION_SPEC.md](FULL_STACK_IMPLEMENTATION_SPEC.md) | 全栈实现规范（§6 API 契约、§7 算力接口、§8 网关） |
| [docs/API_CONTRACTS.md](API_CONTRACTS.md) | 契约冻结与变更流程 |
| [AGENTS.md](../AGENTS.md) | 仓库级硬约束（pnpm workspaces、客户端边界、`pnpm ci-check`） |

> 注意：`requirements/` 里 `compute_bindings` 的 DDL 写的是 `status`，与已上线的迁移 `0013`（`sub2api_status`）不一致。**以已应用的迁移为准**，代码已按迁移对齐。