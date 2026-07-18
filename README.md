# 鲲擎多智能体集成工作站

Electron + React + TypeScript 的本地优先多智能体桌面工作站。

## 当前实现

- 完整 pnpm monorepo 骨架。
- 安全 Electron Main/Preload/Renderer 分层。
- 首页与群聊详情 Mock UI，可通过侧栏、项目卡片和发送按钮切换。
- Runtime、Contracts、Database、Model、Native Agent、Workspace、Memory、Knowledge、Channel、UI 等后续模块包边界。

## 开发

```bash
pnpm install
pnpm dev
```

仅启动浏览器中的 Renderer 便于 UI 调试：

```bash
pnpm dev:web
```

验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 目录

- `apps/desktop`：Electron 桌面应用。
- `apps/runtime`：后续 Agent Runtime utility process。
- `packages/*`：领域契约与业务模块边界。
- `docs/MVP_IMPLEMENTATION_SPEC.md`：完整开发规格。
