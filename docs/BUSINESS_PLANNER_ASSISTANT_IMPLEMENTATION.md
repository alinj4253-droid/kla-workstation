# 建潘-三一规划智能体

## 交付范围

已将 `kunlu-business-planner` 技能包接入新版统一运行时，并新增官方本地智能体「建潘-三一规划智能体」。它与 PPT 助手、路线规划助手使用相同的服务端定义、技能挂载、统一工具网关、Electron 设备心跳、审批/执行权限和成果回执链路。

每个身份首次初始化运行时目录时，服务端幂等创建该智能体并默认挂载：

- `business_planning`：经营规划技能包
- `artifact_management`：成果读取与交付
- `memory_context`：当前群聊短期记忆
- `local_files`：本地任务文件处理

智能体默认 `execution_location=local`，模型和 API Key 仍由服务端按当前身份的默认挂载槽位管理。

## 网关工具

| 工具 | 用途 |
| --- | --- |
| `local_business_metrics` | 查询内置经营指标、人员和规划基线 |
| `local_business_goal_decompose` | 公司目标拆解到部门和 KPI |
| `local_business_deviation` | 按 all/revenue/h1/project 口径分析偏差 |
| `local_business_plan` | 生成公司整体、指定部门或全部规划 |
| `local_business_ppt` | 生成公司整体或部门可编辑 PPTX |

工具参数由 `packages/contracts` 校验，模型只能调用已挂载且已启用的工具。经营规划工具全部通过本地执行器下发，服务端不直接执行压缩包里的 Python。

## 技能包与本地执行

技能包随 Electron `extraResources` 打包到 `resources/skills/kunlu-business-planner`，保留原始 `SKILL.md`、业务引擎、内置 `scripts/data/knowledge_base.json` 与 `metrics.json`。`scripts/kla_bridge.py` 只接受结构化 JSON 操作名，禁止模型传入任意 Python 源码。

执行器使用 `KLA_BUSINESS_PLANNER_PYTHON` 指定 Python；未设置时沿用系统 `python.exe/python3`。运行环境至少需要 Python 3.10 以及技能包 `scripts/requirements.txt` 中的依赖（FastAPI、python-pptx、openpyxl 等）。经营查询和规划返回 JSON；PPT 工具返回真实 PPTX，经过 SHA-256、文件头和大小校验后写入现有 artifacts 回执链路。

## 群聊使用方式

1. 在「我的智能体」中确认该身份已出现「建潘-三一规划智能体」，并在技能管理中确认 `鲲鹭经营规划` 已挂载。
2. 创建群聊时把该智能体加入群聊成员池；群聊秘书只能调度当前群聊成员。
3. 用户可直接 `@建潘-三一规划智能体`，或 `@任务执行` 让群聊秘书在成员池内分派。
4. 首次本地调用要求 Electron 登录同一账号/身份并保持设备在线；有完全访问权限时不弹审批，审批模式仍按现有本地执行策略处理。
5. PPT 生成完成后只交付回执中的真实 artifact，不重复发送文件；右侧成果抽屉可继续使用现有预览和下载能力。

## 数据与权限边界

- 经营知识包是随客户端发布的本地只读数据，不写入服务端知识库表，也不改变知识库模块的检索权限。
- 群聊消息、运行步骤、工具审计和 PPT 成果仍按当前身份、项目和群聊隔离写入服务端数据库。
- 经营规划智能体不能调用未挂载的工具；工具网关和本地执行器同时校验身份权限、设备归属、群聊成员池与工具能力。
- 更新技能包数据需要更新 Electron 资源并重启客户端；更新智能体定义或挂载逻辑由服务端版本发布控制。

## 已验证

- contracts/server/desktop TypeScript 检查通过。
- Python bridge 可读取经营指标、完成目标拆解和部门规划。
- 本地工具适配器已实际生成事业二部 PPTX，并返回有效 Office Open XML 文件头、大小和 Base64 成果。
- 旧的知识库、算力、记忆路径没有被修改。
