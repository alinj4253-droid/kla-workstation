# 密码轮换（PostgreSQL / Redis）

适用：`docs/DEPLOY_CENTOS7_BARE_METAL.md` 的 CentOS 7 裸机部署。密码泄漏、人员变动或例行安全策略时执行。

密码实际存两处，缺一不可：

| 位置 | 作用 | 改动方式 |
| --- | --- | --- |
| 数据库内部（PG `kla` 角色 / Redis `requirepass`） | **唯一真正生效**的认证 | 见下文 SQL / CLI |
| `/etc/kla/server.env` | 应用连接串（`DATABASE_URL` / `REDIS_URL`）+ compose 初始化变量 | 编辑文件后重启 kla |

> `POSTGRES_PASSWORD` / `REDIS_PASSWORD` 只在**首次初始化数据目录**时生效，之后改它们不会改数据库密码——内部 `ALTER USER` / `CONFIG SET` 这一步不能省，也不需要重建容器。

## 1. PostgreSQL

```bash
# 1. 改数据库内部密码
docker exec -it kla-postgres psql -U kla -d kla \
  -c "ALTER USER kla WITH PASSWORD '新密码';"

# 2. 改环境文件（两处保持一致）
vi /etc/kla/server.env
#   DATABASE_URL=postgres://kla:新密码@127.0.0.1:5432/kla
#   POSTGRES_PASSWORD=新密码

# 3. 重启应用并验证
systemctl restart kla
curl -sf http://127.0.0.1:8787/api/health   # 期望 200 {"ok":true,...}
```

## 2. Redis

```bash
# 1. 改运行中实例的密码（CONFIG REWRITE 写回 redis.conf，重启后仍生效）
docker exec kla-redis redis-cli -a '旧密码' --no-auth-warning \
  CONFIG SET requirepass '新密码'
docker exec kla-redis redis-cli -a '新密码' --no-auth-warning CONFIG REWRITE

# 2. 改环境文件
vi /etc/kla/server.env
#   REDIS_URL=redis://:新密码@127.0.0.1:6379
#   REDIS_PASSWORD=新密码

# 3. 重启应用并验证
systemctl restart kla
journalctl -u kla -n 20 --no-pager   # 确认无 NOAUTH / invalid password 报错
```

## 3. 注意事项

- 顺序：先改数据库内部 → 再改 `server.env` → 最后重启 kla。反过来会导致重启后短暂连不上。
- 两个库可分开轮换；轮换 PG 后必须重启 kla，轮换 Redis 后同样需要（连接串在启动时读取）。
- 若通过内网开端口暴露了 5432（见部署 runbook），轮换是收紧访问的时机；确认 `deploy/pg_hba.conf` 白名单网段仍然正确。
- 密码写入 `server.env` 后，该文件权限应保持 `640 root:kla`；不要提交到 git。
- 轮换后如其他机器有直连（报表、BI 工具），需同步更新它们的连接配置。
