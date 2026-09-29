# KLA Workstation Client

KLA Workstation 桌面客户端：React + Vite 渲染层 + 轻量 Electron 桌面壳。源码来源于旧版 Electron Renderer，已具备独立依赖与构建。

## 当前状态

- `src/`：React 页面、组件、状态和客户端交互。
- `public/`：客户端静态资源。
- `index.html`：Renderer 入口。
- `desktop/`：只负责窗口和安全 Preload 的桌面壳，不承载数据库、知识或 Agent 后端逻辑。
- `src/api/`：HTTP API 客户端占位，后续逐步替换 `window.kunqing`。

## 客户端边界

客户端可以保存短期会话上下文、流式恢复点、上传缓存、离线草稿和 UI 状态；所有知识、OCR、标准化全文、切片、embedding、检索、成果、长期记忆、角色权威配置和权限判断必须通过服务端 API 获取。

Renderer 不得直接访问数据库、文件系统、模型密钥、OCR/Embedding/Whisper 服务或 sub2api。Electron 环境下仍必须通过 Preload 类型化桥接；浏览器/服务端模式下使用同一组 API 契约的 HTTP/SSE 适配器。

## 后续迁移

1. 把 `src` 中依赖 `window.kunqing` 的调用收敛到 `src/api`。
2. 用服务端会话和资源权限替代本地 SQLite 读写。
3. 在 API 联调完成后，用本项目独立打包桌面客户端。

## 构建

在仓库根目录使用 pnpm：

```bash
pnpm install
pnpm dev              # Vite 浏览器开发模式
pnpm build            # 类型检查 + 生产构建
pnpm --filter @kla-workstation/desktop desktop   # 构建 + Electron 壳运行
```

`pnpm package:win` 用于生成 Windows 安装包。当前页面业务仍使用旧桥接 API；在后端接口迁移完成前，独立桌面壳用于验证构建边界，不代表全部业务接口已经联通。
