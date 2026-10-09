# KLA Workstation Client

KLA Workstation 桌面客户端：React + Vite 渲染层 + 轻量 Electron 桌面壳。源码来源于旧版 Electron Renderer，已具备独立依赖与构建。

## 当前状态

- `src/`：React 页面、组件、状态和客户端交互。
- `public/`：客户端静态资源。
- `index.html`：Renderer 入口。
- `desktop/`：安全 Preload、本地执行器及窗口壳；不承载服务端数据库、知识或 Agent 编排逻辑。
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
pnpm dev              # Vite 浏览器开发模式（http://localhost:5173）
pnpm build            # 类型检查 + 生产构建
pnpm --filter @kla-workstation/desktop desktop   # 构建 + Electron 壳运行（加载 dist 产物）
```

开发时让 Electron 壳加载 Vite 热更新页面（免重复构建，需 Vite 已启动）：

```bash
# PowerShell
$env:KLA_RENDERER_URL="http://localhost:5173"; pnpm --filter @kla-workstation/desktop exec electron .
# bash
KLA_RENDERER_URL=http://localhost:5173 pnpm --filter @kla-workstation/desktop exec electron .
```

`pnpm package:win` 用于生成 Windows 安装包（前端产物打进壳内 asar，服务端仅提供 API）。当前会话/登录/注册/身份等已切换 `src/api` HTTP 客户端；部分页面仍使用旧桥接 API（浏览器模式自动兜底为空数据），独立桌面壳用于验证构建边界与桌面能力。

## 本地执行边界

浏览器预览只提供群聊界面；`local_*` 工具需要 Electron 桌面客户端登录同一身份并保持在线。本地执行器主动出站轮询服务端，不开放本机入站端口。每次调用均弹窗审批，读取内容、命令输出会回传服务端供智能体继续处理。

默认只允许访问该身份的任务目录。需要读取或写入其他目录时，在启动 Electron 前设置 `KLA_LOCAL_ALLOWED_ROOTS` 为允许目录的绝对路径列表；Windows 用分号分隔，其他系统用冒号分隔。允许目录必须真实存在，符号链接不能用于越界。`local_bat` 和 `local_cli` 仍以当前系统用户权限运行，路径限制只约束工具参数中的文件路径与工作目录，不构成独立 OS 沙箱；对命令内容应逐次审查并审批。

新建文件默认回传可预览副本；设置 `KLA_LOCAL_ARTIFACT_UPLOAD=false` 可只回传文件名、大小和 SHA-256，不回传内容。该设置不会阻止智能体通过已获批准的读取或命令工具返回文件内容。
