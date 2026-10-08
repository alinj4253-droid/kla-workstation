# 知识库迁移到 Workstation

## 分支与来源
- 基线：feature/kla-workstation（最初 bb27f176；交付前同步至 49b912fb）。
- 开发分支：feature/zihaoxie-knowledge-workstation。
- 来源：feature/zihaoxie-front（be975569）。
- 保留新版客户端、认证、身份、权限、群组、项目、算力和服务端结构；只迁移知识库相关页面、契约与业务逻辑。

## 已迁移功能
| 功能 | 新入口／实现 |
| --- | --- |
| 公司、项目、个人知识库目录；创建、编辑、移除目录项 | KnowledgeSection 内嵌路由；服务端 getCatalog/saveCatalog |
| 自动映射集合、连接配置与上传同意 | getConnection/configure/acceptUploadConsent |
| 文件上传、唯一物理文件名、上传取消、提交恢复 | 二进制 submit、cancelUpload、getUnconfirmed/recoverSubmissions |
| 原件列表、类型／状态／日期筛选与查看 | listSources、getBindings；保留精确关联和集合验证 |
| 处理进度、任务取消、终态记录删除 | listJobs/getJob/cancelJob/deleteJobRecord；HTTP SSE + 轮询 |
| 来源变化刷新、已处理状态及部分切片统计 | 共享查询与原统计修正 |
| 切片筛选、分页、每条查看、来源正文跳转 | typed contentRequest → slices/detail/content |
| 全文及元数据查看、长段落阅读短页 | typed contentRequest → meta/content；最多 900 字符或 18 个换行 |
| 知识检索、命中内容和可信来源跳转 | typed contentRequest → search |

## 请求链
Workstation → apps/desktop/src/api/knowledge.ts → KLA /api/v1/knowledge-library/* → server/src/knowledge-api → 192.168.10.206:8120。

客户端不使用 window.kunqing，不直接访问文件系统、上游凭证或处理服务。既有 B 阅读契约在 HTTP 客户端边界复用，继续校验文档 ID、集合、计数和分页游标。

## 服务端状态
- 0018_knowledge_client_state.sql：按 identity_id 隔离连接、目录、上传关联和未确认提交。
- PostgreSQL 为实际运行的权威存储；客户端仅保留 React Query 缓存。
- 原桌面模块的全局可变状态改为 AsyncLocalStorage 身份上下文，避免用户之间串用配置、文档和上传控制器。
- API Key 用 AES-256-GCM 在服务端加密；配置响应不返回明文。
- mock server 使用服务端内存存储，重启重置，不作为持久化模式。

## 接口与权限的范围
KLA 接口校验登录身份、read/write 权限，文档必须精确关联上传记录或由切片接口证明属于当前集合。目录分组仍不代表上游已实现企业／项目 ACL；本次不把旧版展示分组解释为新的业务权限模型。
移除目录项保留上游集合，删除终态任务记录保留原件与切片；两项均保留原分支语义。
原客户端用户数据不随 Git 源码迁移，原 bindings.json 与目录数据没有自动导入；新增服务端状态从当前身份的初始目录开始，已有集合内容通过服务端验证后读取。

## 运行
1. 按 Workstation README 配置 PostgreSQL、Redis 与认证配置。
2. 启动服务端会执行 0017 迁移。
3. KNOWLEDGE_BASE_URL 默认 http://192.168.10.206:8120；更改时同步客户端 VITE_KNOWLEDGE_BASE_URL。
4. 需要知识服务 API Key 时配置 KNOWLEDGE_SECRET_ENCRYPTION_KEY（32 字节 hex/base64）；也可复用 COMPUTE_SECRET_ENCRYPTION_KEY。无 API Key 的知识服务不需要该加密配置。
5. pnpm dev:server；pnpm dev。登录并切换有效身份后进入知识库。
6. 无数据库联调可用 pnpm --filter @kla-workstation/server exec tsx src/mock/mock-server.ts；仅 mock 身份与状态保存在内存，上游读取和上传仍是真实请求。

历史知识库文档保留作为来源记录，以本文的新目录、存储和运行方式为准。
