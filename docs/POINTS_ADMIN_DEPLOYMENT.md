# 积分管理后台部署说明

## 1. 组成

- `apps/points-admin`：独立的积分管理后台前端。
- `server`：提供登录、分页查询企业积分、增加积分、收回积分接口。
- PostgreSQL：业务数据和积分流水的权威数据源。
- Redis：服务端缓存与任务基础设施。

后台积分变更统一经过 `QuotaService`，不会直接修改额度表；增加和收回都会写入 `compute_allocation_ledger`，并尝试同步 Sub2API。

## 2. 生产环境必须配置

在服务端部署环境中设置：

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
DATABASE_URL=postgresql://<user>:<password>@<postgres-host>:5432/<database>
DATABASE_SCHEMA=kla
REDIS_URL=redis://<redis-host>:6379/4
POINTS_ADMIN_USERNAME=<运维管理员账号>
POINTS_ADMIN_PASSWORD=<长度至少16位的随机强密码>
COMPUTE_SECRET_ENCRYPTION_KEY=<既有的32字节加密密钥>
SUB2API_BASE_URL=https://<sub2api-host>
SUB2API_ADMIN_API_KEY=<sub2api管理员key>
POINTS_PER_USD=1000
```

不要把真实 `.env` 提交到 Git。`server/.env.example` 只作为模板。

## 3. 前端部署

推荐由 Nginx 或同一个网关提供同源访问：

```env
VITE_API_BASE_URL=
```

此时前端请求 `/api/...`，网关将 `/api` 反向代理到 `http://server:8787`。

如果前后端分域部署，则构建前设置：

```env
VITE_API_BASE_URL=https://api.example.com
```

构建并发布：

```bash
pnpm --filter @kla-workstation/points-admin install --frozen-lockfile
pnpm --filter @kla-workstation/points-admin build
```

将 `apps/points-admin/dist` 作为静态站点根目录发布。

## 4. Docker 选择数据库

Compose 默认启动自己的 PostgreSQL 和 Redis，适合全新环境。若使用已有数据库，在仓库根目录 `.env` 设置：

```env
KLA_DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
KLA_REDIS_URL=redis://<host>:6379/4
```

然后启动：

```bash
docker compose up -d --build server
```

Compose 会保留本地 PostgreSQL/Redis 容器，但服务端会连接 `KLA_DATABASE_URL` 和 `KLA_REDIS_URL`。部署到已有基础设施时，必须确认网络和防火墙允许容器访问对应地址。

## 5. 验证

```bash
curl http://<host>:8787/api/health
```

浏览器打开积分后台后使用 `POINTS_ADMIN_USERNAME` 和 `POINTS_ADMIN_PASSWORD` 登录。

企业列表接口固定分页 20 条：

```text
GET /api/v1/admin/points/companies?page=1
```

## 6. 当前限制

积分后台登录会话目前保存在服务端进程内存中，适合单实例部署。若生产环境需要多副本或滚动发布，应将后台会话迁移到 Redis，并在网关启用 HTTPS、访问白名单和限流。
