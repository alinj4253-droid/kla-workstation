# 鲲鹭经营规划智能体 (kunlu-business-planner)

标准技能包，提供目标拆解、经营偏差分析、规划生成与 PPT 输出能力。

## 快速开始

```bash
pip install -r scripts/requirements.txt
python scripts/build_kb.py          # 可选：从源文档重建知识库
python scripts/run.py               # 启动服务 (http://127.0.0.1:8000)
```

## 能力

| 能力 | 接口 |
|------|------|
| 目标拆解 | `GET /api/goal/decompose?year=2026&half=H2` |
| 偏差分析 | `GET /api/deviation?scope=h1` |
| 公司规划 | `GET /api/plan/company` |
| 部门规划 | `GET /api/plan/department?department=事业一部` |
| 公司 PPT | `GET /api/ppt/company` |
| 部门 PPT | `GET /api/ppt/department?department=事业二部` |
| 对话调用 | `POST /v1/chat/completions` |
| 工具注册 | `GET /api/tools` |

详细说明见 `SKILL.md`。
