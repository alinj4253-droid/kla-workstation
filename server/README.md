# KLA Workstation Backend

独立的 TypeScript + Node.js 服务端骨架。当前只提供健康检查、当前用户和身份列表占位接口；业务接口、数据库连接、Redis、对象存储、知识处理和 Agent Runtime 暂未实现。

## 开发

```bash
npm install
npm run dev
```

默认监听 `http://127.0.0.1:8787`。

## 当前目录

- `src/server.ts`：Fastify 服务入口。
- `src/routes.ts`：占位 API。
- `src/repositories/`：数据访问接口和内存占位实现。
- `migrations/`：PostgreSQL 初始结构占位。
- `.env.example`：数据库、Redis 和对象存储配置预留。

接口契约和存储实现均保持可替换，后续接入 PostgreSQL、Redis、对象存储和认证中间件时不需要改变前端目录结构。
