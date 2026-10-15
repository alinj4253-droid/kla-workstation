---
name: kunlu-business-planner
description: 鲲鹭经营规划：目标拆解、偏差分析、生成规划与PPT。
version: 1.0.0
author: 鲲鹭科技, Hermes Agent
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [business, planning, ppt, goal-tracking, deviation-analysis]
    related_skills: [office-plugin.pptx, office-plugin.xlsx]
---

# 鲲鹭经营规划智能体

基于鲲鹭科技 2024-2026 规划文档、业绩数据与工作汇报，提供目标拆解、经营偏差分析、规划生成（公司整体+部门），并输出规范可编辑的 PPTX 文件。

不做：不直接修改原始业务数据、不替用户做经营决策。

## When to Use

- 用户需要拆解年度/半年度经营目标到部门和 KPI
- 用户需要对比计划与实际、分析经营偏差并找根因
- 用户需要生成公司整体三一规划或部门规划
- 用户需要把规划输出为规范 PPT 文件

**Don't use for:** 非鲲鹭科技业务数据的通用规划咨询、需要实时财务系统对接的场景。

## Prerequisites

- Python 3.10+
- 依赖：`fastapi`, `uvicorn`, `python-pptx`, `openpyxl`, `pydantic`
- 知识库数据：首次运行需执行 `build_kb.py` 从源文档构建 `data/knowledge_base.json` 与 `data/metrics.json`
- 源文档位于工作目录下（2024/2025 规划 PPT、业绩 Excel、1~6 月汇报 PPT 等）

安装依赖：

```bash
pip install -r ${HERMES_SKILL_DIR}/scripts/requirements.txt
```

## Quick Reference

| 能力 | 接口 / 入口 |
| :--- | :--- |
| 目标拆解 | `GET /api/goal/decompose?year=2026&half=H2` |
| 偏差分析 | `GET /api/deviation?scope=all` (all/revenue/h1/project) |
| 公司规划 | `GET /api/plan/company?year=2026` |
| 部门规划 | `GET /api/plan/department?department=事业一部` |
| 公司 PPT | `GET /api/ppt/company` |
| 部门 PPT | `GET /api/ppt/department?department=事业二部` |
| 对话调用 | `POST /v1/chat/completions` (OpenAI 兼容) |
| 工具注册 | `GET /api/tools` 返回 6 个工具 Schema |

## Procedure

1. **构建知识库**。运行 `python ${HERMES_SKILL_DIR}/scripts/build_kb.py`，从 7 份源文档生成结构化知识库。完成判据：`scripts/data/knowledge_base.json` 与 `metrics.json` 存在且非空。

2. **启动服务**。运行 `python ${HERMES_SKILL_DIR}/scripts/run.py`，默认监听 `http://127.0.0.1:8000`。完成判据：访问根路径返回端点列表。

3. **目标拆解**。调用 `/api/goal/decompose` 获取公司→部门→KPI 的层级目标树。完成判据：返回 6 大公司目标及对应承接部门。

4. **偏差分析**。调用 `/api/deviation?scope=h1` 获取上半年偏差项、根因与对策。完成判据：返回 ≥5 项偏差，每项含根因和对策。

5. **生成规划**。
   - 公司整体：`/api/plan/company`（经营回顾/市场洞察/战略路径/三一规划）
   - 部门：`/api/plan/department?department=事业一部`（承接目标/关键举措/风险对策）
   完成判据：返回完整规划 JSON。

6. **输出 PPT**。
   - 公司 PPT：`/api/ppt/company`（8 页可编辑 PPTX）
   - 部门 PPT：`/api/ppt/department?department=研究院`（3 页）
   完成判据：浏览器直接下载 `.pptx` 文件，可用 PowerPoint 打开。

7. **集成外部 AI 平台**（可选）。
   - 方式一：`GET /api/tools` 获取工具 Schema，注册到外部平台 tools 配置，工具触发时调 `POST /v1/tools/call`
   - 方式二：将用户消息透传到 `POST /v1/chat/completions`，智能体自动路由

## Pitfalls

- **中文文件名下载异常**：已用 RFC 5987 `filename*=UTF-8''` 编码，不要在 `Content-Disposition` 直接写中文。
- **承包制考核周期不匹配**：B 端长回款特性导致上半年利润失真，偏差分析时需考虑高额摊销挂账。
- **云检进度顺延归因**：成都/厦门/泗阳三基地顺延根因不同（打点器验证/预算/移机），不要笼统归因为"执行不力"。
- **PowerShell 中文编码**：用 `python -c` 测试接口时中文可能乱码，JSON 数据本身正确，建议用 Python `requests` 或 `urllib` 验证。

## Verification

1. 服务启动后 `curl http://127.0.0.1:8000/` 返回含 `ppt_company` 等端点的 JSON。
2. `GET /api/ppt/company` 下载的 PPTX 用 python-pptx 读取，页数 = 8。
3. `GET /api/goal/decompose` 返回的 `company_goals` 长度 = 6。
4. `POST /v1/chat/completions` 发送"生成事业二部的ppt"，回复含下载地址 `/api/ppt/department?department=事业二部`。
5. `GET /api/tools` 返回 6 个工具（含 `generate_ppt`）。
