# 记忆模块：只读浏览

## 功能与边界

记忆页参考《鲲擎2.0_交互演示版.html》的统计卡片、群组标签、文本列表和右侧说明布局，增加项目筛选与长期 / 短期切换。页面只读，不提供新增、编辑、删除、重置或导入入口。

权威数据来自当前登录身份对应的 PostgreSQL 记录。近期七天短期记忆在客户端 IndexedDB 缓存一份，查看更早记录时按需请求服务器。浏览不发起模型调用、记忆提炼或写操作，也不刷新记忆的强化时间。最新生命周期与上下文规则见 [MEMORY_LIFECYCLE.md](./MEMORY_LIFECYCLE.md)。

## 查看路径

1. 进入左侧「记忆」，默认查看当前身份的全部项目、群组、智能体的长期记忆。
2. 选择项目后，仅展示该项目的群组和来源智能体；项目级记录也可查看。
3. 选择群组后，仅展示该群组的成员和实际记忆来源智能体。
4. 选择智能体、长期或短期类型，以分页文本列表展示正文、来源、所属项目 / 群组及真实更新时间。短期可选择最近七天、三十天或一年，并展示当前时间权重；归零记录标注「仅历史查看」。长期记忆无时间权重，当前只允许保存和查看，不用于检索或智能体上下文。
5. 切换项目清空群组和智能体筛选，切换群组清空智能体筛选；每次筛选回到第一页。切换身份卸载旧浏览组件、中止未完成的请求并重新加载，避免旧身份数据闪回。

每页默认 20 条，可前后翻页。页面支持加载、无记录、请求失败及只读刷新状态。统计显示当前身份全部范围的条目数，不冒充自动整理次数。

## 数据口径

| 类型 | 来源 | 说明 |
| --- | --- | --- |
| 长期记忆 | `memories` 中有效的已保存记录 | 除 `short_term`、`short-term`、`task_summary`、`task_context` 外的现有 kind 归入长期记忆，保持历史类型兼容；`timeWeight=null` |
| 短期任务记忆 | `memories` 的上述四类记录 | 服务端保留创建后 365 天；显式过期或达到保留期限的记录不展示；30 天后时间权重为零，仍可查看 |
| 短期对话上下文 | 每个群组一年内的用户 / 智能体 `messages` | 历史浏览独立于模型上下文窗口；标注「最近对话上下文」，不冒充已提炼的长期记忆；清理短期记忆不删除聊天记录 |

用户输入属于共享对话上下文，筛选某个智能体时仍展示，并标注「用户输入（共享）」。智能体回复按实际 sender / metadata 归属。未标注来源的历史记忆显示「未标注智能体」，不猜测归属。

群组关联读取 metadata 的 `conversationId`，兼容 `chatId`；项目关联优先群组所属项目，其次工作区 `project_id`，最后 metadata 的 `projectId`。来源读取 `agentId` / `sourceAgentId` 和 `agentName` / `sourceAgentName`，匹配当前身份可见的智能体。没有群组关联的项目级或身份级记录仍可在对应的上级范围查看。

本次不新增自动长期记忆提炼器。当前真实 REST 群聊对话按身份、群组、智能体读取最多 12 条未归零的共享用户输入 / 本智能体消息，再加入最多三条按旧版公式评分的短期任务摘要。成功回复后写入带任务来源的短期摘要。长期记忆不注入上下文，也不被 `/memories/search` 检索；已保存长期记忆可真实查看，没有保存记录时展示空状态。

## 只读接口

所有请求需要有效 Bearer token 和 `x-identity-id`。服务端校验登录会话、身份归属与 `read` 权限；前端身份参数不作为授权依据。

### GET `/api/v1/memories/browser/scopes`

返回标准成功信封，`data` 为：

```ts
{
  projects: Array<{ id: string; name: string; agents: Agent[] }>;
  conversations: Array<{ id: string; projectId: string; name: string; agents: Agent[] }>;
  agents: Agent[]; // 当前身份全部范围的去重来源与群组成员
  counts: { longTerm: number; shortTerm: number };
  latestUpdatedAt: string | null;
}
type Agent = { key: string; name: string };
```

### GET `/api/v1/memories/browser`

| 参数 | 类型 / 默认 | 含义 |
| --- | --- | --- |
| `projectId` | 可选 UUID | 限定项目 |
| `conversationId` | 可选 UUID | 限定群组 |
| `agentKey` | 可选字符串，1–200 字符 | 使用 scopes 返回的 key，不以展示名称代替 |
| `term` | `long_term`（默认） / `short_term` | 记忆周期 |
| `page` | 整数，默认 1，最大 100000 | 页号 |
| `pageSize` | 整数，默认 20，最大 100 | 页大小 |
| `from` | 可选 ISO 时间 | 创建时间下界（包含），近期七天查询可命中本地缓存 |
| `to` | 可选 ISO 时间 | 创建时间上界（包含），不得早于 `from` |

返回 `data: { items, page: { page, pageSize, total } }`。每条 item 包含正文 `content`、`term`、原始 `kind`、`source`、项目 / 群组 ID 与名称、`agentKey` / `agentName`、`shared`、来源消息 ID、创建 / 更新时间及可选过期时间。新增 `reinforcedAt`、`retainedUntil` 和 `timeWeight`；长期记忆后两项为 `null`，短期归零时 `timeWeight=0`。

`source` 为 `stored_memory` 或 `conversation_context`。智能体 key 优先真实 UUID，无法匹配的历史名称使用 `name:<名称>`，未知来源使用 `unattributed`；共享用户上下文使用 `shared`。正文作为普通文本渲染，不执行其中 HTML。

参数无效返回 400；未登录返回 401；身份不属于当前账户或缺少 read 权限返回 403。合法但无权访问的其他身份项目 / 群组 ID 返回空列表，不能读取其他身份数据。错误关联到其他身份项目 / 群组的历史 metadata 不展示，非法 metadata ID 不进行 UUID 强制转换，避免历史数据引发查询失败。

## 实现位置与验证

- 契约：`packages/contracts/src/memories.ts`，共享生命周期常量及衰减函数：`packages/contracts/src/memory-policy.ts`。
- 只读查询：`server/src/memories/browser.ts`，路由追加在 `server/src/routes.ts`。
- 短期召回、摘要保存及清理：`server/src/memories/short-term.ts`。
- 客户端适配器：`apps/desktop/src/api/memories.ts`，IndexedDB 缓存：`apps/desktop/src/api/memory-cache.ts`。
- 页面：`apps/desktop/src/workstation/MemorySection.tsx`，原工作站记忆占位页面替换为独立组件。
- 数据迁移：`server/migrations/0019_short_term_memory_lifecycle.sql`，补充时间、使用计数、评分和保留期限字段；历史记录以创建时间初始化，长期内容不更改。

验证覆盖：项目 / 群组 / 来源智能体映射、长短期切换、时间范围、分页、共享上下文、身份隔离、只读页面无修改按钮、七天缓存 / 更早服务器读取、退出清理、迟到响应与无缓存环境、衰减归零、阅读不强化、摘要幂等、上下文排除长期和其他智能体私有记录、清理不删除长期与聊天记录。数据库集成测试使用独立随机 schema，结束后仅清理该测试 schema。
