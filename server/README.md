# KLA Workstation Backend

独立的 TypeScript + Node.js 服务端（Fastify + PostgreSQL）。提供健康检查、认证/账号/身份/组织、项目与会话/消息、运行步骤、文件元数据、算力（sub2api）等 REST API 与服务端 Agent Loop；Redis、对象存储、知识处理为占位实现，后续接入。

## 开发

在仓库根目录使用 pnpm（workspace 管理）：

```bash
pnpm install
pnpm dev:server   # 等价：pnpm --filter @kla-workstation/server dev
```

默认监听 `http://127.0.0.1:8787`。启动依赖 `.env` 中 `DATABASE_URL` 指向的 PostgreSQL（连接不可达会启动失败，迁移在启动时自动执行）。

无 PostgreSQL 环境可用内存 mock 模式联调（数据重启即清空）：

```bash
pnpm --filter @kla-workstation/server exec tsx src/mock/mock-server.ts
# 预置演示账号：demo@kla.local / demo123456
```

## 当前目录

- `src/server.ts`：Fastify 服务入口。
- `src/routes.ts`：占位 API。
- `src/repositories/`：数据访问接口和内存占位实现。
- `migrations/`：PostgreSQL 初始结构占位。
- `.env.example`：数据库、Redis 和对象存储配置预留。

接口契约和存储实现均保持可替换，后续接入 PostgreSQL、Redis、对象存储和认证中间件时不需要改变前端目录结构。
