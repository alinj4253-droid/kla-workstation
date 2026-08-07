# 渠道手动绑定功能设计

> 状态：待评审 ｜ 目标版本：MVP 后迭代
> 关联：`docs/MVP_IMPLEMENTATION_SPEC.md`

## 1. 背景与目标

现有渠道绑定由渠道侧触发（群内 `/new` 建项目自动绑定、`/use <shortId>` 绑定已有项目，见 `apps/desktop/src/main/channel-manager.ts:330` 的 `getOrCreateBinding`）。缺失的场景：**用户在应用内已建好项目，想直接把某个 IM 群绑定到该项目**，而无需先进入该群发指令。

本功能在**保持现有绑定逻辑不变**的前提下，新增应用侧手动绑定入口：

- 用户从飞书客户端复制群会话 ID（chat_id，`oc_` 开头）；
- 在应用内（设置页渠道管理 / 项目工作区快捷入口）粘贴该 ID、选择项目；
- 校验通过后写入 `channel_bindings`，该群此后按现有链路收发消息。

## 2. 现状与约束

| 项 | 现状 |
| --- | --- |
| 数据表 | `channel_bindings(channel_id, external_conversation_id, project_id, created_at)`（`db/migrate.ts:377`），**无唯一约束** |
| 绑定写入 | `ChannelManager._createBinding`（`channel-manager.ts:733`），私有；调用前必先查重 |
| 绑定查询 | `getOrCreateBinding`（`channel-manager.ts:330`），已有绑定直接返回 |
| IPC | `channels:list / save / test / setEnabled / delete`（`index.ts:2047` 起；preload `index.ts:147`） |
| 渲染 | `SettingsPage.tsx:2157` 的 `ChannelsSettings`；preload 全局对象 `window.kunqing.channels.*` |
| 迁移机制 | `db/migrate.ts:19` 逐条执行 `{name, sql}`，现有最后一条 `018_local_knowledge_index` |

### 约束
- 双向渠道（可收消息）才可绑定：`lark`、`telegram`、`dingtalk`。`wecom-webhook` 仅出站，**排除**。
- 一个 `(channel_id, external_conversation_id)` 只允许对应一个项目；换绑需显式确认（upsert）。
- 渲染进程不得访问 Node/Electron 模块；全部走 `window.kunqing.*` 桥。

## 3. 需求定义

### 3.1 范围（In Scope）
1. 应用侧手动绑定：粘贴会话 ID + 选渠道 + 选项目 → 绑定。
2. 绑定前会话校验（拉取群名回显，防止绑错群）。
3. 已绑定列表管理（查看 / 解绑）。
4. 渠道侧 `/id` 指令：bot 回复当前会话 ID，解决"ID 从哪来"。
5. `channel_bindings` 唯一性迁移与去重。

### 3.2 非目标（Out of Scope）
- 钉钉真实 inbound 链路（`dingtalk.ts:52` stream 仍为 stub），本功能只定义接口与校验策略，钉钉校验随该工作项落地。
- 外部群支持、自动发现（bot 拉取群列表选择绑定）。
- 会话 ID 从群分享链接解析（`add_by_link` 链接是 `link_token`，非 chat_id，不采用）。

### 3.3 用户故事
- 作为用户，我在飞书群设置复制了群 ID，希望在应用里把该群绑到我已建的项目，从而在该群 @机器人 即可使用项目上下文。
- 作为用户，我在钉钉群里发 `/id`，把 bot 回复的会话 ID 粘到应用里完成绑定。

## 4. 调研结论（ID 获取路径）

| 渠道 | 用户端能否直接看到会话 ID | 结论 |
| --- | --- | --- |
| 飞书 | **能**。客户端 ≥ 7.60 后，群右上角 ⋯ → 群设置 页面直接显示"群 ID"（`oc_` 开头），与 `im.message.receive_v1` 的 `message.chat_id` 为同一值 | 手动复制可行 |
| 钉钉 | 不能。存量群 chatId/openConversationId 客户端无展示入口；官方仅支持"创建群"服务端 API 或"选择会话"客户端 JSAPI 获取 | 需靠 bot `/id` 自述 |
| Telegram | 能（第三方工具/机器人） | `/id` 统一覆盖 |

> 结论：飞书可纯手动复制；钉钉必须走 bot `/id`。两渠道都通过"应用侧粘贴 ID"的同一入口收敛。

## 5. 总体方案

```
路径 A（主）：应用侧手动绑定
  应用 UI（粘贴 ID + 选项目）
    → channels:previewConversation（校验，拉群名）
    → channels:bind（写入 channel_bindings，upsert）
    → 后续群内消息沿用现有 getOrCreateBinding / _routeToAgent 链路

路径 B（辅助）：渠道侧 /id 指令
  群内发 /id → ChannelManager.processCommand 新增 'id' 动作
    → 回复 "会话 ID: oc_xxx（渠道: 飞书）"
    → 用户复制 → 走路径 A
```

## 6. 数据模型变更

新迁移 `019_channel_bindings_unique`（追加到 `db/migrate.ts` migrations 数组末尾）：

```sql
-- 去重：同 (channel_id, external_conversation_id) 保留最早一条
DELETE FROM channel_bindings
WHERE id NOT IN (
  SELECT MIN(id) FROM channel_bindings
  GROUP BY channel_id, external_conversation_id
);

CREATE UNIQUE INDEX idx_channel_bindings_conversation
  ON channel_bindings(channel_id, external_conversation_id);
```

影响面：`getOrCreateBinding`/`_createBinding` 均先查重后写入，不冲突；后续 `_createBinding` 改为 `INSERT OR IGNORE` 以防御并发。

## 7. 主进程改动

### 7.1 channel-core 适配器扩展（`packages/channel-core/src/types.ts`）

新增可选能力，双向渠道实现、其余缺省：

```ts
export interface ExternalConversationInfo {
  name?: string;      // 群名，用于回显
  exists: boolean;    // bot 是否可访问该会话
}

export interface ChannelAdapter {
  // ...现有字段
  /** 可选：解析/校验外部会话，供绑定前预览 */
  getConversationInfo?(target: ExternalTarget): Promise<ExternalConversationInfo>;
}
```

实现：
- **lark**（`lark.ts`）：`GET /im/v1/chats/{conversationId}`（需应用已开启 `im:chat:readonly`，且 bot 在该群）。`code === 0` → `exists: true, name: data.name`；`code === 230002`（群不存在/bot 不在群）→ `exists: false`。
- **telegram**（`telegram.ts`）：`GET /bot{token}/getChat?chat_id={conversationId}`，`ok && result.title`。
- **dingtalk**（`dingtalk.ts`）：实现格式校验（`cid_` 前缀）并返回 `exists: true`（尽力而为）；真实查询随 inbound 工作项补充（当前无可用 token 调用链）。

### 7.2 ChannelManager 扩展（`channel-manager.ts`）

新增公开方法：

```ts
async previewConversation(channelId: string, externalConversationId: string)
  // -> { ok, data?: ExternalConversationInfo, error?: string }
  // 渠道不存在 / 不可绑定 / adapter 无该能力时返回 verified=false 而不是报错

async bindConversation(channelId: string, externalConversationId: string, projectId: string)
  // -> { ok, data?: { alreadyBoundToProjectId?: string }, error?: { code, message } }
  // 校验渠道、项目存在；会话重复绑定时（同 channel_id + conv）返回 ALREADY_BOUND，由 UI 二次确认后走 upsert

async unbindConversation(channelId: string, externalConversationId: string)
  // -> { ok }

listBindings(channelId?: string)
  // -> Array<{ channelId, channelName, channelType, externalConversationId, projectId, projectName, createdAt }>
```

复用与改动：
- 写库复用 `_createBinding`（改为 `INSERT OR IGNORE` + 失败时 UPDATE，或直接 `INSERT ... ON CONFLICT(channel_id, external_conversation_id) DO UPDATE SET project_id`）。
- `processCommand`（`channel-manager.ts:370`）新增 `/id` 分支，action 联合类型增加 `'id'`；回复内容由 `_getChannelTypeLabel(channelId)` + `externalConversationId` 拼装。
- `_handleInbound`（`channel-manager.ts:400`）对 `action === 'id'` 走"回复 + `markProcessed` + return"，不落入 agent 路由。
- 隐私提示（`channel-manager.ts:450`）与 `/help`（`:393`）文案补充 `/id` 一行。

### 7.3 IPC 契约（`apps/desktop/src/main/index.ts`，紧邻 `channels:*` 注册区）

| 事件 | 入参 | 出参（成功） |
| --- | --- | --- |
| `channels:listBindings` | `{ channelId?: string }` | `{ ok: true, data: BindingRow[] }` |
| `channels:previewConversation` | `{ channelId, externalConversationId }` | `{ ok: true, data: { name?: string, exists: boolean, verified: boolean } }` |
| `channels:bind` | `{ channelId, externalConversationId, projectId, force?: boolean }` | `{ ok: true, data: { id, alreadyBound?: string } }` |
| `channels:unbind` | `{ channelId, externalConversationId }` | `{ ok: true }` |

错误码（沿用 `{ ok: false, requestId, error: { code, message, retryable } }` 结构）：
- `CHANNEL_NOT_FOUND` / `CHANNEL_NOT_BINDABLE`（wecom-webhook）
- `PROJECT_NOT_FOUND`
- `CONVERSATION_NOT_FOUND`（preview 返回 `exists: false`）
- `ALREADY_BOUND`（`force=false` 时；`error.data.currentProjectId` 供提示）

## 8. 渲染进程改动

### 8.1 preload 桥（`apps/desktop/src/preload/index.ts:147` `channels` 段追加）

```ts
listBindings: (input: { channelId?: string }) => rpc('channels:listBindings', input),
previewConversation: (input: { channelId: string; externalConversationId: string }) => rpc('channels:previewConversation', input),
bind: (input: { channelId: string; externalConversationId: string; projectId: string; force?: boolean }) => rpc('channels:bind', input),
unbind: (input: { channelId: string; externalConversationId: string }) => rpc('channels:unbind', input),
```

### 8.2 UI

**主入口：每个项目的「更多操作」菜单（`ChatPage.tsx`）**
- 在 `ChatPage.tsx:851` 的 `conversation-more-menu` 中，"重命名"（`:854`）与"解散群聊"（`:855`）之间新增按钮：
  ```tsx
  <button type="button" onClick={() => { setMoreMenuOpen(false); setChannelBindOpen(true); }}><Link size={15} />绑定渠道会话</button>
  ```
- 点击打开 `ChannelBindingsDialog`，**当前 `projectId` 已预选**，用户只需选渠道 + 粘贴会话 ID。

**同步入口：项目工作区头部（`WorkspacePage.tsx`）**
- 在 `:284` 的 `workspace-actions` 按钮组中新增（置于「图谱可视化」前或后，样式 `secondary-button`）：
  ```tsx
  <button type="button" className="secondary-button" onClick={() => setChannelBindOpen(true)}><Link size={15} /> 绑定渠道会话</button>
  ```
- 与 ChatPage 入口打开同一个 `ChannelBindingsDialog`，同样预选当前 `projectId`。

- 对话框内容：
  - 项目名（只读展示当前项目）。
  - "新增绑定"表单：渠道下拉（`channels:list`，过滤 `lark/telegram/dingtalk`）→ 会话 ID 输入 → [校验] 按钮（`channels:previewConversation`，成功回显群名）→ [确认绑定]（`channels:bind`；返回 `ALREADY_BOUND` 时二次确认后 `force: true`）。
  - 已绑定列表：该项目名下已有绑定（群名（若有）/ 会话 ID / 渠道名），行尾"解绑"（`confirm` 确认）。
  - 引导文案：飞书用户"群 ⋯ → 群设置 复制群 ID"；钉钉用户"群内发 `/id` 获取会话 ID"。

**辅助入口：设置 → 渠道（`SettingsPage.tsx` `ChannelsSettings`）**
- 保留一个只读管理视图（后续可选）：列出全部绑定、按渠道分组，仅解绑操作。本期可先不做，仅随主入口交付 `listBindings` IPC 供对话框使用。

设计约束：按钮/图标复用现有 `styles.css` 设计变量，不引入新色；对话框样式复用 `project-action-dialog` 结构（`ChatPage.tsx:1011` 重命名对话框同款），新增表单字段参考 `ChannelAddDialog`。

## 9. 校验逻辑（绑定前）

流程：`channels:previewConversation` → 主进程查渠道 → `adapter.getConversationInfo?()`：

1. 渠道不存在 / 类型不可绑定 → `{ verified: false, error: code }`。
2. adapter 无该能力（第三方未来渠道）→ 降级 `{ verified: true, exists: true, name: undefined }`，仅提示用户核对。
3. `exists === false` → UI 提示"机器人不在该群或会话 ID 无效（请确认已把机器人拉入目标群）"，阻断绑定。
4. 通过 → 回显群名 + 确认绑定。

## 10. 错误处理与边界

- 输入规范化：会话 ID `trim()`；飞书 `oc_`、钉钉 `cid_`、Telegram 数字串做前缀/格式预检（仅提示，不强校验）。
- 解绑不改动既有消息与 `channel_events`，只删 `channel_bindings` 行。
- 绑定到已归档项目：提示"项目已归档"，仍允许（维持现状语义，不新增限制）。
- 渠道删除（`channels:delete`）时级联清理 `channel_bindings`（当前 `index.ts:2131` 仅删 channels 行，本设计补一条 `DELETE FROM channel_bindings WHERE channel_id = ?`）。
- 迁移前存在重复绑定：`019` 迁移先 `MIN(id)` 去重再建唯一索引。

## 11. 测试计划

沿用现有 `channel-manager.test.ts` 模式（内存 `better-sqlite3` 建表）：

- `ChannelManager`：
  - `bindConversation`：成功绑定 / 重复绑定返回 `ALREADY_BOUND` / `force` 换绑 / 渠道不存在 / 项目不存在。
  - `unbindConversation`、`listBindings` 联表返回项目名。
  - `processCommand('/id')` 返回含会话 ID 的回复；`_handleInbound` 对 `/id` 不路由 agent。
  - 迁移 `019`：造重复行 → 运行后唯一索引存在、重复行仅保留一条。
- Adapter：`lark.getConversationInfo`（mock fetch：成功 / 230002 / 网络错）、`telegram.getConversationInfo`、`dingtalk` 格式校验。
- 渲染：`SettingsPage` 绑定对话框关键交互（可选，沿用现有组件测试风格）。
- 回归：`pnpm --filter @kunqing/desktop typecheck`、`pnpm lint`、`channel-manager` 与 `channel-core` 全部用例。

## 12. 分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `019` 迁移 + `_createBinding` upsert 化 + 级联清理 | 迁移与单测通过 |
| 2 | channel-core `getConversationInfo`（lark/telegram 真实现，dingtalk 格式校验） | 单测通过 |
| 3 | `ChannelManager` 新方法 + `/id` 指令 + IPC + preload | `channel-manager.test.ts` 全绿 |
| 4 | UI：`ChannelBindingsDialog` + 项目「更多操作」菜单入口（重命名下方）+ 工作区头部按钮（`WorkspacePage.tsx:284`） | 手动冒烟：飞书复制 ID → 校验回显群名 → 绑定 → 群内 @机器人 收到回复 |
| 5 | 文档/帮助文案收尾 | `/help` 与隐私提示包含 `/id` |

## 13. 风险与备注

- **飞书权限**：`GET /im/v1/chats` 需应用开启 `im:chat:readonly`；未开时 preview 返回 403，UI 应提示"请先在开放平台开通读取群信息权限"而非仅报错。
- **钉钉**：preview 为尽力而为（`exists: true`），需在钉钉 inbound 工作项落地后补齐真实校验；本期在 UI 文案中明确告知。
- **外部群**：飞书开放平台对应用机器人外部群支持有限，本期仅支持内部群，文档中注明。
- 本功能为增量改动，`getOrCreateBinding`、`_routeToAgent`、`onRunCompleted` 回复链路均不修改。
