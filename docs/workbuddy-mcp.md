# WorkBuddy MCP 接入

KLA 在这条链路中是 MCP Client，WorkBuddy 是 MCP Server。KLA 不会把自身的统筹提示词写入 WorkBuddy，也不会让 WorkBuddy 反向调用 KLA。

## 配置来源

“智能体管理 → 外接三方 → 接入 WorkBuddy”支持两种来源：

- 从 WorkBuddy 配置读取：`%USERPROFILE%\\.workbuddy\\.mcp.json`、`mcp.json`，以及 connector 运行配置目录中的 `mcp.json`。
- 手动填写 MCP endpoint、传输方式、认证 Token 和任务工具名。

导入时优先使用启用的 `connector-proxy` 或 WorkBuddy endpoint；如果配置文件只有被禁用的 `connector:wk-workbuddy`，界面仍会展示该 endpoint，用户可以确认后启用或手动调整。

## 本地 Connector Proxy

WorkBuddy 的本地 Connector Proxy 通常形如 `http://127.0.0.1:<port>/mcp`，并要求当前 WorkBuddy 会话生成的 Bearer Token。该 Token 是运行时短期密钥，不保存在普通 `mcp.json` 中。KLA 不读取日志、不抓取进程内存；用户需要在连接弹窗中填入当前 Token。KLA 会使用系统 `safeStorage` 加密保存认证头，数据库只保存 secret 引用。

## 群聊执行

连接成功后，KLA 会创建一个可挂载的 `custom.workbuddy` 外接智能体 Profile。群聊实例沿用本地角色卡、记忆和隔离工作区，但不会修改 WorkBuddy 的内部身份。执行时 KLA 通过 MCP 完成 `initialize → tools/list → tools/call`，按工具 schema 传入完整委派消息和工作区路径，结果进入工作树和群聊正式消息。

如果 WorkBuddy 暴露多个工具，可以在弹窗填写“任务工具名称”；留空时 KLA 会按工具名和描述匹配 `chat`、`ask`、`run`、`execute`、`agent` 等任务工具，只有一个工具时自动使用该工具。

## 中立 MCP 中继模式（推荐用于 KLA -> WorkBuddy）

这条链路与上面的“直接连接 WorkBuddy”不同。KLA 不连接 WorkBuddy 的私有地址，也不把 KLA 自己的 Team MCP Server 暴露出去。KLA 在本机启动一个临时的、只监听 `127.0.0.1` 的中立任务中继；WorkBuddy 作为 MCP 客户端挂载它并主动领取任务。

### 桌面端操作步骤

1. 打开 **设置 → 智能体管理 → 外接三方**，找到 WorkBuddy 卡片。
2. 点击 **启动中立 MCP 服务**。KLA 会随机分配本机端口，并生成当前会话临时 Token。
3. 在卡片中点击 **复制配置**。复制内容类似：

   ```json
   {
     "mcpServers": {
       "neutralRelay": {
         "type": "streamableHttp",
         "url": "http://127.0.0.1:43127/mcp",
         "headers": {
           "Authorization": "Bearer <当前会话 Token>"
         }
       }
     }
   }
   ```

4. 打开 WorkBuddy 的 **MCP / 连接器设置**，选择添加服务器（Streamable HTTP），粘贴上面的配置，或分别填写 MCP 地址和 `Authorization` 请求头。
5. 在 WorkBuddy 中启用 `neutralRelay` 连接器，先执行 `tools/list` 确认看到 `relay_get_pending_tasks`、`relay_claim_task`、`relay_report_progress`、`relay_complete_task` 等工具。
6. KLA 后续把需要 WorkBuddy 处理的任务投递到中继队列，WorkBuddy 使用 `relay_get_pending_tasks` 读取、使用 `relay_claim_task` 领取，执行过程中报告进度，最后完成或失败。KLA 通过任务状态读取结果并继续群聊调度。

### 服务边界与安全注意事项

- 中立中继不属于 KLA，也不属于 WorkBuddy；它只做本机任务队列和状态转发，不执行模型调用。
- 服务只绑定 `127.0.0.1`，不会监听局域网或公网；Token 每次启动都会重新生成，停止后立即失效。
- WorkBuddy 配置文件中不要把 Token 提交到 Git 或分享给他人。关闭 KLA 或点击“停止中继服务”后，需要重新启动并复制新的配置。
- 如果 WorkBuddy 运行在虚拟机、容器或另一台电脑中，`127.0.0.1` 指向的是它自己的回环地址，无法访问 KLA；这时需要在同一台机器运行，或后续明确配置受控的局域网代理和访问策略。

### 常见检查

- 浏览器或 PowerShell 访问 `http://127.0.0.1:<端口>/health` 应返回 `service: neutral-task-relay` 和 `running: true`。
- WorkBuddy 返回 401 时，通常是 Token 已过期、复制不完整或 KLA 中继已停止；回到 KLA 重新启动并复制配置。
- 能看到工具但没有任务时，说明连接成功，只是 KLA 尚未向中继投递任务；不需要重复创建服务器。
