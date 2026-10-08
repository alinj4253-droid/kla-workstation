# KLA Workstation

企业多智能体协同工作站（客户端 + 服务端架构）。本分支为新版本（服务端化拆分）代码；旧版纯桌面实现见 `main` / `chat` 分支。

## 要求

- **Node.js** >= 22
- **pnpm**（`corepack enable pnpm`）

## 项目结构

| 目录 | 说明 |
|---|---|
| `apps/desktop` | 桌面客户端：React + Vite 渲染层 + 轻量 Electron 壳（窗口与安全 Preload） |
| `server` | 服务端：Fastify + TypeScript，账号/身份/项目/会话等 API |
| `docs/` | 服务端化拆分的设计与规划文档 |
| `packages/` | 预留：前后端共享契约包（后续按需建立） |

## 快速开始

```bash
pnpm install
pnpm dev:server   # 终端 1：服务端（http://127.0.0.1:8787，连接 server/.env 中的 PostgreSQL）
pnpm dev          # 终端 2：前端 Vite 开发模式（http://localhost:5173，浏览器调试）
```

首次使用在登录页注册账号（邮箱 + 至少 8 位密码 + 昵称），注册即自动登录。

Windows 可直接双击项目根目录的 `start-local-preview.bat`，启动当前目录的最新版前后端预览。需要 Node.js 22+、pnpm，以及已配置的 `server/.env`；依赖缺失时自动按锁文件安装，并构建最新共享契约。后端使用真实 PostgreSQL，启动时按原有逻辑执行数据库迁移。脚本等待前后端就绪后打开 `http://127.0.0.1:5173/`，后台日志位于 `.runtime/preview/`。关闭启动窗口不会停止服务，重复运行会复用当前项目的服务，端口被其他项目占用时会报错。启动脚本及 PowerShell 辅助脚本均可提交 Git，配置和运行日志保持忽略。

终端中可执行 `start-local-preview.bat -NoBrowser` 仅启动服务；需要调整端口时可追加 `-FrontendPort 5179 -BackendPort 8788`，前端会自动使用对应的后端 API 地址。

无数据库联调（mock 模式：内存存储，重启即清空）：

```bash
pnpm --filter @kla-workstation/server exec tsx src/mock/mock-server.ts
# 预置演示账号：demo@kla.local / demo123456
```

Electron 桌面壳运行（加载壳内构建产物）：

```bash
pnpm --filter @kla-workstation/desktop desktop   # 构建 + Electron 壳运行
```

开发时让 Electron 壳加载 Vite 热更新页面（免重复构建，需 Vite 已启动）：

```bash
# PowerShell
$env:KLA_RENDERER_URL="http://localhost:5173"; pnpm --filter @kla-workstation/desktop exec electron .
# bash
KLA_RENDERER_URL=http://localhost:5173 pnpm --filter @kla-workstation/desktop exec electron .
```

## 验证

```bash
pnpm typecheck    # 所有包 TypeScript 类型检查
pnpm lint         # ESLint
pnpm test         # Vitest 单元测试
pnpm build        # 全部包构建
pnpm package:win  # 客户端 Windows NSIS 安装包
```

## 当前实现状态

- **服务端**：PostgreSQL 持久化（启动时自动执行迁移），健康检查、注册/登录/登出、账号/身份/组织、项目与会话/消息、运行步骤、文件元数据、算力（sub2api）等 REST API 与服务端 Agent Loop 可用；Redis、对象存储、知识处理为占位实现。
- **客户端**：会话/登录/注册/身份切换/bootstrap 已切换 `apps/desktop/src/api/` HTTP 客户端；部分页面仍调用旧版 `window.kunqing` 桥接（浏览器模式下自动兜底为空数据），待逐步收敛。
- 迁移边界与计划见 `docs/CLIENT_SERVER_SPLIT.md` 与 `apps/desktop/README.md`。

## 文档索引

- [完整前后端技术落地规格](docs/FULL_STACK_IMPLEMENTATION_SPEC.md)
- [API 契约索引与冻结流程](docs/API_CONTRACTS.md)
- [客户端/服务端拆分](docs/CLIENT_SERVER_SPLIT.md)
- [下一版本 MVP：需求 / 技术设计 / 任务计划 / 项目计划](docs/NEXT_VERSION_MVP_REQUIREMENTS.md)
- [KLA Workstation 账号、身份与权限管理设计](docs/KLA Workstation 账号、身份与权限管理设计.md)
- [sub2api 算力平台设计](docs/DESIGN_SUB2API_COMPUTE_PLATFORM.md)
