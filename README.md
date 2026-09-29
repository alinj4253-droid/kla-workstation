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
pnpm dev:server   # 启动服务端（http://127.0.0.1:8787）
pnpm dev          # 桌面客户端 Vite 开发模式（浏览器调试）
pnpm dev:web      # 同上（根目录别名）
```

Electron 桌面壳运行：

```bash
pnpm --filter @kla-workstation/desktop desktop
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

- **服务端**为骨架：健康检查、注册/登录/登出、账号/身份、项目与会话/消息接口可用（内存存储）；其余接口返回 501 契约占位。PostgreSQL、Redis、对象存储、知识处理与 Agent Runtime 未接入。
- **客户端** UI 从旧版 Renderer 迁移而来，页面业务仍通过旧版 `window.kunqing` 桥接运行；服务端 API 客户端位于 `apps/desktop/src/api/`，尚未接入业务页面。
- 迁移边界与计划见 `docs/CLIENT_SERVER_SPLIT.md` 与 `apps/desktop/README.md`。

## 文档索引

- [客户端/服务端拆分](docs/CLIENT_SERVER_SPLIT.md)
- [下一版本 MVP：需求 / 技术设计 / 任务计划 / 项目计划](docs/NEXT_VERSION_MVP_REQUIREMENTS.md)
- [KLA Workstation 账号、身份与权限管理设计](docs/KLA Workstation 账号、身份与权限管理设计.md)
- [sub2api 算力平台设计](docs/DESIGN_SUB2API_COMPUTE_PLATFORM.md)
