"""
鲲鹭科技经营智能体 - API 服务
提供：
1. OpenAI 兼容的 /v1/chat/completions 接口（直接模型调用）
2. 工具函数接口（供外部 AI 平台注册为 tools 调用）
3. 直接业务接口（目标拆解/偏差分析/规划生成）
"""
import json, os, time, uuid, urllib.parse
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from goal_engine import decompose_company_goals, track_goal_status, quarter_decompose
from deviation_engine import deviation_report, analyze_h1_deviation, analyze_project_deviation
from plan_engine import generate_company_plan, generate_department_plan, generate_all_plans
from ppt_engine import generate_company_ppt, generate_department_ppt
from metrics import build_metrics

app = FastAPI(title="鲲鹭科技经营智能体", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 数据模型 ============
class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "kunlu-agent"
    messages: List[ChatMessage]
    tools: Optional[List[dict]] = None
    temperature: float = 0.3
    stream: bool = False


class ToolCallRequest(BaseModel):
    name: str
    args: Optional[dict] = None


# ============ 直接业务接口 ============
@app.get("/api/metrics")
def api_metrics():
    """获取全部业务指标"""
    return build_metrics()


@app.get("/api/goal/decompose")
def api_goal_decompose(year: int = 2026, half: str = "H2"):
    """公司目标→部门目标拆解"""
    return decompose_company_goals(year=year, half=half)


@app.get("/api/goal/track")
def api_goal_track(goal_no: int, actual: float, target: float):
    """单个目标达成跟踪"""
    return track_goal_status(goal_no, actual, target)


@app.get("/api/goal/quarter")
def api_goal_quarter(annual_target: float, q1: float = 0.15, q2: float = 0.25, q3: float = 0.30, q4: float = 0.30):
    """年度目标按季度拆解"""
    return quarter_decompose(annual_target, q1, q2, q3, q4)


@app.get("/api/deviation")
def api_deviation(scope: str = "all"):
    """经营偏差分析。scope: all/revenue/h1/project"""
    r = deviation_report()
    if scope == "revenue":
        return r["revenue_deviation"]
    if scope == "h1":
        return r["h1_deviation"]
    if scope == "project":
        return r["project_deviation"]
    return r


@app.get("/api/plan/company")
def api_plan_company(year: int = 2026):
    """生成公司整体三一规划"""
    return generate_company_plan(year=year)


@app.get("/api/plan/department")
def api_plan_department(department: str):
    """生成部门规划。department: 事业一部/事业二部/研究院"""
    valid = ["事业一部", "事业二部", "研究院"]
    if department not in valid:
        raise HTTPException(status_code=400, detail=f"department 必须是 {valid} 之一")
    return generate_department_plan(department)


@app.get("/api/plan/all")
def api_plan_all(year: int = 2026):
    """生成公司+全部部门规划"""
    return generate_all_plans()


# ============ PPT 生成接口 ============
@app.get("/api/ppt/company")
def api_ppt_company():
    """生成公司整体三一规划 PPT（可编辑 PPTX）"""
    data = generate_company_ppt()
    # RFC 5987 中文文件名，避免 latin-1 编码异常
    filename = urllib.parse.quote("鲲鹭科技2026年三一规划.pptx")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"}
    )


@app.get("/api/ppt/department")
def api_ppt_department(department: str):
    """生成部门规划 PPT。department: 事业一部/事业二部/研究院"""
    valid = ["事业一部", "事业二部", "研究院"]
    if department not in valid:
        raise HTTPException(status_code=400, detail=f"department 必须是 {valid} 之一")
    data = generate_department_ppt(department)
    filename = urllib.parse.quote(f"{department}2026年规划.pptx")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"}
    )


# ============ 工具函数定义（供外部 AI 平台注册） ============
TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "decompose_goals",
            "description": "将公司整体目标拆解为部门目标和KPI，支持按年度/半年维度",
            "parameters": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer", "description": "年份，默认2026", "default": 2026},
                    "half": {"type": "string", "enum": ["H1", "H2"], "description": "上半年/下半年", "default": "H2"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_deviation",
            "description": "经营偏差分析，对比计划与实际，识别偏差并归因",
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["all", "revenue", "h1", "project"],
                              "description": "分析范围：全部/收入/上半年/项目", "default": "all"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_plan",
            "description": "生成公司整体三一规划或指定部门规划",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["company", "department", "all"],
                             "description": "规划类型：公司整体/部门/全部", "default": "all"},
                    "department": {"type": "string", "description": "部门：事业一部/事业二部/研究院（type=department时必填）"},
                    "year": {"type": "integer", "default": 2026}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_metrics",
            "description": "获取鲲鹭科技全部业务指标数据（业绩、人力、规划目标）",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "track_goal",
            "description": "跟踪单个目标的达成状态，输入实际值和目标值，返回完成率和状态",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal_no": {"type": "integer", "description": "目标编号"},
                    "actual": {"type": "number", "description": "实际值"},
                    "target": {"type": "number", "description": "目标值"}
                },
                "required": ["goal_no", "actual", "target"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_ppt",
            "description": "生成规范可编辑的 PPTX 文件（公司整体三一规划或部门规划），返回文件下载地址",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["company", "department"],
                             "description": "PPT类型：公司整体/部门", "default": "company"},
                    "department": {"type": "string", "description": "部门：事业一部/事业二部/研究院（type=department时必填）"}
                }
            }
        }
    }
]


@app.get("/api/tools")
def api_tools():
    """返回工具函数 Schema，供外部 AI 平台注册"""
    return TOOLS_SCHEMA


def _dispatch_tool(name: str, args: dict):
    """工具分发执行"""
    if name == "decompose_goals":
        return decompose_company_goals(year=args.get("year", 2026), half=args.get("half", "H2"))
    if name == "analyze_deviation":
        return deviation_report() if args.get("scope", "all") == "all" else {
            "revenue": deviation_report()["revenue_deviation"],
            "h1": analyze_h1_deviation(),
            "project": analyze_project_deviation()
        }.get(args["scope"], deviation_report())
    if name == "generate_plan":
        t = args.get("type", "all")
        if t == "company":
            return generate_company_plan(year=args.get("year", 2026))
        if t == "department":
            return generate_department_plan(args.get("department", "事业一部"))
        return generate_all_plans()
    if name == "get_metrics":
        return build_metrics()
    if name == "track_goal":
        return track_goal_status(args["goal_no"], args["actual"], args["target"])
    if name == "generate_ppt":
        t = args.get("type", "company")
        if t == "department":
            dept = args.get("department", "事业一部")
            return {
                "ppt_type": "department",
                "department": dept,
                "download_url": f"/api/ppt/department?department={urllib.parse.quote(dept)}",
                "message": f"{dept}2026年规划 PPT 已生成，请通过 download_url 下载"
            }
        return {
            "ppt_type": "company",
            "download_url": "/api/ppt/company",
            "message": "鲲鹭科技2026年三一规划 PPT 已生成，请通过 download_url 下载"
        }
    return {"error": f"未知工具: {name}"}


# ============ OpenAI 兼容的 Chat Completions 接口 ============
SYSTEM_PROMPT = """你是鲲鹭科技的经营规划智能体，专长于：
1. 目标跟踪与拆解：将公司年度/半年度目标拆解为部门目标、项目KPI，并跟踪达成状态
2. 经营偏差分析：对比计划与实际，识别偏差并归因，给出改进建议
3. 规划生成：输出公司整体三一规划和部门规划

你掌握鲲鹭科技 2024-2026 年的规划文档、业绩数据和工作汇报。
回答时引用具体数据，给出可执行的建议。

核心背景：
- 2026年经营改革：承包制，上半年拆分事业一/二/三部，7月评定承包制失败，重定下半年目标
- 2026下半年六目标：①云检迭代（算法自主可控）+其他行业视觉检测案例1项；②鲲擎体系（家居垂类模型+AI服务平台）；③金牌线项目国家级验收；④市级以上项目申报1项；⑤行业前十龙头客户标杆案例1项；⑥营收1000万、利润50万
- 2026H1：业绩未达标，人员43→30人，鲲擎平台进入市场验证阶段
"""


def _build_text_response(user_msg: str) -> str:
    """根据用户消息，调用引擎生成文本回复"""
    msg = user_msg.lower()
    if any(k in msg for k in ["ppt", "幻灯片", "演示文稿", "出ppt", "生成ppt"]):
        # PPT 生成
        dept = None
        if "一部" in msg or "1部" in msg:
            dept = "事业一部"
        elif "二部" in msg or "2部" in msg:
            dept = "事业二部"
        elif "研究" in msg:
            dept = "研究院"
        if dept:
            url = f"/api/ppt/department?department={urllib.parse.quote(dept)}"
            return f"## {dept}2026年规划 PPT 已生成\n\n下载地址：{url}\n\n在浏览器中打开即可下载可编辑的 PPTX 文件。"
        return ("## 鲲鹭科技2026年三一规划 PPT 已生成\n\n"
                "下载地址：/api/ppt/company\n\n"
                "在浏览器中打开即可下载可编辑的 PPTX 文件。")

    if any(k in msg for k in ["拆解", "目标", "部门目标", "kpi"]):
        tree = decompose_company_goals()
        lines = ["## 2026下半年目标拆解\n"]
        for g in tree["company_goals"]:
            lines.append(f"### {g['no']}. {g['area']}：{g['target']}")
            for sg in g["sub_goals"]:
                lines.append(f"- **{sg['department']}**：{sg['decomposed_target']}")
            lines.append("")
        return "\n".join(lines)

    if any(k in msg for k in ["偏差", "分析", "未达标", "原因"]):
        dev = deviation_report()
        lines = ["## 经营偏差分析\n"]
        for d in dev["h1_deviation"]["deviations"]:
            lines.append(f"### {d['area']}：{d['issue']}")
            lines.append(f"- 根因：{'；'.join(d['root_cause'])}")
            lines.append(f"- 对策：{d['action']}\n")
        return "\n".join(lines)

    if any(k in msg for k in ["规划", "计划", "三一规划"]):
        # 判断是否是部门规划
        dept = None
        if "一部" in msg or "1部" in msg:
            dept = "事业一部"
        elif "二部" in msg or "2部" in msg:
            dept = "事业二部"
        elif "研究" in msg:
            dept = "研究院"

        if dept:
            dp = generate_department_plan(dept)
            lines = [f"# {dp['department']} 2026年规划\n"]
            lines.append("## 承接的公司目标")
            for g in dp["承接的公司目标"]:
                lines.append(f"- **{g['area']}**：{g['dept_target']}")
            lines.append("\n## 业绩基线")
            lines.append(json.dumps(dp["业绩基线"], ensure_ascii=False)[:300])
            lines.append("\n## 关键举措")
            for a in dp["关键举措"]:
                lines.append(f"- {a}")
            lines.append("\n## 风险与对策")
            for r in dp["风险与对策"]:
                lines.append(f"- 风险：{r['risk']} → 对策：{r['mitigation']}")
            return "\n".join(lines)

        plan = generate_company_plan()
        lines = [f"# {plan['title']}\n"]
        for s in plan["sections"]:
            lines.append(f"## {s['name']}")
            if s["name"] == "三一规划":
                lines.append("### 公司目标")
                for g in s["content"]["company_goals"]["company_goals"]:
                    lines.append(f"{g['no']}. {g['area']}：{g['target']}")
                lines.append(f"\n财务目标：营收{s['content']['financial_target']['revenue_wan']}万 / 利润{s['content']['financial_target']['profit_wan']}万")
            lines.append("")
        return "\n".join(lines)

    if any(k in msg for k in ["指标", "数据", "业绩"]):
        m = build_metrics()
        return json.dumps(m, ensure_ascii=False, indent=2)

    return ("我是鲲鹭科技经营规划智能体，可帮你：\n"
            "1. 目标拆解（如：拆解2026下半年目标）\n"
            "2. 经营偏差分析（如：分析上半年偏差原因）\n"
            "3. 生成规划（如：生成公司三一规划/事业一部规划）\n"
            "4. 查询指标数据（如：查看业绩指标）")


@app.post("/v1/chat/completions")
def chat_completions(req: ChatRequest):
    """OpenAI 兼容接口，供外部 AI 平台直接调用模型"""
    user_msg = ""
    for m in req.messages:
        if m.role == "user":
            user_msg = m.content

    # 优先匹配 tool call 风格
    if req.tools:
        # 简单路由：根据用户消息意图调用对应工具
        tool_name = None
        args = {}
        msg_lower = user_msg.lower()
        if any(k in msg_lower for k in ["拆解", "目标", "部门"]):
            tool_name = "decompose_goals"
        elif any(k in msg_lower for k in ["偏差", "分析", "未达标"]):
            tool_name = "analyze_deviation"
        elif any(k in msg_lower for k in ["规划", "计划"]):
            tool_name = "generate_plan"
            if "部门" in user_msg:
                args["type"] = "department"
                if "一部" in user_msg:
                    args["department"] = "事业一部"
                elif "二部" in user_msg:
                    args["department"] = "事业二部"
                elif "研究" in user_msg:
                    args["department"] = "研究院"
        elif any(k in msg_lower for k in ["指标", "数据", "业绩"]):
            tool_name = "get_metrics"

        if tool_name:
            result = _dispatch_tool(tool_name, args)
            return {
                "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": req.model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)},
                    "finish_reason": "tool_calls"
                }],
                "tool_calls": [{
                    "id": f"call_{uuid.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {"name": tool_name, "arguments": json.dumps(args, ensure_ascii=False)}
                }]
            }

    content = _build_text_response(user_msg)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": len(user_msg), "completion_tokens": len(content), "total_tokens": len(user_msg) + len(content)}
    }


@app.post("/v1/tools/call")
def tool_call(req: ToolCallRequest):
    """外部 AI 平台直接调用工具函数"""
    result = _dispatch_tool(req.name, req.args or {})
    return {"tool": req.name, "result": result}


@app.get("/")
def root():
    return {
        "name": "鲲鹭科技经营智能体",
        "version": "1.0.0",
        "endpoints": {
            "chat": "POST /v1/chat/completions",
            "tools": "GET /api/tools",
            "tool_call": "POST /v1/tools/call",
            "goal_decompose": "GET /api/goal/decompose",
            "deviation": "GET /api/deviation",
            "plan": "GET /api/plan/all",
            "ppt_company": "GET /api/ppt/company",
            "ppt_department": "GET /api/ppt/department?department=事业一部",
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
