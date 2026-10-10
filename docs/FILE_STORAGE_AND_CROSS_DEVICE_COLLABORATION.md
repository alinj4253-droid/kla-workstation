# 群聊文件存储、任务工作区与跨设备协作

## 1. 目标与存储分层

用户附件、智能体中间文件、正式成果分层保存。PostgreSQL 保存归属、权限和引用；服务端对象存储保存共享内容；Electron 保存设备任务工作区。群聊消息携带文件 ID 和元数据，不嵌入二进制。其他设备通过服务端 ID 下载，不能访问来源设备的绝对路径。

本次增加文件协作能力，复用既有登录、身份、项目/群聊成员、工具网关与审批。不新增知识入库流程，不改变独立的记忆、知识库和算力业务规则。浏览器可上传/预览/下载；执行本地 read/write/CLI/PPT 必须有在线 Electron 执行器。

| 数据 | 位置 | 共享规则 |
| --- | --- | --- |
| 文件归属、名称、MIME、大小、SHA-256、对象 key | PostgreSQL files、upload_sessions | 权威元数据 |
| 用户上传内容 | ObjectStore | complete 后，当前群聊成员按权限访问 |
| 成果元数据、来源设备、工具调用引用 | PostgreSQL artifacts | 当前身份与群聊成员关系授权 |
| 二进制成果、超过 256 KiB 的文本成果 | ObjectStore | 数据库保存 storage_key；小型文本可保持 inline |
| 本地输入、中间脚本、日志、输出 | Electron agent-runtime/<identityId>/runs | 设备本地、按任务保留 |
| 消息、任务状态、步骤、审批/工具回执 | PostgreSQL | 复用 REST 状态接口和群聊记录 |

当前 ObjectStore 是持久化文件系统适配器，临时文件写入后原子重命名，拒绝越界 key。默认目录是服务端运行目录下的 .runtime/object-storage。S3/MinIO 尚未实现；.env.example 的 endpoint/bucket/access key 为预留项，当前适配器不读取它们。

## 2. 身份与协作权限

请求携带登录 token 和 x-identity-id。服务端验证有效身份、动作权限与资源归属。企业项目群聊沿用企业、项目成员、群聊成员校验。个人身份不能凭企业 ID 读取企业资源；退出群聊后，新文件/成果请求也会被拒绝。

- 群聊附件指定 conversationId，仅当前群聊成员可访问，上传需 write。
- 工作区文件指定 workspaceId，沿用工作区身份归属，不自动向群聊共享。
- workspaceId 与 conversationId 必须且只能选一个。
- 上传会话只能由创建它的身份续传/完成；其他成员只能读已完成文件。
- 成果 /content 预览使用 read；/download 使用 export。
- 附件 /files/{id}/content 当前统一用于预览/下载，使用 read，没有独立附件 export 接口。
- 本地输入接口额外校验设备、设备绑定登录会话、工具调用、运行状态及当前群聊。

fileId、artifactId 是跨设备标识。workspace:// 仅定位当前设备、当前身份工作区，不能交给另一台设备直接使用。

## 3. 用户上传与消息附件

1. 选择多个文件，前端串行上传，每条消息最多 20 个附件；显示进度，上传中禁用发送。切换群聊/身份或卸载组件取消当前上传。
2. POST /api/v1/files/upload-sessions 提交范围 ID、fileName、contentType、sizeBytes、可选 SHA-256。拒绝非法文件名和超限文件。
3. PUT /api/v1/files/upload-sessions/{sessionId}/content 上传 application/octet-stream，验证实际大小和指定 SHA-256。
4. POST /api/v1/files/upload-sessions/{sessionId}/complete 重新校验对象，事务内创建 files 并保存 file_id。完成请求幂等，重试返回同一文件；完成后不能再次 PUT 覆盖。
5. 发送消息携带 fileIds。服务端只接受当前群聊内、已完成且有权访问的文件，保存文件引用和元数据。支持只有附件、没有文字的消息。
6. 点击历史附件打开右侧预览，刷新后从群聊历史恢复引用。

上传会话默认 1 小时过期。创建和过期判定使用数据库时间，避免本机与数据库时钟偏差。PUT/complete 用行锁串行处理；内容缺失、大小/哈希不一致不会生成可用文件记录。

**共享时点是 complete 成功，早于消息发送。** 页面提示“已保存到群聊 · 同群成员可访问”。移除附件草稿只取消本条消息引用，不删除服务端文件。上传失败不加入草稿；取消或过期对象尚无自动清理任务，见 §10。

## 4. 本地工作区

根目录默认 Electron userData/agent-runtime，位于用户数据目录，独立于源码目录。布局：

    agent-runtime/
      installation.json
      <identityId>/
        journals/                  # 回执与副作用状态日志
        runs/
          <runId>/
            <stepId>/
              <toolCallId>/
                workspace.json
                input/             # 共享文件的本地副本
                work/              # CLI、BAT、PPT 中间文件
                output/            # 待发布成果
                logs/              # stdout/stderr

run/step/call 隔离避免并发覆盖。默认 local_write/local_code 输出到当前 output/，CLI/BAT 在当前 work/ 运行。后续工具用返回的 workspace:// 引用访问同一设备、身份的其他步骤文件。

显式外部写入路径和命令工作目录需配置允许目录；现有用户审批可放行外部文件读取/发布。目录隔离不是操作系统级沙箱，CLI 进程权限仍属于启动 Electron 的操作系统用户。

### 清理规则

不在单个工具回执确认后清空 work/，同一 run 后续步骤可能继续使用它。整个 run 清理同时满足：

1. 服务端确认 run 为 completed、failed 或 cancelled。
2. 本地调用目录和回执全部 acknowledged，或明确被服务端拒绝后的 discarded。
3. 达到 TTL，或超过软容量上限时成为可清理候选。

默认最后确认后保留 24 小时，软容量上限 2 GiB；符合条件的候选按时间从旧到新删除。活动任务、状态未知、未确认回执、损坏记录受保护，超过软上限也不强删。离线或查询失败不猜测任务已结束。轮询期间按分钟检查；删除本地副本不影响服务端已上传成果。

## 5. 网关文件工具与跨设备闭环

| 工具 | 位置 | 行为 |
| --- | --- | --- |
| file_read | 服务端 | 读取当前群聊文本附件，支持 offset/maxChars；二进制仅返回元数据和解析提示 |
| artifact_read | 服务端 | 读取当前群聊成果，兼容 inline/对象存储；二进制不进入模型上下文 |
| artifact_write | 服务端 | 创建文本成果，大文本外置；同一调用重试返回同一 ID/key，不能覆盖已有内容 |
| local_file_fetch | 本地 | 按 fileId 或 artifactId 下载共享文件，校验 SHA-256，写入 input/，返回工作区引用 |
| local_file_publish | 本地 | 读取指定本地文件，大小/哈希校验后通过工具回执发布成果 |
| local_write、local_code | 本地 | 默认生成 output/ 文件，按配置自动回传成果 |
| local_cli、local_bat | 本地 | 保存日志和工作目录引用；生成文件须显式 publish 才成为共享成果 |
| PPT 工具 | 本地 | 保留构建、检查、渲染和严格 QC，成果可上传对象存储 |

工具仍须由智能体挂载，经既有统一工具网关路由，不绕过权限/审批。内置文件技能增加 fetch/publish；迁移只补充已有对应内置挂载，不恢复用户移除的挂载。

上下文包含最近最多 20 条附件元数据，方便智能体找到 fileId；不会自动塞入全部内容。read 读取文本，不负责 PDF/图片 OCR 或 Office 二进制解析。

双设备接力示例：

1. 用户上传 sales.csv，消息携带 fileId。
2. 设备 A 经网关 fetch，得到 workspace://runs/.../input/sales.csv。
3. A 用 CLI 处理，在 work/ 生成文件，工具结果返回工作目录引用。
4. A publish，服务端保存对象和成果元数据，返回 artifactId。
5. 设备 B 用 artifactId fetch，下载到 B 自己的 input/，再继续处理。
6. 群聊成员从成果列表预览/下载；消息、任务、工具回执、成果引用形成 REST 闭环。

未发布的本地原始文件和中间文件留在本地。设备 A 离线后，B 可处理已上传副本，不能访问 A 未上传的内容。本地读工具返回的文本仍沿用既有工具结果回传机制。

## 6. API 契约

所有路径以下表 /api/v1 为前缀；前端调用统一走 apps/desktop/src/api 适配器。

| 方法 | 路径 | 输入/输出 |
| --- | --- | --- |
| POST | /files/upload-sessions | 范围 ID、fileName、contentType、sizeBytes、checksum → 会话、URL |
| PUT | /files/upload-sessions/{id}/content | 原始二进制 → uploaded |
| POST | /files/upload-sessions/{id}/complete | 空 body → 文件元数据，幂等 |
| GET | /files?conversationId=... | 当前成员可访问的文件列表 |
| GET | /files/{id} | 文件元数据、contentUrl |
| GET | /files/{id}/content | 鉴权文件内容 |
| POST | /conversations/{id}/messages | text/mode/fileIds；至少文字或一个附件 |
| GET | /conversations/{id}/artifacts | 成果列表，外置内容不重复内嵌 |
| GET | /artifacts/{id} | 成果元数据 |
| GET | /artifacts/{id}/content | read 预览内容 |
| GET | /artifacts/{id}/download | export 下载内容 |
| GET | /runtime/devices/{deviceId}/calls/{callId}/input | 按保存的 fetch 参数返回二进制、文件名、SHA-256 头 |
| POST | /runtime/devices/{deviceId}/calls/{callId}/receipt | result、artifact(s)、approval、receiptId，幂等回执 |
| POST | /runtime/devices/{deviceId}/workspaces/status | 最多 200 个 runIds → 当前设备/身份曾执行的 run 状态 |

input 接口只在 fetch 调用运行中且所属 run 活动时可用，不接受客户端任意替换 fileId。身份切换保留原调用会话/设备上下文，避免回执交到新身份。

## 7. 容量与预览

| 项目 | 默认限制 |
| --- | --- |
| 用户单文件上传 | 100 MiB，可用服务端变量调整 |
| Electron fetch | 100 MiB、60 秒 |
| 单条消息附件 | 20 个不重复 UUID |
| local publish 单文件 | 16 MiB |
| PPT 成果批次 | 32 MiB，须经过既有 QC |
| 右侧内嵌预览 | 10 MiB |
| file_read / local_read 文本 | 10 MB，支持分段返回 |
| 本地任务缓存 | 24 小时、2 GiB 软上限 |

支持文本、Markdown、隔离 HTML、PNG/JPEG/GIF/WebP、PDF 预览。PPTX 保留伴随 PDF 预览入口；其他格式/超限文件提示下载，不假装解析。Blob URL 切换/卸载释放，预览与下载均鉴权。

## 8. 配置与初始化

server/.env：

    OBJECT_STORAGE_PATH=.runtime/object-storage
    OBJECT_STORAGE_MAX_FILE_BYTES=104857600

相对路径按服务端进程工作目录解析。生产建议填写绝对持久化目录；备份同时覆盖数据库和对象目录。

Electron 环境变量必须在启动 Electron 的 shell/脚本设置。Vite .env 中非 VITE_ 项不会自动进入 Electron 主进程；.env.example 仅说明参数。PowerShell 示例：

    $env:KLA_LOCAL_WORKSPACE_TTL_HOURS = '24'
    $env:KLA_LOCAL_WORKSPACE_MAX_BYTES = '2147483648'
    $env:KLA_LOCAL_ALLOWED_ROOTS = 'C:/Work;D:/Projects'
    $env:KLA_LOCAL_ARTIFACT_UPLOAD = 'true'
    # 可选：覆盖 userData/agent-runtime
    # $env:KLA_LOCAL_WORKSPACE_ROOT = 'D:/KLA-local-cache'
    pnpm --filter @kla-workstation/desktop desktop

KLA_LOCAL_ARTIFACT_UPLOAD=false 仅回传元数据，不上传本地成果副本，其他设备无法下载该本地文件。它控制成果上传，不取消用户显式上传附件。允许目录必须预先存在。

新增迁移：

- 0039_file_object_storage.sql：成果对象 key/storage_status、文件上传时间。
- 0041_conversation_files.sql：群聊文件归属、上传会话 file_id、索引、已有文件能力挂载补充。

仓库根目录执行 pnpm --filter @kla-workstation/server db:migrate。迁移器检查已执行版本并补齐迁移，不删除/重置业务数据。服务启动沿用已有数据库初始化流程。

## 9. 验证

真实 PostgreSQL 集成测试使用随机隔离 schema：创建账号、企业、成员、项目、群聊、两台设备，验证上传校验/重试、消息引用、成员共享、跨身份拒绝、设备/会话绑定、成果回传/再次下载、成员撤销、过期/空文件及成果幂等写入。worker 用 stub，不调用真实模型。

前端组件测试覆盖上传→发送→右侧 Markdown 预览、附件页签不误请求成果接口、上传失败不提交引用，以及存储/inline PPTX 的 PDF 预览。Node 桌面检查执行真实文件读写、CLI/BAT、fetch/publish、清理保护和 PPT 适配器调用。

交付检查 pnpm ci-check；另执行：

    node --test apps/desktop/desktop/local-tools.check.cjs apps/desktop/desktop/local-workspace.check.cjs apps/desktop/desktop/local-ppt.check.cjs

## 10. 尚未实现的部署能力

- 文件系统 ObjectStore 尚非 S3/MinIO。多实例需共享可靠持久卷或后续适配器，仅填写 S3 预留参数不会启用 S3。
- 服务端尚无孤儿对象自动清理、附件删除 API、正式文件 TTL/归档任务。取消上传、事务回滚遗留对象及正式文件保留策略需后续实现；本地清理不能代替服务端清理。
- 上传/回执采用限额内整文件内存缓冲，尚无 multipart 断点续传、流式对象写入、杀毒扫描和独立存储配额。
- 跨设备接力必须 publish→服务端 ID→fetch；没有设备间直接文件系统同步。
- 未上传的本地中间结果不可跨端恢复；无在线授权设备时沿用既有调度等待/超时机制。

.runtime/、agent-runtime/ 已加入 Git 忽略。迁移、存储源码及本方案需要正常提交。
