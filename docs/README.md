# KLA Workstation 文档索引

## 当前规范

- [ARCHITECTURE.md](ARCHITECTURE.md)：当前实现的系统分层、工作区目录、智能体调度、知识与文件边界。

## 历史基线与专项设计

- [MVP_IMPLEMENTATION_SPEC.md](MVP_IMPLEMENTATION_SPEC.md)：2026-07-18 MVP 设计和验收基线，保留用于追溯；与当前代码冲突时不作为唯一规范。
- [ACP_ADAPTER_PLAN.md](ACP_ADAPTER_PLAN.md)：外部 CLI 的 ACP 接入计划、验证范围和迁移风险。
- [DESIGN_CHANNEL_MANUAL_BINDING.md](DESIGN_CHANNEL_MANUAL_BINDING.md)：渠道会话手动绑定设计。
- [workbuddy-mcp.md](workbuddy-mcp.md)：WorkBuddy MCP 集成说明。

## 文档维护约定

新增架构或行为变化时，先更新 `ARCHITECTURE.md`；专项方案放在独立设计文档中，并在此处登记状态。历史文档不要直接覆盖，使用顶部说明标注适用版本和与当前实现的差异。
