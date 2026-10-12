# CentOS 7 裸机部署 Runbook（服务端）

适用目标：把 KLA 服务端部署到 CentOS 7（glibc 2.17）服务器，使用 systemd 托管，
PG/Redis 以 Docker 运行。服务、运行时与数据统一放在 `/home/kla`（该机 `/home`
为 9T 本地 XFS/LVM 卷），环境文件在 `/etc/kla/server.env`。

背景：目标主机的 Docker 存储层（`/var/lib/docker`）对 pnpm 安装过程中的
chmod-0444/并发写入模式必报 `EPERM: operation not permitted, write`
（已试遍 pnpm 版本固定、copy 导入、去 cache mount、strace 排障，见 `Dockerfile` 注释），
因此**不在该机容器内构建**：产物在 Windows 开发机构建后传入。该主机 Docker
运行时装载普通镜像（PG/Redis）写入模式简单，不受影响。

通用架构、目录规范、密钥迁移与 HTTPS 规划沿用
`docs/SERVER_AND_WINDOWS_CLIENT_DEPLOYMENT_PLAN.md`（§2–§6、§8）；本文只补充
CentOS 7 特有步骤。

## 1. 宿主机准备（一次性）

### 1.1 修复 yum 源（CentOS 7 EOL 后 mirrorlist 失效）

```bash
sed -i -e 's|^mirrorlist=|#mirrorlist=|' \
       -e 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' \
       /etc/yum.repos.d/CentOS-*.repo
yum makecache
```

### 1.2 目录与账号

```bash
useradd -r -d /home/kla -s /sbin/nologin kla
mkdir -p /home/kla/releases /home/kla/deploy /home/kla/backup /home/kla/object-storage /etc/kla
chown -R kla:kla /home/kla
```

### 1.3 Node.js 运行时（glibc 2.17 兼容版）

CentOS 7 无法运行 Node 官方 Linux 二进制（要求 glibc ≥ 2.28）。使用 Node
unofficial-builds 的 glibc-217 变体：

1. 浏览 <https://unofficial-builds.nodejs.org/download/release/>，选取最新
   Node 22 LTS 版本号（下称 `vX.Y.Z`）。
2. 下载并校验：

```bash
cd /tmp
curl -fLO https://unofficial-builds.nodejs.org/download/release/vX.Y.Z/node-vX.Y.Z-linux-x64-glibc-217-x64.tar.xz
curl -fLO https://unofficial-builds.nodejs.org/download/release/vX.Y.Z/SHASUMS256.txt
grep 'glibc-217-x64.tar.xz' SHASUMS256.txt | sha256sum -c -
```

3. 安装：

```bash
mkdir -p /home/kla/node-vX.Y.Z
tar -xJf node-vX.Y.Z-linux-x64-glibc-217-x64.tar.xz -C /home/kla/node-vX.Y.Z --strip-components=1
ln -sfn /home/kla/node-vX.Y.Z /home/kla/node
/home/kla/node/bin/node -v   # 应输出 vX.Y.Z
```

## 2. PostgreSQL 与 Redis（Docker Compose，数据落本地盘）

数据目录必须 bind mount 到本地磁盘（XFS/ext4），**不要放默认的
`/var/lib/docker` named volume**——该存储层即触发 EPERM 的可疑层。

### 2.1 准备

```bash
mkdir -p /home/kla/deploy /home/kla/pgdata /home/kla/redis-data
chown -R 999:999 /home/kla/pgdata /home/kla/redis-data
```

Compose 文件在仓库 `deploy/docker-compose.yml`，发布时拷到服务器：

```bash
scp deploy/docker-compose.yml deploy/server.env.example deploy/kla.service root@<host>:/home/kla/deploy/
```

按 §4 填写 `/etc/kla/server.env`（其中 `POSTGRES_PASSWORD`、`REDIS_PASSWORD`
供 Compose 注入容器；`REDIS_URL`/`DATABASE_URL` 供服务端连接）。

### 2.2 启动

```bash
cd /home/kla/deploy
ln -sfn /etc/kla/server.env .env   # compose 自动读取项目目录的 .env
docker compose up -d
docker compose ps          # 两容器 healthy
```

若宿主机没有 `docker compose` 子命令（Docker 1.13 时代无 Compose V2 插件），
先升级 Docker CE 20.10：

```bash
yum remove docker docker-common
yum install -y yum-utils
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
yum install -y docker-ce-20.10.24 docker-ce-cli-20.10.24 containerd.io \
  docker-compose-plugin
systemctl enable --now docker
```

注意：PG16 官方镜像要求 ext4/XFS 文件系统（overlay2 的 ext4 后端满足）。

## 3. 构建与发布（每次发版）

### 3.1 Windows 开发机构建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-server-artifact.ps1
```

产出 `out\kla-server-<version>-<stamp>.tar.gz` 及 SHA256。脚本内建校验：
必需文件齐全、`node --check` 语法检查、产物内 0 个符号链接/junction 残留。

### 3.2 传输与校验

```bash
scp out\kla-server-0.1.0-20261010-1200.tar.gz root@<host>:/tmp/
```

```bash
echo '<构建输出的 sha256>' /tmp/kla-server-*.tar.gz | sha256sum -c -
```

### 3.3 解压与切换

```bash
VER=0.1.0   # 与产物文件名一致
mkdir -p /home/kla/releases/$VER
tar -xzf /tmp/kla-server-$VER-*.tar.gz -C /home/kla/releases/$VER
chown -R kla:kla /home/kla/releases/$VER
# 先删再建：若 current 已是真实目录，直接 ln -sfn 会在其内套娃建出 current/$VER/
rm -rf /home/kla/current
ln -s /home/kla/releases/$VER /home/kla/current
systemctl restart kla
```

## 4. 环境文件 `/etc/kla/server.env`

从 `deploy/server.env.example` 复制后填写：

```bash
cp /home/kla/deploy/server.env.example /etc/kla/server.env
chown root:kla /etc/kla/server.env && chmod 640 /etc/kla/server.env
```

必填项（否则服务拒绝启动或功能不可用）：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | `postgres://kla:<密码>@127.0.0.1:5432/kla` |
| `REDIS_URL` | `redis://:<密码>@127.0.0.1:6379`；未设密码为 `redis://127.0.0.1:6379` |
| `COMPUTE_SECRET_ENCRYPTION_KEY` | **必须沿用旧环境原值**，存量积分/凭据密文依赖；旧环境无则随机生成并留存 |
| `KNOWLEDGE_SECRET_ENCRYPTION_KEY` | 同上；旧环境无单独设置时可省略（回退算力密钥） |
| `SUB2API_BASE_URL` / `SUB2API_ADMIN_API_KEY` | 模型网关上游 |
| `SUB2API_DEFAULT_GROUP_ID` / `SUB2API_PERSONAL_GROUP_ID` / `SUB2API_FAST_GROUP_ID` | 托管账号分组 |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | 供 §2 的 Compose 注入容器；服务本身走 `DATABASE_URL`/`REDIS_URL` |

可选项及默认值见文件内注释（与 `server/src/config.ts` 对齐）。

## 5. systemd

```bash
cp /home/kla/deploy/kla.service /etc/systemd/system/kla.service
systemctl daemon-reload
systemctl enable --now kla
```

### 5.1 日志与轮转

| 日志 | 去向 | 轮转 |
| --- | --- | --- |
| kla 应用（pino JSON） | stdout → journald | journald 自带；CentOS 7 默认单文件约 4GB、总量约文件系统 10%，通常够用 |
| kla-postgres / kla-redis | Docker json-file | compose 已配置 `max-size: 50m` × `max-file: 3`（每容器约 150m 上限） |

如需收紧 journald 占用（`/var/log/journal` 在根分区时）：

```bash
vi /etc/systemd/journald.conf
#   SystemMaxUse=500M
#   MaxRetentionSec=1month
systemctl restart systemd-journald
journalctl --vacuum-size=500M --vacuum-time=1month   # 立即收缩已占空间
```

排查日志见 `journalctl -u kla`（应用）、`docker logs kla-postgres`（数据库）；日志字段含义与检索方式见 `docs/OBSERVABILITY_SPEC.md`。

## 6. 验证清单

```bash
systemctl status kla                            # active (running)
journalctl -u kla -n 100 --no-pager            # 无 EPERM / 连接报错
curl -sf http://127.0.0.1:8787/api/health       # 服务端启动自动执行数据库迁移
docker exec kla-postgres psql -U kla -d kla -c '\dt kla.*'   # 业务表就位
```

（Nginx HTTPS 与公网接入见 `SERVER_AND_WINDOWS_CLIENT_DEPLOYMENT_PLAN.md` §5–§6。）

## 7. 升级与回滚

- 升级：构建新版本产物 → 解压到 `/home/kla/releases/<新VER>` →
  `rm -rf /home/kla/current && ln -s /home/kla/releases/<新VER> /home/kla/current` →
  `systemctl restart kla`（服务启动自动迁移数据库）。
- 回滚：`rm -rf /home/kla/current && ln -s /home/kla/releases/<旧VER> /home/kla/current && systemctl restart kla`。
  注意数据库迁移可能已向前执行，回滚前评估迁移兼容性。

## 8. 备份

- 数据库：`docker exec kla-postgres pg_dump -U kla -d kla -Fc > /home/kla/backup/kla-$(date +%F).dump`
- 对象存储：rsync `/home/kla/object-storage`
- 密钥：`/etc/kla/server.env` 单独加密留存
- 备份异机保存（沿用部署方案文档 §4 规划）。

## 9. 故障排查

| 症状 | 排查 |
| --- | --- |
| `systemd-escape`/启动即退 | `journalctl -u kla -n 200`；先查 `DATABASE_URL`/`REDIS_URL` 连通 |
| 5432/6379 连不上 | `docker ps` 两容器是否 Up；`ss -lntp \| grep -E '5432\|6379'` |
| 容器起动即退出 | `docker logs kla-postgres`；常见为数据目录属主不是 999 |
| SELinux 拒绝（initdb 报 `postmaster.pid`/`pg_wal` Operation not permitted） | `/home` 目录标签与容器不匹配；compose 已用 `security_opt: label=disable` 规避。若改回其他挂载路径后复发，用 `ausearch -m avc -ts recent` 确认，并对数据目录 `chcon -R -t container_file_t /home/kla/pgdata` 或恢复 `label=disable` |
| `node -v` 报 `GLIBC_2.28 not found` | 说明装错成官方二进制，重新按 §1.3 安装 glibc-217 变体 |
| 构建产物在容器内构建报 EPERM | 预期内；本仓库不在该机容器内构建，改用 §3 流程 |
| `Cannot find module 'avvio'`（fastify 的传递依赖） | 产物构建必须用 `pnpm deploy --config.node-linker=hoisted`；isolated 布局的链接被展开成副本后路径断链，构建脚本 `scripts/build-server-artifact.ps1` 已固定此参数 |
| 服务启动后无日志静默退出（`requireStack: []` 或直接 exit 0） | 两种可能：① `MODULE_NOT_FOUND, requireStack: []` → 入口文件不存在，检查 `ls -l /home/kla/current/dist/server.js`；② 无报错但退出 → 入口守卫经软链启动时路径不匹配（`server.ts` 已改用 `realpathSync`），确认产物为含此修复的版本 |
| `ln -sfn` 后 `/home/kla/current` 变成目录（套娃 `current/0.1.0/`） | `current` 若已是真实目录，`ln -sfn` 不会替换而是在其内建子目录；先 `rm -rf /home/kla/current` 再 `ln -s /home/kla/releases/$VER /home/kla/current` |
| 磁盘写入慢/数据库损坏 | 确认 `/home/kla` 在本地 XFS/ext4，不在 NFS/CIFS/可疑层 |
