# ACP 统一适配器方案

> 文档版本：0.2（评审通过，进入实现）  
> 状态：Implementing  
> 日期：2026-08-07  
> 范围：新增 ACP（Agent Client Protocol）统一适配器路径，并分批将原生支持 ACP 的现有 CLI 适配器迁移到该路径

## 1. 背景与目标

### 1.1 现状

项目当前有 8 个外部 CLI 适配器（codex、claude-code、aion、gemini、qwen-code、opencode、kimi、codebuddy），全部采用「spawn 子进程 + 命令行参数传指令 + 收集 stdout」的一次性模型。接口定义为 `ExternalAgentAdapter`（`packages/agent-core/src/external-agent-adapter.ts`），`run()` 同步等待进程退出并返回聚合的 stdout/stderr。

项目没有任何 ACP（Agent Client Protocol）支持。

### 1.2 问题

一次性 spawn 模型的能力天花板：

| 能力 | 手写 spawn 模型 | ACP 模型 |
|---|---|---|
| `structuredOutput` | 多数为 `false`（解析 stdout 文本） | 原生支持（事件流） |
| `resumableSession` | 基本为 `false` | `session/load` / `session/resume` |
| `reliableCancellation` | 杀进程 | `session/cancel` 优雅中断 |
| `processScopedMcp` | 无 | `session/new` 注入 mcpServers |
| 流式工具事件 | 无 | `session/update` 原生 |

MVP 规格 L1414 规定：只有同时通过「结构化输出、取消、无交互执行、长期稳定性」的策略才可成为 Leader 候选。当前手写模型下 `structuredOutput` 基本为 `false`，现有 CLI 永远进不了 Leader 门槛。

MVP 规格 L869 的适配器优先级第一项即为「CLI 原生支持 ACP/结构化协议：使用结构化 stdio」——当前实现未落实。

### 1.3 目标

1. 新增 ACP 统一适配器路径，作为外部 CLI 的首选通道。
2. 手写 spawn 模型保留为 ACP 不可用时的 fallback。
3. 分批迁移原生支持 ACP 的现有 CLI（codex、claude-code、gemini、opencode、qwen-code 等）。
4. 保持现有 `ExternalAgentAdapter` 接口与调用方（desktop 端 `agent-executor.ts`、`agent-connection-service.ts`、`index.ts`）无感知，或仅做最小必要改动。

## 2. 架构决策

### 2.1 使用官方 TS SDK

采用官方 `@agentclientprotocol/sdk`（npm，v1.0.0）作为协议实现基础：

- 官方 SDK 已处理 JSON-RPC 2.0 帧解析、id 匹配、通知分发、超时等基础。
- 手写 JSON-RPC over stdio 的坑较多：半包粘包、乱序、请求/通知复用同一通道、cancel 竞态。
- 项目 `packages/agent-core/src/adapters/spawn.ts` 只是简单的 spawn 辅助，没有这一层基础。
- SDK 在 agent-core（纯 Node，`type: module`）内使用，不涉及 Electron 依赖。

> 待确认：SDK 的 Node engine 要求、ESM 兼容性、是否允许自定义 spawn（处理 Windows `.cmd` shim）。

### 2.2 spawn 安全约束对齐 MVP 规格 L1357/L1358

无论 ACP 还是手写路径，spawn 层必须遵守：

- 所有命令使用 `executable + args[]`，禁止保存或执行一整段 Shell 字符串，禁止 `shell: true`（对应 `packages/agent-core/src/adapters/spawn.ts` 的 `buildSpawnInvocation`）。
- Windows `.cmd` shim 只能经过专门的 launcher（`spawn.ts` 的 `shouldUseCmdShim` 路径）；launcher 对空格、引号、Unicode、尾随反斜杠和恶意参数做固定夹具测试。
- ACP SDK 的 spawn 集成必须复用上述 launcher，不能由 SDK 直接裸 spawn，否则 Windows 下 `.cmd` shim 与参数转义会失效。

### 2.3 ACP 是 Client 端长连接，对外仍是一次 `run()`

我们作为 ACP 的 Client 端。每次 `run()` 内部完整执行：

```
spawn 进程
  → initialize（协商协议版本与能力）
  → session/new（创建会话，cwd=工作区，可携带 mcpServers）
  → session/prompt（发送用户指令）
  → 接收 session/update 流（消息块 / tool_call / plan / usage）
  → 收到 stopReason（end_turn / cancelled / ...）
  → session/close（释放资源）
  → 进程退出
```

对外语义不变：`run(input, sink, signal) → ExternalRunResult`。区别仅在内部从「等 stdout 收完」变为「事件驱动」。

### 2.4 一个 AcpCliAdapter + 注册表，而非每 CLI 一个适配器

`AcpCliAdapter` 作为工厂类，通过注册表配置实例化：

```ts
// registry 条目示例
{
  type: 'hermes',
  command: 'hermes',
  args: ['acp'],   // 官方文档：hermes acp 启动 stdio ACP server（JSON-RPC over stdio）
  versionProbe: ['--version'], // 版本探测参数
  env: {}, // ACP server 日志走 stderr，stdout 保持纯协议流，无需 banner 抑制
}
```

- `adapter.type` 来自注册表，非固定值。
- `detect()` 遍历注册表探测各命令是否存在（复用 `detect-shared.ts` 的 `detectExecutables`/`tryExec`）。
- 这避免了每新增一个 ACP CLI 就手写 4 个策略文件。

### 2.5 版本判定保持现有链路

- `readVersion` 仍通过 `--version` 探测（各 CLI 参数由注册表配置）。
- `selectStrategy` → `version-compatibility.ts`（desktop）判定 `compatible / experimental / incompatible`。
- `contract-validator.ts`（agent-core）与 `version-compatibility.ts`（desktop）都要补充新 CLI 条目。

### 2.6 能力上报

ACP 适配器的 `getCapabilities()` 应返回协议能力推导出的完整能力集（`structuredOutput` 等），并修复 `index.ts` `agents:detectCli` 中硬编码的 `capabilities: ['code-generation']`，改为读取 adapter 上报的能力。

### 2.7 能力与参数映射约束（MVP 规格 L1275/L876）

- 机器可读输出、非交互执行、继续会话和 MCP 注入均属于 strategy 能力，**只有契约测试通过才标记支持**（L1275）。ACP 能力同样不能仅凭协议存在就标记，必须逐个 CLI 实测 + 契约测试。
- 适配器必须保持 `detectedVersion -> strategyId -> capabilities` 显式映射；检测版本不在策略覆盖范围时状态为 `incompatible` 或经用户确认的 `experimental`，**禁止猜测命令行参数**（L876）。ACP 启动参数来自注册表实测结果，不得臆测。

## 3. 目录结构

```
packages/agent-core/src/adapters/acp/
├─ transport.ts      — JSON-RPC over stdio 封装（封装 SDK，自定义 spawn 与 banner 抑制）
├─ session.ts        — 连接生命周期：initialize / session/new / prompt / cancel / close
├─ adapter.ts        — AcpCliAdapter implements ExternalAgentAdapter
├─ registry.ts       — 内置 ACP CLI 清单（type + 命令 + 参数 + 版本探测方式 + env）
└─ contract-tests/   — 契约测试夹具
```

## 4. 关键设计决策

### 4.1 run() 生命周期自包含

`agent-executor.ts:911` 与 `:933` 会对同一 connection 调用**两次** `run()`（先拆解任务，再执行完整任务）。两次调用必须各自拥有独立的进程与 session 生命周期，不能复用连接，否则上下文串扰。

要求：`run()` 内部自包含「spawn → initialize → session/new → prompt → close → 进程退出」，任何异常路径都必须确保子进程终止、无泄漏。

### 4.2 调用路径统一到 adapter.run()

两个硬伤必须先行修复：

1. **`agents:startProcess`（`index.ts:1428-1473`）**：当前走 `selectStrategy().buildRun()` 拿 `execArgs`，再交给 `cliExecutor.execute()`（纯 spawn 收 stdout），**完全绕过 `adapter.run()`**。ACP CLI 在该路径会退化为「传指令字符串当参数」。修复方向：优先走 `adapter.run()`，`buildRun` 仅作为非 ACP fallback。

2. **smoke test（`agent-connection-service.ts:7` 依赖 `process-supervisor.ts` 的 `buildSpawnInvocation`）**：需核对 `runSmokeTest` 是否绕过 `adapter.run()`，若绕过则改为走 `adapter.run()`，否则向导「测试连接」对 ACP CLI 是假通过。

### 4.3 stdout 纯净

ACP 是 stdio 干净通道，CLI 的 banner / 进度输出会污染协议流。注册表需为每个 CLI 配置环境变量开关（如 OpenClaw `OPENCLAW_HIDE_BANNER=1`），spawn 时注入。

### 4.4 事件流映射与安全过滤（MVP 规格 L1411/L1412）

`session/update` 通知流映射到现有 `AgentEventSink`，直接复用 `agent-executor.ts:940-949` 的 trace 渲染逻辑，无需改 desktop UI：

| ACP 事件 | AgentEventSink 映射 |
|---|---|
| `agent_message_chunk` | `text-delta` |
| `tool_call` / `tool_call_update` | `tool-call` / `tool-result` |
| `plan` | status / trace |
| `usage_update` | usage |

映射时必须遵守规格约束：

- **结构化事件先做 schema 校验 + 单事件 256 KB 限制**；解析失败降级为受限文本事件并标记 `protocol_degraded`（L1411）。
- **CLI 的隐藏推理、内部 trace 或供应商原始响应不得映射到聊天**；只显示最终答复、可公开进度、工具摘要、警告和成果（L1412）。ACP 的 thought/verbose 类型事件只用于内部 trace，不落聊天。

### 4.5 取消、超时与进程树（MVP 规格 L1419/L1421）

- 取消时先发 `session/cancel`（优雅取消），**2 秒后终止进程树**；Windows 使用 Job Object 或经过测试的等价实现，不能只结束父进程留下孙进程（L1419）。ACP CLI 可能派生子进程（如工具执行、MCP server），进程树清理必须覆盖。
- stdout、stderr 和单次运行总时长都有上限，超限统一映射为稳定错误码（L1421）。

### 4.6 不修改用户全局 CLI 配置（MVP 规格 L1276）

K_Studio 不修改用户全局 CLI 配置。Team MCP / ACP 的 `mcpServers` 注入走进程级或项目级临时配置，并在 Run 结束后清理（对应 ACP `session/new` 传 `mcpServers` 的能力，进程退出即自动释放）。

## 5. 迁移策略（分批，每批可回滚）

### 5.1 分类

> 注意：「原生支持 ACP」均为**待实测项**——需逐个 CLI 验证 ACP 端点是否真实存在、启动参数与非交互行为。不得仅凭第三方名单（如 AionUi 支持列表）直接认定，遵循 L876「禁止猜测命令行参数」。

| 类别 | 名单 | 决策 |
|---|---|---|
| 原生支持 ACP（已实测） | gemini（`gemini --acp`）、opencode（`opencode acp`） | 首批，已迁移到 ACP 路径 |
| 原生支持 ACP（已实测） | codebuddy（`codebuddy --acp`） | 二批，已迁移并实测（v2.132.0 握手 + 完整 prompt） |
| 原生支持 ACP（已迁移，待实测） | qwen-code（`qwen --acp`）、kimi（`kimi acp`） | 二批，已迁移到 ACP 路径，待真实 CLI 实测后标记 verified |
| 原生支持 ACP（待实测） | hermes（`hermes acp`） | 打通协议链路后接入，实测后标记 verified |
| 原生支持 ACP（待实测） | copilot 等 | 后续批次，验证后再决定迁移或保留手写 |
| **无原生 ACP** | codex、claude-code、aion | 保留手写模型。实测：codex CLI 仅提供 `app-server`（JSONL over stdio）与 `mcp-server`，无 ACP 端点；claude-code CLI 无 ACP 端点（需 `claude-agent-acp` 第三方包装器）；aion 无 ACP server 端点（其 `aion-integration-acp` 是 Aion 作为 ACP **客户端**驱动其它 agent 的 harness）。不在本期范围 |
| 确认无 ACP 或需交互终端 | （逐个验证） | 保留手写模型 / `node-pty`（规格 L869 第 3 条）作为 fallback |

### 5.2 落地顺序

1. 修复调用路径硬伤：`agents:startProcess` 与 smoke test 改走 `adapter.run()`。
2. agent-core 加 SDK 依赖，实现 `transport.ts` + `session.ts` 骨架（可独立自测）。
3. `AcpCliAdapter` + `registry.ts`，接 Hermes 打通端到端（验证两次 `run()` 生命周期、cancel、事件流）。
4. 契约测试（`ac-ext-07`）+ 版本兼容表（`version-compatibility.ts` + `contract-validator.ts`）补齐。
5. 首批：实测 gemini / opencode / hermes 的 ACP 端点，逐批迁移。
6. 二批：实测 qwen-code / kimi / codebuddy / aion 的 ACP 端点，再决定迁移或保留手写 / node-pty。

> 实测记录（2026-08-10）：codex、claude-code、aion 的 CLI 无原生 ACP 端点，保留手写模型（详见 §5.1 分类表）。首批原生 ACP 迁移已覆盖 gemini、opencode；二批已迁移 qwen-code、kimi、codebuddy，其中 codebuddy（v2.132.0）已实测 `verified: true`，qwen-code / kimi 待实测。hermes 待本机安装后实测。

## 6. 受影响文件清单

### 必改

| 文件 | 改动 |
|---|---|
| `packages/agent-core/src/adapters/acp/`（新增） | transport / session / adapter / registry / contract-tests |
| `packages/agent-core/package.json` | 新增 `@agentclientprotocol/sdk` 依赖 |
| `packages/agent-core/src/adapters/index.ts` | 导出 AcpCliAdapter |
| `apps/desktop/src/main/cli-agent-registry.ts` | 注册 ACP 适配器 |
| `apps/desktop/src/main/version-compatibility.ts` | 新增 ACP CLI 版本范围 |
| `packages/agent-core/src/contract-validator.ts` | 新增 ACP CLI 契约 |
| `apps/desktop/src/main/index.ts` | `agents:startProcess` 改走 `adapter.run()`；`agents:detectCli` 能力上报修正 |
| `apps/desktop/src/main/agent-connection-service.ts` | smoke test 走 `adapter.run()` |

### 不动

| 文件 | 原因 |
|---|---|
| 现有 8 个适配器目录 | 迁移前保持手写模型 |
| `packages/agent-core/src/adapters/spawn.ts` | 保留，作为 ACP fallback 与 cmd shim 处理复用 |
| `apps/desktop/src/main/agent-executor.ts` | 调用点无感知（若走 `adapter.run()` 则无需改动） |

## 7. 风险与待验证项

1. **SDK 依赖**：`@agentclientprotocol/sdk` 的 Node engine、ESM 兼容性、自定义 spawn 能力（Windows `.cmd` shim）。
2. **各 CLI 的 ACP 启动参数**：是启动非交互 ACP 端点还是进入交互 TUI，需逐个实测（Hermes / OpenClaw / Goose / Copilot 各不相同）。
3. **stdout 污染**：banner / 进度输出混入协议通道，需 env 开关抑制。
4. **两次 run() 生命周期**：拆解 + 执行各需独立进程，异常路径子进程泄漏风险。
5. **`agents:startProcess` 路径**：当前硬编码走 `cliExecutor`，改动面与回归风险。
6. **契约测试**：`version-compatibility.ts` 与 `contract-validator.ts` 需同时补充，漏一处契约测试即失败。

## 8. 工作量估算

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | 调用路径修复（startProcess / smoke） | 1 天 |
| 2 | SDK 依赖 + transport/session 骨架 | 1 天 |
| 3 | AcpCliAdapter + registry + Hermes 打通 | 2 天 |
| 4 | 契约测试 + 版本表 | 1 天 |
| 5 | 首批迁移（codex / claude-code / gemini / opencode，逐个实测 ACP 端点） | 3-5 天 |
| 6 | 二批验证（qwen-code / kimi / codebuddy / aion） | 后续迭代 |

## 9. 验收标准

- [ ] 新增 CLI（Hermes）可通过 ACP 路径完整执行一次任务，事件流在 UI 正确渲染。
- [ ] 拆解 + 执行两次 `run()` 均正常，无进程泄漏。
- [ ] 取消（`session/cancel` + 2 秒兜底终止进程树）可靠生效。
- [ ] 事件流遵守 L1411（schema 校验 + 256KB + `protocol_degraded`）与 L1412（隐藏推理不落聊天）。
- [ ] spawn 遵守 L1357/L1358：无 `shell: true`，Windows `.cmd` shim 走固定 launcher。
- [ ] `agents:startProcess` 与向导 smoke test 对 ACP CLI 走 `adapter.run()` 路径。
- [ ] 契约测试（`ac-ext-07`）与版本兼容表覆盖全部新增 CLI。
- [ ] 首批迁移的现有 CLI（gemini、opencode）能力不低于迁移前（含 `structuredOutput` 提升）；codex、claude-code、aion 因无原生 ACP 端点保留手写模型。
- [ ] 迁移的每个 CLI 均通过实际 ACP 端点实测（不依赖第三方支持名单）。
