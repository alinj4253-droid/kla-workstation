# 知识库归属、上传与检索权限调整方案

状态：设计方案，尚未实施。日期：2026-10-10。

## 1. 目标与现状

一个知识库在创建时确定为企业共享、项目或个人范围。文件上传后继承该库的归属；群聊检索只能召回当前群聊所属企业、项目，以及适用时当前个人身份可见的内容。这里的个人身份 ID 始终是 `identities.id`，不是 `users.id`。切换个人/企业身份后，当前身份 ID 会改变。

当前实现有以下差距：

| 环节 | 当前实现 | 缺口 |
| --- | --- | --- |
| 知识库目录 | `knowledge_client_state` 中按身份保存 `catalog.json`；目录只有 `scope` 和 `collection` | 没有权威的企业、项目、个人归属；项目选择只进入说明文字 |
| 上传 | `knowledge-library/submit` 将文件、名称、`collection` 转发到 `/v1/process/async` | 没有知识库 ID 和三个归属 ID；任务恢复依赖当前身份的 `bindings.json` |
| 文档目录 | `knowledge_documents` 以远端 `doc_id` 为主键 | 未关联知识库；不能区分同一集合内的多个库 |
| 文档授权 | `document_access_policy` 有 `identity_id`、`project_id`、`owner_identity_id` | 没有企业 ID、知识库 ID，且在线上传/检索没有使用该表 |
| 检索 | 页面经 `contentRequest -> /v1/search`；群聊智能体复用该路径；另有直通 `/api/v1/knowledge/search` | 只按当前身份检查基础 `read` 权限，未按文档归属在召回前过滤 |

字段说明文件记录的“80 篇文档、0 条授权”是其撰写时的数据库快照；实施前必须重新核实线上数据。以下设计以仓库现有迁移与代码为依据，尚未验证远端知识服务支持新增字段。

## 2. 归属语义

所有归属字段由 KLA 服务端从已认证身份、知识库和项目关系计算。客户端或模型传入的 ID 只能作为选择条件，不能作为授权事实。

| 库范围 | `organization_id` | `project_id` | `personal_identity_id` | 可读主体 |
| --- | --- | --- | --- | --- |
| `company` | 所属企业 ID | `NULL` | `NULL` | 该企业有效企业身份 |
| `project`（企业项目） | 项目所属企业 ID | 项目 ID | `NULL` | 该项目的有效成员身份 |
| `project`（个人项目） | `NULL` | 项目 ID | `NULL` | 项目所有者的个人身份；按现有项目成员规则 |
| `personal` | `NULL` | `NULL` | 个人身份 ID | 该个人身份本人 |

项目库中的个人身份字段始终为空，即使项目本身属于个人身份。企业群聊检索不带个人身份范围，避免个人文件被智能体回答到共享群聊。个人项目群聊可检索该项目库及当前个人身份的个人库。若将来需要在企业群聊使用个人文件，应另设计明确的私有上下文与分享流程。

字段名统一为 `organizationId/projectId/personalIdentityId`（KLA JSON）和 `organization_id/project_id/personal_identity_id`（KLA 数据库及上游协议）。现有 `owner_identity_id` 在个人库场景等价于 `personal_identity_id`，迁移期间保留原列名并在接口层映射，避免同时维护两份所有者 ID。

## 3. 表结构调整

使用新的增量迁移文件；不要修改已应用的 `0021_knowledge_documents.sql`。迁移编号需在落地时按仓库最新编号确定。

### 3.1 新增 `knowledge_bases`

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `id` | `uuid` 主键 | 稳定知识库 ID；不使用每次重配都会变化的 `serviceInstanceId` |
| `name`, `description`, `collection` | `text` | 展示信息和远端集合映射 |
| `scope` | `text` | `company/project/personal` |
| `organization_id` | `uuid NULL` 外键 | 企业库或企业项目库所属企业 |
| `project_id` | `uuid NULL` 外键 | 项目库所属项目 |
| `owner_identity_id` | `uuid NULL` 外键 | 个人库所属 `identities.id` |
| `created_by_identity_id` | `uuid` 外键 | 创建者及审计 |
| `status`, `created_at`, `updated_at` | 状态/时间 | 停用、查询和审计 |

数据库 `CHECK` 保证：企业库只有企业 ID；项目库必须有项目 ID、个人所有者为空；个人库只有个人所有者 ID。项目库的企业 ID 可为空，以容纳个人项目。企业库与个人库的其他归属列必须为空。创建/更新时再核对：项目 `organization_id` 与库一致，个人所有者的 `identities.type='personal'`，企业身份与企业一致。跨表一致性需由事务内检查或数据库触发器保障。库的归属与范围创建后不可直接修改；改归属走经审计的迁移流程。

`collection` 不是权限边界。多个知识库可使用同一个集合，因此必须同时以 `knowledge_base_id` 过滤。上游连接与凭证应由服务端统一管理；现有按身份存储的 `connection.json`、`serviceInstanceId` 可保留为兼容适配，但不能成为共享库的所有权依据。

### 3.2 扩展 `knowledge_documents`

新增 `knowledge_base_id uuid REFERENCES knowledge_bases(id)`，并建立 `(knowledge_base_id, doc_id)` 索引。继续保留 `doc_id text`，不把远端路径编码改成 UUID。`collection` 必须与所关联知识库一致。

迁移初期该列允许 `NULL`，表示尚未确认归属的历史文档；所有新上传文档必须有非空库 ID。未归属文档不得进入列表、全文读取或检索。历史数据分类完成后再评估 `NOT NULL` 约束；不能依据集合名自动猜测企业或项目归属。若未来接入多个上游服务，应先将文档主键扩为 `(upstream_id, doc_id)`，避免不同上游的同名 `doc_id` 冲突。

新增 `access_mode`，取值 `inherited`（默认）或 `allowlist`。`inherited` 按知识库归属和实时成员关系判权；`allowlist` 还要求当前身份有一条显式文档授权。这样“授权表无记录”有确定含义，不会因首条授权误伤其他文档。

### 3.3 调整 `document_access_policy`

保留该表作为**单文档收紧授权**，而不是企业/项目所有成员的物化名单。新增 `knowledge_base_id`，并将 `doc_id` 关联到 `knowledge_documents.doc_id`；可新增 `organization_id` 便于审计/索引，但它是知识库归属的冗余快照，必须与 `knowledge_bases.organization_id` 一致。现有 `project_id`、`owner_identity_id` 也只可与知识库归属一致，不允许通过修改授权行改变文档归属。`UNIQUE(identity_id, doc_id)` 保持不变。

写入授权时验证：被授权身份确属该企业/项目，或等于个人库所有者；授权不得跨知识库范围扩权。查询时先满足知识库实时成员规则，再在 `access_mode='allowlist'` 时要求授权行。移除项目成员、停用企业身份会立即失去访问权，无需批量更新文档授权表。个人库不能授权给其他身份。授权变更与 `access_mode` 切换在同一事务中完成并记录操作者。

### 3.4 新增 `knowledge_uploads`

建立持久化上传意图/任务关联：`client_upload_id` 唯一、`knowledge_base_id`、`uploader_identity_id`、`collection`、远端 `job_id`、物理文件名、远端存储路径、`doc_id NULL`、状态及时间。上传前写入意图，收到任务编号后更新；任务完成后按精确的 job/存储路径解析远端 `doc_id`，再将文档与库绑定。超时恢复沿用同一意图，不根据显示文件名猜归属。当前 `bindings.json` 和 `submissions.json` 可在迁移期读取，但新上传以该表为准。

## 4. KLA API 契约

所有接口使用 Bearer 会话和 `x-identity-id`。KLA 必须验证该身份属于会话用户且有效，并重新核对企业/项目成员关系。没有通过校验的请求不能发送到远端知识服务。

### 4.1 创建与列出知识库

建议以 `POST /api/v1/knowledge-bases` 创建，`GET /api/v1/knowledge-bases` 返回当前身份可见的库，替代客户端整表覆写式 `saveCatalog`。创建请求示例：

```json
{"name":"项目资料库","description":"方案与交付资料","scope":"project","projectId":"<真实 projects.id>","collection":"项目知识库"}
```

企业库的企业 ID 从当前企业身份取得；个人库的个人身份 ID 从当前个人身份取得；项目库的企业 ID 从 `projects.organization_id` 取得。若请求兼容旧客户端而包含 `organizationId` 或 `personalIdentityId`，只能与服务端计算值比对，不得直接采用。企业库创建/上传要求本企业管理权限，项目库创建/上传要求项目 `owner/manager`，个人库要求当前个人身份。读权限按第 2 节。

响应返回 `id/scope/organizationId/projectId/personalIdentityId/collection`。项目选择必须来自真实项目列表；删除界面的 `demo-project-*` 兜底。共享目录从 `knowledge_bases` 查询，旧的 `getCatalog/saveCatalog` 仅保留受控兼容期，不能再写入新的共享库。

### 4.2 上传

保留 `POST /api/v1/knowledge-library/submit` 的原始二进制请求体和现有 `clientUploadId/name/mime/serviceInstanceId`，增加必填 `knowledgeBaseId`。`collection` 可暂留，但 KLA 必须核对其等于该库的 `collection`。上传前先按库范围判写权限并写入 `knowledge_uploads` 意图。

KLA 向上游 `POST /v1/process/async` 的 multipart 继续传 `file/display_name/collection/ingest/save_slices/fix_terms`，另增加：

```text
knowledge_base_id=<知识库 UUID>
organization_id=<企业 UUID 或空字符串>
project_id=<项目 UUID 或空字符串>
personal_identity_id=<个人身份 UUID 或空字符串>
```

上游须将空字符串规范化为 `NULL`，校验上述组合，并把归属元数据写入文档及每个可检索切片。任务失败、取消或未确认时不能将文件标记为可检索；超时重试以 `clientUploadId` 幂等恢复。上游应返回或提供稳定 `doc_id` 与任务关联，KLA 随后更新 `knowledge_documents`。

### 4.3 检索

统一 `POST /api/v1/knowledge/search`、`knowledge-library/contentRequest` 的 `search` 分支和群聊 `knowledge_search` 工具到同一服务端检索服务。请求必须**二选一**提供 `conversationId`（群聊）或 `knowledgeBaseId`（库内搜索），同时携带 `query/mode/topK`；不再接受客户端自由指定集合或三个归属 ID 来扩大范围。旧入口在兼容期必须委托新服务，未提供上下文时拒绝，不能继续直通 `/v1/search`。

群聊请求先以当前身份验证 `conversation_members` 和 `project_members`，再经 `conversations.project_id -> projects.organization_id` 计算范围。企业项目群聊可检索该企业的企业库及该项目库；个人项目群聊可检索该项目库及当前个人身份的个人库。库内搜索仅检索指定库。服务端列出实际可读的库 ID 与集合，并处理单文档 `allowlist` 规则。

向上游 `POST /v1/search` 传服务端生成的 `organization_id/project_id/personal_identity_id`（不适用者为 JSON `null`）、`knowledge_base_ids` 和检索参数。三个 ID 的含义是**可召回范围的并集**，但每篇文档必须符合第 2 节对应行的完整字段组合，并属于 `knowledge_base_ids`；不能只判断某个非空 ID 相等就放行。企业项目群聊示例：

```json
{"query":"验收标准","mode":"hybrid","top_k":10,"organization_id":"<企业 ID>","project_id":"<项目 ID>","personal_identity_id":null,"knowledge_base_ids":["<可读企业库 ID>","<可读项目库 ID>"]}
```

现有 `/v1/search` 只接受单个 `collection`。若上游支持多集合查询，新增 `collections` 并在一次查询内统一排序；若暂不支持，KLA 按集合分别调用上游，每次调用仍须在**召回前**传完整过滤条件和对应库 ID，最后采用明确的跨集合重排策略，不能直接比较不同集合的原始分数。返回的每个命中必须有稳定 `doc_id`、`knowledge_base_id`、`collection`；KLA 再按当前成员关系和 `access_mode` 复核，异常命中整次报错并记录，不把未知来源内容返回给客户端。返回后裁剪不能代替上游召回前过滤。

## 5. 同步覆盖的读取路径

`listSources/getBindings`、任务与 SSE、切片、全文、预览、下载均应携带 `knowledgeBaseId` 或可验证的 `docId`，按同一库/文档规则判权。当前仅根据 `collection` 或远端 `/slices` 证明文档在某集合，不能证明它属于当前企业或项目。`knowledge_read` 工具也必须用当前群聊范围验证 `docId`，防止通过已知 ID 读取别的库。

客户端缓存键至少包含账号、当前身份 ID、知识库 ID或群聊 ID，以及检索条件；身份切换、成员资格变化和授权变化时失效。服务端不要把按身份保存的连接配置或目录 JSON 当成共享库授权依据。

## 6. 迁移与上线顺序

1. 新增表及可空列、校验规则和索引；保留旧数据，不修改 `0021`，也不运行 `db:grant --all`。
2. 上线知识库权威读写接口和上传意图表。仅把有明确证据的旧目录/绑定迁入：真实项目 UUID、企业归属、个人身份、精确 `doc_id`/任务/存储路径必须一致。重复的按身份目录由管理员确认合并。
3. 将未能确认归属的历史 `knowledge_documents` 保持 `knowledge_base_id=NULL` 并隔离，不自动判为企业共享；生成待分类清单，由管理员逐项指定或重新上传。
4. 先联调上游上传元数据、切片索引和检索前过滤能力。上游不能确认支持这些字段时，作用域检索返回服务不可用，不能退回无过滤搜索。
5. 接通 KLA 所有上传、检索、列表及全文入口；观测未归属、越权命中、恢复失败后切换流量。分类完成后再收紧非空约束并移除旧直通逻辑。

现有授权表为空不应阻止 `access_mode='inherited'` 的合法共享库读取；`allowlist` 文档无授权行则任何人都不可读。历史数据没有可信归属前不能因旧页面曾展示它就自动授予所有身份。

## 7. 验收条件

- 同一账号切换个人/企业身份后，个人库只在对应个人身份可见；传 `users.id`、其他身份 ID 或停用身份均被拒绝。
- 企业 A 与企业 B 使用同一 `collection` 时，上传、列表、检索、全文完全隔离；同企业项目 A/B 也隔离。
- 新增项目成员立即可读继承权限文档，移除成员立即失效；不依赖重写逐文档授权行。
- 企业群聊不会检索个人库；个人项目群聊只检索本项目库和当前个人库。
- 伪造 `organizationId/projectId/personalIdentityId/knowledgeBaseId`、直接调用旧检索入口、已知他库 `docId` 均不能越权。
- 超时/取消/恢复上传不会把文件归到错误库；未完成、未分类或未切片的文档不进入检索。
- 上游返回缺少稳定 `doc_id`、错误库 ID 或不支持过滤时请求失败且不泄露命中内容。

实施时同步更新 `packages/contracts` 的机器可读契约、`docs/API_CONTRACTS.md` 的变更记录及现有任务状态文档，并运行仓库规定的 `pnpm ci-check`。本文件只定义方案，不代表数据库、API 或远端知识服务已经改造。
