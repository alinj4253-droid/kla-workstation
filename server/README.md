# KLA Workstation Backend

TypeScript + Fastify 服务端。提供健康检查、认证/身份、项目/群聊/消息、模型目录与测速、运行记录与成果文件等 REST API（契约见 `packages/contracts` 与 `docs/API_CONTRACTS.md`），持久化使用 PostgreSQL，启动时自动执行 `migrations/`。

## 开发

```bash
pnpm install
pnpm dev:server        # 真实服务，需 PostgreSQL（配置见 .env.example）
pnpm db:migrate        # 手动执行迁移
```

默认监听 `http://127.0.0.1:8787`。

## Mock 模式（无数据库联调）

无需 PostgreSQL/Redis，数据保存在内存、重启即重置，复用与真实服务完全一致的路由和响应契约；内置官方模型目录种子和演示账号（`demo@kla.local` / `demo123456`）。

```bash
pnpm dev:mock          # 开发热重载
pnpm build && pnpm start:mock
```

桌面端默认指向 `http://127.0.0.1:8787/api`（`VITE_API_BASE_URL` 可覆盖），因此 mock 与真实服务可互换。记忆、文件、会议等未接消费方的接口在 mock 下返回空列表。

## 目录

- `src/server.ts`：Fastify 服务入口（PostgreSQL + Redis + Agent Loop Worker）。
- `src/routes.ts`：REST API 路由。
- `src/mock/`：mock server（内存账号仓库、目录池、契约冒烟测试）。
- `src/repositories/`：数据访问接口与 PostgreSQL 实现。
- `src/database/`：连接池与迁移执行器；`migrations/` 为 SQL 迁移。
- `src/infrastructure/`：Redis、对象存储占位、智能体循环 worker。

## 构建与发布

`pnpm build` 产物在 `dist/`（`migrations/` 需与 `dist/` 同级部署）。生产镜像用仓库根目录 `Dockerfile`（构建上下文为仓库根）：`docker build -t kla-server .`，容器内监听 `0.0.0.0` 并带 `/api/health` HEALTHCHECK。
