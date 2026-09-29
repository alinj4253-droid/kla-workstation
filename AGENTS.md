# Repository guidance

- 本分支只承载新版本（客户端 + 服务端）；旧版纯桌面代码在 `main` / `chat` 分支，不要把旧版模块带回本分支。
- 结构：`apps/desktop`（React 渲染层 + 轻量 Electron 壳）、`server`（Fastify 服务端）、`docs/`（新版设计文档）。
- 使用 pnpm workspaces（`apps/*`、`server`）。禁止提交 `package-lock.json`；依赖一律进各包 `package.json` 后 `pnpm install`。
- 交付前运行 `pnpm ci-check`（typecheck + lint + test + build）。
- 客户端边界：渲染层不得访问数据库、文件系统、模型密钥或外部算力服务；Electron 壳仅提供窗口与类型化 Preload（`apps/desktop/desktop/preload.cjs`），保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 服务端 API 调用统一走 `apps/desktop/src/api/` 客户端适配器；`window.kunqing` 为迁移期遗留桥接，新代码不得新增使用，逐步收敛到 HTTP/SSE 契约。
- 服务端权威数据（账号、身份、权限、知识、长期记忆、角色定义）只存服务端；客户端仅做缓存与草稿。
- 设计文档见 `docs/`，拆分原则见 `docs/CLIENT_SERVER_SPLIT.md`。
