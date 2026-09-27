# KLA Workstation 客户端/服务端拆分说明

## 1. 当前代码状态

当前可运行产品是 Electron 桌面应用：

| 现有位置 | 当前职责 | 下一版本归属 |
|---|---|---|
| `apps/desktop/src/renderer` | React 页面、交互、消息流、预览 | 客户端 |
| `apps/desktop/src/preload` | 类型化 Electron 能力桥接 | 客户端适配层 |
| `apps/desktop/src/main` 窗口/IPC/文件选择 | 桌面生命周期和本地代理 | 客户端 Main |
| `apps/desktop/src/main` 知识/OCR/标准化/切片/检索 | 本地知识处理 | 服务端 Knowledge Service |
| `apps/desktop/src/main` `memory-manager`/记忆表 | 长期记忆和摘要 | 服务端 Memory Service；短期缓存留客户端 |
| `apps/desktop/src/main` `agent-executor`/调度/任务表 | 服务端编排和运行审计 | 服务端 Agent Orchestrator |
| `apps/desktop/src/main` `agent-identity`/定义/技能注册 | 角色与技能权威配置 | 服务端 Registry；客户端只缓存快照 |
| `packages/database` SQLite | 本地元数据和运行记录 | 服务端 Metadata DB；客户端只保留缓存数据库 |
| `packages/knowledge-core` | 解析、切片、Embedding 领域逻辑 | 服务端 Worker/Service |
| `packages/memory-core` | 长期记忆领域逻辑 | 服务端 Memory Service |
| `packages/model-core`/模型网关 | 模型调用 | 服务端 Model Gateway + sub2api |
| `packages/channel-core` | 渠道协议适配 | 服务端渠道接入；客户端保留 UI 配置 |

`frontend/` 已创建为当前 Renderer 的客户端快照；`server/` 已创建为服务端边界目录。为避免破坏现有桌面预览，当前 `apps/desktop` 构建入口暂未切换。

## 2. 推荐目标目录

```text
frontend/
  src/                 # React 页面和客户端状态
  public/              # 图标、帮助文档等静态资源
  api/                 # HTTP/SSE 客户端适配器
  desktop/             # Electron Main/Preload 适配器

server/
  apps/api/             # Gateway、认证、权限、业务 API
  apps/worker/          # OCR、解析、切片、Embedding、Whisper 任务
  apps/agent-runtime/   # 服务端 Agent Orchestrator
  packages/knowledge/   # 知识领域服务
  packages/memory/      # 长期记忆
  packages/artifacts/   # 成果和版本
  packages/compute/     # Model Gateway、sub2api、用量
  packages/registry/    # 智能体、技能、MCP 注册表
  packages/auth/        # 身份和权限
```

## 3. 角色、技能和记忆存储

### 后端权威存储

- 智能体身份、职责、角色卡、技能绑定、模型参数、权限声明。
- 官方/组织/项目级角色注册表及版本。
- 技能定义、MCP 工具授权、学习草稿、发布版本和回滚记录。
- 长期记忆、项目事实、用户确认偏好和运行审计。

### 客户端缓存

- 当前用户有权读取的角色注册表快照。
- 当前任务的短期上下文、流式状态、未同步草稿。
- 离线期间的 UI 状态、上传分片和重试队列。

客户端缓存只能用于展示和恢复，不能作为执行时的最终权限或角色依据。服务端每次执行智能体/技能/MCP 前，都要按当前角色版本和用户权限重新校验。

## 4. 迁移顺序

1. 先固定 `contracts` 中的认证、资源作用域、文件、知识、记忆、任务、智能体和用量 API。
2. 把 OCR、解析、标准化、切片、Embedding 和检索抽为服务端 Worker，并以真实文件完成端到端联调。
3. 迁移长期记忆、成果和角色/技能注册表；本地 SQLite 改为缓存和兼容读取。
4. 接入 Model Gateway/sub2api 和服务端 Agent Runtime。
5. 把 Renderer 对 `window.kunqing` 的调用切换到 API adapter；Electron Preload 仅实现同一契约的本地代理。
6. 完成旧工作区迁移、权限隔离和回滚测试后，才切换生产构建入口。

## 5. 不建议的做法

- 不要把整个 `apps/desktop/src/main` 原样移动为服务端。
- 不要让客户端保存角色权威定义、长期记忆或知识主副本。
- 不要让客户端直接连接 sub2api、OCR、向量库或对象存储。
- 不要在服务端迁移前删除现有 SQLite 和本地工作区数据。

