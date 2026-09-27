# KLA Workstation Client

这里是下一版本服务端化拆分中的客户端源码快照，来源于当前可运行的 Electron Renderer。

## 当前状态

- `src/`：React 页面、组件、状态和客户端交互。
- `public/`：客户端静态资源。
- `index.html`：Renderer 入口。
- 当前桌面预览仍使用 `apps/desktop/src/renderer`，本目录暂不替换现有构建入口。

## 客户端边界

客户端可以保存短期会话上下文、流式恢复点、上传缓存、离线草稿和 UI 状态；所有知识、OCR、标准化全文、切片、embedding、检索、成果、长期记忆、角色权威配置和权限判断必须通过服务端 API 获取。

Renderer 不得直接访问数据库、文件系统、模型密钥、OCR/Embedding/Whisper 服务或 sub2api。Electron 环境下仍必须通过 Preload 类型化桥接；浏览器/服务端模式下使用同一组 API 契约的 HTTP/SSE 适配器。

## 后续迁移

1. 把 `src` 中依赖 `window.kunqing` 的调用收敛到客户端 API adapter。
2. 用服务端会话和资源权限替代本地 SQLite 读写。
3. 在 API 联调完成后，再将 `apps/desktop/vite.web.config.ts` 的 Renderer root 切换到本目录。

