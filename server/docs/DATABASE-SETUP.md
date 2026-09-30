# 后端数据库初始化

## 启动行为

服务启动时读取 `DATABASE_URL` 和 `DATABASE_SCHEMA`，默认 schema 为 `kla`。启动迁移是幂等的：创建应用专属 schema、创建 `schema_migrations`，按迁移编号检查并执行建表 SQL，迁移成功后才注册 API 路由。

当前基础表包括：`users`、`user_credentials`、`organizations`、`identities`、`roles`、`permissions`、`identity_roles`、`role_permissions`、`sessions`、`projects`、`conversations`、`messages`。

应用账号不需要 `public` schema 的建表权限，只需要数据库级 `CREATE` 权限，或由管理员预先创建并授权 `kla` schema：

```sql
CREATE SCHEMA kla AUTHORIZATION app_user;
GRANT USAGE, CREATE ON SCHEMA kla TO app_user;
```

连接状态可通过 `GET /api/health/database` 查看。该接口返回数据库名、PostgreSQL 版本和查询延迟，不返回连接字符串。

## Redis 配置与评估

当前本地配置使用 `redis://192.168.0.57:6379/4`，即 Redis 4 号逻辑库。可通过 `GET /api/health/redis` 检查连通性和当前 DB。当前单实例基础接口不强制依赖 Redis，PostgreSQL 已承担账号、身份、项目、会话和消息持久化。后续多实例部署、群聊实时事件、OCR/embedding/Whisper 异步任务、分布式锁、幂等键和短期智能体状态需要 Redis。

因此保留 `REDIS_URL` 配置和适配器边界，但首个基础版本不因 Redis 不可用而阻断 PostgreSQL API。正式启用时 Redis 只保存短期状态，长期业务数据仍以 PostgreSQL 为准。
