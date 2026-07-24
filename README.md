# 鲲擎多智能体集成工作站

Electron + React + TypeScript 的本地优先多智能体桌面工作站。

## 要求

- **Node.js** >= 22
- **pnpm** 9（`corepack enable pnpm`）
- Windows（MVP 以 Windows 为首要目标）

## 快速开始

```bash
pnpm install
pnpm dev          # Electron 开发模式
pnpm dev:web      # 仅浏览器中调试 Renderer UI
```

## 验证

```bash
pnpm typecheck    # TypeScript 类型检查（所有包）
pnpm test         # Vitest 单元测试（303 tests / 19 files）
pnpm build        # 全部包 + electron-vite 构建
pnpm package:win  # 构建 + NSIS 安装包
```

## 项目结构

| 目录 | 说明 |
|---|---|
| `apps/desktop` | Electron 桌面主应用 |
| `apps/runtime` | Agent Runtime utility process |
| `packages/*` | 领域契约与业务模块 |
| `docs/` | 开发规格与文档 |
| `fixtures/` | 测试用 mock Agent |

## 数据目录

默认工作区路径：`~/Documents/K_Studio/`（可在首次启动时通过选择对话框更改）。

```
K_Studio/
├── .kstudio/
│   ├── workspace.lock    # 文件锁，防止多实例冲突
│   ├── workspace.json    # 工作区标记（含 workspaceId、schemaVersion）
│   ├── k_studio.db       # SQLite 业务数据库（Drizzle ORM）
│   ├── logs/             # pino 运行日志
│   ├── cache/            # 缓存
│   └── temp/staged-uploads/  # 临时上传暂存区
├── group-chats/
│   └── {projectId}-workspace/  # 每个群聊项目的工作区
│       ├── identity/     # Agent Identity
│       ├── memory/       # 持久化记忆
│       ├── original/     # 源文件
│       ├── knowledge/    # 知识图谱
│       └── visualization/# 可视化
└── shared-knowledge/
    └── original-files/   # 共享知识原文件
```

> 应用业务数据仅写入上述声明的目录结构，不会散落到未声明位置。

## 技术栈

- **框架**: Electron 43 + React 19 + TypeScript 7
- **构建**: electron-vite 5 + Vite 8
- **样式**: Tailwind CSS 4 + shadcn/ui 风格 Design Token
- **数据库**: SQLite (better-sqlite3) + Drizzle ORM
- **Agent**: LangGraph + ModelGateway + ToolRegistry
- **渠道**: Telegram / 飞书 / 钉钉 / 企业微信 Webhook 适配器
- **测试**: Vitest + Testing Library

## 已知限制（MVP）

- **会议**和**任务中心**在导航中明确禁用（不在 MVP 范围）。
- **渠道适配器**使用 mock 适配器进行 schema 验证；真实消息收发需通过对应外部服务验证。
- **安装包**仅支持 Windows NSIS；卸载默认保留用户工作区数据。
- **Crash Recovery**：Runtime 崩溃后重启会将未完成 Run 标记为 `interrupted`。
- **原生模块** `better-sqlite3` 需 `node-gyp` 编译，`electron-rebuild` 在 `dev`/`build` 时自动处理。
